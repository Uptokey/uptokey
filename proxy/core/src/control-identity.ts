import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { controlIdentityPath } from "./paths.ts";
import type { ControlIdentity } from "./control-capability.ts";
import { unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";

export async function loadControlIdentity(): Promise<ControlIdentity | undefined> {
  const identity = await readJson<unknown>(controlIdentityPath(), null);
  if (!identity) return undefined;
  assertControlIdentity(identity);
  return identity;
}

export async function saveControlIdentity(identity: ControlIdentity): Promise<void> { assertControlIdentity(identity); await writeJsonAtomic(controlIdentityPath(), identity); }
export async function deleteControlIdentity(): Promise<void> { try { await unlink(controlIdentityPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

export function assertControlIdentity(value: unknown): asserts value is ControlIdentity {
  if (!record(value) || Object.keys(value).sort().join(",") !== "credential,deviceId,expectedOrigin,expectedRPID,tenantId" || !safeId(value.tenantId) || !safeId(value.deviceId) || !safeRpId(value.expectedRPID) || !safeOriginForRP(value.expectedOrigin, value.expectedRPID) || !record(value.credential)) throw new Error("control_identity_invalid");
  const credential = value.credential;
  if (Object.keys(credential).some((key) => !["id", "publicKey", "counter", "transports"].includes(key)) || !safeId(credential.id) || typeof credential.publicKey !== "string" || credential.publicKey.length < 16 || credential.publicKey.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(credential.publicKey) || !safeCounter(credential.counter)) throw new Error("control_identity_invalid");
  const transports = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
  if (credential.transports !== undefined && (!Array.isArray(credential.transports) || credential.transports.length > transports.size || new Set(credential.transports).size !== credential.transports.length || credential.transports.some((item) => typeof item !== "string" || !transports.has(item)))) throw new Error("control_identity_invalid");
}

function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
export function safeRpId(value: unknown): value is string { return typeof value === "string" && value.length <= 253 && (value === "localhost" || isIP(value) === 0 && value.split(".").length >= 2 && value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))); }
function safeOriginForRP(value: unknown, rpID: string): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  let origin: URL; try { origin = new URL(value); } catch { return false; }
  const local = origin.protocol === "http:" && origin.hostname === "localhost" && rpID === "localhost";
  return (origin.protocol === "https:" || local) && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash && origin.origin === value && (origin.hostname === rpID || origin.hostname.endsWith(`.${rpID}`));
}
function safeCounter(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff; }
