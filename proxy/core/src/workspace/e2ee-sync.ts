import { isSyncEnvelope } from "@uptokey/sync-contract/envelope";
import { ensureDeviceSyncKeypair, sealConfig, openConfig, type SyncEnvelope } from "../sync-envelope.ts";
import type { SecretStore } from "../secret-store.ts";
import { sharedSinkAuthority, type SinkAccessPolicy } from "./sink-authority.ts";

export interface E2EESyncServiceOptions {
  /** Deny-only retention gate for durable objects; no registration means the core default. */
  sinkPolicy?: SinkAccessPolicy;
  /** Principal whose retention governs local object writes. */
  owner?: string;
}

/**
 * E2EESyncService — Sync opcional E2EE para dados de usuário.
 *
 * Armazena objetos cifrados via o envelope HPKE de sync-envelope.ts
 * (mesma suíte que cifra a config de device), garantindo que apenas o
 * detentor da chave privada do device possa decifrar.
 *
 * O servidor só recebe o envelope serializado (ciphertext + metadados
 * mínimos). Nunca o payload em claro nem a chave privada.
 */
export class E2EESyncService {
  private static readonly PREFIX = "local:sync-data:";
  private readonly secrets: SecretStore;
  private readonly sinkPolicy: SinkAccessPolicy;
  private readonly owner: string;

  constructor(secrets: SecretStore, options?: E2EESyncServiceOptions) {
    this.secrets = secrets;
    this.sinkPolicy = options?.sinkPolicy ?? sharedSinkAuthority();
    this.owner = options?.owner ?? "local";
  }

  async writeObject(
    objectId: string,
    data: unknown,
    context: {
      tenantId: string;
      deviceId: string;
      recipientPublicKey: string;
      configVersion: number;
    },
  ): Promise<void> {
    if (!SYNC_OBJECT_ID.test(objectId)) throw new Error("sync_object_invalid_id");
    this.sinkPolicy.assertSinkAllowed(this.owner, "vault:objects");
    const envelope = await sealConfig(data, {
      tenantId: context.tenantId,
      deviceId: context.deviceId,
      configVersion: context.configVersion,
      recipientPublicKey: context.recipientPublicKey,
    });
    const key = E2EESyncService.PREFIX + objectId;
    await this.secrets.set(key, JSON.stringify(envelope));
  }

  /**
   * Device-to-device transfer path: seals an opaque payload to a paired device's
   * HPKE public key using the same reviewed envelope as writeObject, without
   * writing it to any local or remote store. The caller transports the envelope.
   */
  async sealForDevice(data: unknown, context: {
    tenantId: string;
    deviceId: string;
    recipientPublicKey: string;
    configVersion: number;
  }): Promise<SyncEnvelope> {
    return sealConfig(data, {
      tenantId: context.tenantId,
      deviceId: context.deviceId,
      configVersion: context.configVersion,
      recipientPublicKey: context.recipientPublicKey,
    });
  }

  /** Opens a device-transfer envelope with the recipient device private key. */
  async openFromDevice(envelope: SyncEnvelope, context: {
    tenantId: string;
    deviceId: string;
    recipientPrivateKey: string;
  }): Promise<unknown> {
    return openConfig(envelope, {
      tenantId: context.tenantId,
      deviceId: context.deviceId,
      recipientPrivateKey: context.recipientPrivateKey,
    });
  }

  async readObject(
    objectId: string,
    context: {
      tenantId: string;
      deviceId: string;
      recipientPrivateKey: string;
    },
  ): Promise<unknown> {
    if (!SYNC_OBJECT_ID.test(objectId)) throw new Error("sync_object_invalid_id");
    const key = E2EESyncService.PREFIX + objectId;
    const raw = await this.secrets.get(key);
    // Only absence is not-found; an empty or malformed persisted value is corruption
    // and must not be reported as a missing object nor silently replaced.
    if (raw === undefined) {
      throw new Error("sync_object_not_found");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("sync_object_corrupt");
    }
    if (!isSyncEnvelope(parsed)) {
      throw new Error("sync_object_corrupt");
    }
    return openConfig(parsed, {
      tenantId: context.tenantId,
      deviceId: context.deviceId,
      recipientPrivateKey: context.recipientPrivateKey,
    });
  }
}

