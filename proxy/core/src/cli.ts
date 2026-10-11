#!/usr/bin/env bun
import {parseEmbeddingsCliArguments,type EmbeddingsProfile} from './embeddings-profile.ts';
import {parseVideoCliArguments,type VideoProfile} from "../../../quimera/uptokey/scripts/quimera-video-options.mjs";
import {parseImageCliArguments,type ImageProfile} from "../../../quimera/uptokey/scripts/quimera-image-options.mjs";
import {parseSpeechCliArguments,type SpeechProfile} from './speech-profile.ts';
import {parseTranscriptionCliArguments,type TranscriptionProfile} from './transcription-profile.ts';
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { loadConfig, updateConfig } from "./config.ts";
import type { LinuxPortalSecretStore } from "./linux-portal-secret-store.ts";
import type { MacProtectedSecretStore, NativeSecretStore } from "./secret-store.ts";
import { QuotaLedger } from "./quota-ledger.ts";
import { AnthropicAdapter, CerebrasAdapter, DeepSeekAdapter, GeminiAdapter, GenericOpenAIAdapter, GroqAdapter, MistralAdapter, OllamaAdapter, OpenRouterAdapter, TogetherAdapter, VllmAdapter } from "./adapters.ts";
import { Router } from "./router.ts";
import { streamingAwareHandler } from "./streaming-transport.ts";
import { TokenCalibration } from "./token-calibration.ts";
import { createApp, ensureLocalToken } from "./app.ts";
import { WorkspaceStore } from './workspace/store.ts';
import { GEMINI_FREE_PRIVACY_NOTICE, GEMINI_FREE_PRIVACY_NOTICE_VERSION, geminiPrivacyAccepted } from "./privacy.ts";
import type { ProviderName } from "./types.ts";
import type { ProviderAdapter } from "./types.ts";
import { AllowlistTelemetry } from "./telemetry.ts";
import { ControlCapabilityService } from "./control-capability.ts";
import { createTailnetControlApp, validateTailnetAllowedOrigin, validateTailnetExpectedHost } from "./tailnet-app.ts";
import { enableProvider, MAX_PROVIDER_KEY_LENGTH, reconcileProviderPresence, revokeProvider as revokeProviderLifecycle } from "./provider-lifecycle.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deleteControlIdentity, loadControlIdentity, saveControlIdentity } from "./control-identity.ts";
import { DEVICE_TOKEN_ACCOUNT, exchangeDeviceBootstrap } from "./device-cloud.ts";
import { DeviceConfigPoller } from "./device-poller.ts";
import { enrollFirstDevice } from "./device-enrollment.ts";
import { cleanupKeychainAcceptance, prepareKeychainAcceptance } from "./keychain-acceptance.ts";
import { PACKAGE_VERSION, RELEASE_VERSION } from "./version.ts";
import { claimProxyPid, readLiveProxyPid } from "./daemon-lifecycle.ts";
import { ExactMatchCache, exactCacheEnabled } from "./exact-match-cache.ts";
import { syncStatePath, tokenCalibrationPath, updateTransactionPath } from "./paths.ts";
import { UpdateJournal } from "./update-transaction.ts";
import type { UpdateTransaction } from "./update-transaction.ts";
import { basename, dirname, resolve } from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { localAdminRequest, approveLocalPairing, parsePairingApprovalArgs } from "./local-admin-client.ts";
import { readTerminalSecret } from "./terminal-secret.ts";
import { spawn } from "node:child_process";
import { checkAndStageUpdate } from "./update-client.ts";
import { parseLocalManagementCommand } from "./local-command-contract.ts";
import { ControlOriginLeaseRenewer, publishDeviceControlOrigin } from "./device-control-origin.ts";
import { openBootstrapToken } from "./bootstrap-envelope.ts";
import { ensureDeviceSyncKeypair } from "./sync-envelope.ts";
import { WebAuthnCounterCoordinator } from "./webauthn-counter.ts";
import { collectGeminiUserBudget } from "./provider-input.ts";
import { publicCliFailure } from "./cli-error.ts";
import { runMcpCommand, formatMcpCliFailure } from "./mcp-cli.ts";
import { integrationProfilesForUi, previewIntegrationCopy, doctorIntegrationSummary } from "./integration-profiles.ts";
import { previewSkillInstall, installSkillPackage, loadInstalledManifest, uninstallSkillByManifest, type SkillPackageFixture } from "./skill-install.ts";
import { evaluateOffline, offlineTtlEnabled } from "./offline-policy.ts";
import { createDaemonShutdown } from "./daemon-shutdown.ts";
import { onceEffect } from "./once-effect.ts";
import { containProcessOutput, writeProcessOutput } from "./process-output.ts";
import { shutdownTailnet } from "./tailnet-shutdown.ts";
import { MAX_INFERENCE_REQUEST_BYTES, MAX_LOCAL_CONTROL_REQUEST_BYTES } from "@uptokey/sync-contract/limits";
import { CORE_LICENSE_TEXT } from "./license.ts";
import { configureOptionalProvider, optionalProviderAllowsKeyless, optionalProviderReady } from "./provider-profile.ts";
import { ALL_PROVIDERS, isNamedExperimentalProvider, isOptionalProvider, isProvider, isUserDefinedProvider, NAMED_EXPERIMENTAL_DEFAULTS, OPTIONAL_PROVIDERS } from "./provider-registry.ts";
import { provisionPairedClient, revokePairedClientAsAdministrator } from "./pairing.ts";
import { acceptNamedProviderRisk, NAMED_PROVIDER_RISK_NOTICES } from "./provider-risk.ts";
import { OLLAMA_MODEL_LICENSE_NOTICE } from "./ollama-risk.ts";
import { VLLM_LOCAL_RUNTIME_NOTICE } from "./vllm-risk.ts";
import { assertQuimeraCommand, quimeraControlPlaneOrigin } from "./quimera-runtime.ts";
import { completionScript, isCompletionShell, renderCliHelp, renderVersion } from "./cli-ui.ts";
import { routesToTerminal } from './tui/cli-route.ts';
import { inspectCompositionRuntime, parseBrowserArguments, parseCompositionCliArguments, parseTelemetryCliArguments, type LangGraphCompositionRuntime, type PlaywrightBrowserOptions } from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import type { WorkspaceBrowser } from "./browser-service.ts";
import { filesystemStartOption, createFilesystemProfile } from './filesystem-launch.ts';
import type { WorkspaceServices } from './workspace/runtime.ts';
import type { WorkspaceTelemetryOutbox } from "./workspace/telemetry-outbox.ts";
import type { WorkspaceCompositionHandle } from "./composition-launch.ts";

