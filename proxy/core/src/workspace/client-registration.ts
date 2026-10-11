/**
 * Pacote 03 / L1 — registro tipado e persistido de cliente workspace.
 *
 * A audiência de um cliente é fixada pelo fluxo que o admitiu (sessão de navegador
 * assinada, pareamento aprovado por humano, provisionamento administrativo) e
 * gravada aqui. O guard consome este registro, não o nome de exibição. O fluxo
 * de pareamento ainda deriva a audiência do rótulo declarado; substituí-lo por
 * concessão tipada visível na aprovação permanece necessário. Registros ausentes
 * seguem o adaptador de legado; registros inválidos são preservados e recusados.
 */
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import type { SecretStore } from "../secret-store.ts";
import { serialClientAuthority } from '../client-authority-lock.ts';
import { VALID_AUDIENCES, type ClientAudience } from "./client-access-policy.ts";

export const CLIENT_REGISTRATION_SCHEMA_VERSION = 1;
export type ClientEnrollmentPath = "browser-session" | "pairing" | "provision" | "legacy-migration";
const ENROLLMENT_PATHS: readonly ClientEnrollmentPath[] = ["browser-session", "pairing", "provision", "legacy-migration"];
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredClientRegistration {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly audience: ClientAudience;
  readonly enrolledVia: ClientEnrollmentPath;
  /** Monotonic; revoking or narrowing grants increments it so stale decisions are refused. */
  readonly policyRevision: number;
  /** Projects this client may touch; "*" = every project of its principal. */
  readonly projects: "*" | readonly string[];
  readonly createdAt: string;
  /** Exact extension origin admitted in the administrator-approved pairing. */
  readonly browserOrigin?: string;
}

export const registrationKey = (clientId: string) => `local:client-reg:${clientId}`;

export class ClientRegistrationError extends Error {
  constructor() { super("client_registration_invalid"); this.name = "ClientRegistrationError"; }
}

export function parseClientRegistration(value: unknown): StoredClientRegistration {
  if (!isDataRecord(value)) throw new Error("client_registration_invalid");
  const allowed = ["schemaVersion", "clientId", "audience", "enrolledVia", "policyRevision", "projects", "createdAt"];
  if (Object.keys(value).some((key) => !allowed.includes(key) && key !== "browserOrigin") || allowed.some((key) => !Object.hasOwn(value, key))) throw new Error("client_registration_invalid");
  if (value.browserOrigin !== undefined && (value.audience !== 'browser-extension' || typeof value.browserOrigin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}$/.test(value.browserOrigin))) throw new Error("client_registration_invalid");
  if (value.schemaVersion !== CLIENT_REGISTRATION_SCHEMA_VERSION) throw new Error("client_registration_version_unsupported");
  if (typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) throw new Error("client_registration_invalid");
  if (typeof value.audience !== "string" || !(VALID_AUDIENCES as readonly string[]).includes(value.audience)) throw new Error("client_registration_invalid");
  if (typeof value.enrolledVia !== "string" || !(ENROLLMENT_PATHS as readonly string[]).includes(value.enrolledVia)) throw new Error("client_registration_invalid");
  if (!Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) < 1) throw new Error("client_registration_invalid");
  const projects = value.projects;
  if (projects !== "*" && !(Array.isArray(projects) && projects.length <= 256 && projects.every((id) => typeof id === "string" && id.length >= 1 && id.length <= 200))) throw new Error("client_registration_invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("client_registration_invalid");
  return Object.freeze({
    schemaVersion: 1, clientId: value.clientId, audience: value.audience as ClientAudience,
    enrolledVia: value.enrolledVia as ClientEnrollmentPath, policyRevision: value.policyRevision as number,
    projects: projects === "*" ? "*" : Object.freeze([...(projects as string[])]), createdAt: value.createdAt,
    ...(typeof value.browserOrigin === 'string' ? { browserOrigin: value.browserOrigin } : {}),
  });
}

export async function readClientRegistration(secrets: SecretStore, clientId: string): Promise<StoredClientRegistration | undefined> {
  const raw = await secrets.get(registrationKey(clientId));
  if (raw === undefined) return undefined;
  try {
    const record = parseClientRegistration(JSON.parse(raw));
    if (record.clientId !== clientId) throw new ClientRegistrationError();
    return record;
  } catch { throw new ClientRegistrationError(); }
}

