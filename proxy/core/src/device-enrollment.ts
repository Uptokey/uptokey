import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { ControlIdentity } from "./control-capability.ts";
import { assertControlIdentity, saveControlIdentity } from "./control-identity.ts";
import { DEVICE_TOKEN_ACCOUNT, validatedControlOrigin } from "./device-cloud.ts";
import type { SecretStore } from "./secret-store.ts";
import { ensureDeviceSyncKeypair } from "./sync-envelope.ts";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { MAX_CONTROL_RESPONSE_BYTES, readBoundedJson } from "@uptokey/sync-contract/limits";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

interface EnrollmentStartResponse { deviceCode: string; userCode: string; deviceId: string; expiresAt: string; verificationUri: string }
interface EnrollmentIssuedResponse extends ControlIdentity { status: "issued"; deviceToken: string }
const ENROLLMENT_MAX_TTL_MS = 5 * 60_000;

export async function enrollFirstDevice(options: {
  controlPlaneOrigin: string;
  dashboardOrigin?: string;
  secrets: SecretStore;
  proxyVersion: string;
  fetcher?: typeof fetch;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  deviceName?: string;
  openExternal?: (url: string) => Promise<void>;
  onStarted?: (value: { userCode: string; verificationUri: string; expiresAt: string }) => void;
  persistIdentity?: (identity: ControlIdentity) => Promise<void>;
  requestTimeoutMs?: number;
}): Promise<ControlIdentity> {
  const origin = validatedControlOrigin(options.controlPlaneOrigin);
  const verificationOrigin = expectedVerificationOrigin(origin, options.dashboardOrigin);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  assertEnrollmentActive(options.signal);
  const pair = await ensureDeviceSyncKeypair(options.secrets);
  assertEnrollmentActive(options.signal);
  const startRequest = await enrollmentFetch(fetcher, new URL("/enroll/device", origin), {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, cache: "no-store", redirect: "error",
    body: JSON.stringify({ publicKey: pair.publicKey, fingerprint: `sha256:${createHash("sha256").update(pair.publicKey).digest("base64url")}`, name: (options.deviceName ?? hostname()).slice(0, 80), proxyVersion: options.proxyVersion })
  }, "start", options.signal, options.requestTimeoutMs);
  let started: Partial<EnrollmentStartResponse>;
  try {
    if (startRequest.response.status !== 201) { cancelStream(startRequest.response.body); throw new Error(`device_enrollment_start_rejected:${startRequest.response.status}`); }
    started = await enrollmentJson(startRequest.response, "start") as Partial<EnrollmentStartResponse>;
  } finally { startRequest.clear(); }
  assertEnrollmentActive(options.signal);
  const acceptedAt = now(); const acceptedMonotonic = monotonicNow();
  if (!validStart(started, verificationOrigin, acceptedAt) || !validMonotonic(acceptedMonotonic)) throw new Error("device_enrollment_start_invalid");
  options.onStarted?.({ userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: started.expiresAt });
  await options.openExternal?.(started.verificationUri).catch(() => undefined);
  assertEnrollmentActive(options.signal);

  const expiresAt = Date.parse(started.expiresAt);
  const monotonicDeadline = acceptedMonotonic + Math.min(ENROLLMENT_MAX_TTL_MS, expiresAt - acceptedAt);
  while (true) {
    const observedCivil = now(); const observedMonotonic = monotonicNow();
    if (!validCivil(observedCivil) || observedCivil >= expiresAt || !validMonotonic(observedMonotonic) || observedMonotonic >= monotonicDeadline) break;
    assertEnrollmentActive(options.signal);
    const request = await enrollmentFetch(fetcher, new URL("/enroll/token", origin), { method: "POST", headers: { authorization: `Bearer ${started.deviceCode}`, accept: "application/json" }, cache: "no-store", redirect: "error" }, "exchange", options.signal, options.requestTimeoutMs);
    let exchangeStatus: number; let exchangeBody: unknown;
    try {
      exchangeStatus = request.response.status;
      if (exchangeStatus !== 200 && exchangeStatus !== 202) { cancelStream(request.response.body); throw new Error(`device_enrollment_exchange_rejected:${exchangeStatus}`); }
      exchangeBody = await enrollmentJson(request.response, "exchange");
    } finally { request.clear(); }
    if (exchangeStatus === 202) { assertEnrollmentActive(options.signal); if (!validPending(exchangeBody)) throw new Error("device_enrollment_exchange_invalid"); const civilRemaining = Math.max(0, expiresAt - now()); const monotonicRemaining = Math.max(0, monotonicDeadline - monotonicNow()); await waitForEnrollment(Math.min(2_000, civilRemaining, monotonicRemaining), options.sleep, options.signal); continue; }
    const issued = exchangeBody as Partial<EnrollmentIssuedResponse>;
    assertEnrollmentActive(options.signal);
    if (!validIssued(issued, started.deviceId)) throw new Error("device_enrollment_exchange_invalid");
    const identity: ControlIdentity = { tenantId: issued.tenantId, deviceId: issued.deviceId, expectedOrigin: issued.expectedOrigin, expectedRPID: issued.expectedRPID, credential: issued.credential };
    await options.secrets.set(DEVICE_TOKEN_ACCOUNT, issued.deviceToken);
    try { assertEnrollmentActive(options.signal); await (options.persistIdentity ?? saveControlIdentity)(identity); }
    catch (error) { await options.secrets.delete(DEVICE_TOKEN_ACCOUNT); throw error; }
    return identity;
  }
  throw new Error("device_enrollment_expired");
}

