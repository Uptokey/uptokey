/**
 * Pacote 03 / H4–H6 — consumidor real de VaultCrypto, RecoveryEnvelopeService,
 * E2EESyncService e SyncDataStore para mobilidade entre aparelhos.
 *
 * Não cria cofre, formato ou sincronização paralelos: usa a hierarquia VK/DEK
 * existente, o envelope de recuperação versionado, o envelope HPKE de dispositivo
 * e a coleção de objetos opacos do SyncDataStore. Escopo e consentimento são
 * explícitos por operação; nenhuma chave, frase ou material de recuperação é
 * enviado ao transporte de sincronização.
 *
 * Limites declarados: a troca VK/envelope não é transação entre contas do
 * SecretStore (falha após a primeira escrita é reportada como estado parcial);
 * restauração em aparelho distinto e cofre nativo exigem execução fora deste
 * processo e permanecem identificadas no handoff.
 */
import { createECDH, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { MemorySecretStore, type SecretStore } from "../secret-store.ts";
import {withVaultIdentityLock,type VaultIdentityLease} from '../vault-identity-lock.ts';
import { VaultCrypto, type VaultObjectEnvelope } from "../vault-crypto.ts";
import { RecoveryEnvelopeService } from "../recovery-envelope.ts";
import { assertSyncEnvelope, encodeP256PrivateKey, openConfig, sealConfig, type SyncEnvelope } from "../sync-envelope.ts";
import { E2EESyncService, SyncDataError, SyncDataStore, type SyncDataRecord } from "./e2ee-sync.ts";
import { sharedSinkAuthority, type SinkAccessPolicy } from "./sink-authority.ts";

export type VaultErrorCode =
  | "vault_consent_required"
  | "vault_consent_invalid"
  | "vault_identity_conflict"
  | "vault_identity_unavailable"
  | "vault_key_missing_restore_required"
  | "recovery_envelope_not_found"
  | "recovery_envelope_invalid"
  | "recovery_envelope_unsupported_version"
  | "recovery_phrase_invalid"
  | "mobility_bundle_invalid"
  | "mobility_bundle_unsupported_version"
  | "device_transfer_invalid"
  | "hosted_envelope_invalid";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly status: number;
  constructor(code: VaultErrorCode, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "VaultError";
  }
}

export type VaultOperation =
  | "vault:object:seal"
  | "vault:object:open"
  | "vault:recovery:create"
  | "vault:recovery:rotate"
  | "vault:recovery:restore"
  | "vault:recovery:replace"
  | "vault:mobility:export"
  | "vault:mobility:import"
  | "vault:device:export"
  | "vault:device:import"
  | "vault:hosted:push"
  | "vault:hosted:pull";

export interface VaultConsentBinding {
  readonly principalId: string;
  readonly operation: VaultOperation;
  readonly resourceScope: string;
  readonly policyRevision: string;
  readonly expiresAt: number;
}

const CONSENT_TTL_MS = 5 * 60 * 1000;
const CONSENT_CAPACITY = 128;
const PRINCIPAL_ID = /^[A-Za-z0-9_:.@-]{1,200}$/;
const MAX_BUNDLE_CHARS = 16 * 1024 * 1024;

/**
 * In-process one-shot consent grants. The caller is the surface that obtained the
 * explicit human confirmation; this authority only enforces binding, expiry and
 * single use. Cryptographic key possession or Origin never creates a grant.
 */