export async function getDeviceKeypair(secrets: SecretStore) {
  return ensureDeviceSyncKeypair(secrets);
}

/**
 * Pacote 03 / L4 — dono único dos objetos da rota `/v1/workspace/sync-data/:id`.
 *
 * - Envelope estrito (`isSyncEnvelope` do contrato): campos exatos, base64url canônico,
 *   algoritmo/versão fixos. Qualquer outro objeto — inclusive plaintext — é recusado.
 *   O transporte não prova que o conteúdo foi cifrado; prova só o formato. A cifra real
 *   continua responsabilidade do cliente (e de revisão criptográfica independente).
 * - Versão monotônica com CAS obrigatório: criar exige `expectedVersion: 0`; atualizar
 *   exige a versão atual; conflito devolve 409 com a versão corrente.
 * - DELETE exige CAS e grava tombstone versionado no mesmo registro; recriar exige
 *   `expectedVersion` igual à versão do tombstone (a numeração nunca volta a 1).
 * - Operações por objeto são serializadas no processo (o core é o único escritor).
 */

export type SyncDataRecord =
  | { readonly state: "live"; readonly version: number; readonly deviceId: string; readonly updatedAt: string; readonly envelope: unknown }
  | { readonly state: "tombstone"; readonly version: number; readonly updatedAt: string };

export class SyncDataError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 500;
  readonly currentVersion: number | undefined;
  constructor(code: string, status: 400 | 404 | 409 | 422 | 500, currentVersion?: number) {
    super(code);
    this.status = status;
    this.currentVersion = currentVersion;
  }
}

const SYNC_OBJECT_ID = /^[A-Za-z0-9_-]{3,100}$/;
const MAX_SYNC_VERSION = Number.MAX_SAFE_INTEGER - 1;

export class SyncDataStore {
  private readonly secrets: Pick<SecretStore, "get" | "set" | "delete">;
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly sinkPolicy: SinkAccessPolicy;

  constructor(secrets: Pick<SecretStore, "get" | "set" | "delete">, now: () => Date = () => new Date(), options?: { sinkPolicy?: SinkAccessPolicy }) {
    this.secrets = secrets;
    this.now = now;
    this.sinkPolicy = options?.sinkPolicy ?? sharedSinkAuthority();
  }

  private key(owner: string, objectId: string): string {
    if (!SYNC_OBJECT_ID.test(objectId)) throw new SyncDataError("invalid_request", 400);
    return `sync-data:${owner}:${objectId}`;
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }

  /** Reads the current record, understanding the pre-L4 layout (record + separate ":tombstone" key). */
  private async read(key: string): Promise<SyncDataRecord | undefined> {
    const raw = await this.secrets.get(key);
    if (raw) {
      let value: Record<string, unknown>;
      try { value = JSON.parse(raw) as Record<string, unknown>; } catch { throw new SyncDataError("storage_corruption", 500); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncDataError("storage_corruption", 500);
      const version = value.version;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new SyncDataError("storage_corruption", 500);
      if (value.state === "tombstone") return { state: "tombstone", version, updatedAt: String(value.updatedAt ?? "") };
      // Older writers accepted arbitrary JSON. Preserve those records in place,
      // but never return or silently replace plaintext as a valid sync envelope.
      if ((value.state !== undefined && value.state !== "live") || !isSyncEnvelope(value.envelope)) throw new SyncDataError("storage_corruption", 500);
      return { state: "live", version, deviceId: typeof value.deviceId === "string" ? value.deviceId : "", updatedAt: String(value.updatedAt ?? value.createdAt ?? ""), envelope: value.envelope };
    }
    const legacyTombstone = await this.secrets.get(`${key}:tombstone`);
    if (!legacyTombstone) return undefined;
    try {
      const value = JSON.parse(legacyTombstone) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncDataError("storage_corruption", 500);
      const last = value.lastVersion;
      if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 1 || last > MAX_SYNC_VERSION) throw new SyncDataError("storage_corruption", 500);
      // The legacy delete did not advance the version; the tombstone takes the next one.
      return { state: "tombstone", version: last + 1, updatedAt: String(value.tombstonedAt ?? "") };
    } catch { throw new SyncDataError("storage_corruption", 500); }
  }

