import type { SecretStore } from "./secret-store.ts";
import {withVaultIdentityLock,type VaultIdentityLease} from './vault-identity-lock.ts';
import { randomBytes, createHash, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

const RECOVERY_ENVELOPE_ACCOUNT = "vault:recovery:envelope";
const DEK_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KDF_SALT_LENGTH = 16;
const PHRASE_ENTROPY_BYTES = 32;
const PHRASE_CHECKSUM_BYTES = 4;
const PHRASE_SYMBOLS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PHRASE_GROUP_SIZE = 4;
const PHRASE_SYMBOL_COUNT = Math.ceil(((PHRASE_ENTROPY_BYTES + PHRASE_CHECKSUM_BYTES) * 8) / 5);
const SCHEMA_VERSION = 2;
const SUITE_ID = "uptokey-recovery-aes256gcm-hkdfsha256-v2";
const AAD_DOMAIN = "uptokey-recovery-envelope-v2";
const KDF_INFO = "uptokey-recovery-wrapping-key-v2";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * RecoveryEnvelopeService — recuperação de alta entropia (ADR-013).
 *
 * O recovery secret é 256 bits de entropia codificados em base32 com
 * checksum. No envelope v2 a wrapping key é derivada por HKDF-SHA256 sobre
 * a entropia decodificada com salt aleatório por envelope; a frase só é
 * aceita após normalização e verificação do checksum. O envelope
 * armazenado contém apenas a VK cifrada com AES-256-GCM; nunca o
 * recovery secret em claro.
 *
 * Envelopes v1 (salt fixo, frase como IKM, layout nonce|tag|ciphertext)
 * permanecem legíveis sem migração; a frase v1 precisa ser fornecida
 * exatamente como emitida. Geração sempre produz v2.
 *
 * Sem o recovery secret nem outro device pareado, Uptokey não pode
 * recuperar os dados — propriedade do protocolo, não limitação.
 */
export interface RecoveryEnvelopeV2 {
  v: 2;
  suite: typeof SUITE_ID;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
}

export interface RecoveryEnvelopeServiceOptions {
  /** Deterministic byte source for tests/vectors only; production keeps CSPRNG default. */
  rng?: (length: number) => Buffer;
  revalidate?:()=>Promise<void>;
}

export class RecoveryEnvelopeService {
  private readonly secrets: SecretStore;
  private readonly rng: (length: number) => Buffer;
  private readonly revalidate:(()=>Promise<void>)|undefined;

  constructor(secrets: SecretStore, options?: RecoveryEnvelopeServiceOptions) {
    this.secrets = secrets;
    this.rng = options?.rng ?? ((length: number) => randomBytes(length));
    this.revalidate=options?.revalidate;
  }

  async generateRecoveryEnvelope(vk: Buffer | Uint8Array,identityLease?:VaultIdentityLease): Promise<{
    recoveryPhrase: string;
    envelope: string;
  }> {
    if (!(vk instanceof Uint8Array) || vk.byteLength !== DEK_LENGTH) throw new Error("recovery_vk_length_invalid");
    const entropy = this.rng(PHRASE_ENTROPY_BYTES);
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== PHRASE_ENTROPY_BYTES) throw new Error("recovery_entropy_invalid");
    const phrase = encodeRecoveryPhrase(Buffer.from(entropy));
    const salt = this.rng(KDF_SALT_LENGTH);
    const nonce = this.rng(NONCE_LENGTH);
    const wrappingKey = deriveWrappingKeyV2(entropy, salt);
    try {
      const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce, { authTagLength: TAG_LENGTH });
      cipher.setAAD(recoveryAadV2(salt));
      const sealed = Buffer.concat([cipher.update(Buffer.from(vk)), cipher.final()]);
      const envelope: RecoveryEnvelopeV2 = {
        v: SCHEMA_VERSION,
        suite: SUITE_ID,
        salt: salt.toString("base64url"),
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: sealed.toString("base64url"),
        createdAt: new Date().toISOString(),
      };
      const serialized = JSON.stringify(envelope);
      await this.importRecoveryEnvelope(serialized, { replaceExisting: true,identityLease });
      return { recoveryPhrase: phrase, envelope: serialized };
    } finally {
      wrappingKey.fill(0);
      entropy.fill(0);
    }
  }

  async recoverVault(recoveryPhrase: string): Promise<Buffer> {
    const raw = await this.exportRecoveryEnvelope();
    if (!raw) {
      throw new Error("recovery_envelope_not_found");
    }
    return raw.startsWith("{") ? this.recoverVaultV2(raw, recoveryPhrase) : this.recoverVaultLegacy(raw, recoveryPhrase);
  }

  private async recoverVaultV2(raw: string, recoveryPhrase: string): Promise<Buffer> {
    const envelope = parseRecoveryEnvelopeV2(raw);
    const entropy = decodeRecoveryPhrase(recoveryPhrase);
    const salt = Buffer.from(envelope.salt, "base64url");
    const wrappingKey = deriveWrappingKeyV2(entropy, salt);
    try {
      const decipher = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(envelope.nonce, "base64url"), { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      decipher.setAAD(recoveryAadV2(salt));
      let vk: Buffer;
      try {
        vk = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
      } catch {
        throw new Error("recovery_envelope_authentication_failed");
      }
      if (vk.length !== DEK_LENGTH) {
        vk.fill(0);
        throw new Error("recovery_vk_length_invalid");
      }
      return vk;
    } finally {
      wrappingKey.fill(0);
      entropy.fill(0);
    }
  }

  /** v1: fixed salt, phrase text as IKM, layout nonce|tag|ciphertext. Exact legacy behavior. */
  private async recoverVaultLegacy(envelopeB64: string, recoveryPhrase: string): Promise<Buffer> {
    const envelope = Buffer.from(envelopeB64, "base64url");
    const minLen = NONCE_LENGTH + TAG_LENGTH + DEK_LENGTH;
    if (envelope.length < minLen) {
      throw new Error("recovery_envelope_truncated");
    }
    const nonce = envelope.subarray(0, NONCE_LENGTH);
    const tag = envelope.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
    const ciphertext = envelope.subarray(NONCE_LENGTH + TAG_LENGTH);
    const wrappingKey = deriveWrappingKeyV1(recoveryPhrase);
    try {
      const decipher = createDecipheriv("aes-256-gcm", wrappingKey, nonce, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      decipher.setAAD(legacyAadV1());
      let vk: Buffer;
      try {
        vk = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new Error("recovery_envelope_authentication_failed");
      }
      if (vk.length !== DEK_LENGTH) {
        vk.fill(0);
        throw new Error("recovery_vk_length_invalid");
      }
      return vk;
    } finally {
      wrappingKey.fill(0);
    }
  }

  async verifyRecoveryPhrase(recoveryPhrase: string): Promise<boolean> {
    try {
      await this.recoverVault(recoveryPhrase);
      return true;
    } catch {
      return false;
    }
  }

  async hasRecoveryEnvelope(identityLease?:VaultIdentityLease): Promise<boolean> {
    const raw = await this.exportRecoveryEnvelope(identityLease);
    return raw !== undefined;
  }

  /** Exports the opaque stored envelope so it can travel with the user. */
  async exportRecoveryEnvelope(identityLease?:VaultIdentityLease): Promise<string | undefined> {
    return withVaultIdentityLock(this.secrets,()=>this.secrets.get(RECOVERY_ENVELOPE_ACCOUNT),identityLease);
  }

  /**
   * Imports a previously exported envelope (v2 JSON or legacy v1 base64url) into
   * a fresh profile. A different stored envelope is never replaced silently.
   */
  async importRecoveryEnvelope(envelope: string, options?: { replaceExisting?: boolean;identityLease?:VaultIdentityLease }): Promise<void> {
    return withVaultIdentityLock(this.secrets,async identityLease=>{
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > 8 * 1024) throw new Error("recovery_envelope_invalid");
    if (envelope.startsWith("{")) parseRecoveryEnvelopeV2(envelope);
    else assertLegacyRecoveryEnvelope(envelope);
    await this.revalidate?.();const existing = await this.secrets.get(RECOVERY_ENVELOPE_ACCOUNT);await this.revalidate?.();
    if (existing !== undefined && existing !== envelope && !options?.replaceExisting) throw new Error("recovery_envelope_present");
    if (existing === envelope) return;
    try{await this.secrets.set(RECOVERY_ENVELOPE_ACCOUNT, envelope);await this.revalidate?.();const verify=await this.secrets.get(RECOVERY_ENVELOPE_ACCOUNT);if(verify!==envelope)throw Error('recovery_envelope_persist_failed');await this.revalidate?.();}
    catch(error){await this.compensateImport(envelope,existing,identityLease);throw error;}
    },options?.identityLease);
  }

  /** Compensate a rejected identity change only while these exact bytes remain. */
  async compensateImport(expected:string,previous:string|undefined,identityLease?:VaultIdentityLease):Promise<void>{
    return withVaultIdentityLock(this.secrets,async()=>{if(await this.secrets.get(RECOVERY_ENVELOPE_ACCOUNT)!==expected)return;
      if(previous===undefined)await this.secrets.delete(RECOVERY_ENVELOPE_ACCOUNT);else await this.secrets.set(RECOVERY_ENVELOPE_ACCOUNT,previous);
    },identityLease);
  }
}