export class VaultConsentAuthority {
  private readonly pending = new Map<string, VaultConsentBinding>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(binding: Omit<VaultConsentBinding, "expiresAt"> & { expiresAt?: number }): { token: string; binding: VaultConsentBinding } {
    if (typeof binding.principalId !== "string" || !PRINCIPAL_ID.test(binding.principalId)) throw new VaultError("vault_consent_invalid");
    if (typeof binding.resourceScope !== "string" || binding.resourceScope.length > 256) throw new VaultError("vault_consent_invalid");
    if (typeof binding.policyRevision !== "string" || binding.policyRevision.length > 200) throw new VaultError("vault_consent_invalid");
    const now = this.now();
    for (const [token, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(token);
    if (this.pending.size >= CONSENT_CAPACITY) throw new VaultError("vault_consent_invalid");
    const expiresAt = binding.expiresAt ?? now + CONSENT_TTL_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + CONSENT_TTL_MS) throw new VaultError("vault_consent_invalid");
    const token = randomBytes(32).toString("base64url");
    const stored: VaultConsentBinding = {
      principalId: binding.principalId,
      operation: binding.operation,
      resourceScope: binding.resourceScope,
      policyRevision: binding.policyRevision,
      expiresAt,
    };
    this.pending.set(token, stored);
    return { token, binding: stored };
  }

  /** Consumes the grant exactly once. Any divergence is a generic invalid grant. */
  consume(token: string, expected: { principalId: string; operation: VaultOperation; resourceScope: string; policyRevision: string }): void {
    const pending = typeof token === "string" ? this.pending.get(token) : undefined;
    if (pending) this.pending.delete(token);
    if (!pending || pending.expiresAt <= this.now()) throw new VaultError("vault_consent_required", 403);
    const same = pending.principalId === expected.principalId && pending.operation === expected.operation
      && pending.resourceScope === expected.resourceScope && pending.policyRevision === expected.policyRevision;
    if (!same) throw new VaultError("vault_consent_invalid", 403);
  }
}

export interface VaultServiceOptions {
  vaultId?: string;
  tenantScope?: string;
  consent?: VaultConsentAuthority;
  now?: () => number;
  /** Deterministic byte source for tests/vectors only. */
  rng?: (length: number) => Buffer;
  syncData?: SyncDataStore;
  e2ee?: E2EESyncService;
  /** Deny-only retention gate: ephemeral principals never create vault identity or objects. */
  sinkPolicy?: SinkAccessPolicy;
  /** Optional live admission supplied by the native mobility operation. */
  revalidate?:()=>Promise<void>;
}

interface MobilityRecordLive {
  readonly objectId: string;
  readonly state: "live";
  readonly version: number;
  readonly deviceId: string;
  readonly updatedAt: string;
  readonly envelope: unknown;
}
interface MobilityRecordTombstone {
  readonly objectId: string;
  readonly state: "tombstone";
  readonly version: number;
  readonly updatedAt: string;
}
type MobilityRecord = MobilityRecordLive | MobilityRecordTombstone;

interface MobilityCollection {
  readonly schemaVersion: 2;
  readonly kind: "uptokey-mobility-collection";
  readonly exportedAt: string;
  readonly records: readonly MobilityRecord[];
}

interface MobilityBundle {
  readonly schemaVersion: 2;
  readonly kind: "uptokey-mobility-bundle";
  readonly createdAt: string;
  readonly vault: { readonly vaultId: string; readonly tenantScope: string };
  readonly recoveryEnvelope: string;
  readonly payload: VaultObjectEnvelope;
}

interface DeviceTransferPayload {
  readonly schemaVersion: 2;
  readonly kind: "uptokey-device-transfer";
  readonly createdAt: string;
  readonly vaultKey: string;
  readonly recoveryEnvelope?: string;
  readonly collection: MobilityCollection;
}

export interface MobilityImportOutcome {
  readonly objectId: string;
  readonly status: "imported" | "unchanged" | "already_absent" | "conflict_missing_locally" | "conflict_diverged";
}

/** Restore/rotation result. The recovery phrase is returned exactly once and never stored. */
export interface RecoveryCreationResult {
  readonly recoveryPhrase: string;
  readonly envelope: string;
  readonly rotated: boolean;
  readonly vaultKeyFingerprint: string;
}

export class VaultService {
  private readonly secrets:SecretStore;
  private readonly vault: VaultCrypto;
  private readonly recovery: RecoveryEnvelopeService;
  private readonly consent: VaultConsentAuthority;
  private readonly syncData: SyncDataStore;
  private readonly e2ee: E2EESyncService;
  private readonly sinkPolicy: SinkAccessPolicy;
  private readonly now: () => number;
  private readonly vaultIdValue: string;
  private readonly tenantScopeValue: string;
  private readonly revalidate:(()=>Promise<void>)|undefined;

  constructor(secrets: SecretStore, options: VaultServiceOptions = {}) {
    this.secrets=secrets;
    this.now = options.now ?? Date.now;
    this.sinkPolicy = options.sinkPolicy ?? sharedSinkAuthority();
    this.vaultIdValue = options.vaultId ?? "default";
    this.tenantScopeValue = options.tenantScope ?? "personal";
    this.revalidate=options.revalidate;
    this.vault = new VaultCrypto(secrets, {
      vaultId: this.vaultIdValue,
      tenantScope: this.tenantScopeValue,
      ...(options.rng !== undefined ? { rng: options.rng } : {}),
      ...(options.revalidate?{revalidate:options.revalidate}:{}),
    });
    this.recovery = new RecoveryEnvelopeService(secrets, {...(options.rng?{rng:options.rng}:{}),...(options.revalidate?{revalidate:options.revalidate}:{})});
    this.consent = options.consent ?? new VaultConsentAuthority(this.now);
    this.syncData = options.syncData ?? new SyncDataStore(secrets);
    this.e2ee = options.e2ee ?? new E2EESyncService(secrets);
  }