/**
 * Records the audience admitted by an enrollment path. Re-enrollment of the same client
 * keeps its revision and project grants; a different audience for an existing client is
 * refused rather than silently switched.
 */
export async function recordClientEnrollment(secrets: SecretStore, input: { clientId: string; audience: ClientAudience; enrolledVia: ClientEnrollmentPath; projects?: "*" | readonly string[]; now?: Date; browserOrigin?: string }): Promise<StoredClientRegistration> {
  return serialClientAuthority(secrets, `client:${input.clientId}`, async () => {
  const existing = await readClientRegistration(secrets, input.clientId);
  if (existing) {
    if (existing.audience !== input.audience || existing.browserOrigin !== input.browserOrigin) throw new Error("client_audience_conflict");
    return existing;
  }
  const record = parseClientRegistration({
    schemaVersion: 1, clientId: input.clientId, audience: input.audience, enrolledVia: input.enrolledVia,
    policyRevision: 1, projects: input.projects ?? "*", createdAt: (input.now ?? new Date()).toISOString(),
    ...(input.browserOrigin ? { browserOrigin: input.browserOrigin } : {}),
  });
  await secrets.set(registrationKey(input.clientId), JSON.stringify(record));
  return record;
  });
}

/** Increments the policy revision (revoke/narrow); decisions bound to the old revision are refused. */
export async function bumpClientPolicyRevision(secrets: SecretStore, clientId: string, projects?: "*" | readonly string[]): Promise<StoredClientRegistration | undefined> {
  return serialClientAuthority(secrets, `client:${clientId}`, async () => {
  const existing = await readClientRegistration(secrets, clientId);
  if (!existing) return undefined;
  const next = parseClientRegistration({ ...existing, policyRevision: existing.policyRevision + 1, projects: projects ?? existing.projects });
  await secrets.set(registrationKey(clientId), JSON.stringify(next));
  return next;
  });
}

/**
 * Historical compatibility mapping, only for clients issued before typed records.
 * Never use this label-based mapping for new enrollment or pairing approval.
 */
export function declaredPairingAudience(clientName: string): ClientAudience {
  const name = clientName.trim().toLowerCase();
  if (name === "vs code" || name === "vscode" || name.startsWith("vs code ") || name.startsWith("uptokey vs code")) return "vscode";
  if (name === "uptokey chrome" || name === "uptokey browser extension" || name.startsWith("uptokey chrome ")) return "browser-extension";
  if (name === "uptokey desktop" || name.startsWith("uptokey desktop ") || name === "tauri desktop") return "tauri";
  return "legacy";
}

/**
 * Explicit migration for clients issued before registrations existed. The mapping is
 * the one the previous guard enforced, never broader: a browser-session key without a
 * name is a PWA enrollment; a recognized legacy name keeps its surface; anything else
 * (including names the old guard let through unchecked) becomes "legacy".
 */
export async function migrateUnregisteredClient(secrets: SecretStore, clientId: string): Promise<StoredClientRegistration> {
  const name = await secrets.get(`local:client:${clientId}:name`);
  const hasBrowserKey = !!(await secrets.get(`local:client:${clientId}:workspace-key`));
  // Only BrowserSessionService issues tokens without a name and with a workspace key:
  // that record is a browser-session enrollment and keeps being one.
  if (!name && hasBrowserKey) return recordClientEnrollment(secrets, { clientId, audience: "pwa", enrolledVia: "browser-session" });
  const audience: ClientAudience = name ? (declaredPairingAudience(name) !== "legacy" ? declaredPairingAudience(name) : legacyNameAudience(name)) : "legacy";
  return recordClientEnrollment(secrets, { clientId, audience, enrolledVia: "legacy-migration" });
}

/** Mapping of the retired name-based guard, kept only for one-time migration of old records. */
function legacyNameAudience(clientName: string): ClientAudience {
  const name = clientName.toLowerCase();
  if (/vs\s?code/.test(name)) return "vscode";
  if (/browser-extension/.test(name)) return "browser-extension";
  if (/tauri|desktop/.test(name)) return "tauri";
  if (/pwa|browser|web/.test(name)) return "pwa";
  return "legacy";
}