  private async write(key: string, record: SyncDataRecord, owner?: string): Promise<void> {
    if (owner !== undefined) this.sinkPolicy.assertSinkAllowed(owner, "cloud:sync_upload");
    await this.secrets.set(key, JSON.stringify(record));
    // The single canonical record is already committed and takes precedence.
    // Removing obsolete legacy metadata must not turn that commit into a false
    // failed write (and provoke retries). A later write retries this cleanup.
    await this.secrets.delete(`${key}:tombstone`).catch(() => undefined);
  }

  async get(owner: string, objectId: string): Promise<SyncDataRecord> {
    const record = await this.read(this.key(owner, objectId));
    if (!record) throw new SyncDataError("sync_object_not_found", 404);
    return record;
  }

  async put(owner: string, objectId: string, input: unknown): Promise<{ version: number }> {
    const key = this.key(owner, objectId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SyncDataError("invalid_request", 400);
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((field) => !["envelope", "expectedVersion", "deviceId"].includes(field))) throw new SyncDataError("invalid_request", 400);
    if (!isSyncEnvelope(body.envelope)) throw new SyncDataError("sync_envelope_invalid", 422);
    const expected = body.expectedVersion;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0 || (expected as number) > MAX_SYNC_VERSION) throw new SyncDataError("expected_version_required", 400);
    const deviceId = body.deviceId === undefined ? "" : body.deviceId;
    if (typeof deviceId !== "string" || (deviceId !== "" && !SYNC_OBJECT_ID.test(deviceId))) throw new SyncDataError("invalid_request", 400);
    return this.serial(key, async () => {
      this.sinkPolicy.assertSinkAllowed(owner, "cloud:sync_upload");
      const current = await this.read(key);
      const currentVersion = current?.version ?? 0;
      if (expected !== currentVersion) throw new SyncDataError("revision_conflict", 409, currentVersion);
      // Never advance past a safe integer: writing an unsafe version would corrupt
      // the record for every future read instead of failing the request.
      if (currentVersion >= MAX_SYNC_VERSION) throw new SyncDataError("sync_version_exhausted", 409, currentVersion);
      const version = currentVersion + 1;
      await this.write(key, { state: "live", version, deviceId, updatedAt: this.now().toISOString(), envelope: body.envelope }, owner);
      return { version };
    });
  }

  async delete(owner: string, objectId: string, input: unknown): Promise<{ version: number }> {
    const key = this.key(owner, objectId);
    const expected = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).expectedVersion : undefined;
    if (!Number.isSafeInteger(expected) || (expected as number) < 1) throw new SyncDataError("expected_version_required", 400);
    if (Object.keys(input as Record<string, unknown>).some(field => field !== "expectedVersion")) throw new SyncDataError("invalid_request", 400);
    return this.serial(key, async () => {
      this.sinkPolicy.assertSinkAllowed(owner, "cloud:sync_upload");
      const current = await this.read(key);
      if (!current) throw new SyncDataError("sync_object_not_found", 404);
      if (current.state === "tombstone" || expected !== current.version) throw new SyncDataError("revision_conflict", 409, current.version);
      if (current.version > MAX_SYNC_VERSION) throw new SyncDataError("sync_version_exhausted", 409, current.version);
      const version = current.version + 1;
      await this.write(key, { state: "tombstone", version, updatedAt: this.now().toISOString() }, owner);
      return { version };
    });
  }
}
