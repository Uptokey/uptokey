/**
 * B9 — explicit, reversible audience transition of an existing client identity.
 *
 * The clientId never changes, so the data owner (`<namespace>_<clientId>` principal), tokens,
 * enrolled consent key, projects and history stay with the same identity. Nothing here runs
 * automatically: old identities keep working with their recorded audience until the local
 * administrator asks for a transition (CLI `uptokey client audience`). Only the narrowing
 * transitions published by the contract (`CLIENT_AUDIENCE_TRANSITIONS`, today pwa → tui) are
 * accepted. Every change increments policyRevision so decisions bound to the old registration
 * are refused (the guard compares the registration after its awaits).
 *
 * The pre-transition registration is stored in its own vault account BEFORE the registration
 * changes, so revert restores the exact audience/enrolledVia. Vault accounts are not
 * transactional: an interrupted transition leaves the record with the old registration and is
 * completed (or reverted) by repeating the explicit command; it never widens authority.
 */
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import { CLIENT_AUDIENCE_TRANSITIONS, parseClientAudienceTransition, type ClientAudienceTransitionRequest } from "@uptokey/sync-contract/client-keys";
import type { SecretStore } from "../secret-store.ts";
import { serialClientAuthority } from "../client-authority-lock.ts";
import { VALID_AUDIENCES, type ClientAudience } from "./client-access-policy.ts";
import { parseClientRegistration, readClientRegistration, registrationKey, type ClientEnrollmentPath, type StoredClientRegistration } from "./client-registration.ts";

export const audienceTransitionKey = (clientId: string) => `local:client-audience-transition:${clientId}`;

export interface ClientAudienceTransitionRecord {
  readonly schemaVersion: 1;
  readonly clientId: string;
  readonly from: { readonly audience: ClientAudience; readonly enrolledVia: ClientEnrollmentPath; readonly policyRevision: number };
  readonly to: ClientAudience;
  readonly transitionedAt: string;
}

export type ClientAudienceTransitionErrorCode =
  | "audience_transition_invalid"
  | "client_registration_missing"
  | "audience_transition_not_allowed"
  | "policy_revision_conflict"
  | "audience_transition_record_invalid"
  | "audience_transition_missing";

export class ClientAudienceTransitionError extends Error {
  readonly code: ClientAudienceTransitionErrorCode;
  constructor(code: ClientAudienceTransitionErrorCode) { super(code); this.name = "ClientAudienceTransitionError"; this.code = code; }
}

const fail = (code: ClientAudienceTransitionErrorCode): never => { throw new ClientAudienceTransitionError(code); };

function parseTransitionRecord(raw: string, clientId: string): ClientAudienceTransitionRecord {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isDataRecord(value) || Object.keys(value).sort().join(",") !== "clientId,from,schemaVersion,to,transitionedAt") throw new Error();
    const from = value.from;
    if (value.schemaVersion !== 1 || value.clientId !== clientId || !isDataRecord(from) || Object.keys(from).sort().join(",") !== "audience,enrolledVia,policyRevision") throw new Error();
    if (!(VALID_AUDIENCES as readonly unknown[]).includes(from.audience) || !(VALID_AUDIENCES as readonly unknown[]).includes(value.to)) throw new Error();
    if (!CLIENT_AUDIENCE_TRANSITIONS.some((pair) => pair.from === from.audience && pair.to === value.to)) throw new Error();
    if (typeof from.enrolledVia !== "string" || !Number.isSafeInteger(from.policyRevision) || (from.policyRevision as number) < 1) throw new Error();
    if (typeof value.transitionedAt !== "string" || !Number.isFinite(Date.parse(value.transitionedAt))) throw new Error();
    return Object.freeze({ schemaVersion: 1, clientId, from: Object.freeze({ audience: from.audience as ClientAudience, enrolledVia: from.enrolledVia as ClientEnrollmentPath, policyRevision: from.policyRevision as number }), to: value.to as ClientAudience, transitionedAt: value.transitionedAt });
  } catch { return fail("audience_transition_record_invalid"); }
}

export async function readClientAudienceTransition(secrets: SecretStore, clientId: string): Promise<ClientAudienceTransitionRecord | undefined> {
  const raw = await secrets.get(audienceTransitionKey(clientId));
  return raw === undefined ? undefined : parseTransitionRecord(raw, clientId);
}

export interface ClientAudienceStatus {
  readonly registration: StoredClientRegistration | undefined;
  readonly transition: ClientAudienceTransitionRecord | undefined;
}

export async function clientAudienceStatus(secrets: SecretStore, clientId: string): Promise<ClientAudienceStatus> {
  return { registration: await readClientRegistration(secrets, clientId), transition: await readClientAudienceTransition(secrets, clientId) };
}

/**
 * Applies a parsed request (`parseClientAudienceTransition`). The caller is responsible for the
 * administrative authority; this function enforces the published transition table, the exact
 * current audience, CAS on policyRevision and the clientId (owner) invariance.
 */
export async function applyClientAudienceTransition(secrets: SecretStore, input: unknown, now: () => Date = () => new Date()): Promise<StoredClientRegistration> {
  let request: ClientAudienceTransitionRequest;
  try { request = parseClientAudienceTransition(input); } catch { return fail("audience_transition_invalid"); }
  const clientId = request.clientId;
  return serialClientAuthority(secrets, `client:${clientId}`, async () => {
    const current = await readClientRegistration(secrets, clientId);
    if (!current) return fail("client_registration_missing");
    const pending = await readClientAudienceTransition(secrets, clientId);
    if (request.kind === "transition") {
      if (current.policyRevision !== request.expectedPolicyRevision) return fail("policy_revision_conflict");
      if (current.audience !== request.from) return fail("audience_transition_not_allowed");
      // Browser-session provenance is what makes a pwa identity key-bound; other paths are not narrowed here.
      if (current.enrolledVia !== "browser-session") return fail("audience_transition_not_allowed");
      // A record left by an interrupted transition must describe this same starting point.
      if (pending && (pending.from.audience !== current.audience || pending.from.enrolledVia !== current.enrolledVia || pending.to !== request.to)) return fail("audience_transition_record_invalid");
      const record: ClientAudienceTransitionRecord = { schemaVersion: 1, clientId, from: { audience: current.audience, enrolledVia: current.enrolledVia, policyRevision: current.policyRevision }, to: request.to, transitionedAt: now().toISOString() };
      await secrets.set(audienceTransitionKey(clientId), JSON.stringify(record));
      const next = parseClientRegistration({ ...current, audience: request.to, policyRevision: current.policyRevision + 1 });
      await secrets.set(registrationKey(clientId), JSON.stringify(next));
      return next;
    }
    if (!pending) return fail("audience_transition_missing");
    if (current.policyRevision !== request.expectedPolicyRevision) return fail("policy_revision_conflict");
    if (current.audience === pending.from.audience && current.enrolledVia === pending.from.enrolledVia) {
      // Interrupted transition (registration never changed): only the record remains.
      await secrets.delete(audienceTransitionKey(clientId));
      return current;
    }
    if (current.audience !== pending.to || current.enrolledVia !== pending.from.enrolledVia) return fail("audience_transition_record_invalid");
    // Revisions are monotonic: revert is a new revision, never a reuse of the old one.
    const restored = parseClientRegistration({ ...current, audience: pending.from.audience, enrolledVia: pending.from.enrolledVia, policyRevision: current.policyRevision + 1 });
    await secrets.set(registrationKey(clientId), JSON.stringify(restored));
    await secrets.delete(audienceTransitionKey(clientId));
    return restored;
  });
}