/**
 * Decodes a recovery phrase into the 256-bit entropy that generated it.
 * Input is normalized (case and group separators); the checksum and the
 * canonical zero padding are verified before the entropy is returned.
 */
export function decodeRecoveryPhrase(phrase: string): Buffer {
  if (typeof phrase !== "string") throw new Error("recovery_phrase_invalid");
  const normalized = phrase.toUpperCase().replace(/[\s-]+/g, "");
  if (normalized.length !== PHRASE_SYMBOL_COUNT || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(normalized)) {
    throw new Error("recovery_phrase_invalid");
  }
  const bits: number[] = [];
  for (const symbol of normalized) {
    const value = PHRASE_SYMBOLS.indexOf(symbol);
    for (let shift = 4; shift >= 0; shift--) bits.push((value >> shift) & 1);
  }
  // 58 symbols encode 288 bits plus 2 canonical zero padding bits.
  const padding = bits.length - (PHRASE_ENTROPY_BYTES + PHRASE_CHECKSUM_BYTES) * 8;
  for (let i = 1; i <= padding; i++) {
    if (bits[bits.length - i] !== 0) throw new Error("recovery_phrase_invalid");
  }
  const total = PHRASE_ENTROPY_BYTES + PHRASE_CHECKSUM_BYTES;
  const bytes = Buffer.alloc(total);
  for (let i = 0; i < total; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[i * 8 + bit]!;
    bytes[i] = value;
  }
  try {
    const expected = createHash("sha256").update(bytes.subarray(0, PHRASE_ENTROPY_BYTES)).digest().subarray(0, PHRASE_CHECKSUM_BYTES);
    if (!timingSafeEqual(expected, bytes.subarray(PHRASE_ENTROPY_BYTES))) throw new Error("recovery_phrase_invalid");
    return Buffer.from(bytes.subarray(0, PHRASE_ENTROPY_BYTES));
  } finally {
    bytes.fill(0);
  }
}

