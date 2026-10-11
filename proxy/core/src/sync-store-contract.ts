import { randomBytes, createHash } from "node:crypto";

/**
 * Contrato do store remoto E2EE (H5) — MongoDB metadados + R2 blobs.
 *
 * Invariante: nenhuma coleção contém plaintext, VK, DEK em claro, BYOK,
 * private key, recovery secret, path local ou prompt. Apenas envelopes
 * opacos, metadados mínimos e digests operacionais.
 */

export const MONGO_COLLECTIONS = {
  vaultObjectsMetadata: "vault_objects_metadata",
  deviceEnrollments: "device_enrollments",
  syncOperations: "sync_operations",
  tombstones: "tombstones",
  auditEvents: "audit_events",
} as const;

/** Campos proibidos em qualquer documento Mongo — falha fechada. */
const FORBIDDEN_FIELDS = [
  "plaintext",
  "content",
  "prompt",
  "vaultKey",
  "vault_key",
  "dek",
  "dataEncryptionKey",
  "privateKey",
  "private_key",
  "recoverySecret",
  "recovery_secret",
  "recoveryPhrase",
  "byok",
  "apiKey",
  "api_key",
  "localPath",
  "clipboard",
] as const;

const FORBIDDEN_PATTERNS = [
  /gsk_[A-Za-z0-9]{8,}/,
  /AIza[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{8,}/,
  /utk_(?:local|live)_[A-Za-z0-9._-]{8,}/,
] as const;

/** Metadados de objeto do vault — envelope opaco + metadados mínimos. */
export interface VaultObjectMetadata {
  readonly objectId: string;
  readonly vaultId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly envelopeBytes: number;
  readonly r2ObjectKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tombstonedAt: string | null;
  readonly idempotencyKey: string | null;
}

/** Índices e constraints por coleção. */
export interface CollectionSpec {
  readonly collection: string;
  readonly unique: ReadonlyArray<ReadonlyArray<string>>;
  readonly indexes: ReadonlyArray<{ readonly keys: Record<string, 1 | -1>; readonly ttlSeconds?: number }>;
  readonly writeConcern: "majority";
}

export const COLLECTION_SPECS: ReadonlyArray<CollectionSpec> = [
  {
    collection: MONGO_COLLECTIONS.vaultObjectsMetadata,
    unique: [["tenantId", "objectId"]],
    indexes: [{ keys: { tenantId: 1, updatedAt: -1 } }],
    writeConcern: "majority",
  },
  {
    collection: MONGO_COLLECTIONS.deviceEnrollments,
    unique: [["tenantId", "deviceId"]],
    indexes: [{ keys: { tenantId: 1, createdAt: -1 } }],
    writeConcern: "majority",
  },
  {
    collection: MONGO_COLLECTIONS.syncOperations,
    unique: [["idempotencyKey"]],
    indexes: [{ keys: { tenantId: 1, createdAt: -1 }, ttlSeconds: 30 * 24 * 3600 }],
    writeConcern: "majority",
  },
  {
    collection: MONGO_COLLECTIONS.tombstones,
    unique: [["tenantId", "objectId"]],
    indexes: [{ keys: { tenantId: 1, tombstonedAt: -1 } }],
    writeConcern: "majority",
  },
  {
    collection: MONGO_COLLECTIONS.auditEvents,
    unique: [],
    indexes: [{ keys: { tenantId: 1, createdAt: -1 }, ttlSeconds: 90 * 24 * 3600 }],
    writeConcern: "majority",
  },
];

/** Valida metadados antes de persistir — rejeita segredos e plaintext. */
export function validateVaultObjectMetadata(doc: unknown): asserts doc is VaultObjectMetadata {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("metadata_invalid");
  const d = doc as Record<string, unknown>;
  const allowed = new Set(["objectId", "vaultId", "tenantId", "version", "envelopeBytes", "r2ObjectKey", "createdAt", "updatedAt", "tombstonedAt", "idempotencyKey"]);
  for (const key of Object.keys(d)) {
    if (!allowed.has(key)) throw new Error(`metadata_unknown_field:${key}`);
    const low = key.toLowerCase();
    for (const f of FORBIDDEN_FIELDS) {
      if (low.includes(f.toLowerCase())) throw new Error(`metadata_forbidden_field:${key}`);
    }
  }
  if (typeof d.objectId !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(d.objectId)) throw new Error("metadata_object_id_invalid");
  if (typeof d.vaultId !== "string" || d.vaultId.length < 1 || d.vaultId.length > 100) throw new Error("metadata_vault_id_invalid");
  if (typeof d.tenantId !== "string" || d.tenantId.length < 1 || d.tenantId.length > 100) throw new Error("metadata_tenant_id_invalid");
  if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) throw new Error("metadata_version_invalid");
  if (typeof d.envelopeBytes !== "number" || !Number.isSafeInteger(d.envelopeBytes) || d.envelopeBytes < 1 || d.envelopeBytes > 64 * 1024 * 1024) throw new Error("metadata_envelope_bytes_invalid");
  if (d.r2ObjectKey !== null && (typeof d.r2ObjectKey !== "string" || !isOpaqueR2Key(d.r2ObjectKey))) throw new Error("metadata_r2_key_invalid");
  if (typeof d.createdAt !== "string" || typeof d.updatedAt !== "string") throw new Error("metadata_timestamp_invalid");
  if (d.tombstonedAt !== null && typeof d.tombstonedAt !== "string") throw new Error("metadata_tombstone_invalid");
  if (d.idempotencyKey !== null && typeof d.idempotencyKey !== "string") throw new Error("metadata_idempotency_invalid");
  // Serializa e verifica padrões de segredo — canário operacional.
  const serialized = JSON.stringify(d);
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(serialized)) throw new Error("metadata_secret_pattern_detected");
  }
}

/** R2 object key deve ser opaco: `v1/<32 hex aleatórios>` — nunca path sensível. */
export function buildR2ObjectKey(): string {
  return `v1/${randomBytes(16).toString("hex")}`;
}

export function isOpaqueR2Key(key: unknown): key is string {
  return typeof key === "string" && /^v1\/[0-9a-f]{32}$/.test(key);
}

/** Digest operacional sobre ciphertext (integridade de transferência) — nunca sobre plaintext. */
export function ciphertextDigest(ciphertextB64Url: string): string {
  return createHash("sha256").update(ciphertextB64Url).digest("hex");
}