declare const Bun: { serve(options: { hostname: string; port: number; fetch: (request: Request, server: { timeout(request: Request, seconds: number): void }) => Response | Promise<Response>; idleTimeout?: number; maxRequestBodySize?: number; development?: boolean; error?: (error: unknown) => Response }): { url: URL; stop(closeActiveConnections?: boolean): void } };

const sourceLaunch = /(?:^|[\\/])cli\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? "");
const compiledLaunch = ["uptokey", "uptokey-windows.exe"].includes(basename(process.argv[1] ?? "").toLowerCase());
const cliArguments = process.argv.slice(sourceLaunch || compiledLaunch ? 2 : 1);
const [area, command, argument, ...rest] = cliArguments;
const localManagementCommand = parseLocalManagementCommand(cliArguments);
let secrets!: NativeSecretStore | MacProtectedSecretStore | LinuxPortalSecretStore;
containProcessOutput(stdout);
containProcessOutput(stderr);

async function main(): Promise<void> {
  if (area === 'workspace-context') {
    const { runWorkspaceContextCli } = await import('./workspace-context-cli.ts');
    await runWorkspaceContextCli(cliArguments.slice(1));
    return;
  }
  if (cliArguments.length === 0) {
    if (stdin.isTTY && stdout.isTTY) {
      const { runTui } = await import("./tui/index.ts");
      await runTui([]);
    } else {
      // Piped input is never interpreted as an inference request implicitly.
      usage(0);
    }
    return;
  }
  const helpRequested = cliArguments.includes("--help") || cliArguments.includes("-h");
  const terminalAlias = ['tui','code','forge'].includes(area ?? '');
  if (terminalAlias || routesToTerminal(area,path=>{try{return lstatSync(path).isDirectory()}catch{return false}})) {
    const { runTui } = await import('./tui/index.ts');
    await runTui(terminalAlias ? cliArguments.slice(1) : cliArguments);
    return;
  }
  if (area==='help' && ['tui','code','forge'].includes(command??'')) {
    const { runTui } = await import('./tui/index.ts');
    await runTui(['--help']);
    return;
  }
  if (helpRequested || cliArguments[0] === "help") {
    const topic = cliArguments
      .filter((value) => value !== "help" && value !== "--help" && value !== "-h" && !value.startsWith("--"))
      .slice(0, 2)
      .join(" ") || undefined;
    usage(0, topic);
    return;
  }
  if (cliArguments[0] === "completion") {
    if (!isCompletionShell(cliArguments[1])) throw new Error("completion_shell_invalid: use bash, zsh, fish ou powershell");
    stdout.write(completionScript(cliArguments[1]));
    return;
  }
  if (cliArguments[0] === "--version" || (area === "version" && (!command || command === "--json"))) {
    stdout.write(renderVersion(RELEASE_VERSION, PACKAGE_VERSION, cliArguments.includes("--json")));
    return;
  }
  const gateway = gatewayStartOption(cliArguments);
  const videoProfile = parseVideoCliArguments(cliArguments);
  const imageProfile = parseImageCliArguments(cliArguments);
  const speechProfile = parseSpeechCliArguments(cliArguments);
  const transcriptionProfile = parseTranscriptionCliArguments(cliArguments);
  const embeddingsProfile = parseEmbeddingsCliArguments(cliArguments);
  const browserOptions = browserStartOption(cliArguments);
  const filesystemRoot = filesystemStartOption(cliArguments);
  const telemetry = parseTelemetryCliArguments(cliArguments);
  const composition = parseCompositionCliArguments(cliArguments);
  const compositionRuntime = composition ? inspectCompositionRuntime() : undefined;
  assertQuimeraCommand(cliArguments);
  quimeraControlPlaneOrigin();
  if (area === "models" && command === "install") {
    const {installLocalModelCli} = await import("./local-model-install-cli.ts");
    await installLocalModelCli(argument, rest);
    return;
  }
  if (area === "license" && !command) {
    stdout.write(CORE_LICENSE_TEXT);
    return;
  }
  if (area === "build-identity" && !command) {
    const { compiledBuildIdentity } = await import("./build-identity.ts");
    stdout.write(`${JSON.stringify(compiledBuildIdentity())}\n`);
    return;
  }
  let workspaceBrowser: WorkspaceBrowser | undefined;
  const workspaceFilesystem = filesystemRoot ? await createFilesystemProfile(filesystemRoot) : undefined;
  if (workspaceFilesystem && "diagnostic" in workspaceFilesystem) process.stderr.write(`filesystem profile unavailable: ${workspaceFilesystem.diagnostic}
`);
  if (browserOptions) {
    const { createPlaywrightBrowser } = await import("./gateway-launch.ts");
    workspaceBrowser = await createPlaywrightBrowser(browserOptions);
  }
  const { assertSecretStoreBoundary, createOfficialSecretStore } = await import("./secret-store.ts");
  secrets = createOfficialSecretStore();
  assertSecretStoreBoundary(secrets.securityBoundary());

  if (area === "version" && !command) stdout.write(renderVersion(RELEASE_VERSION, PACKAGE_VERSION));
  else if (area === "proxy" && command === "start") await startProxy(gateway, workspaceBrowser, telemetry?.kind === "start" ? telemetry : undefined, compositionRuntime, workspaceFilesystem, speechProfile, imageProfile, videoProfile, transcriptionProfile, embeddingsProfile);
  else if (telemetry?.kind === "configure") {
    const { configureLangfuseTelemetry } = await import("./telemetry-launch.ts");
    stdout.write(`Destino Langfuse local: ${telemetry.endpoint}\n`);
    stdout.write("--telemetry=langfuse exporta metadados das execuções gravadas; sem conteúdo. A configuração não inicia exportação.\n");
    await configureLangfuseTelemetry(telemetry.endpoint, secrets);
    stdout.write("Langfuse local configurado; chaves armazenadas no cofre. Para ativar no próximo início: start --telemetry=langfuse\n");
  }
  else if (area === "proxy" && command === "login") await loginProxy();
  else if (area === "proxy" && command === "pair" && argument === "approve") await approvePairing(rest);
  else if (area === "proxy" && command === "control-pair" && argument === "approve") await approveControlPairing(rest[0], rest[1]);
  else if (area === "proxy" && command === "control-pair" && argument === "revoke") await revokeControlPairing();
  else if (localManagementCommand?.kind === "provider_add") await addProvider(localManagementCommand.provider);
  else if (localManagementCommand?.kind === "provider_configure_gemini") await configureGemini();
  else if (localManagementCommand?.kind === "provider_configure_optional") await configureOptionalProviderCli(localManagementCommand.provider, localManagementCommand.endpointUrl, localManagementCommand.model);
  else if (localManagementCommand?.kind === "provider_revoke") await revokeProvider(localManagementCommand.provider);
  else if (localManagementCommand?.kind === "client_create") await createLocalClient(localManagementCommand.clientName);
  else if (localManagementCommand?.kind === "client_revoke") await revokeLocalClient(localManagementCommand.clientId);
  else if (localManagementCommand?.kind === "routing_set") await setRouting(localManagementCommand.order);
  else if (area === "update" && command === "apply" && argument) await applyDesktopUpdate(argument);
  else if (area === "update" && command === "check") await checkForUpdate();
  else if (area === "security" && command === "acceptance" && argument === "prepare") stdout.write(`${JSON.stringify(await prepareKeychainAcceptance(secrets))}\n`);
  else if (area === "security" && command === "acceptance" && argument === "cleanup" && rest[0]) await cleanupKeychainAcceptance(secrets, rest[0]);
  else if (area === "start" && (!command || command.startsWith("--"))) await startProxy(gateway, workspaceBrowser, telemetry?.kind === "start" ? telemetry : undefined, compositionRuntime, workspaceFilesystem, speechProfile, imageProfile, videoProfile, transcriptionProfile, embeddingsProfile);
  else if (area === "doctor" && !command) await doctor();
  else if (area === "providers" && !command) await listProviders();
  else if (area === "models" && !command) await listModels();
  else if (area === "integrations" && !command) { stdout.write(`${JSON.stringify(integrationProfilesForUi(), null, 2)}\n`); }
  else if (area === "integrations" && command === "copy" && argument) {
    const preview = previewIntegrationCopy(argument);
    stdout.write(`${preview.display}\n`);
  }
  else if (area === "integrations" && command === "doctor") {
    stdout.write(`${JSON.stringify(doctorIntegrationSummary(), null, 2)}\n`);
  }
  else if (area === "skills" && command === "manifest" && argument) {
    const manifest = await loadInstalledManifest(argument);
    stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
  else if (area === "skills" && command === "uninstall" && argument) {
    const result = await uninstallSkillByManifest(argument);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (area === "skills" && command === "install") {
    const input = await readStdin();
    const pkg = JSON.parse(input) as SkillPackageFixture;
    const targetRoot = argument ?? ".";
    const result = await installSkillPackage(targetRoot, pkg);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  else if (area === "skills" && command === "preview") {
    const input = await readStdin();
    const pkg = JSON.parse(input) as SkillPackageFixture;
    const targetRoot = argument ?? ".";
    const preview = await previewSkillInstall(targetRoot, pkg);
    stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  }
  else if (area === "mcp" && !command) await runMcp();
  else if (area === "tui" || area === "forge" || area === "code") { const { runTui } = await import("./tui/index.ts"); await runTui(cliArguments.slice(1)); }
  else usage();
}

await main().catch((error: unknown) => {
  writeProcessOutput(stderr, `${publicCliFailure(error)}\n`);
  process.exitCode = 1;
});


function proxyNativeError(): Response { return Response.json({ error: { type: "proxy_unavailable" } }, { status: 503, headers: { "cache-control": "no-store" } }); }

/** No gateway is loaded without the exact explicit start option. Validate before opening the vault. */
function gatewayStartOption(args: readonly string[]): "9router" | undefined {
  const options = args.filter(value => /^--gateway/i.test(value));
  if (!options.length) return undefined;
  const startsProxy = args[0] === "proxy" && args[1] === "start" || args[0] === "start" && (!args[1] || args[1].startsWith("--"));
  if (!startsProxy || options.length !== 1 || options[0] !== "--gateway=9router") throw new Error("gateway_start_option_invalid");
  return "9router";
}

/** Reject incomplete/misplaced public browser options before opening the native vault. */
function browserStartOption(args: readonly string[]): PlaywrightBrowserOptions | undefined {
  const options = args.filter(value => /^--browser/i.test(value));
  if (!options.length) return undefined;
  const offset = args[0] === "proxy" && args[1] === "start" ? 2 : args[0] === "start" ? 1 : 0;
  if (!offset || args.slice(offset).some(value => !value.startsWith("--"))) throw new Error("quimera_browser_option_rejected");
  return parseBrowserArguments(options);
}

async function serveLoopbackHttp(options: { port: number; fetch: (request: Request) => Response | Promise<Response>; maxRequestBodySize: number; idleTimeout?: number }): Promise<{ url: URL; stop: (closeActiveConnections?: boolean) => void }> {
  const bunRuntime = (globalThis as { Bun?: { serve: typeof Bun.serve } }).Bun;
  const portInUse = (): Error => new Error(`uptokey_port_in_use:127.0.0.1:${options.port}`);
  const remapBind = (error: Error): Error => (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? portInUse() : error;
  if (bunRuntime?.serve) {
    try {
      return bunRuntime.serve({ hostname: "127.0.0.1", port: options.port, fetch: streamingAwareHandler(options.fetch), idleTimeout: options.idleTimeout ?? 10, maxRequestBodySize: options.maxRequestBodySize, development: false, error: proxyNativeError });
    } catch (error) {
      throw remapBind(error as Error);
    }
  }
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: options.fetch, hostname: "127.0.0.1", port: options.port }, () => {});
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(remapBind(error));
    server.once("error", failed);
    server.once("listening", () => { server.off("error", failed); resolve(); });
  });
  return {
    url: new URL(`http://127.0.0.1:${options.port}/`),
    stop(closeActiveConnections = false) {
      const nodeServer = server as { close?: (cb?: (err?: Error) => void) => void; closeAllConnections?: () => void };
      if (closeActiveConnections && typeof nodeServer.closeAllConnections === "function") nodeServer.closeAllConnections();
      nodeServer.close?.();
    }
  };
}

