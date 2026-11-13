import { createHash, randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { withConfigFileLock } from "./config-file-lock.ts";
import { connectionJobsPath, connectionProfilesPath } from "./paths.ts";
import type { SecretStore } from "./secret-store.ts";
import type { ProxyConfig } from "./types.ts";
import {
  assertViewHasNoSecrets,
  CONNECTIONS_SCHEMA_VERSION,
  CONNECTION_LIMITS,
  parseConnectionPatch,
  parseConnectionProfile,
  projectConnectionView,
  type ConnectionAccessMode,
  type ConnectionPatch,
  type ConnectionProfile,
  type ConnectionStatus,
  type ConnectionSupportLevel,
  type ConnectionView,
} from "@uptokey/sync-contract/connections";

export type { ConnectionProfile, ConnectionView };

export interface StoredProfile extends ConnectionProfile {
  id: string;
  createdAt: string;
  updatedAt: string;
  migratedFromLegacy: boolean;
  retiredCredentialRef?: string;
}

interface ProfilesFile {
  schemaVersion: number;
  multicontaEnabled: boolean;
  profiles: StoredProfile[];
  /** operationId → { profileId, revision }: replay não duplica. */
  idempotency: Record<string, { profileId: string; revision: number }>;
  oauthProviders: Record<string, OAuthProviderRegistration>;
  /** profileId → oauth connectionId (refresh/revogação por perfil). */
  oauthBindings: Record<string, string>;
}

export interface OAuthProviderRegistration {
  templateId: string;
  providerId: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  issuer: string;
  allowedScopes: string[];
  termsUrl: string;
  termsCheckedAt: string;
}

export interface ConnectionStateStorage {
  loadProfiles(): Promise<ProfilesFile | null>;
  saveProfiles(state: ProfilesFile, beforeCommit?: () => Promise<void>): Promise<void>;
}

export function fileConnectionStorage(
  profilesPath: string = connectionProfilesPath(),
): ConnectionStateStorage {
  return {
    loadProfiles: () => readJson<ProfilesFile | null>(profilesPath, null),
    saveProfiles: (state, beforeCommit) =>
      withConfigFileLock(profilesPath, () => writeJsonAtomic(profilesPath, state, { beforeCommit })),
  };
}

export function memoryConnectionStorage(): ConnectionStateStorage {
  let state: ProfilesFile | null = null;
  return {
    loadProfiles: async () => state,
    saveProfiles: async (next, beforeCommit) => { if (beforeCommit) await beforeCommit(); state = next; },
  };
}

/** UUID v4 determinístico para o perfil default migrado de cada provedor. */
export function defaultProfileId(providerId: string): string {
  const digest = createHash("sha256").update(`e2-02-default:${providerId}`).digest("hex");
  const chars = digest.slice(0, 32).split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16]!, 16) & 0x3 | 0x8;
  chars[16] = variant.toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function connectionSecretRef(profileId: string): string {
  return `conn:${profileId}`;
}

export function legacySecretRef(providerId: string): string {
  return `provider:${providerId}`;
}

