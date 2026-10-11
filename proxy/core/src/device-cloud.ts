import type { SecretStore } from "./secret-store.ts";
import type { ControlIdentity } from "./control-capability.ts";
import { MAX_CONTROL_RESPONSE_BYTES, readBoundedJson } from "@uptokey/sync-contract/limits";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export const DEVICE_TOKEN_ACCOUNT = "cloud:device-token";

export async function exchangeDeviceBootstrap(controlPlaneOrigin: string, identity: ControlIdentity, bootstrapToken: string, secrets: SecretStore, fetcher: typeof fetch = fetch, timeoutMs = 8_000): Promise<void> {
  const origin = validatedControlOrigin(controlPlaneOrigin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) throw new Error("device_bootstrap_timeout_invalid");
  const deadline = createDeadline(timeoutMs); const signal = deadline.signal; let response: Response; let parsed;
  try { response = await fetcher(new URL("/device/bootstrap/exchange", origin), { method: "POST", headers: { authorization: `Bearer ${bootstrapToken}`, accept: "application/json" }, redirect: "error", signal }); }
  catch { deadline.clear(); throw new Error(signal.aborted ? "device_bootstrap_exchange_timeout" : "device_bootstrap_exchange_unavailable"); }
  try {
    if (response.status !== 200) { cancelStream(response.body); throw new Error("device_bootstrap_exchange_rejected"); }
    parsed = await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES);
  } finally { deadline.clear(); }
  if (!parsed.ok || !record(parsed.value) || Object.keys(parsed.value).sort().join(",") !== "deviceId,deviceToken") throw new Error(parsed.ok ? "device_bootstrap_response_invalid" : parsed.reason === "too_large" ? "device_bootstrap_response_too_large" : "device_bootstrap_response_invalid");
  const body = parsed.value;
  if (body.deviceId !== identity.deviceId || typeof body.deviceToken !== "string" || !/^utk_device_[A-Za-z0-9_-]{40,}$/.test(body.deviceToken)) throw new Error("device_bootstrap_response_invalid");
  const previous = await secrets.get(DEVICE_TOKEN_ACCOUNT);
  try { await secrets.set(DEVICE_TOKEN_ACCOUNT, body.deviceToken); }
  catch (storeError) {
    try { if (previous === undefined) await secrets.delete(DEVICE_TOKEN_ACCOUNT); else await secrets.set(DEVICE_TOKEN_ACCOUNT, previous); }
    catch (rollbackError) { throw new AggregateError([storeError, rollbackError], "device_token_rollback_failed"); }
    throw storeError;
  }
}


export function validatedControlOrigin(value: string): URL {
  const url = new URL(value);
  const localDevelopment = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!localDevelopment && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("control_plane_origin_invalid");
  return url;
}