  consentAuthority(): VaultConsentAuthority {
    return this.consent;
  }

  /** Explicit-scope object encryption over the existing VK/DEK hierarchy. */
  async sealObject(input: {
    principalId: string;
    resourceScope: string;
    objectId: string;
    payload: Uint8Array;
    consent: string;
    policyRevision: string;
    objectVersion?: number;
    expiresAt?: string;
  }): Promise<VaultObjectEnvelope> {
    this.consume(input.consent, input.principalId, "vault:object:seal", input.resourceScope, input.policyRevision);
    this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
    await this.requireVaultKey();
    return this.vault.encryptObject(input.objectId, input.payload, {
      ...(input.objectVersion !== undefined ? { objectVersion: input.objectVersion } : {}),
      resourceScope: input.resourceScope,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  async openObject(input: {
    principalId: string;
    resourceScope: string;
    envelope: VaultObjectEnvelope;
    consent: string;
    policyRevision: string;
    objectId?: string;
    objectVersion?: number;
  }): Promise<Uint8Array> {
    this.consume(input.consent, input.principalId, "vault:object:open", input.resourceScope, input.policyRevision);
    return this.vault.decryptObject(input.envelope, {
      ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
      ...(input.objectVersion !== undefined ? { objectVersion: input.objectVersion } : {}),
      resourceScope: input.resourceScope,
    });
  }

  /**
   * Creates (or explicitly rotates) the recovery envelope for this device. A first
   * creation is refused when a vault key is absent but an envelope already exists —
   * that state requires restoration, never a fresh key that would orphan the envelope.
   */
  async createRecovery(input: {
    principalId: string;
    consent: string;
    policyRevision: string;
    rotate?: boolean;
  }): Promise<RecoveryCreationResult> {
    return withVaultIdentityLock(this.secrets,async identityLease=>{
    const rotate = input.rotate === true;
    this.consume(input.consent, input.principalId, rotate ? "vault:recovery:rotate" : "vault:recovery:create", `recovery:${input.principalId}`, input.policyRevision);
    this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
    let existingEnvelope = false;
    try {
      existingEnvelope = await this.recovery.hasRecoveryEnvelope(identityLease);
    } catch {
      throw new VaultError("vault_identity_unavailable", 503);
    }
    if (existingEnvelope && !rotate) throw new VaultError("vault_identity_conflict", 409);
    const key = await this.requireVaultKey(identityLease);
    try {
      const generated = await this.recovery.generateRecoveryEnvelope(key,identityLease);
      return {
        recoveryPhrase: generated.recoveryPhrase,
        envelope: generated.envelope,
        rotated: existingEnvelope,
        vaultKeyFingerprint: fingerprint(key),
      };
    } finally {
      key.fill(0);
    }
    });
  }

  /**
   * Clean-environment restoration of the vault identity from a recovery phrase and
   * an exported envelope. All validation happens on a disposable store first: a
   * wrong phrase or tampered envelope never mutates the target vault.
   */
  async restoreRecovery(input: {
    principalId: string;
    envelope: string;
    recoveryPhrase: string;
    consent: string;
    policyRevision: string;
    replaceConsent?: string;
  }): Promise<{ restored: true; replaced: boolean; vaultKeyFingerprint: string }> {
    this.consume(input.consent, input.principalId, "vault:recovery:restore", `recovery:${input.principalId}`, input.policyRevision);
    this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
    const probe = new MemorySecretStore();
    const probeRecovery = new RecoveryEnvelopeService(probe);
    let key: Buffer;
    try {
      await probeRecovery.importRecoveryEnvelope(input.envelope);
    } catch (error) {
      throw recoveryEnvelopeError(error);
    }
    try {
      key = await probeRecovery.recoverVault(input.recoveryPhrase);
    } catch (error) {
      throw recoveryEnvelopeError(error);
    }
    try{const replaced = await this.applyIdentity({ principalId: input.principalId, key, envelope: input.envelope, replaceConsent: input.replaceConsent, policyRevision: input.policyRevision });
      return { restored: true, replaced, vaultKeyFingerprint: fingerprint(key) };
    }finally{key.fill(0);}
  }

  /**
   * Exports the authorized collection of opaque sync objects plus the recovery
   * envelope. The returned bundle contains ciphertext only; the phrase never
   * travels in it and must be kept by the user.
   */
  async exportMobility(input: {
    principalId: string;
    objectIds: readonly string[];
    consent: string;
    policyRevision: string;
  }): Promise<{ bundle: string; recoveryEnvelope: string; missing: string[]; vaultKeyFingerprint: string }> {
    this.consume(input.consent, input.principalId, "vault:mobility:export", `mobility:${input.principalId}`, input.policyRevision);
    const recoveryEnvelope = await this.recovery.exportRecoveryEnvelope();
    if (!recoveryEnvelope) throw new VaultError("recovery_envelope_not_found", 409);
    const key = await this.requireVaultKey();
    try {
      const { records, missing } = await this.collectRecords(input.principalId, input.objectIds);
      const collection: MobilityCollection = {
        schemaVersion: 2,
        kind: "uptokey-mobility-collection",
        exportedAt: new Date(this.now()).toISOString(),
        records,
      };
      const payload = await this.vault.encryptObject(`mobility:${input.principalId}`, Buffer.from(JSON.stringify(collection), "utf8"), {
        objectVersion: 1,
        resourceScope: `mobility:${input.principalId}`,
      });
      const bundle: MobilityBundle = {
        schemaVersion: 2,
        kind: "uptokey-mobility-bundle",
        createdAt: payload.createdAt,
        vault: { vaultId: payload.vaultId, tenantScope: payload.tenantScope },
        recoveryEnvelope,
        payload,
      };
      return { bundle: JSON.stringify(bundle), recoveryEnvelope, missing, vaultKeyFingerprint: fingerprint(key) };
    } finally {
      key.fill(0);
    }
  }

  /**
   * Imports a mobility bundle into this profile. Existing local objects are never
   * overwritten: diverged versions become explicit outcomes. The vault identity is
   * only replaced with a dedicated `vault:recovery:replace` consent.
   */
  async importMobility(input: {
    principalId: string;
    bundle: string;
    recoveryPhrase: string;
    consent: string;
    policyRevision: string;
    replaceConsent?: string;
    deviceId?: string;
  }): Promise<{ restored: true; replaced: boolean; outcomes: MobilityImportOutcome[]; vaultKeyFingerprint: string }> {
    this.consume(input.consent, input.principalId, "vault:mobility:import", `mobility:${input.principalId}`, input.policyRevision);
    this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
    const bundle = parseMobilityBundle(input.bundle);
    if (bundle.vault.vaultId !== this.vaultIdValue || bundle.vault.tenantScope !== this.tenantScopeValue) throw new VaultError("mobility_bundle_invalid", 403);
    const { key, collection } = await this.openMobilityPayload(bundle.payload, bundle.recoveryEnvelope, input.recoveryPhrase, input.principalId);
    try {
      const replaced = await this.applyIdentity({ principalId: input.principalId, key, envelope: bundle.recoveryEnvelope, replaceConsent: input.replaceConsent, policyRevision: input.policyRevision });
      const outcomes = await this.importRecords(input.principalId, collection.records, input.deviceId);
      return { restored: true, replaced, outcomes, vaultKeyFingerprint: fingerprint(key) };
    } finally {
      key.fill(0);
    }
  }

  /**
   * Device-to-device transfer path (paired device key). The vault key travels only
   * inside the HPKE envelope sealed to the recipient device; it is never written to
   * the sync store, never returned in clear and never logged.
   */
  async exportDeviceTransfer(input: {
    principalId: string;
    recipientPublicKey: string;
    tenantId: string;
    deviceId: string;
    configVersion: number;
    objectIds: readonly string[];
    consent: string;
    policyRevision: string;
  }): Promise<{ envelope: string; missing: string[] }> {
    this.consume(input.consent, input.principalId, "vault:device:export", `mobility:${input.principalId}`, input.policyRevision);
    const key = await this.requireVaultKey();
    try {
      const { records, missing } = await this.collectRecords(input.principalId, input.objectIds);
      const recoveryEnvelope = await this.recovery.exportRecoveryEnvelope();
      const exportedAt = new Date(this.now()).toISOString();
      const payload: DeviceTransferPayload = {
        schemaVersion: 2,
        kind: "uptokey-device-transfer",
        createdAt: exportedAt,
        vaultKey: key.toString("hex"),
        ...(recoveryEnvelope !== undefined ? { recoveryEnvelope } : {}),
        collection: { schemaVersion: 2, kind: "uptokey-mobility-collection", exportedAt, records },
      };
      const envelope = await this.e2ee.sealForDevice(payload, {
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        configVersion: input.configVersion,
        recipientPublicKey: input.recipientPublicKey,
      });
      return { envelope: JSON.stringify(envelope), missing };
    } finally {
      key.fill(0);
    }
  }

  async importDeviceTransfer(input: {
    principalId: string;
    envelope: string;
    recipientPrivateKey: string;
    tenantId: string;
    deviceId: string;
    consent: string;
    policyRevision: string;
    replaceConsent?: string;
  }): Promise<{ restored: true; replaced: boolean; outcomes: MobilityImportOutcome[]; vaultKeyFingerprint: string }> {
    this.consume(input.consent, input.principalId, "vault:device:import", `mobility:${input.principalId}`, input.policyRevision);
    this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
    let payload: DeviceTransferPayload;
    try {
      const parsed = JSON.parse(input.envelope) as unknown;
      const opened = await this.e2ee.openFromDevice(parsed as SyncEnvelope, {
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        recipientPrivateKey: input.recipientPrivateKey,
      });
      payload = parseDeviceTransfer(opened);
    } catch {
      throw new VaultError("device_transfer_invalid", 403);
    }
    if (!/^[0-9a-f]{64}$/.test(payload.vaultKey)) throw new VaultError("device_transfer_invalid", 403);
    const key = Buffer.from(payload.vaultKey, "hex");
    try {
      const replaced = await this.applyIdentity({ principalId: input.principalId, key, envelope: payload.recoveryEnvelope, replaceConsent: input.replaceConsent, policyRevision: input.policyRevision });
      const outcomes = await this.importRecords(input.principalId, payload.collection.records, undefined);
      return { restored: true, replaced, outcomes, vaultKeyFingerprint: fingerprint(key) };
    } finally {
      key.fill(0);
    }
  }

  /**
   * B9-reparo (frente B): canal hospedado derivado da VK. O identificador é público
   * e igual em todo dispositivo com a mesma VK; a VK e a chave privada derivada
   * nunca saem deste serviço.
   */
  async hostedChannelId(): Promise<string> {
    const key = await this.requireVaultKey();
    try { return hostedChannelIdFrom(key); } finally { key.fill(0); }
  }

  /**
   * Cifra no dispositivo: objeto VK/DEK (versão vinculada) dentro de envelope HPKE
   * endereçado ao canal da VK. O resultado é opaco para o transporte B8.
   */
  async sealHostedObject(input: {
    principalId: string;
    objectId: string;
    version: number;
    payload: Uint8Array;
    consent: string;
    policyRevision: string;
  }): Promise<{ envelope: SyncEnvelope; channelId: string }> {
    const key = await this.requireVaultKey();
    try {
      const channelId = hostedChannelIdFrom(key);
      const scope = `hosted:${channelId}`;
      this.consume(input.consent, input.principalId, "vault:hosted:push", scope, input.policyRevision);
      this.sinkPolicy.assertSinkAllowed(input.principalId, "vault:objects");
      this.sinkPolicy.assertSinkAllowed(input.principalId, "cloud:sync_upload");
      if (!Number.isSafeInteger(input.version) || input.version <= 0 || !HOSTED_OBJECT_ID.test(input.objectId)) throw new VaultError("hosted_envelope_invalid", 400);
      const inner = await this.vault.encryptObject(input.objectId, input.payload, { objectVersion: input.version, resourceScope: scope });
      const pair = hostedChannelKeypair(key);
      const envelope = await sealConfig(
        { schema: HOSTED_OBJECT_SCHEMA, objectId: input.objectId, version: input.version, inner: Buffer.from(JSON.stringify(inner), "utf8").toString("hex") },
        { tenantId: this.tenantScopeValue, deviceId: channelId, configVersion: input.version, recipientPublicKey: pair.publicKey, createdAt: new Date(this.now()) },
      );
      return { envelope, channelId };
    } finally {
      key.fill(0);
    }
  }

  /**
   * Autentica HPKE, vínculo objectId/versão e o objeto VK/DEK antes de devolver
   * conteúdo. Qualquer divergência é `hosted_envelope_invalid` sem plaintext.
   */
  async openHostedObject(input: {
    principalId: string;
    objectId: string;
    version: number;
    envelope: unknown;
    consent: string;
    policyRevision: string;
  }): Promise<Uint8Array> {
    const key = await this.requireVaultKey();
    try {
      const channelId = hostedChannelIdFrom(key);
      const scope = `hosted:${channelId}`;
      this.consume(input.consent, input.principalId, "vault:hosted:pull", scope, input.policyRevision);
      const envelope = input.envelope;
      try { assertSyncEnvelope(envelope); } catch { throw new VaultError("hosted_envelope_invalid", 403); }
      if (envelope.config_version !== input.version || envelope.device_id !== channelId) throw new VaultError("hosted_envelope_invalid", 403);
      const pair = hostedChannelKeypair(key);
      let config: unknown;
      try {
        config = await openConfig(envelope, { tenantId: this.tenantScopeValue, deviceId: channelId, recipientPrivateKey: pair.privateKey });
      } catch {
        throw new VaultError("hosted_envelope_invalid", 403);
      }
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new VaultError("hosted_envelope_invalid", 403);
      const record = config as Record<string, unknown>;
      if (Object.keys(record).sort().join(",") !== "inner,objectId,schema,version" || record.schema !== HOSTED_OBJECT_SCHEMA
        || record.objectId !== input.objectId || record.version !== input.version || typeof record.inner !== "string" || !/^(?:[0-9a-f]{2})+$/.test(record.inner)) {
        throw new VaultError("hosted_envelope_invalid", 403);
      }
      try {
        const inner = JSON.parse(Buffer.from(record.inner, "hex").toString("utf8")) as VaultObjectEnvelope;
        return await this.vault.decryptObject(inner, { objectId: input.objectId, objectVersion: input.version, resourceScope: scope });
      } catch {
        throw new VaultError("hosted_envelope_invalid", 403);
      }
    } finally {
      key.fill(0);
    }
  }

  async vaultKeyFingerprint(): Promise<string | undefined> {
    try {
      const key = await this.vault.exportVaultKey();
      try { return fingerprint(key); } finally { key.fill(0); }
    } catch {
      return undefined;
    }
  }

  /** VK must exist. Creating a fresh key is only allowed when no recovery envelope exists. */
  private async requireVaultKey(identityLease?:VaultIdentityLease): Promise<Buffer> {
    return withVaultIdentityLock(this.secrets,async lease=>{
    try {
      return await this.vault.exportVaultKey(lease);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "vault_key_missing") throw new VaultError("vault_identity_unavailable", 503);
    }
    if (await this.recovery.hasRecoveryEnvelope(lease)) throw new VaultError("vault_key_missing_restore_required", 409);
    await this.vault.ensureVaultKey(lease);
    return this.vault.exportVaultKey(lease);
    },identityLease);
  }

  private consume(token: string, principalId: string, operation: VaultOperation, resourceScope: string, policyRevision: string): void {
    this.consent.consume(token, { principalId, operation, resourceScope, policyRevision });
  }

  private async collectRecords(principalId: string, objectIds: readonly string[]): Promise<{ records: MobilityRecord[]; missing: string[] }> {
    const unique = [...new Set(objectIds)];
    const records: MobilityRecord[] = [];
    const missing: string[] = [];
    for (const objectId of unique.sort()) {
      try {
        records.push(toMobilityRecord(objectId, await this.syncData.get(principalId, objectId)));
      } catch (error) {
        if (error instanceof SyncDataError && error.status === 404) { missing.push(objectId); continue; }
        throw error;
      }
    }
    return { records, missing };
  }

  private async openMobilityPayload(payload: VaultObjectEnvelope, recoveryEnvelope: string, recoveryPhrase: string, principalId: string): Promise<{ key: Buffer; collection: MobilityCollection }> {
    const probe = new MemorySecretStore();
    const probeRecovery = new RecoveryEnvelopeService(probe);
    let key: Buffer;
    try {
      await probeRecovery.importRecoveryEnvelope(recoveryEnvelope);
    } catch (error) {
      throw recoveryEnvelopeError(error);
    }
    try {
      key = await probeRecovery.recoverVault(recoveryPhrase);
    } catch (error) {
      throw recoveryEnvelopeError(error);
    }
    try {
      const probeVault = new VaultCrypto(probe, { vaultId: this.vaultIdValue, tenantScope: this.tenantScopeValue });
      await probeVault.restoreVaultKey(key);
      const plaintext = await probeVault.decryptObject(payload, { objectId: payload.objectId, objectVersion: payload.objectVersion, resourceScope: `mobility:${principalId}` });
      return { key, collection: parseCollection(Buffer.from(plaintext).toString("utf8")) };
    } catch (error) {
      key.fill(0);
      if (error instanceof VaultError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("unsupported_envelope_version") || message.includes("unsupported_suite")) throw new VaultError("mobility_bundle_unsupported_version", 409);
      throw new VaultError("mobility_bundle_invalid", 403);
    }
  }

  private async applyIdentity(input: {
    principalId: string;
    key: Buffer;
    envelope?: string;
    replaceConsent?: string;
    policyRevision: string;
  }): Promise<boolean> {
    return withVaultIdentityLock(this.secrets,async identityLease=>{
    await this.revalidate?.();
    let storedKeyHex: string | undefined;
    try {
      const current = await this.vault.exportVaultKey(identityLease);
      storedKeyHex = current.toString("hex");
      current.fill(0);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "vault_key_missing") throw new VaultError("vault_identity_unavailable", 503);
    }
    const keyHex = input.key.toString("hex");
    const keyDiffers = storedKeyHex !== undefined && !constantTimeEqual(storedKeyHex, keyHex);
    const existingEnvelope = input.envelope !== undefined ? await this.recovery.exportRecoveryEnvelope(identityLease) : undefined;
    await this.revalidate?.();this.sinkPolicy.assertSinkAllowed(input.principalId,'vault:objects');
    const envelopeDiffers = input.envelope !== undefined && existingEnvelope !== undefined && existingEnvelope !== input.envelope;
    const replaced = keyDiffers || envelopeDiffers;
    if (replaced && input.replaceConsent === undefined) throw new VaultError("vault_identity_conflict", 409);
    if (replaced) this.consume(input.replaceConsent!, input.principalId, "vault:recovery:replace", `recovery:${input.principalId}`, input.policyRevision);
    let imported=false;
    try{
      if(input.envelope!==undefined&&(existingEnvelope===undefined||envelopeDiffers)){await this.recovery.importRecoveryEnvelope(input.envelope,{replaceExisting:true,identityLease});imported=true;}
      await this.revalidate?.();this.sinkPolicy.assertSinkAllowed(input.principalId,'vault:objects');
      if(storedKeyHex===undefined||keyDiffers)await this.vault.restoreVaultKey(keyHex,{replaceExisting:true,identityLease});
    }catch(error){if(imported&&input.envelope!==undefined)await this.recovery.compensateImport(input.envelope,existingEnvelope,identityLease);throw error;}
    return replaced;
    });
  }

  private async importRecords(principalId: string, records: readonly MobilityRecord[], deviceId?: string): Promise<MobilityImportOutcome[]> {
    const outcomes: MobilityImportOutcome[] = [];
    for (const record of [...records].sort((a, b) => a.objectId.localeCompare(b.objectId))) {
      let current: SyncDataRecord | undefined;
      try {
        current = await this.syncData.get(principalId, record.objectId);
      } catch (error) {
        if (!(error instanceof SyncDataError) || error.status !== 404) throw error;
      }
      if (!current) {
        if (record.state === "tombstone") { outcomes.push({ objectId: record.objectId, status: "already_absent" }); continue; }
        await this.syncData.put(principalId, record.objectId, {
          envelope: record.envelope,
          expectedVersion: 0,
          ...(deviceId !== undefined ? { deviceId } : {}),
        });
        outcomes.push({ objectId: record.objectId, status: "imported" });
        continue;
      }
      if (current.version === record.version && current.state === record.state) { outcomes.push({ objectId: record.objectId, status: "unchanged" }); continue; }
      outcomes.push({
        objectId: record.objectId,
        status: current.version < record.version ? "conflict_missing_locally" : "conflict_diverged",
      });
    }
    return outcomes;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const HOSTED_OBJECT_SCHEMA = "uptokey.hosted-object.v1";
const HOSTED_OBJECT_ID = /^[A-Za-z0-9_:-]{3,100}$/;

function hostedChannelIdFrom(key: Buffer): string {
  return "vault-" + createHash("sha256").update("uptokey-hosted-channel-v1\0").update(key).digest("hex").slice(0, 32);
}

/** Par P-256 determinístico derivado da VK por HKDF; vive só durante a operação. */
function hostedChannelKeypair(key: Buffer): { publicKey: string; privateKey: string } {
  for (let counter = 0; counter < 16; counter += 1) {
    const scalar = Buffer.from(hkdfSync("sha256", key, Buffer.from("uptokey-mobility-sync-v1"), Buffer.from(`hosted-channel-p256:${counter}`), 32));
    try {
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(scalar);
      return { publicKey: ecdh.getPublicKey("base64url"), privateKey: encodeP256PrivateKey(scalar) };
    } catch {
      continue;
    } finally {
      scalar.fill(0);
    }
  }
  throw new VaultError("vault_identity_unavailable", 503);
}

function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function recoveryEnvelopeError(error: unknown): VaultError {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("unsupported_version") || message.includes("unsupported_suite")) return new VaultError("recovery_envelope_unsupported_version", 409);
  if (message.includes("authentication_failed") || message.includes("recovery_phrase_invalid")) return new VaultError("recovery_phrase_invalid", 403);
  if (message.startsWith("recovery_envelope")) return new VaultError("recovery_envelope_invalid", 400);
  return new VaultError("recovery_phrase_invalid", 403);
}

function toMobilityRecord(objectId: string, record: SyncDataRecord): MobilityRecord {
  if (record.state === "tombstone") return { objectId, state: "tombstone", version: record.version, updatedAt: record.updatedAt };
  return { objectId, state: "live", version: record.version, deviceId: record.deviceId, updatedAt: record.updatedAt, envelope: record.envelope };
}

function parseMobilityBundle(raw: string): MobilityBundle {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BUNDLE_CHARS) throw new VaultError("mobility_bundle_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new VaultError("mobility_bundle_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new VaultError("mobility_bundle_invalid");
  const bundle = parsed as Record<string, unknown>;
  const allowed = ["schemaVersion", "kind", "createdAt", "vault", "recoveryEnvelope", "payload"];
  for (const key of Object.keys(bundle)) if (!allowed.includes(key)) throw new VaultError("mobility_bundle_invalid");
  if (bundle.schemaVersion !== 2) throw new VaultError("mobility_bundle_unsupported_version", 409);
  if (bundle.kind !== "uptokey-mobility-bundle") throw new VaultError("mobility_bundle_invalid");
  if (typeof bundle.createdAt !== "string" || !canonicalInstant(bundle.createdAt)) throw new VaultError("mobility_bundle_invalid");
  const vault = bundle.vault as Record<string, unknown> | undefined;
  if (!vault || typeof vault.vaultId !== "string" || typeof vault.tenantScope !== "string") throw new VaultError("mobility_bundle_invalid");
  if (typeof bundle.recoveryEnvelope !== "string" || bundle.recoveryEnvelope.length === 0 || bundle.recoveryEnvelope.length > 8 * 1024) throw new VaultError("mobility_bundle_invalid");
  if (!bundle.payload || typeof bundle.payload !== "object" || Array.isArray(bundle.payload)) throw new VaultError("mobility_bundle_invalid");
  return {
    schemaVersion: 2,
    kind: "uptokey-mobility-bundle",
    createdAt: bundle.createdAt,
    vault: { vaultId: vault.vaultId, tenantScope: vault.tenantScope },
    recoveryEnvelope: bundle.recoveryEnvelope,
    payload: bundle.payload as VaultObjectEnvelope,
  };
}

function parseCollection(raw: string): MobilityCollection {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new VaultError("mobility_bundle_invalid", 403); }
  return parseCollectionValue(parsed);
}

function parseCollectionValue(value: unknown): MobilityCollection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultError("mobility_bundle_invalid", 403);
  const collection = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "kind", "exportedAt", "records"];
  for (const key of Object.keys(collection)) if (!allowed.includes(key)) throw new VaultError("mobility_bundle_invalid", 403);
  if (collection.schemaVersion !== 2) throw new VaultError("mobility_bundle_unsupported_version", 409);
  if (collection.kind !== "uptokey-mobility-collection") throw new VaultError("mobility_bundle_invalid", 403);
  if (typeof collection.exportedAt !== "string" || !canonicalInstant(collection.exportedAt)) throw new VaultError("mobility_bundle_invalid", 403);
  if (!Array.isArray(collection.records) || collection.records.length > 10_000) throw new VaultError("mobility_bundle_invalid", 403);
  const seen = new Set<string>();
  for (const item of collection.records) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new VaultError("mobility_bundle_invalid", 403);
    const record = item as Record<string, unknown>;
    const recordAllowed = ["objectId", "state", "version", "deviceId", "updatedAt", "envelope"];
    for (const key of Object.keys(record)) if (!recordAllowed.includes(key)) throw new VaultError("mobility_bundle_invalid", 403);
    if (typeof record.objectId !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(record.objectId) || seen.has(record.objectId)) throw new VaultError("mobility_bundle_invalid", 403);
    seen.add(record.objectId);
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) throw new VaultError("mobility_bundle_invalid", 403);
    if (typeof record.updatedAt !== "string" || !canonicalInstant(record.updatedAt)) throw new VaultError("mobility_bundle_invalid", 403);
    if (record.state === "tombstone") continue;
    if (record.state !== "live" || typeof record.deviceId !== "string" || !record.envelope) throw new VaultError("mobility_bundle_invalid", 403);
  }
  return collection as unknown as MobilityCollection;
}

function parseDeviceTransfer(value: unknown): DeviceTransferPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultError("device_transfer_invalid", 403);
  const payload = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "kind", "createdAt", "vaultKey", "recoveryEnvelope", "collection"];
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new VaultError("device_transfer_invalid", 403);
  if (payload.schemaVersion !== 2 || payload.kind !== "uptokey-device-transfer") throw new VaultError("device_transfer_invalid", 403);
  if (typeof payload.vaultKey !== "string") throw new VaultError("device_transfer_invalid", 403);
  if (payload.recoveryEnvelope !== undefined && (typeof payload.recoveryEnvelope !== "string" || payload.recoveryEnvelope.length > 8 * 1024)) throw new VaultError("device_transfer_invalid", 403);
  const collection = parseCollectionValue(payload.collection);
  return { ...(payload as unknown as DeviceTransferPayload), collection };
}

function canonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