async function startProxy(gateway?: "9router", workspaceBrowser?: WorkspaceBrowser, telemetry?: import("../../../quimera/uptokey/scripts/quimera-isolation.mjs").TelemetryStart, compositionRuntime?: LangGraphCompositionRuntime, workspaceFilesystem?: WorkspaceServices['filesystem'], speechProfile?: SpeechProfile, imageProfile?: ImageProfile, videoProfile?: VideoProfile, transcriptionProfile?: TranscriptionProfile, embeddingsProfile?: EmbeddingsProfile) {
  // Quimera development never resumes inherited package-update helpers.
  const config = await loadConfig();
  const cache = new ExactMatchCache(secrets); await cache.initialize();
  await reconcileProviderPresence(config, secrets, undefined, cache);
  const ledger = new QuotaLedger();
  await ledger.initialize();
  // Durable estimate-vs-provider calibration (numeric aggregates only; retention on load).
  // Ephemeral dispatches are skipped by retentionMode, never persisted.
  const tokenCalibration = new TokenCalibration({ persistence: { path: tokenCalibrationPath() } });
  await tokenCalibration.initialize();
  const adapters = new Map<ProviderName, ProviderAdapter>([
    ["groq", new GroqAdapter()],
    ["gemini", new GeminiAdapter()],
    ["ollama", new OllamaAdapter(() => config.providers.ollama?.endpointUrl ?? "http://127.0.0.1:11434/v1/chat/completions")],
    ["vllm", new VllmAdapter(() => config.providers.vllm?.endpointUrl ?? "http://127.0.0.1:8000/v1/chat/completions")],
    ["custom", new GenericOpenAIAdapter("custom", () => config.providers.custom?.endpointUrl ?? "https://example.invalid/v1/chat/completions")],
    ["deepseek", new DeepSeekAdapter(() => config.providers.deepseek?.endpointUrl ?? "https://api.deepseek.com/chat/completions")],
    ["mistral", new MistralAdapter(() => config.providers.mistral?.endpointUrl ?? "https://api.mistral.ai/v1/chat/completions")],
    ["cerebras", new CerebrasAdapter(() => config.providers.cerebras?.endpointUrl ?? "https://api.cerebras.ai/v1/chat/completions")],
    ["together", new TogetherAdapter(() => config.providers.together?.endpointUrl ?? "https://api.together.xyz/v1/chat/completions")],
    ["anthropic", new AnthropicAdapter(() => config.providers.anthropic?.endpointUrl ?? "https://api.anthropic.com/v1/messages")],
    ["openrouter", new OpenRouterAdapter(() => config.providers.openrouter?.endpointUrl ?? "https://openrouter.ai/api/v1/chat/completions")]
  ]);
  // UPTOKEY_EXACT_CACHE=off stops new lookups/writes; stored entries stay encrypted and still honour invalidation.
  const router = new Router(config, adapters, secrets, ledger, undefined, new AllowlistTelemetry(), undefined, exactCacheEnabled(process.env) ? cache : undefined, undefined, tokenCalibration);
  await ensureLocalToken(secrets);
  const controlIdentity = await loadControlIdentity();
  const controlPlaneOrigin = quimeraControlPlaneOrigin();
  let poller: DeviceConfigPoller | undefined; let controlCapabilities!: ControlCapabilityService; let stopTailnet: (() => Promise<void>) | undefined;
  const counterCoordinator = new WebAuthnCounterCoordinator(secrets);
  const stopPrivateControl = async () => { const stop = stopTailnet; stopTailnet = undefined; await stop?.(); };
  const ensurePoller = (identity: NonNullable<typeof controlIdentity>) => {
    // Provisioning may follow an expired token or replace the device identity.
    // Start a fresh observer rather than retaining a stopped or differently bound one.
    poller?.stop();
    poller = new DeviceConfigPoller(controlPlaneOrigin, config, secrets, identity, { onRevoked: async () => { await controlCapabilities.revokeAll(); await stopPrivateControl(); }, counterCoordinator, invalidateProviderCache: (provider) => cache.invalidateProvider(provider) });
    poller.start();
  };
  controlCapabilities = new ControlCapabilityService({
    identity: controlIdentity, persistIdentity: saveControlIdentity,
    deleteIdentity: async () => { await deleteControlIdentity(); await secrets.delete(DEVICE_TOKEN_ACCOUNT); await counterCoordinator.clear(); await unlink(syncStatePath()).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); poller?.stop(); poller = undefined; await stopPrivateControl(); },
    persistCounter: controlIdentity ? async (counter) => saveControlIdentity({ ...controlIdentity, credential: { ...controlIdentity.credential, counter } }) : undefined,
    provisionDeviceAuth: async (identity, bootstrapToken) => { await exchangeDeviceBootstrap(controlPlaneOrigin, identity, bootstrapToken, secrets); ensurePoller(identity); }, counterCoordinator
  });
  const workspaceStore = new WorkspaceStore(secrets);
  let workspaceTelemetry: WorkspaceTelemetryOutbox | undefined;
  let workspaceComposition: WorkspaceCompositionHandle | undefined;
  let gatewayProcess: Awaited<ReturnType<typeof import("./gateway-launch.ts").startNineRouterGateway>> | undefined;
  let videoProcess: Awaited<ReturnType<typeof import('./video-profile.ts').startConfiguredVideo>> | undefined;
  let imageProcess: Awaited<ReturnType<typeof import('./image-profile.ts').startConfiguredImage>> | undefined;
  let speechProcess: Awaited<ReturnType<typeof import('./speech-profile.ts').startConfiguredSpeech>> | undefined;
  let embeddingsProcess: Awaited<ReturnType<typeof import('./embeddings-profile.ts').startConfiguredEmbeddings>> | undefined;
  let transcriptionProcess: Awaited<ReturnType<typeof import('./transcription-profile.ts').startConfiguredTranscription>> | undefined;
  let gatewayClosing: Promise<void> | undefined;
  const closeGateway = () => gatewayClosing ??= (async()=>{try{await embeddingsProcess?.close();await speechProcess?.close();}finally{try{await transcriptionProcess?.close();}finally{try{await imageProcess?.close();}finally{try{await videoProcess?.close();}finally{await gatewayProcess?.close();}}}}})();
  let app: ReturnType<typeof createApp> | undefined;
  let releasePid: () => void = () => {}; let server: Awaited<ReturnType<typeof serveLoopbackHttp>> | undefined;
  let startupInterrupted = false;
  const interruptStartup = () => { startupInterrupted = true; };
  const checkStartup = () => { if (startupInterrupted) throw new Error("gateway_start_interrupted"); };
  process.once("SIGTERM", interruptStartup); process.once("SIGINT", interruptStartup);
  try {
    if (compositionRuntime) {
      const { openWorkspaceComposition } = await import("./composition-launch.ts");
      checkStartup();
      workspaceComposition = await openWorkspaceComposition(compositionRuntime.stateRoot);
      checkStartup();
    }
    if (telemetry?.driver === "langfuse") {
      const { createLangfuseTelemetry } = await import("./telemetry-launch.ts");
      workspaceTelemetry = await createLangfuseTelemetry(telemetry.driver, config, secrets, workspaceStore);
      checkStartup();
    }
    if(telemetry?.driver === "collector-local"){const {createCollectorTelemetry}=await import("./telemetry-launch.ts");workspaceTelemetry=await createCollectorTelemetry(telemetry.endpoint,workspaceStore);checkStartup();}
    if (gateway === "9router") {
      const { startNineRouterGateway } = await import("./gateway-launch.ts");
      checkStartup();
      gatewayProcess = await startNineRouterGateway({ config, secrets, ledger, store: workspaceStore });
      checkStartup();
    }
    if(speechProfile){const {startConfiguredSpeech}=await import('./speech-profile.ts');checkStartup();speechProcess=await startConfiguredSpeech(speechProfile,{config,secrets,store:workspaceStore});checkStartup();}
    if(embeddingsProfile){const {startConfiguredEmbeddings}=await import('./embeddings-profile.ts');checkStartup();embeddingsProcess=await startConfiguredEmbeddings(embeddingsProfile,{config,secrets,store:workspaceStore});checkStartup();}
    if(transcriptionProfile){const {startConfiguredTranscription}=await import('./transcription-profile.ts');checkStartup();transcriptionProcess=await startConfiguredTranscription(transcriptionProfile,{config,secrets,store:workspaceStore});checkStartup();}
    if(imageProfile){const {startConfiguredImage}=await import('./image-profile.ts');checkStartup();imageProcess=await startConfiguredImage(imageProfile,{config,secrets,store:workspaceStore});checkStartup();}
    if(videoProfile){const {startConfiguredVideo}=await import('./video-profile.ts');checkStartup();videoProcess=await startConfiguredVideo(videoProfile,{config,secrets,store:workspaceStore});checkStartup();}
    app = createApp(config, router, secrets, undefined, undefined, undefined, controlCapabilities, undefined, undefined, () => controlCapabilities.currentIdentityContext(), undefined, undefined, () => poller?.entitlementObservation(), workspaceStore, undefined, gatewayProcess?.gateway, workspaceBrowser, workspaceTelemetry, workspaceComposition, workspaceFilesystem, speechProcess?.speech, imageProcess?.image, videoProcess?.video, undefined, undefined, undefined, undefined, transcriptionProcess?.transcription, undefined, undefined, embeddingsProcess?.embeddings);
    await app.workspaceReady;
    checkStartup();
    releasePid = claimProxyPid();
    server = await serveLoopbackHttp({ port: 21435, fetch: app.fetch, idleTimeout: 10, maxRequestBodySize: MAX_INFERENCE_REQUEST_BYTES });
    checkStartup();
  } catch (error) {
    try {
      try { server?.stop(true); } finally {
        if (app) await app.closeWorkspace();
        else { try { await workspaceTelemetry?.close(); } finally { await workspaceStore.close(); } }
      }
    } finally {
      try { await workspaceComposition?.close(); } finally { try { await closeGateway(); } finally { releasePid(); } }
    }
    throw error;
  } finally {
    process.off("SIGTERM", interruptStartup); process.off("SIGINT", interruptStartup);
  }
  const activeApp = app, activeServer = server;
  const releasePidOnce = onceEffect(releasePid);
  const shutdown = createDaemonShutdown({
    stopPoller: () => poller?.stop(), stopTailnet: stopPrivateControl, stopServer: async () => {
      try { try { activeServer.stop(true); } finally { await activeApp.closeWorkspace(); } }
      finally { try { await workspaceComposition?.close(); } finally { try { await closeGateway(); } finally { await tokenCalibration.flush(); } } }
    }, releasePid: releasePidOnce,
    exit: (code) => process.exit(code)
  });
  process.once("SIGTERM", () => { void shutdown(); }); process.once("SIGINT", () => { void shutdown(); }); process.once("exit", releasePidOnce);
  try {
    if (controlIdentity && await secrets.get(DEVICE_TOKEN_ACCOUNT)) ensurePoller(controlIdentity);
    // Quimera development does not install or modify global Tailscale mappings.
    stdout.write(`Uptokey proxy ativo em ${activeServer.url.origin}\n`);
    stdout.write("Mini-UI: http://127.0.0.1:21435/ui\n");
    stdout.write("Token administrativo local armazenado no secret store nativo.\n");
    if (workspaceTelemetry) stdout.write(`Langfuse local: ${config.workspaceTelemetry!.endpoint}; metadados das execuções gravadas, sem conteúdo.\n`);
    if (workspaceComposition) stdout.write("Composição LangGraph local ativa; referências e progresso no SQLite isolado. Cada efeito continua sujeito à aprovação W0.\n");
  } catch (error) {
    writeProcessOutput(stderr, `${publicCliFailure(error)}\n`);
    await shutdown(true);
  }
}

