import { parseTailnetControlOrigin } from "@uptokey/sync-contract/tailnet-origin";
import { DEVICE_TOKEN_ACCOUNT, validatedControlOrigin } from "./device-cloud.ts";
import type { SecretStore } from "./secret-store.ts";
import { TAILNET_CONTROL_ORIGIN_RENEW_MS } from "@uptokey/sync-contract/tailnet-origin";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export async function publishDeviceControlOrigin(options: {
  controlPlaneOrigin: string;
  controlOrigin: string;
  secrets: SecretStore;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const controlPlane = validatedControlOrigin(options.controlPlaneOrigin);
  const controlOrigin = parseTailnetControlOrigin(options.controlOrigin);
  if (!controlOrigin) throw new Error("tailnet_control_origin_invalid");
  const deviceToken = await options.secrets.get(DEVICE_TOKEN_ACCOUNT);
  if (!deviceToken || !/^utk_device_[A-Za-z0-9_-]{40,}$/.test(deviceToken)) throw new Error("device_auth_required_for_tailnet_publish");
  const deadline = createDeadline(8_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(new URL("/device/control-origin", controlPlane), {
      method: "PUT", redirect: "error", cache: "no-store", signal,
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ controlOrigin }),
    });
  } catch {
    if (options.signal?.aborted) throw new Error("tailnet_control_origin_publish_cancelled");
    throw new Error(deadline.signal.aborted ? "tailnet_control_origin_publish_timeout" : "tailnet_control_origin_publish_unavailable");
  } finally { deadline.clear(); }
  cancelStream(response.body);
  if (response.status !== 204) throw new Error(`tailnet_control_origin_publish_rejected:${response.status}`);
}

export class ControlOriginLeaseRenewer {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: AbortController;
  private generation = 0;
  private stopped = true;
  private readonly options: Parameters<typeof publishDeviceControlOrigin>[0];
  private readonly intervalMs: number;
  constructor(options: Parameters<typeof publishDeviceControlOrigin>[0], intervalMs: number = TAILNET_CONTROL_ORIGIN_RENEW_MS) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > TAILNET_CONTROL_ORIGIN_RENEW_MS) throw new Error("tailnet_lease_interval_invalid");
    this.options = options; this.intervalMs = intervalMs;
  }
  start(): void { if (!this.stopped) return; this.stopped = false; this.generation += 1; this.schedule(this.generation); }
  stop(): void { this.stopped = true; this.generation += 1; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.inFlight?.abort(new Error("tailnet_lease_stopped")); }
  async renewOnce(): Promise<void> {
    if (this.inFlight) throw new Error("tailnet_lease_renewal_in_progress");
    const controller = new AbortController(); this.inFlight = controller;
    try { await publishDeviceControlOrigin({ ...this.options, signal: controller.signal }); }
    finally { if (this.inFlight === controller) this.inFlight = undefined; }
  }
  private schedule(generation: number): void {
    this.timer = setTimeout(async () => {
      if (this.stopped || generation !== this.generation) return;
      try { await this.renewOnce(); } catch { /* lease expira no control plane se a renovação continuar falhando */ }
      if (!this.stopped && generation === this.generation) this.schedule(generation);
    }, this.intervalMs);
  }
}
