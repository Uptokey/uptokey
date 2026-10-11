/**
 * MCP session authorization.
 *
 * A session holds a paired local client token in a non-enumerable private slot.
 * Tool results expose only sessionId, scopes, expiry, and proxy origin — never the token.
 * Bootstrap uses the administrative vault token solely to provision the MCP client; that admin
 * token is also never returned through MCP.
 */
import { randomUUID } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";
import { MCP_PROXY_HOST, MCP_PROXY_ORIGIN, loopbackProxyUrl } from "./mcp-loopback.ts";
import { assertNoSecretMaterial, redactForAuditLog } from "./mcp-redact.ts";

export const MCP_SESSION_TTL_MS = 60 * 60 * 1_000;
export const MCP_SCOPES = ["providers", "models", "chat", "usage", "doctor", "browser"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpSessionPublic {
  sessionId: string;
  clientId: string;
  scopes: readonly McpScope[];
  expiresAt: string;
  proxyOrigin: typeof MCP_PROXY_ORIGIN;
  proxyHost: typeof MCP_PROXY_HOST;
}

export interface McpSessionAuditEvent {
  type: "mcp_session_opened" | "mcp_session_closed" | "mcp_tool_denied" | "mcp_tool_ok" | "mcp_tool_error";
  sessionId?: string;
  tool?: string;
  code?: string;
  at: string;
}

type FetchLike = typeof fetch;

const TOKEN = Symbol("mcp.session.token");
const ADMIN = Symbol("mcp.session.admin");

export class McpSession {
  readonly publicView: McpSessionPublic;
  private readonly [TOKEN]: string;
  private readonly [ADMIN]: string;
  private closed = false;
  private readonly audit: McpSessionAuditEvent[] = [];

  private constructor(publicView: McpSessionPublic, clientToken: string, adminToken: string) {
    this.publicView = Object.freeze({ ...publicView, scopes: Object.freeze([...publicView.scopes]) });
    this[TOKEN] = clientToken;
    this[ADMIN] = adminToken;
    this.record({ type: "mcp_session_opened", sessionId: publicView.sessionId, at: new Date().toISOString() });
  }

  static async open(options: {
    secrets: SecretStore;
    fetcher?: FetchLike;
    ttlMs?: number;
    now?: () => number;
    clientName?: string;
  }): Promise<McpSession> {
    const fetcher = options.fetcher ?? fetch;
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? MCP_SESSION_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1_000) throw new Error("mcp_session_ttl_invalid");

    const admin = await options.secrets.get("local:api-token");
    if (!admin || !/^utk_local_[A-Za-z0-9_-]{32}$/.test(admin)) throw new Error("mcp_admin_token_missing");

    const provisionUrl = loopbackProxyUrl("/local/client/provision");
    let response: Response;
    try {
      response = await fetcher(provisionUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          Host: MCP_PROXY_HOST,
          Accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${admin}`,
        },
        body: JSON.stringify({ clientName: options.clientName ?? "Uptokey MCP", ttlMs }),
      });
    } catch {
      throw new Error("mcp_session_provision_failed_unavailable");
    }
    if (response.status !== 201) throw new Error(`mcp_session_provision_failed_${response.status}`);
    const body = await response.json() as { clientId?: string; token?: string; scope?: string };
    if (typeof body.clientId !== "string" || typeof body.token !== "string") throw new Error("mcp_session_provision_invalid");
    if (!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(body.token)) throw new Error("mcp_session_token_invalid");
    if (body.scope !== "inference") throw new Error("mcp_session_scope_invalid");

    const sessionId = randomUUID();
    const expiresAt = new Date(now() + ttlMs).toISOString();
    const publicView: McpSessionPublic = {
      sessionId,
      clientId: body.clientId,
      scopes: MCP_SCOPES,
      expiresAt,
      proxyOrigin: MCP_PROXY_ORIGIN,
      proxyHost: MCP_PROXY_HOST,
    };
    assertNoSecretMaterial(publicView, "mcp_session_public");
    return new McpSession(publicView, body.token, admin);
  }

  /** Test/helper constructor that never touches the network. */
  static forTests(publicView: McpSessionPublic, clientToken: string, adminToken = "utk_local_" + "a".repeat(32)): McpSession {
    return new McpSession(publicView, clientToken, adminToken);
  }

  bearerAuthorization(): string {
    this.assertActive();
    return `Bearer ${this[TOKEN]}`;
  }

  assertScope(scope: McpScope): void {
    this.assertActive();
    if (!this.publicView.scopes.includes(scope)) {
      this.record({ type: "mcp_tool_denied", sessionId: this.publicView.sessionId, tool: scope, code: "mcp_scope_denied", at: new Date().toISOString() });
      throw new Error("mcp_scope_denied");
    }
  }

  assertActive(now = Date.now()): void {
    if (this.closed) throw new Error("mcp_session_closed");
    if (Date.parse(this.publicView.expiresAt) <= now) throw new Error("mcp_session_expired");
  }

  async close(secrets?: SecretStore, fetcher: FetchLike = fetch): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (secrets) {
        const url = loopbackProxyUrl("/local/client/revoke");
        await fetcher(url, {
          method: "POST",
          redirect: "error",
          headers: {
            Host: MCP_PROXY_HOST,
            Accept: "application/json",
            "content-type": "application/json",
            authorization: this.bearerAuthorizationUnsafe(),
          },
          body: JSON.stringify({ clientId: this.publicView.clientId }),
        }).catch(() => undefined);
      }
    } finally {
      (this as unknown as { [TOKEN]: string })[TOKEN] = "";
      (this as unknown as { [ADMIN]: string })[ADMIN] = "";
      this.record({ type: "mcp_session_closed", sessionId: this.publicView.sessionId, at: new Date().toISOString() });
    }
  }

  /** Only for revoke during close before token wipe — not for tool results. */
  private bearerAuthorizationUnsafe(): string {
    return `Bearer ${this[TOKEN]}`;
  }

  recordTool(tool: string, ok: boolean, code?: string): void {
    this.record({
      type: ok ? "mcp_tool_ok" : "mcp_tool_error",
      sessionId: this.publicView.sessionId,
      tool,
      ...(code ? { code } : {}),
      at: new Date().toISOString(),
    });
  }

  auditTrail(): McpSessionAuditEvent[] {
    return this.audit.map((event) => redactForAuditLog(event));
  }

  private record(event: McpSessionAuditEvent): void {
    this.audit.push(redactForAuditLog(event));
    if (this.audit.length > 200) this.audit.shift();
  }
}