async function applyDesktopUpdate(stagedArtifact: string) {
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("O aplicador desktop exige macOS ou Windows.");
  const platform = process.platform === "darwin" ? "macos" : "windows";
  const journalPath = updateTransactionPath(); const transaction = await new UpdateJournal(journalPath).load();
  if (!transaction || transaction.state !== "staged" || transaction.platform !== platform) throw new Error(`Nenhum update ${platform} em staging está pronto para aplicar.`);
  const artifact = resolve(stagedArtifact); if (artifact !== transaction.artifactPath || !existsSync(artifact) || !lstatSync(artifact).isFile() || lstatSync(artifact).isSymbolicLink() || basename(artifact) !== transaction.artifactName) throw new Error("Artefato staged não corresponde à transação.");
  const daemonPid = readLiveProxyPid(); const token = await secrets.get("local:api-token"); if (!token) throw new Error("local_admin_token_missing");
  const authorized = await localAdminRequest("/local/update/authorize-stop", token, { pid: daemonPid }); if (authorized !== 204) throw new Error(`update_daemon_stop_refused_${authorized}`);
  spawnUpdateHelper(transaction, daemonPid); stdout.write(`Update ${transaction.toVersion} entregue ao helper assinado; aguardando health e rollback automático se necessário.\n`);
}

