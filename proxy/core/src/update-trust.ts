import { createHash, createPublicKey } from "node:crypto";

declare const UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64: string | undefined;
declare const UPTOKEY_UPDATE_KEY_FINGERPRINT: string | undefined;
declare const UPTOKEY_UPDATE_NEXT_PUBLIC_KEY_SPKI_BASE64: string | undefined;
declare const UPTOKEY_UPDATE_NEXT_KEY_FINGERPRINT: string | undefined;
declare const UPTOKEY_UPDATE_ORIGIN: string | undefined;

export interface UpdateTrustKey { publicKey: ReturnType<typeof createPublicKey>; fingerprint: string }
export interface CompiledUpdateTrust extends UpdateTrustKey { fallbackKeys?: readonly UpdateTrustKey[] }

export function compiledUpdateTrust(): CompiledUpdateTrust {
  if (typeof UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64 !== "string" || typeof UPTOKEY_UPDATE_KEY_FINGERPRINT !== "string") throw new Error("update_trust_not_compiled");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64) || !/^[a-f0-9]{64}$/.test(UPTOKEY_UPDATE_KEY_FINGERPRINT)) throw new Error("update_trust_compiled_value_invalid");
  const der = Buffer.from(UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64, "base64"); if (der.toString("base64") !== UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64) throw new Error("update_trust_spki_noncanonical");
  const primary = parseTrustKey(der, UPTOKEY_UPDATE_KEY_FINGERPRINT); const nextSpki = typeof UPTOKEY_UPDATE_NEXT_PUBLIC_KEY_SPKI_BASE64 === "string" ? UPTOKEY_UPDATE_NEXT_PUBLIC_KEY_SPKI_BASE64 : undefined; const nextFingerprint = typeof UPTOKEY_UPDATE_NEXT_KEY_FINGERPRINT === "string" ? UPTOKEY_UPDATE_NEXT_KEY_FINGERPRINT : undefined;
  if ((nextSpki === undefined) !== (nextFingerprint === undefined)) throw new Error("update_rotation_trust_partial"); if (!nextSpki) return Object.freeze(primary); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nextSpki) || !/^[a-f0-9]{64}$/.test(nextFingerprint!)) throw new Error("update_rotation_trust_invalid"); const nextDer = Buffer.from(nextSpki, "base64"); if (nextDer.toString("base64") !== nextSpki) throw new Error("update_rotation_spki_noncanonical"); const next = parseTrustKey(nextDer, nextFingerprint!); if (next.fingerprint === primary.fingerprint) throw new Error("update_rotation_key_duplicate"); return Object.freeze({ ...primary, fallbackKeys: Object.freeze([next]) });
}

export function compiledUpdateOrigin(): string { if (typeof UPTOKEY_UPDATE_ORIGIN !== "string") throw new Error("update_origin_not_compiled"); const parsed = new URL(UPTOKEY_UPDATE_ORIGIN); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== UPTOKEY_UPDATE_ORIGIN) throw new Error("update_origin_compiled_value_invalid"); return UPTOKEY_UPDATE_ORIGIN; }
function parseTrustKey(der: Buffer, expectedFingerprint: string): UpdateTrustKey { const publicKey = createPublicKey({ key: der, type: "spki", format: "der" }); if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("update_trust_key_not_p256"); const fingerprint = createHash("sha256").update(der).digest("hex"); if (fingerprint !== expectedFingerprint) throw new Error("update_trust_fingerprint_mismatch"); return Object.freeze({ publicKey, fingerprint }); }
