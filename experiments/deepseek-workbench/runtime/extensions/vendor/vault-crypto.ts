import type { SecretStore } from "./secret-store.ts";
import {withVaultIdentityLock,type VaultIdentityLease} from './vault-identity-lock.ts';
import { randomBytes, createHash, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

const VK_ACCOUNT = "vault:key";
const DEK_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KDF_SALT_LENGTH = 16;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024; // 64 MB
const SUITE_ID = "uptokey-vault-v1";
/** Current write schema. v2 authenticates suiteId and expiresAt in the AAD and binds
 * the wrapped DEK to the full envelope context. v1 stays readable without migration. */
const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VAULT_KEY_HEX = /^[0-9a-f]{64}$/;

/** Envelope de objeto cifrado — schema versionado e restrito. */
export interface VaultObjectEnvelope {
  schemaVersion: number;
  suiteId: string;
  objectId: string;
  vaultId: string;
  tenantScope: string;
  objectVersion: number;
  resourceScope: string;
  createdAt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  wrappedDek: string;
  kdfSalt: string;
  aadDigest: string;
  expiresAt?: string;
}

export interface VaultCryptoOptions {
  vaultId?: string;
  tenantScope?: string;
  maxPayloadBytes?: number;
  /** Deterministic byte source for tests/vectors only; production keeps CSPRNG default. */
  rng?: (length: number) => Buffer;
  revalidate?:()=>Promise<void>;
}

/**
 * VaultCrypto — AES-256-GCM com hierarquia VK/DEK por objeto (ADR-012).
 *
 * Hierarquia:
 *   - VK (Vault Key): 256 bits CSPRNG, armazenada no SecretStore do cliente.
 *   - DEK (Data Encryption Key): 256 bits CSPRNG por objeto/versão.
 *   - Envelope: DEK envolta com VK via AES-256-GCM, payload cifrado com DEK.
 *
 * O servidor só recebe o envelope serializado; nunca VK nem DEK em claro.
 *
 * Envelope schema versionado com AAD vinculado a objeto, versão, vault,
 * tenant, recurso e finalidade. Parser estrito rejeita campos desconhecidos,
 * codificações não canônicas, tamanhos inválidos e versões incompatíveis.
 * O schema v2 (escrita atual) também autentica suiteId e expiresAt — remover
 * ou esticar o prazo invalida a autenticação — e vincula a DEK envolta ao
 * contexto completo do envelope. Envelopes v1 continuam legíveis byte a byte,
 * sem migração ou reescrita de qualquer dado já cifrado.
 */
export class VaultCrypto {
  private readonly secrets: SecretStore;
  private readonly vaultId: string;
  private readonly tenantScope: string;
  private readonly maxPayloadBytes: number;
  private readonly rng: (length: number) => Buffer;
  private readonly revalidate: (()=>Promise<void>) | undefined;
  private readonly nonceRegistry = new Map<string, Set<string>>();
  private readonly MAX_NONCE_ENTRIES = 4096;

  constructor(secrets: SecretStore, options?: VaultCryptoOptions) {
    this.secrets = secrets;
    this.vaultId = options?.vaultId ?? "default";
    this.tenantScope = options?.tenantScope ?? "personal";
    this.maxPayloadBytes = options?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
    this.rng = options?.rng ?? ((length: number) => randomBytes(length));
    this.revalidate=options?.revalidate;
    for (const [name, value] of [["vaultId", this.vaultId], ["tenantScope", this.tenantScope]] as const) {
      if (!isSafeComponent(value)) throw new Error(`invalid_${name}`);
    }
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1) throw new Error("invalid_max_payload_bytes");
  }

  async ensureVaultKey(identityLease?:VaultIdentityLease): Promise<void> {
    return withVaultIdentityLock(this.secrets,()=>this.initializeVaultKey(),identityLease);
  }

  private async initializeVaultKey(): Promise<void> {
    // Locked/unavailable is not absent. Never replace key material after a read
    // error or malformed persisted value: existing ciphertext still needs it.
    await this.revalidate?.();const existing = await this.secrets.get(VK_ACCOUNT);await this.revalidate?.();
    if (existing !== undefined) {
      if (!VAULT_KEY_HEX.test(existing)) {
        throw new Error("vault_key_invalid");
      }
      return;
    }
    const vk = this.rng(DEK_LENGTH).toString("hex");
    await this.persistKey(vk,existing);
  }

  /**
   * Recovery entry point: writes a validated 256-bit VK into the shared account.
   * Idempotent for the same key; a different existing key is never replaced
   * without explicit `replaceExisting`. Serialized with key initialization.
   */
  async restoreVaultKey(keyMaterial: Buffer | string, options?: { replaceExisting?: boolean;identityLease?:VaultIdentityLease }): Promise<void> {
    return withVaultIdentityLock(this.secrets,()=>this.writeRestoredKey(keyMaterial,options),options?.identityLease);
  }

  private async writeRestoredKey(keyMaterial: Buffer | string, options?: { replaceExisting?: boolean }): Promise<void> {
    let hex: string;
    if (typeof keyMaterial === "string") {
      if (!VAULT_KEY_HEX.test(keyMaterial)) throw new Error("vault_key_invalid");
      hex = keyMaterial;
    } else {
      if (!(keyMaterial instanceof Uint8Array)) throw new Error("vault_key_invalid");
      if (keyMaterial.byteLength !== DEK_LENGTH) throw new Error("vault_key_invalid");
      hex = Buffer.from(keyMaterial).toString("hex");
    }
    await this.revalidate?.();const existing = await this.secrets.get(VK_ACCOUNT);await this.revalidate?.();
    if (existing !== undefined) {
      if (existing === hex) return;
      if (!options?.replaceExisting) throw new Error("vault_key_present");
    }
    await this.persistKey(hex,existing);
  }

  /** Called only inside the original per-SecretStore key initialization lock. */
  private async persistKey(value:string,previous:string|undefined):Promise<void>{
    await this.revalidate?.();
    try{await this.secrets.set(VK_ACCOUNT,value);await this.revalidate?.();if(await this.secrets.get(VK_ACCOUNT)!==value)throw Error('vault_key_persist_failed');await this.revalidate?.();}
    catch(error){if(await this.secrets.get(VK_ACCOUNT)===value){if(previous===undefined)await this.secrets.delete(VK_ACCOUNT);else await this.secrets.set(VK_ACCOUNT,previous);}throw error;}
  }

  /** Exports the raw VK for the recovery envelope service; never logs or ships it. */
  async exportVaultKey(identityLease?:VaultIdentityLease): Promise<Buffer> {
    return this.getVaultKey(identityLease);
  }

  private async getVaultKey(identityLease?:VaultIdentityLease): Promise<Buffer> {
    return withVaultIdentityLock(this.secrets,async()=>{const raw=await this.secrets.get(VK_ACCOUNT);
      if(raw===undefined)throw Error('vault_key_missing');if(!VAULT_KEY_HEX.test(raw))throw Error('vault_key_invalid');return Buffer.from(raw,'hex');
    },identityLease);
  }

  /**
   * Cifra o payload com DEK aleatória e retorna o envelope com DEK
   * envolta pela VK. O objectId é vinculado via AAD para prevenir
   * ataques de swap entre objetos.
   */
  async encryptObject(objectId: string, payload: Uint8Array, options?: { objectVersion?: number; resourceScope?: string; expiresAt?: string }): Promise<VaultObjectEnvelope> {
    // Validate payload size before touching the vault
    if (payload.byteLength > this.maxPayloadBytes) {
      throw new Error("payload_too_large");
    }

    const objectVersion = options?.objectVersion ?? 1;
    const resourceScope = options?.resourceScope ?? "";
    const expiresAt = options?.expiresAt;
    if (typeof objectId !== "string" || objectId.length < 3 || objectId.length > 256 || objectId.includes("\x00")) {
      throw new Error("invalid_object_id");
    }
    if (!Number.isSafeInteger(objectVersion) || objectVersion < 1) throw new Error("invalid_object_version");
    if (!isSafeComponent(resourceScope)) throw new Error("invalid_resource_scope");
    if (expiresAt !== undefined) {
      if (typeof expiresAt !== "string" || !isCanonicalInstant(expiresAt)) throw new Error("invalid_expires_at");
      if (Date.parse(expiresAt) <= Date.now()) throw new Error("expires_at_in_past");
    }

    await this.ensureVaultKey();

    // AAD v2: objectId + vaultId + tenantScope + version + resourceScope + suiteId + expiresAt.
    // Components are validated NUL-free so \x00 joins cannot alias different tuples, and
    // expiresAt is authenticated so stripping or stretching it invalidates the envelope.
    const aadComponents = [objectId, this.vaultId, this.tenantScope, String(objectVersion), resourceScope, SUITE_ID, expiresAt ?? ""];
    const aad = digestAad(aadComponents);
    const aadDigest = aad.toString("hex");

    // Generate DEK and nonce
    const dek = this.rng(DEK_LENGTH);
    let nonce = this.rng(NONCE_LENGTH);
    let nonceStr = nonce.toString("base64url");

    // Check nonce uniqueness per objectId
    const objNonces = this.nonceRegistry.get(objectId) ?? new Set();
    if (objNonces.has(nonceStr)) {
      // Collision detected, regenerate
      let attempts = 0;
      do {
        nonce = this.rng(NONCE_LENGTH);
        nonceStr = nonce.toString("base64url");
        attempts++;
        if (attempts > 10) {
          // Flush old nonces and retry
          this.nonceRegistry.clear();
          break;
        }
      } while (objNonces.has(nonceStr));
    }
    objNonces.add(nonceStr);
    // Prune if too large
    if (objNonces.size > this.MAX_NONCE_ENTRIES) {
      const arr = Array.from(objNonces);
      this.nonceRegistry.set(objectId, new Set(arr.slice(-this.MAX_NONCE_ENTRIES / 2)));
    }
    this.nonceRegistry.set(objectId, objNonces);

    const vk = await this.getVaultKey();
    let wrappingKey: Buffer = Buffer.alloc(0);
    let dekSalt: Buffer = Buffer.alloc(0);
    try {
      // Envolves DEK com VK: gera salt, deriva wrapping key via HKDF.
      dekSalt = this.rng(KDF_SALT_LENGTH);
      wrappingKey = hkdfSha256(vk, dekSalt, "uptokey-e2ee-dek-wrap-v1", DEK_LENGTH);
    } finally {
      vk.fill(0);
    }

    try {
      // Cifra payload com DEK + AES-256-GCM.
      const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_LENGTH });
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
      const tag = cipher.getAuthTag();

      // v2: a DEK envolta é vinculada ao AAD completo do envelope; um DEK trocado
      // entre envelopes falha na autenticação antes de tocar o payload.
      const dekNonce = this.rng(NONCE_LENGTH);
      const dekCipher = createCipheriv("aes-256-gcm", wrappingKey, dekNonce, { authTagLength: TAG_LENGTH });
      dekCipher.setAAD(aad);
      const wrappedDekCt = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
      const wrappedDekTag = dekCipher.getAuthTag();

      // Embute dekNonce + DEK ciphertext + tag para de-envolver depois.
      const wrappedDekB64 = Buffer.concat([dekNonce, wrappedDekCt, wrappedDekTag]).toString("base64url");

      return {
        schemaVersion: SCHEMA_VERSION,
        suiteId: SUITE_ID,
        objectId,
        vaultId: this.vaultId,
        tenantScope: this.tenantScope,
        objectVersion,
        resourceScope,
        createdAt: new Date().toISOString(),
        nonce: nonceStr,
        ciphertext: encrypted.toString("base64url"),
        tag: tag.toString("base64url"),
        wrappedDek: wrappedDekB64,
        kdfSalt: dekSalt.toString("base64url"),
        aadDigest,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    } finally {
      wrappingKey.fill(0);
      dek.fill(0);
    }
  }

  /**
   * Descifra um envelope e retorna o payload original.
   * Rejeita envelopes com schema incompatível, codificação não canônica,
   * vault/tenant divergentes da instância, binding esperado divergente,
   * ciphertext truncado ou tag inválida.
   */
  async decryptObject(
    envelope: VaultObjectEnvelope,
    expected?: { objectId?: string; objectVersion?: number; resourceScope?: string },
  ): Promise<Uint8Array> {
    validateEnvelope(envelope, this.maxPayloadBytes);

    // Instance binding: an envelope from another vault/tenant of the same store
    // must not silently decrypt as if it belonged to this instance.
    if (envelope.vaultId !== this.vaultId) throw new Error("vault_mismatch");
    if (envelope.tenantScope !== this.tenantScope) throw new Error("tenant_mismatch");
    if (expected?.objectId !== undefined && expected.objectId !== envelope.objectId) throw new Error("object_binding_mismatch");
    if (expected?.objectVersion !== undefined && expected.objectVersion !== envelope.objectVersion) throw new Error("version_binding_mismatch");
    if (expected?.resourceScope !== undefined && expected.resourceScope !== envelope.resourceScope) throw new Error("scope_binding_mismatch");

    const vk = await this.getVaultKey();
    try {
      if (envelope.schemaVersion === LEGACY_SCHEMA_VERSION) {
        return await this.decryptLegacy(vk, envelope);
      }
      // v2: the AAD digest is verified before use, then the DEK bound to that same
      // AAD is unwrapped, then the payload is authenticated.
      const aad = envelopeAad(envelope);
      if (aad.toString("hex") !== envelope.aadDigest) {
        throw new Error("aad_mismatch");
      }
      const dek = await unwrapDek(vk, envelope, aad);
      try {
        return decryptPayload(dek, envelope, aad);
      } finally {
        dek.fill(0);
      }
    } finally {
      vk.fill(0);
    }
  }

  /** v1 read compatibility: constant DEK-wrap AAD and the v1 component set. */
  private async decryptLegacy(vk: Buffer, envelope: VaultObjectEnvelope): Promise<Uint8Array> {
    const aad = legacyEnvelopeAad(envelope);
    const wrapAad = createHash("sha256").update("wrapped_dek").digest();
    const dek = await unwrapDek(vk, envelope, wrapAad);
    try {
      if (aad.toString("hex") !== envelope.aadDigest) {
        throw new Error("aad_mismatch");
      }
      return decryptPayload(dek, envelope, aad);
    } finally {
      dek.fill(0);
    }
  }
}