async function checkForUpdate() { const result = await checkAndStageUpdate({ currentVersion: RELEASE_VERSION }); stdout.write(`Update ${result.transaction.toVersion} verificado e staged em ${result.artifactPath}.\nExecute: uptokey update apply ${result.artifactPath}\n`); }

async function handoffInterruptedUpdate(): Promise<boolean> {
  if (process.platform !== "darwin" && process.platform !== "win32") return false; const journal = new UpdateJournal(updateTransactionPath()); const transaction = await journal.load(); if (!transaction) return false;
  const updateChild = process.argv.find((value) => value.startsWith("--update-child="))?.slice(15); const rollbackChild = process.argv.find((value) => value.startsWith("--rollback-child="))?.slice(17);
  if (updateChild === transaction.id && ["installing", "awaiting-health"].includes(transaction.state) && transaction.toVersion === RELEASE_VERSION) {
    if (transaction.state === "installing") await journal.recordCandidatePid(process.pid);
    else if (transaction.candidatePid !== process.pid) throw new Error("Update child PID não corresponde à transação.");
    return false;
  }
  if (rollbackChild === transaction.id && transaction.state === "rolling-back" && transaction.fromVersion === RELEASE_VERSION) return false;
  if (!["installing", "awaiting-health", "rolling-back"].includes(transaction.state)) return false;
  const platform = process.platform === "darwin" ? "macos" : "windows"; if (transaction.platform !== platform) throw new Error("Update interrompido pertence a outra plataforma."); spawnUpdateHelper(transaction, process.pid); stdout.write(`Recovery do update ${transaction.id} entregue ao helper; o proxy aguardará rollback antes de reiniciar.\n`); return true;
}

