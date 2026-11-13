import { setTimeout as waitForStarterVerification } from "node:timers/promises";
import type { Context, Hono } from "hono";
import type { ConnectionProfileService } from "./connection-profiles.ts";
import { DEFAULT_OLLAMA_CHAT_ENDPOINT, discoverLocalModels, probeDefaultOllamaChat } from "./local-model-discovery.ts";
import { OLLAMA_STARTER_MODEL } from "./local-runtime/ollama-chat-control.ts";
import type { InstallJobSnapshot, ModelInstallJobService } from "./model-install-jobs.ts";
import type { ProxyConfig } from "./types.ts";

export const STARTER_DOWNLOAD_PATH = "/local/provider/setup/starter-download";
const STARTER_DOWNLOAD_BYTES = 523_000_000;
const activeStates = new Set(["queued", "downloading", "verifying"]);
const hasStarter = (inventory: Awaited<ReturnType<typeof discoverLocalModels>>) =>
  inventory.models.some(model => model.name === OLLAMA_STARTER_MODEL);

type StarterDownloadDeps = {
  authority(c: Context): Promise<string | null>;
  profiles: Pick<ConnectionProfileService, "list">;
  installs: ModelInstallJobService;
  getConfig(): ProxyConfig;
  checkRate(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number };
  fetchImpl?: typeof fetch;
};

/** The paired shell can operate only the fixed starter, never arbitrary jobs or registry tags. */
export function registerStarterDownloadRoutes(app: Hono, deps: StarterDownloadDeps): void {
  async function eligible() {
    const ollama = deps.getConfig().providers.ollama;
    return deps.installs.supportsDefaultStarter() && !ollama?.configured &&
      (ollama?.endpointUrl ?? DEFAULT_OLLAMA_CHAT_ENDPOINT) === DEFAULT_OLLAMA_CHAT_ENDPOINT &&
      !(await deps.profiles.list()).some(profile => profile.providerId === "ollama");
  }
  function project(c: Context, state: string, job?: InstallJobSnapshot) {
    return c.json({ modelId: OLLAMA_STARTER_MODEL, state, sizeBytes: job?.sizeBytes ?? STARTER_DOWNLOAD_BYTES,
      ...(job ? { downloadedBytes: job.downloadedBytes } : {}) });
  }
  async function verifyInstalled(c: Context, completedDownload: boolean) {
    const signal = c.req.raw.signal;
    let status = await probeDefaultOllamaChat(OLLAMA_STARTER_MODEL, signal, deps.fetchImpl);
    if (completedDownload && status === "retryable") {
      await waitForStarterVerification(150, undefined, { signal });
      status = await probeDefaultOllamaChat(OLLAMA_STARTER_MODEL, signal, deps.fetchImpl);
    }
    signal.throwIfAborted();
    if (status === "verified") return project(c, "available");
    return project(c, completedDownload ? "verification-unavailable" : "unavailable");
  }
  const handle = (action: "read" | "download" | "cancel") => async (c: Context) => {
    c.header("Cache-Control", "no-store");
    const owner = await deps.authority(c);
    if (!owner?.startsWith("refresh:")) return c.json({ error: { type: "unauthorized" } }, 401);
    const decision = deps.checkRate("starter-download:" + action, action === "read" ? 120 : 8, 60_000);
    if (!decision.ok) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfter))));
      return c.json({ error: { type: "rate_limited" } }, 429);
    }
    try {
      if (action === "cancel") {
        const job = await deps.installs.cancelStarter();
        // A finished download still needs to pass the separate activation flow.
        return job && job.state !== "ready" ? project(c, job.state, job) : project(c, "unavailable");
      }
      if (!await eligible()) return project(c, "unavailable");
      const job = await deps.installs.getStarter();
      if (job && activeStates.has(job.state)) return project(c, job.state, job);
      const signal = c.req.raw.signal;
      const inspect = () => discoverLocalModels(signal, deps.fetchImpl, DEFAULT_OLLAMA_CHAT_ENDPOINT);
      const inventory = await inspect();
      signal.throwIfAborted();
      if (inventory.status === "unreachable") return project(c, "runtime-unreachable");
      if (inventory.status !== "available") return project(c, job?.state === "ready" ? "verification-unavailable" : "unavailable");
      if (hasStarter(inventory)) return await verifyInstalled(c, job?.state === "ready");
      if (action === "read") {
        const state = job && ["failed", "cancelled", "interrupted"].includes(job.state) ? job.state : "downloadable";
        return project(c, state, job?.state === "ready" ? undefined : job);
      }
      if (await deps.authority(c) !== owner) return c.json({ error: { type: "unauthorized" } }, 401);
      if (!await eligible() || signal.aborted) return project(c, "unavailable");
      const started = await deps.installs.startStarter(async () => {
        const latest = await inspect();
        return latest.status === "available" && !hasStarter(latest) &&
          await deps.authority(c) === owner && await eligible() && !signal.aborted;
      });
      if (started.state === "ready") {
        if (await deps.authority(c) !== owner) return c.json({ error: { type: "unauthorized" } }, 401);
        if (!await eligible()) return project(c, "unavailable");
        return await verifyInstalled(c, true);
      }
      return project(c, started.state, started);
    } catch {
      return c.json({ error: { type: "starter_download_unavailable" } }, 503);
    }
  };
  app.get(STARTER_DOWNLOAD_PATH, handle("read"));
  app.post(STARTER_DOWNLOAD_PATH, handle("download"));
  app.post(STARTER_DOWNLOAD_PATH + "/cancel", handle("cancel"));
}