function parseRecoveryEnvelopeV2(raw: string): RecoveryEnvelopeV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("recovery_envelope_corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("recovery_envelope_corrupt");
  const e = parsed as Record<string, unknown>;
  const allowed = ["v", "suite", "salt", "nonce", "tag", "ciphertext", "createdAt"];
  for (const key of Object.keys(e)) {
    if (!allowed.includes(key)) throw new Error(`recovery_envelope_unknown_field:${key}`);
  }
  if (e.v !== SCHEMA_VERSION) throw new Error(`recovery_envelope_unsupported_version:${String(e.v)}`);
  if (e.suite !== SUITE_ID) throw new Error("recovery_envelope_unsupported_suite");
  if (typeof e.salt !== "string" || !canonicalBase64url(e.salt, KDF_SALT_LENGTH)) throw new Error("recovery_envelope_invalid_salt");
  if (typeof e.nonce !== "string" || !canonicalBase64url(e.nonce, NONCE_LENGTH)) throw new Error("recovery_envelope_invalid_nonce");
  if (typeof e.tag !== "string" || !canonicalBase64url(e.tag, TAG_LENGTH)) throw new Error("recovery_envelope_invalid_tag");
  if (typeof e.ciphertext !== "string" || !canonicalBase64url(e.ciphertext, DEK_LENGTH)) throw new Error("recovery_envelope_invalid_ciphertext");
  if (typeof e.createdAt !== "string" || !isCanonicalInstant(e.createdAt)) throw new Error("recovery_envelope_invalid_created_at");
  return e as unknown as RecoveryEnvelopeV2;
}