function spawnUpdateHelper(transaction: UpdateTransaction, oldPid: number): void { const platform = process.platform === "darwin" ? "macos" : "windows"; const executable = resolve(process.execPath); const installed = platform === "macos" ? resolve(dirname(executable), "..", "..") : executable; const helper = platform === "macos" ? resolve(dirname(executable), "..", "Helpers", "uptokey-update-helper") : resolve(dirname(executable), "uptokey-update-helper.exe"); if ((platform === "macos" ? basename(installed) !== "Uptokey.app" : basename(installed).toLowerCase() !== "uptokey-windows.exe") || !existsSync(helper) || !lstatSync(helper).isFile() || lstatSync(helper).isSymbolicLink()) throw new Error("Helper assinado não encontrado no pacote instalado."); const child = spawn(helper, [updateTransactionPath(), transaction.artifactPath, installed, String(oldPid)], { detached: true, stdio: "ignore", windowsHide: true }); child.unref(); if (!child.pid) throw new Error("Não foi possível iniciar o helper de update."); }

async function loginProxy() {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const existingIdentity = await loadControlIdentity();
    if (existingIdentity && await secrets.get(DEVICE_TOKEN_ACCOUNT)) {
      stdout.write(`Este proxy já está conectado como ${existingIdentity.deviceId}.\n`);
      return;
    }
    const controlPlaneOrigin = quimeraControlPlaneOrigin();
    const identity = await enrollFirstDevice({
      controlPlaneOrigin, dashboardOrigin: process.env.UPTOKEY_DASHBOARD_ORIGIN, secrets, proxyVersion: PACKAGE_VERSION, signal: controller.signal, openExternal: (url) => openExternal(url, controller.signal),
      onStarted: ({ userCode, verificationUri, expiresAt }) => {
        stdout.write(`Abra ${verificationUri}\n`);
        stdout.write(`Código de uso único: ${userCode}\n`);
        stdout.write(`Expira em ${new Date(expiresAt).toLocaleTimeString()}. Aguardando confirmação por passkey…\n`);
      }
    });
    stdout.write(`Proxy conectado com segurança como ${identity.deviceId}. O token final foi salvo no secret store nativo.\n`);
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}