/** v2 AAD: objectId + vaultId + tenantScope + version + resourceScope + suiteId + expiresAt. */
function envelopeAad(envelope: VaultObjectEnvelope): Buffer {
  return digestAad([
    envelope.objectId,
    envelope.vaultId,
    envelope.tenantScope,
    String(envelope.objectVersion),
    envelope.resourceScope ?? "",
    SUITE_ID,
    envelope.expiresAt ?? "",
  ]);
}

/** v1 AAD: objectId + vaultId + tenantScope + version + resourceScope (unchanged). */
function legacyEnvelopeAad(envelope: VaultObjectEnvelope): Buffer {
  return digestAad([
    envelope.objectId,
    envelope.vaultId,
    envelope.tenantScope,
    String(envelope.objectVersion),
    envelope.resourceScope ?? "",
  ]);
}

function digestAad(components: string[]): Buffer {
  return createHash("sha256").update(components.join("\x00")).digest();
}

function decryptPayload(dek: Buffer, envelope: VaultObjectEnvelope, aad: Buffer): Uint8Array {
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(envelope.nonce, "base64url"), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
}

/** Parser estrito para envelope. Rejeita campos desconhecidos, codificações não
 * canônicas, tamanhos inválidos e versões incompatíveis. */
function validateEnvelope(envelope: unknown, maxPayloadBytes: number): asserts envelope is VaultObjectEnvelope {
  if (!envelope || typeof envelope !== "object") throw new Error("invalid_envelope");
  const e = envelope as Record<string, unknown>;

  // Check for unknown fields
  const allowed = new Set(["schemaVersion", "suiteId", "objectId", "vaultId", "tenantScope",
    "objectVersion", "resourceScope", "createdAt", "nonce", "ciphertext", "tag", "wrappedDek", "kdfSalt",
    "aadDigest", "expiresAt"]);
  for (const key of Object.keys(e)) {
    if (!allowed.has(key)) throw new Error(`unknown_envelope_field:${key}`);
  }

  if (typeof e.schemaVersion !== "number" || (e.schemaVersion !== SCHEMA_VERSION && e.schemaVersion !== LEGACY_SCHEMA_VERSION)) {
    throw new Error(`unsupported_envelope_version:${e.schemaVersion}`);
  }
  if (typeof e.suiteId !== "string" || e.suiteId !== SUITE_ID) throw new Error("unsupported_suite");
  if (typeof e.objectId !== "string" || e.objectId.length < 3 || e.objectId.length > 256) throw new Error("invalid_object_id");
  if (typeof e.vaultId !== "string" || !isSafeComponent(e.vaultId)) throw new Error("invalid_vault_id");
  if (typeof e.tenantScope !== "string" || !isSafeComponent(e.tenantScope)) throw new Error("invalid_tenant_scope");
  if (typeof e.objectVersion !== "number" || !Number.isSafeInteger(e.objectVersion) || e.objectVersion < 1) throw new Error("invalid_object_version");
  if (typeof e.resourceScope !== "string" || !isSafeComponent(e.resourceScope)) throw new Error("invalid_resource_scope");
  if (typeof e.createdAt !== "string" || !isCanonicalInstant(e.createdAt)) throw new Error("invalid_created_at");
  if (typeof e.nonce !== "string" || !canonicalBase64url(e.nonce, NONCE_LENGTH)) throw new Error("invalid_nonce");
  if (typeof e.ciphertext !== "string" || !canonicalCiphertext(e.ciphertext, maxPayloadBytes)) throw new Error("invalid_ciphertext");
  if (typeof e.tag !== "string" || !canonicalBase64url(e.tag, TAG_LENGTH)) throw new Error("invalid_tag");
  if (typeof e.wrappedDek !== "string" || !canonicalBase64url(e.wrappedDek, NONCE_LENGTH + DEK_LENGTH + TAG_LENGTH)) throw new Error("invalid_wrapped_dek");
  if (typeof e.kdfSalt !== "string" || !canonicalBase64url(e.kdfSalt, KDF_SALT_LENGTH)) throw new Error("invalid_kdf_salt");
  if (typeof e.aadDigest !== "string" || !/^[0-9a-f]{64}$/.test(e.aadDigest)) throw new Error("invalid_aad_digest");
  if (e.expiresAt !== undefined && (typeof e.expiresAt !== "string" || !isCanonicalInstant(e.expiresAt))) throw new Error("invalid_expires_at");
  if (e.expiresAt && Date.parse(e.expiresAt) < Date.now()) throw new Error("envelope_expired");
}

