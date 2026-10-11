/**
 * B9 — `uptokey client audience` (local administrative CLI, explicit and reversible).
 *
 *   uptokey client audience <client-id>                                   show registration/transition
 *   uptokey client audience <client-id> tui --expected-revision <n>       pwa(browser-session) → tui
 *   uptokey client audience <client-id> revert --expected-revision <n>    restore recorded audience
 *
 * The expected revision comes from `show`: the operator confirms the exact state being changed.
 * The clientId (data owner) is never changed; tokens and consent key are untouched. Like
 * `client create/revoke`, this runs against the local vault; the daemon re-reads the typed
 * registration on every request and refuses decisions bound to the previous revision.
 */
import type { SecretStore } from "./secret-store.ts";
import { ClientAudienceTransitionError, applyClientAudienceTransition, clientAudienceStatus } from "./workspace/client-audience-transition.ts";
import { ClientRegistrationError } from "./workspace/client-registration.ts";

export type ClientAudienceCommand =
  | { kind: "client_audience"; clientId: string; action: "show" }
  | { kind: "client_audience"; clientId: string; action: "tui" | "revert"; expectedPolicyRevision: number };

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CLIENT_AUDIENCE_USAGE = "Use: uptokey client audience <client-id> [tui|revert --expected-revision <n>]";

/** Parses `client audience ...` arguments (after `client audience`). Undefined = not this command. */
export function parseClientAudienceArgs(args: readonly string[]): ClientAudienceCommand | undefined {
  const [clientId, action, flag, revision, ...extra] = args;
  if (!clientId || !CLIENT_ID.test(clientId) || extra.length) return undefined;
  if (action === undefined) return { kind: "client_audience", clientId, action: "show" };
  if ((action !== "tui" && action !== "revert") || flag !== "--expected-revision" || !revision || !/^[1-9]\d{0,15}$/.test(revision)) return undefined;
  const expectedPolicyRevision = Number(revision);
  if (!Number.isSafeInteger(expectedPolicyRevision)) return undefined;
  return { kind: "client_audience", clientId, action, expectedPolicyRevision };
}

export interface ClientAudienceIo { write(text: string): void; fail(code: string): void }

export async function runClientAudienceCommand(secrets: SecretStore, command: ClientAudienceCommand, io: ClientAudienceIo): Promise<void> {
  try {
    if (command.action === "show") {
      const { registration, transition } = await clientAudienceStatus(secrets, command.clientId);
      if (!registration) { io.fail("client_registration_missing"); return; }
      io.write(`${JSON.stringify({
        clientId: registration.clientId, audience: registration.audience, enrolledVia: registration.enrolledVia,
        policyRevision: registration.policyRevision, projects: registration.projects,
        transition: transition ? { from: transition.from.audience, to: transition.to, transitionedAt: transition.transitionedAt } : null,
      }, null, 2)}\n`);
      return;
    }
    const request = command.action === "tui"
      ? { kind: "transition", clientId: command.clientId, from: "pwa", to: "tui", expectedPolicyRevision: command.expectedPolicyRevision }
      : { kind: "revert", clientId: command.clientId, expectedPolicyRevision: command.expectedPolicyRevision };
    const next = await applyClientAudienceTransition(secrets, request);
    io.write(`Cliente ${next.clientId}: audiência ${next.audience} (revisão ${next.policyRevision}). Mesmo clientId e dono dos dados; reversível com: uptokey client audience ${next.clientId} ${command.action === "tui" ? `revert --expected-revision ${next.policyRevision}` : `tui --expected-revision ${next.policyRevision}`}\n`);
  } catch (error) {
    if (error instanceof ClientAudienceTransitionError) { io.fail(error.code); return; }
    if (error instanceof ClientRegistrationError) { io.fail("client_registration_invalid"); return; }
    throw error;
  }
}
