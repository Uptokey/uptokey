import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import type { GatewayChatRequest } from "@uptokey/sync-contract/gateway";
import { GenericOpenAIAdapter } from "./adapters.ts";
import { assertProxyConfig } from "./config.ts";
import { assertEndpointCredentialFree, assertProviderEndpointUrl } from "./endpoint-policy.ts";
import { IpcWorkspaceGateway, gatewayWireHasAudio, type WorkspaceGateway } from "./gateway-service.ts";
import { dispatchInference } from "./inference-service.ts";
import type { QuotaLedger } from "./quota-ledger.ts";
import type { SecretStore } from "./secret-store.ts";
import { conservativeTokenEstimate, planAttemptAccounting } from "./token-estimate.ts";
import type { ProviderConfig, ProxyConfig } from "./types.ts";
import type { WorkspaceStore } from "./workspace/store.ts";
import { inspectBrowserRuntime, productCodeRoots, type PlaywrightBrowserOptions } from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import type { WorkspaceBrowser } from "./browser-service.ts";

const REVISION = "17c4cc76877bd1755030a8414f8d0083f48dcccf";
const PREFIX = "quimera-custom";
const CHILD_ENDPOINT = "http://127.0.0.1:20128/api/v1/chat/completions";
const failed = () => new Error("quimera_gateway_unavailable");
type Runtime = { root: string; entry: string; env: NodeJS.ProcessEnv };

/** Composition only. MCP workers start later, after W5 admission of each read. */
export async function createPlaywrightBrowser(options: PlaywrightBrowserOptions, root?: string): Promise<WorkspaceBrowser> {
  const runtime = inspectBrowserRuntime(options, root);
  const { McpWorkspaceBrowser } = await import("./browser-service.ts");
  return new McpWorkspaceBrowser(runtime);
}

export interface NineRouterGatewayOptions {
  config: ProxyConfig;
  secrets: Pick<SecretStore, "get">;
  ledger: Pick<QuotaLedger, "reserve">;
  store: Pick<WorkspaceStore, "readRun">;
}

/** Injectable process/transport boundaries for isolated tests; no alternate persisted configuration. */
export interface NineRouterLaunchDependencies {
  runtime(): Runtime;
  spawnChild(runtime: Runtime): ChildProcess;
  sendChat(chat: GatewayChatRequest, requestId: string, signal: AbortSignal, token: string, timeoutMs: number): Promise<Response>;
  fetchImpl: typeof fetch;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
}

function unlinked(path: string): string {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw failed();
    if (dirname(current) === current) break;
  }
  return resolve(path);
}

function knownRuntime(): Runtime {
  const root = unlinked(join(productCodeRoots().INTEGRATIONS, "9router/app"));
  const entry = unlinked(join(root, "quimera-gateway-child.cjs"));
  const manifest = unlinked(join(root, "..", "source-manifest.json"));
  if (lstatSync(manifest).size > 2_000_000 || JSON.parse(readFileSync(manifest, "utf8")).commit !== REVISION) throw failed();
  const profilePath = unlinked(join(root, "quimera-profile.cjs"));
  const profile = createRequire(import.meta.url)(profilePath) as {
    PORT: number;
    childEnvironment(parent: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv;
    assertRuntime(env: NodeJS.ProcessEnv, cwd: string): unknown;
  };
  if (profile.PORT !== 20128) throw failed();
  unlinked(join(root, "node_modules", "next", "dist", "bin", "next"));
  const env = profile.childEnvironment(process.env, root);
  profile.assertRuntime(env, root);
  return { root, entry, env };
}

function customProfile(config: ProxyConfig): ProviderConfig {
  assertProxyConfig(config);
  const entry = config.providers.custom;
  if (!entry?.enabled || !entry.configured || !entry.endpointUrl || config.deviceRevokedAt || config.entitlementSuspendedAt ||
      entry.endpointUrl === "https://example.invalid/v1/chat/completions" || !entry.models.includes(entry.defaultModel)) throw failed();
  assertProviderEndpointUrl("custom", entry.endpointUrl);
  assertEndpointCredentialFree(entry.endpointUrl);
  const url = new URL(entry.endpointUrl);
  if (url.href !== entry.endpointUrl || url.search || url.hash ||
      !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") ||
      !url.pathname.endsWith("/chat/completions") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.defaultModel) ||
      `${PREFIX}/${entry.defaultModel}`.length > 200) throw failed();
  return entry;
}

