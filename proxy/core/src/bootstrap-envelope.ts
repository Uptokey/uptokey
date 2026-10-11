import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { SYNC_ALGORITHM, SYNC_HPKE_SUITE } from "./sync-envelope.ts";

export const BOOTSTRAP_SCHEMA_VERSION = 2;
export const BOOTSTRAP_PURPOSE = "tailnet_device_bootstrap";
const BOOTSTRAP_HPKE_INFO = Buffer.from("uptokey-bootstrap-v2");

export interface BootstrapEnvelope {
  purpose: typeof BOOTSTRAP_PURPOSE;
  schema_version: typeof BOOTSTRAP_SCHEMA_VERSION;
  algorithm: typeof SYNC_ALGORITHM;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
}

export async function openBootstrapToken(envelope: unknown, context: { tenantId: string; deviceId: string; controlOrigin: string; recipientPrivateKey: string }): Promise<string> {
  if (!isEnvelope(envelope) || !validContext(context)) throw new Error("control_bootstrap_envelope_rejected");
  const aad = Buffer.from(canonicalJson({ purpose: BOOTSTRAP_PURPOSE, schema_version: BOOTSTRAP_SCHEMA_VERSION, tenant_id: context.tenantId, device_id: context.deviceId, control_origin: context.controlOrigin, nonce: envelope.nonce }));
  try {
    const recipientKey = await SYNC_HPKE_SUITE.kem.importKey("raw", toArrayBuffer(Buffer.from(context.recipientPrivateKey, "base64url")), false);
    const plaintext = await SYNC_HPKE_SUITE.open({ recipientKey, enc: toArrayBuffer(Buffer.from(envelope.ephemeral_public_key, "base64url")), info: BOOTSTRAP_HPKE_INFO }, Buffer.from(envelope.ciphertext, "base64url"), aad);
    const token = Buffer.from(plaintext).toString("utf8");
    if (!/^utk_bootstrap_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid_token");
    return token;
  } catch { throw new Error("control_bootstrap_envelope_rejected"); }
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function isEnvelope(value: unknown): value is BootstrapEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "algorithm,ciphertext,ephemeral_public_key,nonce,purpose,schema_version") return false;
  return item.purpose === BOOTSTRAP_PURPOSE && item.schema_version === BOOTSTRAP_SCHEMA_VERSION && item.algorithm === SYNC_ALGORITHM
    && canonicalBase64url(item.ephemeral_public_key, 65)
    && canonicalBase64url(item.nonce, 12)
    && canonicalBase64url(item.ciphertext, 73);
}

function validContext(value: { tenantId: string; deviceId: string; controlOrigin: string; recipientPrivateKey: string }): boolean {
  if (!safeId(value.tenantId) || !safeId(value.deviceId) || !canonicalBase64url(value.recipientPrivateKey, 32) || value.controlOrigin.length > 300) return false;
  try { const origin = new URL(value.controlOrigin); return origin.protocol === "https:" && origin.port === "21436" && origin.hostname.endsWith(".ts.net") && origin.origin === value.controlOrigin && !origin.username && !origin.password; } catch { return false; }
}

function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function canonicalBase64url(value: unknown, bytes: number): value is string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false; const decoded = Buffer.from(value, "base64url"); return decoded.length === bytes && decoded.toString("base64url") === value; }