function fail(code: string, status?: number): Error {
  return Object.assign(new Error(code), { code, ...(status === undefined ? {} : { status }) });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function blankFile(): ProfilesFile {
  return { schemaVersion: CONNECTIONS_SCHEMA_VERSION, multicontaEnabled: true, profiles: [], idempotency: {}, oauthProviders: {}, oauthBindings: {} };
}

/** Campos internos (datas, migração) nunca entram no contrato W0. */
function toContract(profile: StoredProfile): ConnectionProfile {
  return {
    schemaVersion: CONNECTIONS_SCHEMA_VERSION as unknown as 1,
    ...(profile.id ? { id: profile.id } : {}),
    revision: profile.revision,
    providerId: profile.providerId,
    label: profile.label,
    accessMode: profile.accessMode,
    enabled: profile.enabled,
    endpointUrl: profile.endpointUrl,
    modelIds: [...profile.modelIds],
    ...(profile.credentialRef ? { credentialRef: profile.credentialRef } : {}),
    ...(profile.commercialAccountId ? { commercialAccountId: profile.commercialAccountId } : {}),
    ...(profile.imageInputModels?.length ? { imageInputModels: [...profile.imageInputModels] } : {}),
    ...(profile.audioInputModels?.length ? { audioInputModels: [...profile.audioInputModels] } : {}),
    ...(profile.toolModels?.length ? { toolModels: [...profile.toolModels] } : {}),
    ...(profile.jsonSchemaModels?.length ? { jsonSchemaModels: [...profile.jsonSchemaModels] } : {}),
    ...(profile.proxyPoolId ? { proxyPoolId: profile.proxyPoolId } : {}),
    priority: profile.priority,
  };
}

export interface ProfileHooks {
  /** Revogar o perfil default migrado também desliga a credencial legada do roteador. */
  onDefaultRevoked?: (providerId: string, hasRemainingEnabledProfiles: boolean) => Promise<void>;
  now?: () => number;
}

const MAX_SECRET_LENGTH = 512;

/**
 * Perfis multicontas E2-02. Fonte de contas; o roteador legado continua lendo
 * `ProxyConfig`/namespace `provider:` — a seleção por conta em inferência é E2-04.
 */
export class ConnectionProfileService {
  private readonly secrets: SecretStore;
  private readonly storage: ConnectionStateStorage;
  private readonly hooks: ProfileHooks;
  private state: ProfilesFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(secrets: SecretStore, storage: ConnectionStateStorage, hooks: ProfileHooks = {}) {
    this.secrets = secrets;
    this.storage = storage;
    this.hooks = hooks;
  }

  private nowIso(): string {
    return new Date(this.hooks.now?.() ?? Date.now()).toISOString();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<ProfilesFile> {
    if (!this.state) {
      const stored = await this.storage.loadProfiles();
      if (stored && stored.schemaVersion === CONNECTIONS_SCHEMA_VERSION) {
        const partial = stored as Partial<ProfilesFile>;
        this.state = {
          schemaVersion: CONNECTIONS_SCHEMA_VERSION,
          multicontaEnabled: partial.multicontaEnabled ?? true,
          profiles: partial.profiles ?? [],
          idempotency: partial.idempotency ?? {},
          oauthProviders: partial.oauthProviders ?? {},
          oauthBindings: partial.oauthBindings ?? {},
        };
      } else {
        this.state = blankFile();
      }
    }
    return this.state;
  }

  private async persist(state: ProfilesFile, beforeCommit?: () => Promise<void>): Promise<void> {
    await this.storage.saveProfiles(state, beforeCommit);
    this.state = state;
  }

  /** Migração transacional do config legado: um perfil default por provedor configurado. */
  async migrateFromLegacy(config: ProxyConfig): Promise<{ created: string[]; skipped: string[] }> {
    return this.exclusive(async () => {
      const state = await this.load();
      const created: string[] = [];
      const skipped: string[] = [];
      // Falha mantém o legado utilizável: só lemos o legado e escrevemos o novo.
      const entries = Object.entries(config.providers as Record<string, {
        configured?: unknown; enabled?: unknown; endpointUrl?: unknown; models?: unknown;
      }>);
      for (const [providerId, item] of entries) {
        if (item?.configured !== true) continue;
        const id = defaultProfileId(providerId);
        const existing = state.profiles.find((p) => p.id === id);
        if (existing) {
          // A profile born from the provider configuration follows it: models, endpoint and switch chosen in the
          // CLI/TUI are the account's (same key, provider:<id>). Profiles the person created stay untouched.
          if (existing.migratedFromLegacy) {
            const models = Array.isArray(item.models) ? item.models.filter((m): m is string => typeof m === "string") : [];
            const endpointUrl = typeof item.endpointUrl === "string" ? item.endpointUrl : undefined;
            const enabled = item.enabled === true;
            if (JSON.stringify(models) !== JSON.stringify(existing.modelIds) || endpointUrl !== existing.endpointUrl || enabled !== existing.enabled) {
              const { createdAt: _c, updatedAt: _u, migratedFromLegacy: _m, ...contract } = existing;
              const next = parseConnectionProfile({ ...contract, modelIds: models, endpointUrl, enabled, revision: existing.revision + 1 });
              Object.assign(existing, next, { id, credentialRef: existing.credentialRef, migratedFromLegacy: true, createdAt: existing.createdAt, updatedAt: this.nowIso() });
            }
          }
          skipped.push(providerId); continue;
        }
        if (state.profiles.length >= CONNECTION_LIMITS.maxConnectionsPerDevice) break;
        const accessMode: ConnectionAccessMode = providerId === "ollama" || providerId === "vllm" ? "local" : "byok";
        // Account-only onboarding configures the adapter without a legacy key.
        // Do not fabricate a provider-wide default beside the actual account.
        if (accessMode !== 'local' && state.profiles.some(p => p.providerId === providerId && !p.migratedFromLegacy) && !await this.secrets.get(legacySecretRef(providerId))) { skipped.push(providerId); continue; }
        if (accessMode === "local" && Array.isArray(item.models) && item.models.length > 0) {
          const accountModels = new Set(state.profiles
            .filter(profile => profile.providerId === providerId && profile.accessMode === "local" &&
              !profile.migratedFromLegacy && profile.endpointUrl === item.endpointUrl)
            .flatMap(profile => profile.modelIds));
          if (item.models.every(model => accountModels.has(model))) { skipped.push(providerId); continue; }
        }
        const profile = parseConnectionProfile({
          schemaVersion: CONNECTIONS_SCHEMA_VERSION,
          id,
          revision: 1,
          providerId,
          label: `${providerId} (default)`,
          accessMode,
          enabled: item.enabled === true,
          endpointUrl: typeof item.endpointUrl === "string" ? item.endpointUrl : undefined,
          modelIds: Array.isArray(item.models) ? item.models : [],
        });
        const stamped: StoredProfile = {
          ...profile,
          id,
          createdAt: this.nowIso(),
          updatedAt: this.nowIso(),
          migratedFromLegacy: true,
          // The provider's own vault entry, not a copy: a key replaced through the CLI/TUI is the key every
          // service uses (a copy kept answering with the revoked key).
          credentialRef: accessMode === "local" ? undefined : legacySecretRef(providerId),
        };
        state.profiles.push(stamped);
        created.push(providerId);
      }
      await this.persist(state);
      return { created, skipped };
    });
  }

  async getActiveProfileForProvider(providerId: string): Promise<StoredProfile | undefined> {
    const profiles = await this.list();
    const candidates = profiles.filter((p) => p.providerId === providerId);
    if (candidates.length === 0) return undefined;
    const enabled = candidates.filter((p) => p.enabled !== false);
    const pool = enabled.length > 0 ? enabled : candidates;
    // A conta marcada principal (priority) dirige o despacho quando não há conta
    // explícita no pedido; empate preserva a criação mais antiga (ordem da lista).
    return pool.reduce((best, profile) => (profile.priority > best.priority ? profile : best));
  }
  /** Keep a funding observation bound to the reviewed profile association through commit. */
  async withCommercialAccount<T>(id: string, revision: number | undefined, operation: (profile: StoredProfile) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const profile = (await this.load()).profiles.find(item => item.id === id);
      if (!profile) throw fail('connection_not_found', 404);
      if (revision !== undefined && profile.revision !== revision) throw fail('revision_conflict', 409);
      if (!profile.commercialAccountId || !['byok', 'custom'].includes(profile.accessMode)) throw fail('connection_account_unbound', 422);
      return operation({...profile, modelIds:[...profile.modelIds]});
    });
  }
  async list(): Promise<StoredProfile[]> {
    const state = await this.load();
    return state.profiles.map((p) => ({ ...p, modelIds: [...p.modelIds] }));
  }

  async get(id: string): Promise<StoredProfile | undefined> {
    if (!isUuid(id)) return undefined;
    const state = await this.load();
    const found = state.profiles.find((p) => p.id === id);
    return found ? { ...found, modelIds: [...found.modelIds] } : undefined;
  }

  /** Last-mile check against this service's live writer-owned state, not a copied
   * authorization result. Callers must first load/read the profile normally.
   * No await may separate this check from dispatch. External process mutations
   * are outside this service's existing single-owner authority boundary. */
  isCurrentIdentity(profile: Pick<StoredProfile, "id" | "revision" | "providerId">): boolean {
    const current = this.state?.profiles.find(item => item.id === profile.id);
    return current?.enabled === true && current.providerId === profile.providerId && current.revision === profile.revision;
  }

  private async readCredentialReferences(ref?: string, fallback?: string): Promise<string | undefined> {
    const value = ref ? await this.secrets.get(ref) : undefined;
    if (typeof value === "string" && value.length > 0) return value;
    const legacy = fallback && fallback !== ref ? await this.secrets.get(fallback) : undefined;
    return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
  }

  private readPresentedCredential(profile: StoredProfile): Promise<string | undefined> {
    return this.readCredentialReferences(profile.credentialRef, profile.migratedFromLegacy ? legacySecretRef(profile.providerId) : undefined);
  }

  private async deleteCredentialIfPresent(ref?: string): Promise<void> {
    if (!ref) return;
    try {
      await this.secrets.delete(ref);
    } catch (error) {
      // Some vaults reject deletion of a missing entry. A previously confirmed
      // cleanup must not prevent another rotation or revocation.
      if (await this.secrets.get(ref) !== undefined) throw error;
    }
  }

  async credentialPresent(profile: StoredProfile): Promise<boolean> {
    return profile.accessMode === "local" || (await this.readPresentedCredential(profile)) !== undefined;
  }

  /** Valor de credencial para sondas autenticadas; nunca vai a logs, views ou exports. */
  async readCredential(profile: StoredProfile): Promise<string | null> {
    const legacy = profile.migratedFromLegacy && profile.accessMode !== "local" ? legacySecretRef(profile.providerId) : undefined;
    return await this.readCredentialReferences(legacy ?? profile.credentialRef, legacy ? profile.credentialRef : undefined) ?? null;
  }

  async accountLabel(profile: StoredProfile): Promise<string> {
    if (profile.accessMode === "local") return profile.providerId;
    return this.formatAccountLabel(profile, await this.readPresentedCredential(profile));
  }

  private formatAccountLabel(profile: StoredProfile, value: string | undefined): string {
    if (!value) return "sem credencial";
    if (profile.accessMode === "oauth") return `conta ••${createHash("sha256").update(value).digest("hex").slice(0, 4)}`;
    return value.length <= 8 ? "conta ••••" : `conta ••${value.slice(-4)}`;
  }

  async projectViews(
    resolve: (profile: StoredProfile, credentialPresent: boolean | undefined) => Promise<{ supportLevel: ConnectionSupportLevel; status: ConnectionStatus }>,
  ): Promise<ConnectionView[]> {
    const state = await this.load();
    const observedAt = this.nowIso();
    const views: ConnectionView[] = [];
    for (const profile of state.profiles) {
      let credentialPresent: boolean | undefined = true;
      let accountLabel = profile.providerId;
      if (profile.accessMode !== "local") {
        try {
          const value = await this.readPresentedCredential(profile);
          credentialPresent = value !== undefined;
          accountLabel = this.formatAccountLabel(profile, value);
        } catch {
          // A vault error is unknown state for this account, not a missing key.
          credentialPresent = undefined;
        }
      }
      const derived = await resolve(profile, credentialPresent);
      const view = projectConnectionView(toContract(profile), {
        credentialPresent: credentialPresent === true,
        accountLabel,
        supportLevel: derived.supportLevel,
        status: profile.enabled ? derived.status : "disabled",
        observedAt,
      });
      assertViewHasNoSecrets(view);
      views.push(view);
    }
    return views;
  }

  async create(input: unknown, secret?: string, operationId?: string, admit?: () => Promise<void>, publishFirstLocal?: () => Promise<void>): Promise<StoredProfile> {
    if (operationId !== undefined && !isUuid(operationId)) throw fail("connection_invalid_profile", 400);
    return this.exclusive(async () => {
      const state = await this.load();
      if (operationId) {
        const replay = state.idempotency[operationId];
        if (replay) {
          const existing = state.profiles.find((p) => p.id === replay.profileId);
          if (existing) {
            await admit?.();
            return { ...existing, modelIds: [...existing.modelIds] };
          }
        }
      }
      if (!state.multicontaEnabled) throw fail("multiconta_disabled", 409);
      if (state.profiles.length >= CONNECTION_LIMITS.maxConnectionsPerDevice) {
        throw fail("connection_limit_exceeded", 429);
      }
      const parsed = parseConnectionProfile(input);
      if (publishFirstLocal && (parsed.accessMode !== "local" || secret !== undefined)) {
        throw fail("connection_invalid_profile", 400);
      }
      await admit?.();
      const id = parsed.id ?? randomUUID();
      if (state.profiles.some((p) => p.id === id)) throw fail("connection_invalid_profile", 400);
      if (secret !== undefined && (typeof secret !== "string" || secret.length > MAX_SECRET_LENGTH)) {
        throw fail("connection_invalid_profile", 400);
      }
      const stamped: StoredProfile = {
        ...parsed,
        id,
        revision: 1,
        createdAt: this.nowIso(),
        updatedAt: this.nowIso(),
        migratedFromLegacy: false,
        ...(secret !== undefined && secret.length > 0 ? { credentialRef: connectionSecretRef(id) } : {}),
      };
      const next: ProfilesFile = { ...state, profiles: [...state.profiles, stamped],
        idempotency: operationId ? { ...state.idempotency, [operationId]: { profileId: id, revision: 1 } } : state.idempotency };
      const ref = stamped.credentialRef;
      try {
        if (ref && secret) await this.secrets.set(ref, secret);
        await admit?.();
        await this.persist(next, admit);
        await publishFirstLocal?.();
      } catch (error) {
        this.state = null;
        if (ref) {
          // An error after rename can leave a committed profile. Keep its key,
          // and also keep the key if storage cannot prove it is unreferenced.
          const referenced = await this.storage.loadProfiles().then(
            latest => latest?.profiles.some(profile => profile.credentialRef === ref) ?? false,
            () => undefined,
          );
          if (referenced === false) await this.secrets.delete(ref);
        }
        if (publishFirstLocal) {
          // The profile writer is still held. Undo only our own addition if
          // runtime configuration declined it, leaving other writers alone.
          try {
            const latest = await this.storage.loadProfiles();
            if (JSON.stringify(latest) === JSON.stringify(next)) await this.persist(state);
            else this.state = null;
          } catch (rollbackError) {
            this.state = null;
            throw new AggregateError([error, rollbackError], "connection_first_local_rollback_failed");
          }
        }
        throw error;
      }
      return { ...stamped, modelIds: [...stamped.modelIds] };
    });
  }

  /** Local service configuration shares the canonical account/key owner. The callback
   * publishes only bounded non-secret binding metadata while this writer queue is held.
   * Compensation is process-local; it is not a transaction across OS credential/file stores. */
  async commitServiceProfile<T>(input:{id?:string;revision?:number;providerId:string;endpointUrl:string;label:string;enabled:boolean;credential?:string;remove?:boolean},admit:()=>Promise<void>,publish:(profile:StoredProfile|undefined)=>Promise<T>):Promise<T>{
    return this.exclusive(async()=>{
      if(!/^service-[a-z][a-z0-9_-]{0,79}$/.test(input.providerId)||input.credential!==undefined&&(typeof input.credential!=='string'||!input.credential||input.credential.length>MAX_SECRET_LENGTH||/[\r\n\0]/.test(input.credential)))throw fail('connection_invalid_profile',400);
      const state=await this.load(),before=structuredClone(state),current=input.id?state.profiles.find(item=>item.id===input.id):undefined;
      if(input.id&&(!current||current.revision!==input.revision||current.providerId!==input.providerId||current.endpointUrl!==input.endpointUrl||current.accessMode!=='byok'))throw fail('revision_conflict',409);
      if(!current&&(!state.multicontaEnabled||state.profiles.length>=CONNECTION_LIMITS.maxConnectionsPerDevice))throw fail('connection_limit_exceeded',429);
      if(!current&&input.remove)throw fail('connection_not_found',404);
      const id=current?.id??randomUUID(),ref=current?.credentialRef??connectionSecretRef(id),previousSecret=await this.secrets.get(ref);
      const credential=input.credential??previousSecret;
      if(!input.remove&&!credential)throw fail('connection_invalid_profile',400);
      const parsed=parseConnectionProfile({schemaVersion:CONNECTIONS_SCHEMA_VERSION,id,revision:(current?.revision??0)+1,providerId:input.providerId,label:input.label,accessMode:'byok',enabled:input.enabled,endpointUrl:input.endpointUrl,modelIds:[],credentialRef:ref,priority:current?.priority??0});
      const profile:StoredProfile={...parsed,id,createdAt:current?.createdAt??this.nowIso(),updatedAt:this.nowIso(),migratedFromLegacy:false,...(current?.retiredCredentialRef?{retiredCredentialRef:current.retiredCredentialRef}:{})};
      let touched=false;
      try{
        await admit();
        if(input.remove)await this.deleteCredentialIfPresent(current?.retiredCredentialRef);
        touched=true;
        if(input.remove)await this.secrets.delete(ref);else if(input.credential!==undefined||!current)await this.secrets.set(ref,credential!);
        await admit();
        state.profiles=state.profiles.filter(item=>item.id!==id);if(!input.remove)state.profiles.push(profile);
        await this.persist(state);await admit();
        const result=await publish(input.remove?undefined:profile);await admit();return result;
      }catch(error){
        if(touched){
          const stored=await this.secrets.get(ref);
          if(stored===credential||input.remove&&stored===undefined){if(previousSecret===undefined)await this.secrets.delete(ref);else await this.secrets.set(ref,previousSecret);}
          // This canonical queue excludes other in-process profile writers. Do not overwrite an unexpected external revision.
          const latest=await this.storage.loadProfiles();
          if(latest&&JSON.stringify(latest.profiles)===JSON.stringify(state.profiles))await this.persist(before);else this.state=null;
        }
        throw error;
      }
    });
  }

  async update(id: string, patchInput: unknown, admit?: () => Promise<void>): Promise<StoredProfile> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.profiles.findIndex((p) => p.id === id);
      if (index < 0) throw fail("connection_not_found", 404);
      const current = state.profiles[index]!;
      const patch: ConnectionPatch = parseConnectionPatch(patchInput);
      if (patch.revision !== current.revision) throw fail("revision_conflict", 409);
      const merged = parseConnectionProfile({
        schemaVersion: CONNECTIONS_SCHEMA_VERSION,
        id: current.id,
        revision: current.revision + 1,
        providerId: current.providerId,
        label: patch.label ?? current.label,
        accessMode: current.accessMode,
        enabled: patch.enabled ?? current.enabled,
        endpointUrl: patch.endpointUrl !== undefined ? patch.endpointUrl : current.endpointUrl,
        modelIds: patch.modelIds ?? current.modelIds,
        ...(current.credentialRef ? { credentialRef: current.credentialRef } : {}),
        ...(patch.commercialAccountId !== undefined
          ? (patch.commercialAccountId === null ? {} : { commercialAccountId: patch.commercialAccountId })
          : (current.commercialAccountId ? { commercialAccountId: current.commercialAccountId } : {})),
        // Declared capabilities (image/audio/tools/json_schema) follow the same patch rule: null clears.
        ...Object.fromEntries((["imageInputModels", "audioInputModels", "toolModels", "jsonSchemaModels"] as const).flatMap(field => {
          const next = patch[field] !== undefined ? patch[field] : current[field];
          return next?.length ? [[field, next]] : [];
        })),
        ...(patch.proxyPoolId !== undefined
          ? (patch.proxyPoolId === null ? {} : { proxyPoolId: patch.proxyPoolId })
          : (current.proxyPoolId ? { proxyPoolId: current.proxyPoolId } : {})),
        priority: patch.priority ?? current.priority,
      });
      const next: StoredProfile = {
        ...merged, id: current.id, createdAt: current.createdAt, updatedAt: this.nowIso(), migratedFromLegacy: current.migratedFromLegacy,
        ...(current.retiredCredentialRef ? { retiredCredentialRef: current.retiredCredentialRef } : {}),
      };
      const profiles = [...state.profiles];
      profiles[index] = next;
      try { await this.persist({ ...state, profiles }, admit); }
      catch (error) { this.state = null; throw error; }
      return { ...next, modelIds: [...next.modelIds] };
    });
  }

  /** Rotação/reconexão de segredo: nunca retorna o valor, só a projeção. */
  async updateSecret(id: string, revision: number, secret: string, operationId?: string): Promise<StoredProfile> {
    if (typeof secret !== "string" || secret.length < 1 || secret.length > MAX_SECRET_LENGTH) {
      throw fail("connection_invalid_profile", 400);
    }
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.profiles.findIndex((p) => p.id === id);
      if (index < 0) throw fail("connection_not_found", 404);
      const current = state.profiles[index]!;
      if (current.accessMode === "local" || current.accessMode === "oauth") throw fail("connection_invalid_profile", 400);
      if (revision !== current.revision) throw fail("revision_conflict", 409);
      if (operationId) {
        const replay = state.idempotency[operationId];
        if (replay && replay.profileId === id) return { ...current, modelIds: [...current.modelIds] };
      }
      const ref = current.migratedFromLegacy
        ? current.credentialRef ?? connectionSecretRef(id)
        : `${connectionSecretRef(id)}:${randomUUID()}`;
      const next: StoredProfile = {
        ...current, credentialRef: ref, revision: current.revision + 1, updatedAt: this.nowIso(),
        ...(!current.migratedFromLegacy && current.credentialRef ? { retiredCredentialRef: current.credentialRef } : {}),
      };
      const updated: ProfilesFile = {
        ...state,
        profiles: state.profiles.map((profile, position) => position === index ? next : profile),
        idempotency: operationId
          ? { ...state.idempotency, [operationId]: { profileId: id, revision: next.revision } }
          : state.idempotency,
      };
      if (current.migratedFromLegacy) {
        await this.secrets.set(ref, secret);
        await this.persist(updated);
        return { ...next, modelIds: [...next.modelIds] };
      }
      // An in-flight request keeps the committed reference until the new revision
      // is visible. An older snapshot can never read from the new key slot.
      await this.deleteCredentialIfPresent(current.retiredCredentialRef);
      try {
        await this.secrets.set(ref, secret);
        await this.persist(updated);
      } catch (error) {
        this.state = null;
        const referenced = await this.storage.loadProfiles().then(
          latest => latest?.profiles.some(profile => profile.credentialRef === ref) ?? false,
          () => undefined,
        );
        if (referenced === false) await this.deleteCredentialIfPresent(ref);
        throw error;
      }
      // The new revision is already committed. Keep the retired reference so
      // the next rotation or revocation can retry a failed vault deletion.
      await this.deleteCredentialIfPresent(next.retiredCredentialRef).catch(() => undefined);
      return { ...next, modelIds: [...next.modelIds] };
    });
  }

  /**
   * Revogar remove a associação local e o segredo do namespace por conexão.
   * Revogar uma conta preserva as demais; tentativas em trânsito não recriam credencial
   * (o refresh OAuth verifica revisão/estado antes de persistir).
   */
  async revoke(id: string, revision: number): Promise<{ revoked: boolean; providerId: string; remote: "skipped" }> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.profiles.findIndex((p) => p.id === id);
      if (index < 0) throw fail("connection_not_found", 404);
      const current = state.profiles[index]!;
      if (revision !== current.revision) throw fail("revision_conflict", 409);
      if (current.migratedFromLegacy) {
        const hasRemainingEnabledProfiles = state.profiles.some(profile => profile.id !== current.id && profile.providerId === current.providerId && profile.enabled);
        await this.hooks.onDefaultRevoked?.(current.providerId, hasRemainingEnabledProfiles);
      }
      // Keep the association until its cleanup is confirmed. A partial failure must
      // not turn a still-present legacy key into the router's unscoped fallback.
      await this.deleteCredentialIfPresent(current.retiredCredentialRef);
      if (current.credentialRef) await this.secrets.delete(current.credentialRef);
      await this.persist({ ...state, profiles: state.profiles.filter(profile => profile.id !== current.id) });
      return { revoked: true, providerId: current.providerId, remote: "skipped" as const };
    });
  }

  async registerOAuthProvider(registration: OAuthProviderRegistration): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      state.oauthProviders[registration.providerId] = registration;
      await this.persist(state);
    });
  }

  async getOAuthProvider(providerId: string): Promise<OAuthProviderRegistration | undefined> {
    const state = await this.load();
    return state.oauthProviders[providerId];
  }

  async bindOAuth(profileId: string, oauthConnectionId: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      state.oauthBindings[profileId] = oauthConnectionId;
      await this.persist(state);
    });
  }

  async oauthBinding(profileId: string): Promise<string | undefined> {
    const state = await this.load();
    return state.oauthBindings[profileId];
  }

  async unbindOAuth(profileId: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      delete state.oauthBindings[profileId];
      await this.persist(state);
    });
  }

  async setMulticontaEnabled(enabled: boolean): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      state.multicontaEnabled = enabled;
      await this.persist(state);
    });
  }

  /** Jobs usam o file de jobs; este acesso existe para o cancelamento em cascata. */
  jobsPath(): string {
    return connectionJobsPath();
  }
}
