import test from "node:test";
import assert from "node:assert/strict";
import { McpSession } from "../src/mcp-session.ts";
import { McpProxyClient } from "../src/mcp-proxy-client.ts";
import { createUptokeyMcpServer } from "../src/mcp-server.ts";
import { assertNoSecretMaterial } from "../src/mcp-redact.ts";

function sessionFixture() {
  return McpSession.forTests({
    sessionId: "00000000-0000-4000-8000-000000000099",
    clientId: "11111111-1111-4111-8111-111111111111",
    scopes: ["providers", "models", "chat", "usage", "doctor"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    proxyOrigin: "http://127.0.0.1:21435",
    proxyHost: "127.0.0.1:21435",
  }, "utk_local_11111111-1111-4111-8111-111111111111.abcdefghijklmnopqrstuvwxyz012345");
}

test("proxy client redacts secrets and records auth failures", async () => {
  const session = sessionFixture();
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ id: "groq/model" }],
    authorization: "Bearer utk_local_abcdefghijklmnopqrstuvwxyz012345",
  }), { status: 200, headers: { "content-type": "application/json" } });
  const client = new McpProxyClient(session, fetcher);
  const body = await client.getJson("/v1/models", "models") as { authorization?: string; data: unknown };
  assert.equal(body.authorization, "[redacted]");
  assert.doesNotThrow(() => assertNoSecretMaterial(body));
});

test("unauthorized proxy responses do not leak tokens in thrown payload", async () => {
  const session = sessionFixture();
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    error: { type: "unauthorized", token: "utk_local_abcdefghijklmnopqrstuvwxyz012345" },
  }), { status: 401, headers: { "content-type": "application/json" } });
  const client = new McpProxyClient(session, fetcher);
  await assert.rejects(() => client.getJson("/v1/usage", "usage"), /mcp_proxy_http_401/);
});

test("server close shuts down without exposing session token", async () => {
  const session = sessionFixture();
  const handles = createUptokeyMcpServer(session);
  const serialized = JSON.stringify(session.publicView);
  assert.equal(serialized.includes("abcdefghijklmnopqrstuvwxyz012345"), false);
  await handles.close();
  assert.throws(() => session.bearerAuthorization(), /mcp_session_closed/);
});