async function openExternal(url: string, signal?: AbortSignal): Promise<void> {
  const run = promisify(execFile);
  if (process.platform === "win32") await run("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, timeout: 10_000, signal });
  else if (process.platform === "darwin") await run("open", [url], { windowsHide: true, timeout: 10_000, signal });
  else await run("xdg-open", [url], { windowsHide: true, timeout: 10_000, signal });
}

async function startTailnetControl(config: Awaited<ReturnType<typeof loadConfig>>, capabilities: ControlCapabilityService, ledger: QuotaLedger) {
  const dashboardOrigin = process.env.UPTOKEY_DASHBOARD_ORIGIN;
  let allowedOrigin: string;
  try { allowedOrigin = validateTailnetAllowedOrigin(dashboardOrigin ?? ""); }
  catch {
    stdout.write("Controle Tailscale desativado com segurança: UPTOKEY_DASHBOARD_ORIGIN HTTPS não configurada.\n");
    return;
  }
  try {
    const run = promisify(execFile);
    const { stdout: statusJson } = await run("tailscale", ["status", "--json"], { windowsHide: true, timeout: 10_000 });
    const status = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (!dnsName?.endsWith(".ts.net")) throw new Error("tailscale_magicdns_unavailable");
    const expectedHost = validateTailnetExpectedHost(`${dnsName}:21436`);
    const privateOrigin = `https://${expectedHost}`;
    const control = createTailnetControlApp({ expectedHost, allowedOrigin, config, secrets, capabilities, ledger,
      openBootstrapEnvelope: async (envelope, context) => openBootstrapToken(envelope, { ...context, recipientPrivateKey: (await ensureDeviceSyncKeypair(secrets)).privateKey }) });
    const controlServer = await serveLoopbackHttp({ port: 21436, fetch: control.fetch, idleTimeout: 10, maxRequestBodySize: MAX_LOCAL_CONTROL_REQUEST_BYTES });
    let serveConfigured = false;
    try {
      await run("tailscale", ["serve", "--bg", "--https=21436", "http://127.0.0.1:21436"], { windowsHide: true, timeout: 30_000 });
      serveConfigured = true;
      await publishDeviceControlOrigin({ controlPlaneOrigin: quimeraControlPlaneOrigin(), controlOrigin: privateOrigin, secrets });
    } catch (error) {
      await shutdownTailnet({ stopLease: () => undefined, stopListener: () => controlServer.stop(true),
        removeServe: () => serveConfigured ? run("tailscale", ["serve", "--bg", "--https=21436", "off"], { windowsHide: true, timeout: 30_000 }) : undefined }).catch(() => undefined);
      throw error;
    }
    const lease = new ControlOriginLeaseRenewer({ controlPlaneOrigin: quimeraControlPlaneOrigin(), controlOrigin: privateOrigin, secrets });
    lease.start();
    stdout.write(`Controle privado ativo em ${privateOrigin} (origem permitida: ${allowedOrigin}).\n`);
    return async () => shutdownTailnet({ stopLease: () => lease.stop(), stopListener: () => controlServer.stop(true),
      removeServe: () => run("tailscale", ["serve", "--bg", "--https=21436", "off"], { windowsHide: true, timeout: 30_000 }) });
  } catch (error) {
    const reason = error instanceof Error && /magicdns/i.test(error.message) ? "MagicDNS indisponível" : "Tailscale não instalado/conectado";
    stdout.write(`Controle Tailscale desativado com segurança: ${reason}. Inferência localhost continua ativa.\n`);
  }
}


async function addProvider(provider: ProviderName) {
  const config = await loadConfig();
  if (provider === "ollama" || provider === "vllm") {
    stdout.write(`${provider === "ollama" ? OLLAMA_MODEL_LICENSE_NOTICE : VLLM_LOCAL_RUNTIME_NOTICE}\n`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const accepted = (await rl.question("Digite ACEITO para confirmar que verificará a licença do modelo: ")).trim();
      if (accepted !== "ACEITO") { stdout.write(`${provider} não foi ativado.\n`); return; }
    } finally { rl.close(); }
    await enableProvider(provider, "", secrets, undefined, { invalidateProvider: invalidateProviderCache });
    await reloadRunningProxy();
    const latest = await loadConfig();
    const endpoint = provider === "ollama"
      ? (latest.providers.ollama?.endpointUrl ?? "http://127.0.0.1:11434/v1/chat/completions")
      : (latest.providers.vllm?.endpointUrl ?? "http://127.0.0.1:8000/v1/chat/completions");
    stdout.write(`${provider} ativado localmente em ${endpoint} sem chave no cofre.\n`);
    return;
  }
  if (provider === "custom") {
    if (!optionalProviderReady(config, "custom")) {
      stdout.write("Configure primeiro: uptokey provider configure custom <https://endpoint/v1/chat/completions> <modelo>\n");
      process.exitCode = 2;
      return;
    }
  }
  if (isNamedExperimentalProvider(provider)) {
    const { configureNamedExperimentalDefaults } = await import("./provider-profile.ts");
    const notice = NAMED_PROVIDER_RISK_NOTICES[provider];
    stdout.write(`${notice.summary}\n`);
    stdout.write(`Fonte oficial (${notice.reviewedAt}): ${notice.sourceUrl}\n`);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const accepted = (await rl.question("Digite ACEITO para registrar este aviso e continuar: ")).trim();
      if (accepted !== "ACEITO") { stdout.write(`${provider} não foi ativado.\n`); return; }
    } finally { rl.close(); }
    await updateConfig((current) => {
      if (!current.providers[provider]) configureNamedExperimentalDefaults(current, provider);
      acceptNamedProviderRisk(current.providers[provider]!, provider);
    });
    stdout.write(`Canal ${provider} tier 3 user-managed; não é suporte oficial.\n`);
  }
  const latest = await loadConfig();
  if (provider === "gemini" && !geminiPrivacyAccepted(latest.providers.gemini.privacyAcceptedAt, latest.providers.gemini.privacyNoticeVersion)) {
    stdout.write(`${GEMINI_FREE_PRIVACY_NOTICE}\n`);
    stdout.write("Execute primeiro: uptokey provider configure gemini\n");
    process.exitCode = 2;
    return;
  }
  const allowKeyless = isOptionalProvider(provider) && optionalProviderAllowsKeyless(latest, provider);
  const key = await readTerminalSecret(allowKeyless ? `Chave ${provider} (vazio para endpoint local sem autenticação): ` : `Chave ${provider}: `, MAX_PROVIDER_KEY_LENGTH);
  if (!key.trim() && !allowKeyless) throw new Error("A chave não pode ser vazia.");
  await enableProvider(provider, key, secrets, undefined, { invalidateProvider: invalidateProviderCache }, allowKeyless);
  await reloadRunningProxy();
  stdout.write(`${provider} ativado localmente. A chave não foi enviada à Cloud.\n`);
}