/** Explicitly called by the opted-in daemon. No keys, ledgers or journals are created here. */
export async function startNineRouterGateway(options: NineRouterGatewayOptions, injected: Partial<NineRouterLaunchDependencies> = {}): Promise<{ gateway: WorkspaceGateway; close(): Promise<void> }> {
  let child: ChildProcess | undefined;
  let inner: IpcWorkspaceGateway | undefined;
  let available = false;
  let exited = false;
  let closing: Promise<void> | undefined;
  let resolveExited!: () => void;
  const childExited = new Promise<void>(resolveExit => { resolveExited = resolveExit; });
  const shutdownTimeout = injected.shutdownTimeoutMs ?? 5_000;
  const startupTimeout = injected.startupTimeoutMs ?? 60_000;
  if (![shutdownTimeout, startupTimeout].every(value => Number.isSafeInteger(value) && value > 0 && value <= 60_000)) throw failed();
  let frozen: ProviderConfig;
  try { frozen = structuredClone(customProfile(options.config)); } catch { throw failed(); }
  const ipcToken = randomBytes(32).toString("hex");
  const expected = canonicalJson(frozen);
  const assertCurrent = (): ProviderConfig => {
    if (!available || !child?.connected || exited) throw failed();
    try {
      const current = customProfile(options.config);
      if (canonicalJson(current) !== expected) throw failed();
      return current;
    } catch {
      available = false;
      inner?.dispose();
      void close().catch(() => undefined);
      throw failed();
    }
  };
  const onClosed = () => { exited = true; available = false; inner?.dispose(); resolveExited(); };
  const onFailed = () => { available = false; inner?.dispose(); void close().catch(() => undefined); };
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "unapproved-network") onFailed();
  };
  const waitForExit = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([childExited, new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, shutdownTimeout); })]); }
    finally { clearTimeout(timer); }
  };
  function close(): Promise<void> {
    if (closing) return closing;
    available = false;
    inner?.dispose();
    closing = Promise.resolve().then(async () => {
      if (!child) return;
      if (!exited) {
        try { if (child.connected) child.send("quimera:stop", () => undefined); else child.kill(); } catch { child.kill(); }
        await waitForExit();
      }
      if (!exited) { child.kill("SIGKILL"); await waitForExit(); }
      if (!exited) throw new Error("quimera_gateway_shutdown_failed");
      child.off("close", onClosed); child.off("exit", onClosed);
      child.off("disconnect", onFailed); child.off("error", onFailed); child.off("message", onMessage);
    });
    return closing;
  }
  try {
    const runtime = (injected.runtime ?? knownRuntime)();
    child = (injected.spawnChild ?? (value => spawn(process.execPath, [value.entry], {
      cwd: value.root, env: value.env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    })))(runtime);
    child.on("close", onClosed); child.on("exit", onClosed);
    child.on("disconnect", onFailed); child.on("error", onFailed); child.on("message", onMessage);
    const ownedChild = child;
    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const timer = setTimeout(() => finish(false), startupTimeout);
      const ready = (message: unknown) => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") finish(true);
      };
      const failedStart = () => finish(false);
      function finish(ok: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ownedChild.off("message", ready); ownedChild.off("exit", failedStart); ownedChild.off("close", failedStart);
        ownedChild.off("disconnect", failedStart); ownedChild.off("error", failedStart);
        if (ok && ownedChild.connected && !exited) resolveReady(); else rejectReady(failed());
      }
      ownedChild.on("message", ready); ownedChild.once("exit", failedStart); ownedChild.once("close", failedStart);
      ownedChild.once("disconnect", failedStart); ownedChild.once("error", failedStart);
      const token = ipcToken;
      try { ownedChild.send({ type: "configure", token, baseUrl: frozen.endpointUrl!.slice(0, -"/chat/completions".length),
        prefix: PREFIX, providerModel: frozen.defaultModel, provider: "openai-compatible-quimera-custom" }, error => { if (error) finish(false); }); }
      catch { finish(false); }
    });
    if (closing || exited || !child.connected) throw failed();
    available = true;
    assertCurrent();
    const model = `${PREFIX}/${frozen.defaultModel}`;
    inner = new IpcWorkspaceGateway({ child, model, providerModel: frozen.defaultModel, providerUrl: frozen.endpointUrl!, driverRevision: REVISION,
      store: options.store,
      prepareTimeoutMs: Math.min(30_000, frozen.requestTimeoutMs),
      sendProtocol: async (request,requestId,signal) => {
        assertCurrent();signal.throwIfAborted();
        return fetch('http://127.0.0.1:20128/api/quimera/normalize',{method:'POST',redirect:'error',signal,
          headers:{'content-type':'application/json',authorization:'Bearer '+ipcToken,'x-quimera-request-id':requestId},body:JSON.stringify(request)});
      },
      sendProjection: async(request,requestId,signal)=>{
        assertCurrent();signal.throwIfAborted();
        return fetch('http://127.0.0.1:20128/api/quimera/project-output',{method:'POST',redirect:'error',signal,
          headers:{'content-type':'application/json',authorization:'Bearer '+ipcToken,'x-quimera-request-id':requestId},body:JSON.stringify(request)});
      },
      sendProtocolStream: async(request,requestId,signal)=>{
        assertCurrent();signal.throwIfAborted();
        return fetch('http://127.0.0.1:20128/api/quimera/protocol-stream',{method:'POST',redirect:'error',signal,
          headers:{'content-type':'application/json',authorization:'Bearer '+ipcToken,'x-quimera-request-id':requestId},body:JSON.stringify(request)});
      },
      sendChat: async (chat, requestId, signal) => {
        const current = assertCurrent(); signal.throwIfAborted();
        if (injected.sendChat) return injected.sendChat(chat, requestId, signal, ipcToken, current.requestTimeoutMs);
        const adapter = new GenericOpenAIAdapter("custom", CHILD_ENDPOINT, { "x-quimera-request-id": requestId });
        return dispatchInference({ dispatch: (request, _context, inputSignal) => adapter.dispatch(request, ipcToken, inputSignal ?? new AbortController().signal, current.requestTimeoutMs) },
          chat, { requestId, allowedProviders: ["custom"], disableRetries: true }, signal);
      },
      beforeDispatch: async (_chat, wire, effect, signal) => {
        const current = assertCurrent(); signal.throwIfAborted();
        if (effect.capability.dataDestination.id !== "custom" || wire.provider !== "openai-compatible-quimera-custom") throw failed();
        // Same coherent accounting as the router: resolved model + uncovered envelope, never
        // a private estimator. The request is OpenAI-shaped for this custom endpoint.
        const request = JSON.parse(wire.body);
        let tokens: number;
        if (gatewayWireHasAudio(wire.body)) {
          // Audio bytes/base64 are not text tokens. Until the endpoint provides complete
          // media accounting, reserve the administrator's explicit input-context ceiling
          // plus requested output. This is a quota ceiling reservation, not measured usage.
          if (!Number.isSafeInteger(current.maxContextTokens) || current.maxContextTokens! < 1) throw new Error('budget_audio_context_limit_missing');
          tokens = current.maxContextTokens! + request.max_tokens;
          if (!Number.isSafeInteger(tokens)) throw new Error('budget_audio_context_limit_invalid');
        } else {
          const conservative = conservativeTokenEstimate(request);
          if (!conservative) throw failed();
          tokens = planAttemptAccounting(request, conservative).reservation.total;
        }
        const decision = await options.ledger.reserve("custom", { ...current.budget }, tokens);
        signal.throwIfAborted(); assertCurrent();
        if (!decision.allowed || !decision.reservation) throw failed();
        // Keep reservations for ambiguous outcomes; W3 owns the receipt, this ledger owns its estimate.
      },
      resolveCredential: async () => {
        assertCurrent();
        const secret = await options.secrets.get("provider:custom");
        assertCurrent();
        if (!secret) throw failed();
        return secret;
      },
      fetchImpl: (url, init) => {
        assertCurrent(); init?.signal?.throwIfAborted();
        return (injected.fetchImpl ?? fetch)(url, init);
      },
    });
    const gateway: WorkspaceGateway = {
      model,
      // W0 revision 5 carries bounded text/input_audio parts. Destination declarations
      // and revocation still belong to the parent; this declares lane transport only.
      inputParts: ['audio'],
      attachAccountFunding: reserve => inner!.attachAccountFunding(reserve),
      attachDispatchAuthority: validate => inner!.attachDispatchAuthority(validate),
      get available() { try { assertCurrent(); return true; } catch { return false; } },
      normalizeProtocol: async (request,signal) => {
        assertCurrent();const chat=await inner!.normalizeProtocol(request,signal);assertCurrent();return chat;
      },
      projectProtocolOutput:async(request,signal)=>{assertCurrent();const result=await inner!.projectProtocolOutput(request,signal);assertCurrent();return result;},
      openProtocolStream:async(protocol,identity,tools,signal)=>{assertCurrent();const result=await inner!.openProtocolStream(protocol,identity,tools,signal);assertCurrent();return result;},
      prepare: async (chat, signal) => {
        assertCurrent();
        const result = await inner!.prepare(chat, signal);
        assertCurrent();
        if (result.provider !== "openai-compatible-quimera-custom") throw failed();
        return result;
      },
      execute: (chat, wire, effect) => {
        const current = assertCurrent();
        return inner!.execute(chat, wire, { ...effect, limits: { ...effect.limits, timeoutMs: Math.min(effect.limits.timeoutMs, current.requestTimeoutMs) } });
      },
    };
    return { gateway, close };
  } catch {
    await close();
    throw failed();
  }
}