function assertLegacyRecoveryEnvelope(envelope: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(envelope)) throw new Error("recovery_envelope_invalid");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(envelope, "base64url");
  } catch {
    throw new Error("recovery_envelope_invalid");
  }
  if (decoded.length < NONCE_LENGTH + TAG_LENGTH + DEK_LENGTH || decoded.toString("base64url") !== envelope) {
    throw new Error("recovery_envelope_invalid");
  }
}

function deriveWrappingKeyV2(entropy: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", entropy, salt, KDF_INFO, DEK_LENGTH));
}

function recoveryAadV2(salt: Buffer): Buffer {
  return createHash("sha256").update(AAD_DOMAIN).update("\x00").update(salt).digest();
}

function deriveWrappingKeyV1(phrase: string): Buffer {
  const ikm = Buffer.from(phrase, "utf8");
  // v1 compatibility: the phrase encodes 256 random bits (high entropy), so HKDF with the
  // historical fixed domain is adequate; a human password would need a memory-hard KDF.
  const salt = createHash("sha256").update("uptokey-recovery-kdf-salt-v1").digest();
  return Buffer.from(hkdfSync("sha256", ikm, salt, "uptokey-recovery-wrapping-key-v1", DEK_LENGTH));
}

function legacyAadV1(): Buffer {
  return createHash("sha256").update("vault-recovery-envelope-v1").digest();
}

/** Codifica 256 bits de entropia + 4 bytes de checksum em base32. */
function encodeRecoveryPhrase(entropy: Buffer): string {
  const checksum = createHash("sha256").update(entropy).digest();
  const totalBytes = new Uint8Array(entropy.length + PHRASE_CHECKSUM_BYTES);
  totalBytes.set(entropy);
  totalBytes.set(checksum.subarray(0, PHRASE_CHECKSUM_BYTES), entropy.length);

  const symbols: string[] = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (let i = 0; i < totalBytes.length; i++) {
    buffer = (buffer << 8) | totalBytes[i]!;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      symbols.push(PHRASE_SYMBOLS[(buffer >> bitsLeft) & 0x1f]!);
    }
  }
  if (bitsLeft > 0) {
    symbols.push(PHRASE_SYMBOLS[(buffer << (5 - bitsLeft)) & 0x1f]!);
  }

  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += PHRASE_GROUP_SIZE) {
    groups.push(symbols.slice(i, i + PHRASE_GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

function canonicalBase64url(value: string, bytes: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return false;
  }
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

function isCanonicalInstant(value: string): boolean {
  if (!ISO_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