/** Canonical UTC instant exactly as `Date.prototype.toISOString` emits it; any other
 * encoding (or a non-round-tripping date) is refused before it reaches the AAD. */
function isCanonicalInstant(s: string): boolean {
  if (!ISO_INSTANT.test(s)) return false;
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === s;
}

/** AAD components must be NUL-free so the \x00 join is injective; control chars
 * are excluded for the same reason and to keep envelope metadata log-safe. */
function isSafeComponent(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length > 256) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** Strict canonical base64url of exactly `bytes` decoded bytes. */
function canonicalBase64url(value: string, bytes: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  let decoded: Buffer;
  try { decoded = Buffer.from(value, "base64url"); } catch { return false; }
  return decoded.length === bytes && decoded.toString("base64url") === value;
}

/** Bounds the encoded length before decoding to cap allocation. An empty
 * plaintext produces an empty ciphertext, which is canonical. */
function canonicalCiphertext(value: string, maxPayloadBytes: number): boolean {
  const maxEncoded = Math.ceil((maxPayloadBytes * 4) / 3) + 4;
  if (typeof value !== "string" || value.length > maxEncoded || !/^[A-Za-z0-9_-]*$/.test(value)) return false;
  let decoded: Buffer;
  try { decoded = Buffer.from(value, "base64url"); } catch { return false; }
  return decoded.length <= maxPayloadBytes && decoded.toString("base64url") === value;
}