function validStart(value: Partial<EnrollmentStartResponse>, expectedOrigin: string, observedAt: number): value is EnrollmentStartResponse {
  if (!record(value) || Object.keys(value).sort().join(",") !== "deviceCode,deviceId,expiresAt,userCode,verificationUri" || typeof value.deviceCode !== "string" || !/^utk_enroll_[A-Za-z0-9_-]{40,}$/.test(value.deviceCode)
    || typeof value.userCode !== "string" || !/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(value.userCode)
    || !safeId(value.deviceId) || !utcTimestamp(value.expiresAt) || !Number.isSafeInteger(observedAt) || Date.parse(value.expiresAt) <= observedAt || Date.parse(value.expiresAt) > observedAt + ENROLLMENT_MAX_TTL_MS || typeof value.verificationUri !== "string") return false;
  let verification: URL; try { verification = new URL(value.verificationUri); } catch { return false; }
  return verification.origin === expectedOrigin && verification.pathname === "/enroll" && verification.toString() === `${expectedOrigin}/enroll` && !verification.username && !verification.password && !verification.search && !verification.hash;
}
function expectedVerificationOrigin(controlOrigin: URL, configured: string | undefined): string {
  const localDevelopment = controlOrigin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(controlOrigin.hostname);
  if (configured === undefined && localDevelopment) return "http://localhost:3000";
  if (typeof configured !== "string" || configured.length < 1 || configured.length > 2_048) throw new Error("dashboard_origin_required");
  let value: URL; try { value = new URL(configured); } catch { throw new Error("dashboard_origin_invalid"); }
  if (value.origin !== configured || value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) throw new Error("dashboard_origin_invalid");
  return value.origin;
}
function validIssued(value: Partial<EnrollmentIssuedResponse>, expectedDeviceId: string): value is EnrollmentIssuedResponse {
  if (!record(value) || Object.keys(value).sort().join(",") !== "credential,deviceId,deviceToken,expectedOrigin,expectedRPID,status,tenantId" || value.status !== "issued" || typeof value.deviceToken !== "string" || !/^utk_device_[A-Za-z0-9_-]{40,}$/.test(value.deviceToken) || value.deviceId !== expectedDeviceId) return false;
  try { assertControlIdentity({ tenantId: value.tenantId, deviceId: value.deviceId, expectedOrigin: value.expectedOrigin, expectedRPID: value.expectedRPID, credential: value.credential }); return true; } catch { return false; }
}
function validPending(value: unknown): boolean { return Boolean(record(value) && Object.keys(value).length === 1 && value.status === "pending"); }
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function utcTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function validCivil(value: number): boolean { return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()); }
function validMonotonic(value: number): boolean { return Number.isFinite(value) && value >= 0; }
async function enrollmentJson(response: Response, phase: "start" | "exchange"): Promise<unknown> { const parsed = await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES); if (!parsed.ok) throw new Error(`device_enrollment_${phase}_${parsed.reason === "too_large" ? "response_too_large" : "invalid"}`); return parsed.value; }
async function enrollmentFetch(fetcher: typeof fetch, url: URL, init: RequestInit, phase: "start" | "exchange", callerSignal?: AbortSignal, timeoutMs = 8_000): Promise<{ response: Response; clear: () => void }> {
  const deadline = createDeadline(timeoutMs); const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  try { return { response: await fetcher(url, { ...init, signal }), clear: deadline.clear }; }
  catch { deadline.clear(); throw new Error(callerSignal?.aborted ? "device_enrollment_cancelled" : `device_enrollment_${phase}_${deadline.signal.aborted ? "timeout" : "unavailable"}`); }
}

async function waitForEnrollment(milliseconds: number, sleep?: (milliseconds: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  assertEnrollmentActive(signal);
  if (!signal) { await (sleep ? sleep(milliseconds) : new Promise(resolve => setTimeout(resolve, milliseconds))); return; }
  let onAbort: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = sleep ? sleep(milliseconds) : new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); });
    await Promise.race([operation, new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("device_enrollment_cancelled")); signal.addEventListener("abort", onAbort, { once: true }); })]);
  } finally { if (timer) clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
}
function assertEnrollmentActive(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("device_enrollment_cancelled"); }
