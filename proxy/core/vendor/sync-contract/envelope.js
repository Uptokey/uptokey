import { ECDH } from "node:crypto";
import { isDataRecord as dataRecord } from "./plain-data.js";

export const SYNC_ALGORITHM = "HPKE-P256-HKDF-SHA256-AES-256-GCM";
export const SYNC_SCHEMA_VERSION = 2;
const ENVELOPE_KEYS = ["algorithm", "ciphertext", "config_version", "created_at", "device_id", "ephemeral_public_key", "nonce", "schema_version"];

export function isSyncEnvelope(value) {
  if (!dataRecord(value) || Object.keys(value).sort().join(",") !== ENVELOPE_KEYS.join(",")) return false;
  return safeId(value.device_id)
    && Number.isSafeInteger(value.config_version) && value.config_version > 0
    && value.schema_version === SYNC_SCHEMA_VERSION
    && value.algorithm === SYNC_ALGORITHM
    && canonicalP256PublicKey(value.ephemeral_public_key)
    && canonicalBase64url(value.nonce, 12)
    && canonicalCiphertext(value.ciphertext)
    && canonicalIso(value.created_at);
}

function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function canonicalIso(value) { if (typeof value !== "string") return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function canonicalCiphertext(value) { if (typeof value !== "string" || value.length > 87_404 || !/^[A-Za-z0-9_-]+$/.test(value)) return false; const decoded = decode(value); return decoded !== undefined && decoded.length > 16 && decoded.length <= 65_536 && decoded.toString("base64url") === value; }
function canonicalBase64url(value, bytes) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false; const decoded = decode(value); return decoded !== undefined && decoded.length === bytes && decoded.toString("base64url") === value; }
export function isP256PublicKey(value) { if (!canonicalBase64url(value, 65)) return false; try { return ECDH.convertKey(Buffer.from(value, "base64url"), "prime256v1", undefined, undefined, "uncompressed").toString("base64url") === value; } catch { return false; } }
function canonicalP256PublicKey(value) { return isP256PublicKey(value); }
function decode(value) { try { return Buffer.from(value, "base64url"); } catch { return undefined; } }
