import { createHash } from "node:crypto";
import type {
  McpEffectClass as W0McpEffectClass,
  McpToolDescriptor as W0McpToolDescriptor,
  McpToolBinding as W0McpToolBinding,
  ToolResultView as W0ToolResultView,
} from "@uptokey/sync-contract/agents-cli";

/** Re-export canonical W0 types for backward compatibility. */
export type McpEffectClass = W0McpEffectClass;
export type McpToolDescriptor = W0McpToolDescriptor;
export type McpToolBinding = Omit<W0McpToolBinding, "schemaVersion">;
export type ToolResultView = W0ToolResultView;

const MAX_TOOLS = 100;
const MAX_PAGES = 20;
const MAX_SCHEMA_BYTES = 256 * 1024;

export function schemaDigest(schema: unknown): string {
  const encoded = JSON.stringify(schema ?? null);
  if (Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES) {
    throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid" });
  }
  return createHash("sha256").update(encoded).digest("hex");
}

export function inferEffectClass(tool: McpToolDescriptor): McpEffectClass {
  const name = tool.name.toLowerCase();
  if (/(write|delete|put|patch|exec|run|shell|install|click|fill|submit|type|evaluate)/.test(name)) return "write";
  if (/(fetch|http|browser|navigate|screenshot)/.test(name)) return "network";
  if (tool.readOnlyHint === true) return "read";
  return "unknown";
}

export function bindMcpTool(
  tool: McpToolDescriptor,
  serverProfileRevision: number,
  transportVersion = "2025-06-18",
): McpToolBinding {
  return {
    serverProfileRevision,
    transportVersion,
    name: tool.name,
    inputSchemaDigest: schemaDigest(tool.inputSchema),
    outputSchemaDigest: tool.outputSchema === undefined ? null : schemaDigest(tool.outputSchema),
    effectClass: inferEffectClass(tool),
    approvedSchemaDigest: null,
  };
}

export function approveToolBinding(binding: McpToolBinding): McpToolBinding {
  return { ...binding, approvedSchemaDigest: binding.inputSchemaDigest };
}

export function assertToolCallAllowed(
  binding: McpToolBinding,
  liveTool: McpToolDescriptor,
  requestedEffect: McpEffectClass,
): void {
  if (!binding.approvedSchemaDigest) {
    throw Object.assign(new Error("mcp_tool_unavailable"), { code: "mcp_tool_unavailable" });
  }
  const live = bindMcpTool(liveTool, binding.serverProfileRevision, binding.transportVersion);
  if (live.inputSchemaDigest !== binding.approvedSchemaDigest) {
    throw Object.assign(new Error("mcp_schema_changed"), { code: "mcp_schema_changed" });
  }
  // 14-04: readOnly hint cannot grant write.
  if (liveTool.readOnlyHint === true && (requestedEffect === "write" || requestedEffect === "exec")) {
    throw Object.assign(new Error("mcp_tool_unavailable"), { code: "mcp_tool_unavailable", reason: "readonly_hint_not_authorization" });
  }
  if (requestedEffect === "write" && binding.effectClass === "read") {
    throw Object.assign(new Error("mcp_tool_unavailable"), { code: "mcp_tool_unavailable" });
  }
}

export interface ToolsListPage {
  tools: McpToolDescriptor[];
  nextCursor: string | null;
}

/**
 * Paginated tools/list — never executes tools/call.
 * Repeated cursor refused; max 100 tools / 20 pages.
 */
export class McpDiscoverySession {
  private readonly all: McpToolDescriptor[];
  private readonly pageSize: number;
  private pagesServed = 0;
  private lastCursor: string | null = null;
  private readonly seenCursors = new Set<string>();

  constructor(tools: McpToolDescriptor[], pageSize = 10) {
    if (tools.length > MAX_TOOLS) throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid" });
    this.all = tools;
    this.pageSize = Math.max(1, Math.min(pageSize, MAX_TOOLS));
  }

  list(cursor: string | null = null): ToolsListPage {
    if (this.pagesServed >= MAX_PAGES) {
      throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid", reason: "page_limit" });
    }
    if (cursor !== null) {
      if (this.seenCursors.has(cursor)) {
        throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid", reason: "cursor_replay" });
      }
      this.seenCursors.add(cursor);
    }
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor && cursor !== String(offset))) {
      throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid" });
    }
    const slice = this.all.slice(offset, offset + this.pageSize);
    this.pagesServed += 1;
    const nextOffset = offset + this.pageSize;
    const nextCursor = nextOffset < this.all.length ? String(nextOffset) : null;
    this.lastCursor = nextCursor;
    return { tools: slice.map((t) => ({ ...t })), nextCursor };
  }

  /** Explicit: discovery never calls tools. */
  get callsExecuted(): number {
    return 0;
  }
}

export function assertResourceUriSafe(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw Object.assign(new Error("mcp_output_invalid"), { code: "mcp_output_invalid" });
  }
  // External http(s) resource does not unlock arbitrary fetch.
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    throw Object.assign(new Error("mcp_tool_unavailable"), { code: "mcp_tool_unavailable", reason: "external_resource_uri" });
  }
  if (parsed.protocol !== "uptokey:" && parsed.protocol !== "file:") {
    throw Object.assign(new Error("mcp_tool_unavailable"), { code: "mcp_tool_unavailable" });
  }
}

export function projectToolResult(
  binding: McpToolBinding,
  attemptId: string,
  payload: { structuredContent?: unknown; text?: string; isError?: boolean; mediaRefs?: string[] },
): ToolResultView {
  return {
    structuredContent: payload.structuredContent ?? null,
    text: payload.text ?? null,
    mediaRefs: [...(payload.mediaRefs ?? [])],
    isError: Boolean(payload.isError),
    provenance: {
      serverProfileRevision: binding.serverProfileRevision,
      toolName: binding.name,
      attemptId,
    },
  };
}
