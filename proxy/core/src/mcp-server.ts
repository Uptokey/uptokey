/**
 * Uptokey embedded MCP server (stdio).
 * Tools: providers, models, chat, usage, doctor, integrations_list, integrations_copy, skills_preview, skills_manifest, mcp_discover.
 * Never returns provider keys or local tokens to the agent.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { PACKAGE_VERSION } from "./version.ts";
import { McpSession, type McpSessionPublic } from "./mcp-session.ts";
import { McpProxyClient } from "./mcp-proxy-client.ts";
import { assertNoSecretMaterial, redactForAuditLog, redactForToolResult } from "./mcp-redact.ts";
import { MCP_PROXY_ORIGIN } from "./mcp-loopback.ts";
import { integrationProfilesForUi, previewIntegrationCopy, doctorIntegrationSummary } from "./integration-profiles.ts";
import { previewSkillInstall, loadInstalledManifest } from "./skill-install.ts";
import { McpDiscoverySession } from "./mcp-tool-binding.ts";
import type { WorkspaceBrowser } from "./browser-service.ts";

export interface McpServerHandles {
  server: McpServer;
  session: McpSession;
  close: () => Promise<void>;
}

export function createUptokeyMcpServer(
  session: McpSession,
  client: McpProxyClient = new McpProxyClient(session),
  browser?: WorkspaceBrowser,
): McpServerHandles {
  const server = new McpServer({
    name: "uptokey",
    version: PACKAGE_VERSION,
    websiteUrl: "https://uptokey.com",
  }, {
    instructions: [
      "Uptokey MCP exposes local proxy tools only.",
      `All inference traffic targets ${MCP_PROXY_ORIGIN}.`,
      "Provider API keys and local vault tokens are never returned by these tools.",
      "Use doctor before chat if the proxy may be offline.",
    ].join(" "),
  });

  server.registerTool("providers", {
    title: "List providers",
    description: "List configured providers and admission state without secrets or endpoints that embed credentials.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {},
  }, async () => textResult(await projectProviders(client, session)));

  server.registerTool("models", {
    title: "List models",
    description: "List OpenAI-compatible model ids exposed by the local proxy.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {},
  }, async () => textResult(await client.getJson("/v1/models", "models")));

  server.registerTool("usage", {
    title: "Usage metrics",
    description: "Return local usage metrics snapshot (no prompts, no keys).",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {},
  }, async () => textResult(await client.getJson("/v1/usage", "usage")));

  server.registerTool("doctor", {
    title: "Doctor",
    description: "Health and first-run diagnostics for the local proxy session.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {},
  }, async () => textResult(await projectDoctor(client, session)));

  server.registerTool("chat", {
    title: "Chat completion",
    description: "Send a Chat Completions request to the local OpenAI-compatible proxy. Upstream provider keys stay in the OS vault.",
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    inputSchema: {
      model: z.string().min(1).max(200).describe("Model id from the local /v1/models catalog"),
      messages: z.array(z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().max(200_000),
      }).strict()).min(1).max(128),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().max(128_000).optional(),
      stream: z.literal(false).optional().describe("Streaming is not exposed over MCP in v1; omit or false"),
    },
  }, async (args) => {
    const body = {
      model: args.model,
      messages: args.messages,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
      stream: false,
    };
    const completion = await client.postJson("/v1/chat/completions", body, "chat");
    // Return completion metadata + assistant text only; strip any accidental secret-shaped fields.
    return textResult(projectChatResult(completion));
  });

  server.registerTool("integrations_list", {
    title: "List integration profiles",
    description: "List available IDE/agent integration profiles (copy config only; never installs).",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {},
  }, async () => textResult({ profiles: integrationProfilesForUi() }));

  server.registerTool("integrations_copy", {
    title: "Copy integration config",
    description: "Generate copyable config for a verified integration profile (cline, continue, aider). Does not install packages.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {
      profileId: z.enum(["cline", "continue", "aider"]).describe("Integration profile id"),
      baseUrl: z.string().url().optional().describe("Override base URL (default: local proxy)"),
      model: z.string().max(200).optional().describe("Override model id"),
    },
  }, async (args) => {
    const preview = previewIntegrationCopy(args.profileId, args.baseUrl, args.model);
    return textResult({ profile: preview.profile, display: preview.display, copyGeneratesInstall: false });
  });

  server.registerTool("skills_preview", {
    title: "Preview skill install",
    description: "Preview what a skill package would install without writing files. Returns conflicts and would-write list.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {
      targetRoot: z.string().min(1).max(1024).describe("Absolute target directory"),
      pkg: z.object({
        id: z.string().min(1).max(100),
        revision: z.string().min(1).max(100),
        license: z.string().min(1).max(200),
        sourceUrl: z.string().min(1).max(2048),
        entrypoint: z.string().min(1).max(512),
        files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(10_000_000) })).min(1).max(1024),
      }).strict(),
    },
  }, async (args) => {
    const preview = await previewSkillInstall(args.targetRoot, args.pkg);
    return textResult({ preview });
  });

  server.registerTool("skills_manifest", {
    title: "Installed skill manifest",
    description: "Read the installed skill manifest from a target directory (read-only).",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {
      targetRoot: z.string().min(1).max(1024).describe("Absolute target directory"),
    },
  }, async (args) => {
    const manifest = await loadInstalledManifest(args.targetRoot);
    return textResult({ manifest });
  });

  server.registerTool("mcp_discover", {
    title: "MCP tool discovery",
    description: "Paginated discovery of MCP tools from a tool list. Never executes tools/call. Max 100 tools / 20 pages.",
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    inputSchema: {
      tools: z.array(z.object({
        name: z.string().min(1).max(200),
        inputSchema: z.unknown(),
        outputSchema: z.unknown().optional(),
        readOnlyHint: z.boolean().optional(),
      }).passthrough()).max(100),
      pageSize: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(100).nullable().optional(),
    },
  }, async (args) => {
    const session = new McpDiscoverySession(args.tools, args.pageSize ?? 10);
    const page = session.list(args.cursor ?? null);
    return textResult({ tools: page.tools, nextCursor: page.nextCursor, callsExecuted: session.callsExecuted });
  });

  server.registerTool("browser_navigate", {
    title: "Browse URL",
    description: "Navigate to a URL and inspect page content/snapshot using isolated Playwright MCP. Read-only operation without side effects.",
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    inputSchema: {
      url: z.string().url().describe("Target URL to navigate and inspect"),
      maxOutputBytes: z.number().int().positive().max(1_048_576).optional().describe("Output limit in bytes (default: 65536)"),
    },
  }, async (args) => {
    if (browser) {
      const text = await browser.readPage({
        url: args.url,
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        maxOutputBytes: args.maxOutputBytes ?? 65_536,
      });
      return textResult({ url: args.url, snapshot: redactForToolResult(text) });
    }
    const info = await client.getJson("/v1/workspace/browser", "browser");
    return textResult({ url: args.url, browserInfo: redactForToolResult(info) });
  });

  server.registerTool("browser_action_plan", {
    title: "Browser Action Plan (W5 Required)",
    description: "Formulate a sealed W5 Execution Plan for web operations with side effects (filling forms, submitting, clicking). Suspended until explicit user consent is confirmed.",
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    inputSchema: {
      projectId: z.string().min(1).describe("Target workspace project id"),
      expectedRevision: z.number().int().min(1).describe("Expected project revision number"),
      url: z.string().url().describe("Target web URL"),
      fields: z.array(z.object({
        label: z.string().min(1).max(200),
        value: z.string().max(2000),
      })).min(1).describe("Form fields to fill"),
    },
  }, async (args) => {
    const plan = await client.postJson(`/v1/workspace/projects/${encodeURIComponent(args.projectId)}/browser-fill-plans`, {
      expectedRevision: args.expectedRevision,
      request: { url: args.url, fields: args.fields },
    }, "browser");
    return textResult({ status: "awaiting_w5_consent", plan: redactForToolResult(plan) });
  });

  return {
    server,
    session,
    close: async () => {
      await server.close().catch(() => undefined);
      await session.close();
    },
  };
}

export async function runMcpStdio(session: McpSession, secrets?: import("./secret-store.ts").SecretStore): Promise<void> {
  const handles = createUptokeyMcpServer(session);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await handles.server.close().catch(() => undefined);
    await session.close(secrets);
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("beforeExit", () => { void shutdown(); });
  await handles.server.connect(transport);
}

function textResult(payload: unknown) {
  const safe = redactForToolResult(payload);
  assertNoSecretMaterial(safe, "mcp_tool_result");
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
    structuredContent: typeof safe === "object" && safe !== null ? safe as Record<string, unknown> : { value: safe },
  };
}

async function projectProviders(client: McpProxyClient, session: McpSession): Promise<unknown> {
  const connections = await client.getJson("/v1/connections", "providers") as Record<string, unknown>;
  const providers = Array.isArray(connections.providers) ? connections.providers : [];
  return {
    session: publicSession(session),
    observedAt: connections.observedAt ?? null,
    deviceAccess: connections.deviceAccess ?? null,
    providers: providers.map((item) => projectProviderRow(item)),
  };
}

function projectProviderRow(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") return { status: "unknown" };
  const row = item as Record<string, unknown>;
  return redactForToolResult({
    id: row.id ?? row.provider ?? row.name,
    admission: row.admission ?? row.providerAdmission ?? null,
    cooldownMs: row.cooldownMs ?? null,
    configured: row.configured ?? null,
    enabled: row.enabled ?? null,
    // Explicitly omit endpointUrl/apiKey/token fields even if present upstream.
  });
}

async function projectDoctor(client: McpProxyClient, session: McpSession): Promise<unknown> {
  let health: unknown = null;
  let status: unknown = null;
  let usage: unknown = null;
  try { health = await client.getJson("/health", "doctor"); } catch { health = { status: "unreachable" }; }
  try { status = await client.getJson("/local/status", "doctor"); } catch (error) {
    status = { error: error instanceof Error ? error.message : "status_unavailable" };
  }
  try { usage = await client.getJson("/v1/usage", "doctor"); } catch { usage = null; }
  return {
    session: publicSession(session),
    proxyOrigin: MCP_PROXY_ORIGIN,
    health: redactForToolResult(health),
    status: redactForToolResult(status),
    usage: redactForToolResult(usage),
    audit: session.auditTrail().slice(-20).map((event) => redactForAuditLog(event)),
  };
}

function projectChatResult(completion: unknown): unknown {
  if (!completion || typeof completion !== "object") return { ok: false };
  const row = completion as Record<string, unknown>;
  const choices = Array.isArray(row.choices) ? row.choices : [];
  return redactForToolResult({
    id: row.id ?? null,
    model: row.model ?? null,
    choices: choices.map((choice) => {
      if (!choice || typeof choice !== "object") return {};
      const c = choice as Record<string, unknown>;
      const message = c.message && typeof c.message === "object" ? c.message as Record<string, unknown> : null;
      return {
        index: c.index ?? 0,
        finish_reason: c.finish_reason ?? null,
        message: message ? { role: message.role ?? "assistant", content: typeof message.content === "string" ? message.content : null } : null,
      };
    }),
    usage: row.usage ?? null,
  });
}

function publicSession(session: McpSession): McpSessionPublic {
  const view = session.publicView;
  assertNoSecretMaterial(view, "mcp_session_view");
  return view;
}