async function configureGemini() {
  stdout.write(`${GEMINI_FREE_PRIVACY_NOTICE}\n\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const accepted = (await rl.question("Digite ACEITO para continuar: ")).trim();
    if (accepted !== "ACEITO") { stdout.write("Gemini não foi ativado.\n"); return; }
    const budget = await collectGeminiUserBudget((prompt) => rl.question(prompt));
    const privacyAcceptedAt = new Date().toISOString();
    await updateConfig((current) => { current.providers.gemini.budget = budget; current.providers.gemini.privacyAcceptedAt = privacyAcceptedAt; current.providers.gemini.privacyNoticeVersion = GEMINI_FREE_PRIVACY_NOTICE_VERSION; });
    await reloadRunningProxy();
    stdout.write("Aviso aceito e orçamento conservador salvo localmente. Agora adicione a chave.\n");
  } finally { rl.close(); }
}

async function configureOptionalProviderCli(provider: import("./types.ts").OptionalProviderName, endpointUrl: string, model: string) {
  await invalidateProviderCache(provider);
  await updateConfig((config) => configureOptionalProvider(config, provider, endpointUrl, model));
  await reloadRunningProxy();
  if (isNamedExperimentalProvider(provider)) {
    stdout.write(`${NAMED_PROVIDER_RISK_NOTICES[provider].summary}\n`);
    stdout.write(`${provider} configurado como preset tier 3 user-managed; execute provider add e aceite o aviso antes de ativar.\n`);
  } else {
    const tier = provider === "ollama" || provider === "vllm" ? "tier 2 experimental" : "tier 3 custom";
    stdout.write(`${provider} configurado como ${tier}. Endpoint e modelo foram salvos; segredos continuam somente no cofre nativo.\n`);
  }
}

async function createLocalClient(clientName: string) {
  const paired = await provisionPairedClient(secrets, clientName);
  stdout.write(`Cliente local criado: ${paired.clientName}\nclientId=${paired.clientId}\ntoken=${paired.token}\n`);
  stdout.write("O token aparece uma única vez; ele autoriza somente inferência localhost. Revogue com: uptokey client revoke <clientId>\n");
}

async function revokeLocalClient(clientId: string) {
  await revokePairedClientAsAdministrator(secrets, clientId);
  stdout.write(`Cliente local ${clientId} revogado neste dispositivo.\n`);
}

async function revokeProvider(provider: ProviderName) {
  await revokeProviderLifecycle(provider, secrets, undefined, { invalidateProvider: invalidateProviderCache });
  await reloadRunningProxy();
  stdout.write(`${provider} revogado neste device. Para efeito imediato em device perdido, revogue também no console do provider.\n`);
}

async function invalidateProviderCache(provider: ProviderName): Promise<void> {
  if (hasLiveProxy()) {
    const token = await secrets.get("local:api-token"); if (!token) throw new Error("local_admin_token_missing");
    const status = await localAdminRequest(`/local/cache/invalidate/${provider}`, token);
    if (status !== 204) throw new Error(`cache_invalidation_failed_${status}`);
    return;
  }
  const cache = new ExactMatchCache(secrets); await cache.initialize(); await cache.invalidateProvider(provider);
}

function hasLiveProxy(): boolean {
  try { readLiveProxyPid(); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "proxy_not_running") return false;
    throw error;
  }
}

async function approvePairing(args: readonly string[]) {
  const approval = parsePairingApprovalArgs(args);
  const token = await secrets.get("local:api-token");
  if (!token) throw new Error("Token administrativo local ausente. Inicie o proxy primeiro.");
  await approveLocalPairing("/local/pair/approve", token, approval);
  stdout.write("Cliente aprovado localmente. Ele já pode consumir o token uma única vez.\n");
}

async function approveControlPairing(id?: string, userCode?: string) {
  if (!id || !userCode) throw new Error("Use: uptokey proxy control-pair approve <challenge-id> <codigo>");
  const token = await secrets.get("local:api-token");
  if (!token) throw new Error("Token administrativo local ausente. Inicie o proxy primeiro.");
  await approveLocalPairing("/local/control-pair/approve", token, { id, userCode });
  stdout.write("Dashboard aprovado localmente por 10 minutos; a capability não autoriza inferência.\n");
}

async function revokeControlPairing() {
  const token = await secrets.get("local:api-token");
  if (!token) throw new Error("Token administrativo local ausente. Inicie o proxy primeiro.");
  const status = await localAdminRequest("/local/control-pair/revoke", token);
  if (status !== 204) throw new Error(`Revogação do controle falhou (${status}).`);
  stdout.write("Pareamento do dashboard revogado; capabilities invalidadas. Chaves de provider foram preservadas.\n");
}

async function setRouting(value: string) {
  const order = value.split(",").map((item) => item.trim());
  if (order.length < 2 || order.length > ALL_PROVIDERS.length || new Set(order).size !== order.length || !order.every(isProvider)) {
    throw new Error(`Use de 2 a ${ALL_PROVIDERS.length} providers sem repeticao: ${ALL_PROVIDERS.join(", ")}.`);
  }
  await updateConfig((config) => {
    for (const provider of order) if (isOptionalProvider(provider) && !config.providers[provider]) throw new Error(`Configure ${provider} antes de inclui-lo na rota.`);
    config.fallbackOrder = order;
  });
  await reloadRunningProxy();
  stdout.write(`Ordem de fallback salva localmente: ${order.join(" → ")}\n`);
}

async function reloadRunningProxy(): Promise<void> {
  const token = await secrets.get("local:api-token");
  if (!token) return;
  try {
    const status = await localAdminRequest("/local/config/reload", token);
    if (status === 204) return;
  } catch { /* daemon parado ou indisponível: a revisão será carregada no próximo startup */ }
  stdout.write("Configuração salva; reinicie o proxy para aplicar esta revisão.\n");
}



async function runMcp(): Promise<void> {
  try {
    await runMcpCommand();
  } catch (error) {
    writeProcessOutput(stderr, `${formatMcpCliFailure(error)}\n`);
    process.exitCode = 1;
  }
}

async function doctor(): Promise<void> {
  const lines: string[] = [];
  lines.push(`uptokey ${RELEASE_VERSION}`);
  lines.push("proxy_expected_host 127.0.0.1:21435");
  lines.push("openai_compatible_base http://127.0.0.1:21435/v1");
  try {
    const boundary = secrets.securityBoundary(); lines.push(`secret_store ${boundary.mechanism} native=${boundary.native} app_bound=${boundary.applicationBound}`);
  } catch (error) {
    lines.push(`secret_store_error ${publicCliFailure(error)}`);
  }
  try {
    const config = await loadConfig();
    const enabled = Object.values(config.providers).filter((p) => p?.enabled).map((p) => p.name);
    lines.push(`providers_configured ${Object.keys(config.providers).length}`);
    lines.push(`providers_enabled ${enabled.length ? enabled.join(",") : "(none)"}`);
    lines.push(`fallback_order ${config.fallbackOrder.join(",")}`);
    const offline = evaluateOffline(config);
    lines.push(`offline_ttl ${offlineTtlEnabled() ? "on" : "disabled_dev"}`);
    // The TTL is a control-plane synchronization signal, not a BYOK
    // inference gate. The HTTP inference routes intentionally allow the
    // expired-grace state while still enforcing revocation/suspension.
    lines.push(`offline_sync ${offline.allowed ? `current remaining_ms=${offline.remainingMs ?? 0}` : `stale code=${offline.code}`}`);
    if (!offline.allowed && offline.code === "offline_grace_expired") {
      lines.push(enabled.length
        ? `offline_inference BYOK_allowed; enabled=${enabled.join(",")}`
        : "offline_inference BYOK_allowed; configure/enable a provider before sending");
    }
    if (!enabled.length) {
    lines.push("provider_hint open the TUI, use /conexoes, choose a provider, then select a discovered model");
    }
  } catch (error) {
    lines.push(`config_error ${publicCliFailure(error)}`);
  }
  try {
    const live = await readLiveProxyPid();
    lines.push(live ? `proxy_pid ${live}` : "proxy_pid (not running)");
  } catch {
    lines.push("proxy_pid (unknown)");
  }
  stdout.write(lines.join("\n") + "\n");
}

async function listProviders(): Promise<void> {
  const config = await loadConfig();
  const rows = ALL_PROVIDERS.map((name) => {
    const entry = config.providers[name];
    const state = !entry ? "absent" : entry.enabled ? "enabled" : entry.configured ? "configured" : "present";
    return `${name}\t${state}`;
  });
  const custom = Object.keys(config.providers).filter((name) => isUserDefinedProvider(name));
  for (const name of custom) {
    const entry = (config.providers as Record<string, typeof config.providers.groq>)[name];
    const state = entry?.enabled ? "enabled" : entry?.configured ? "configured" : "present";
    rows.push(`${name}\t${state}`);
  }
  stdout.write(["provider\tstate", ...rows].join("\n") + "\n");
}

async function listModels(): Promise<void> {
  const config = await loadConfig();
  const lines: string[] = ["provider\tmodel\tdefault"];
  for (const [name, entry] of Object.entries(config.providers)) {
    if (!entry) continue;
    for (const model of entry.models) {
      lines.push(`${name}\t${model}\t${model === entry.defaultModel ? "yes" : "no"}`);
    }
  }
  stdout.write(lines.join("\n") + "\n");
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function usage(exitCode = 1, topic?: string) {
  stdout.write(renderCliHelp(topic));
  process.exitCode = exitCode;
}
