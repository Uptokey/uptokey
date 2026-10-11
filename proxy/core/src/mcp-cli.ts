/**
 * `uptokey mcp` — stdio MCP server entry.
 */
import { createOfficialSecretStore, assertSecretStoreBoundary } from "./secret-store.ts";
import { McpSession } from "./mcp-session.ts";
import { runMcpStdio } from "./mcp-server.ts";
import { publicCliFailure } from "./cli-error.ts";
import { stderr } from "node:process";
import { writeProcessOutput } from "./process-output.ts";

export async function runMcpCommand(): Promise<void> {
  const secrets = createOfficialSecretStore();
  assertSecretStoreBoundary(secrets.securityBoundary());
  const session = await McpSession.open({ secrets });
  // Session public metadata only on stderr (never the token). Stdio stdout is reserved for MCP framing.
  writeProcessOutput(stderr, `uptokey mcp session ${session.publicView.sessionId} → ${session.publicView.proxyOrigin}\n`);
  try {
    await runMcpStdio(session, secrets);
  } catch (error) {
    await session.close(secrets).catch(() => undefined);
    throw error;
  }
}

export function formatMcpCliFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "mcp_admin_token_missing") {
      return "mcp_admin_token_missing: run `uptokey start` once so the local admin token exists in the OS vault";
    }
    if (error.message === "mcp_session_provision_failed_unavailable" || error.message.startsWith("mcp_session_provision_failed_")) {
      return `${error.message}: proxy must be listening on http://127.0.0.1:21435 before uptokey mcp`;
    }
    if (error.message.startsWith("mcp_")) return error.message;
  }
  return publicCliFailure(error);
}
