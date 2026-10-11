/**
 * Authorized MCP → local proxy HTTP client.
 * Always targets http://127.0.0.1:21435, refuses redirects, bounds response size.
 */
import { MCP_PROXY_HOST, loopbackProxyUrl } from "./mcp-loopback.ts";
import type { McpSession } from "./mcp-session.ts";
import { assertNoSecretMaterial, redactForToolResult } from "./mcp-redact.ts";

export const MCP_MAX_RESPONSE_BYTES = 1_048_576;

type FetchLike = typeof fetch;

export class McpProxyClient {
  private readonly session: McpSession;
  private readonly fetcher: FetchLike;
  private readonly maxBytes: number;

  constructor(
    session: McpSession,
    fetcher: FetchLike = fetch,
    maxBytes = MCP_MAX_RESPONSE_BYTES,
  ) {
    this.session = session;
    this.fetcher = fetcher;
    this.maxBytes = maxBytes;
  }

  async getJson(path: string, scope: "providers" | "models" | "usage" | "doctor" | "browser"): Promise<unknown> {
    this.session.assertScope(scope === "doctor" ? "doctor" : scope);
    return this.request("GET", path, undefined, scope);
  }

  async postJson(path: string, body: unknown, scope: "chat" | "browser"): Promise<unknown> {
    this.session.assertScope(scope);
    return this.request("POST", path, body, scope);
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, tool: string): Promise<unknown> {
    this.session.assertActive();
    const url = loopbackProxyUrl(path);
    const init: RequestInit = {
      method,
      redirect: "error",
      headers: {
        Host: MCP_PROXY_HOST,
        Accept: "application/json",
        authorization: this.session.bearerAuthorization(),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      this.session.recordTool(tool, false, "mcp_proxy_unavailable");
      throw new Error("mcp_proxy_unavailable");
    }
    const raw = await readBoundedText(response, this.maxBytes);
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try { parsed = JSON.parse(raw); }
      catch {
        this.session.recordTool(tool, false, "mcp_proxy_json_invalid");
        throw new Error("mcp_proxy_json_invalid");
      }
    }
    const safe = redactForToolResult(parsed);
    assertNoSecretMaterial(safe, `mcp_tool_${tool}`);
    if (!response.ok) {
      this.session.recordTool(tool, false, `mcp_proxy_http_${response.status}`);
      const err = new Error(`mcp_proxy_http_${response.status}`);
      (err as Error & { payload?: unknown }).payload = safe;
      throw err;
    }
    this.session.recordTool(tool, true);
    return safe;
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("mcp_proxy_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}