async function unwrapDek(vk: Buffer, envelope: VaultObjectEnvelope, wrapAad: Buffer): Promise<Buffer> {
  const dekSalt = Buffer.from(envelope.kdfSalt, "base64url");
  const wrappingKey = hkdfSha256(vk, dekSalt, "uptokey-e2ee-dek-wrap-v1", DEK_LENGTH);
  try {
    const wrappedRaw = Buffer.from(envelope.wrappedDek, "base64url");
    const expectedMinLen = NONCE_LENGTH + DEK_LENGTH + TAG_LENGTH;
    if (wrappedRaw.length < expectedMinLen) {
      throw new Error("wrapped_dek_truncated");
    }

    const dekNonce = wrappedRaw.subarray(0, NONCE_LENGTH);
    const dekCtWithTag = wrappedRaw.subarray(NONCE_LENGTH);
    const splitPoint = dekCtWithTag.length - TAG_LENGTH;
    if (splitPoint <= 0) {
      throw new Error("wrapped_dek_too_short");
    }
    const dekCiphertext = dekCtWithTag.subarray(0, splitPoint);
    const dekTag = dekCtWithTag.subarray(splitPoint);

    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, dekNonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(dekTag);
    decipher.setAAD(wrapAad);
    let dek: Buffer;
    try {
      dek = Buffer.concat([decipher.update(dekCiphertext), decipher.final()]);
    } catch {
      throw new Error("wrapped_dek_authentication_failed");
    }
    if (dek.length !== DEK_LENGTH) {
      dek.fill(0);
      throw new Error("dek_length_invalid");
    }
    return dek;
  } finally {
    wrappingKey.fill(0);
  }
}

function hkdfSha256(
  ikm: Buffer,
  salt: Buffer,
  info: string,
  outputLength: number,
): Buffer {
  // RFC 5869 HKDF from node:crypto (previously a hand-rolled single-block variant).
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, outputLength));
}
