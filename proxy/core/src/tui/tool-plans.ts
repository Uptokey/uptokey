/**
 * Uptokey TUI — canonical tool proposal helpers.
 *
 * The TUI never executes a tool and never treats model-provided names or
 * arguments as authority. This module only translates the durable proposal
 * artifact produced by a gateway chat run into UI items bound to the proxy's
 * tool-plan endpoint, and validates that exact binding on the way back.
 */
import { parseGatewayChatRequest, parseGatewayToolProposal, type GatewayChatRequest, type GatewayFunctionTool, type GatewayToolProposal } from "@uptokey/sync-contract/gateway";
import type { FilesystemCatalog } from "@uptokey/sync-contract/filesystem";
import { logTurnMetric, PromptCacheTracker, resolveCodingMetricsDir, type CacheableBlock, type CacheHint, type CachedPromptAssembly, type TurnMetricRecord } from "../coding/prompt-cache.ts";
import type { WorkspaceView } from "./workspace.ts";

/** Output budget for a TUI chat plan; the plan binds it and the provider honors it. */
export const TUI_TURN_MAX_TOKENS = 4096;
export const TOOL_PROPOSAL_MEDIA_TYPE = "application/json";
export const TEXT_RESULT_MEDIA_TYPES: readonly string[] = ["text/markdown", "text/plain", "text/csv"];
const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 4000;

/** Only catalogued read-only tools may be proposed; profile/schema digests stay local. */
export function filesystemToolsFromCatalog(catalog: FilesystemCatalog | null): GatewayFunctionTool[] {
  if (!catalog?.available) return [];
  const textAdmitted = catalog.tools.some((tool) => tool.name === "read_text_file");
  return catalog.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.name === "list_directory"
        ? "Propose listing names in a configured local directory. Requires separate human approval."
        : tool.name === "read_text_file"
          ? "Propose reading a bounded window of local text lines, not the whole file. Requires separate human approval."
          : "Propose reading local file metadata, not file content. Requires separate human approval.",
      parameters: {
        type: "object",
        properties: {
          relativePath: { type: "string" },
          ...(tool.name === "read_text_file" && textAdmitted ? { lineLimit: { type: "number" } } : {}),
        },
        required: tool.name === "read_text_file" && textAdmitted ? ["relativePath", "lineLimit"] : ["relativePath"],
        additionalProperties: false,
      },
    },
  }));
}

/** Validate the chat request the same way the core will, before any plan exists. */
export function buildPlanChatRequest(input: {
  model: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  tools: readonly GatewayFunctionTool[];
  maxTokens?: number;
}): GatewayChatRequest {
  const messages = input.messages.map((message) => {
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new Error("tui_chat_role_unsupported");
    }
    return { role: message.role, content: message.content } as const;
  });
  return parseGatewayChatRequest({
    model: input.model,
    messages,
    stream: true,
    max_tokens: input.maxTokens ?? TUI_TURN_MAX_TOKENS,
    // Multiple calls may be proposed; none executes without its own plan and
    // consent, so the provider is not restricted to a single call.
    ...(input.tools.length > 0 ? { tools: [...input.tools], tool_choice: "auto" as const, parallel_tool_calls: true } : {}),
  });
}

export interface CachedPlanChatInput {
  model: string;
  blocks: readonly CacheableBlock[];
  turn: string;
  tools: readonly GatewayFunctionTool[];
  maxTokens?: number;
  conversationId?: string;
  tracker?: PromptCacheTracker;
  metricsDir?: string;
}

export interface CachedPlanChatResult {
  chat: GatewayChatRequest;
  cache: {
    hints: readonly CacheHint[];
    gatewayHeader: CachedPromptAssembly["gatewayHeader"];
    record: TurnMetricRecord;
  };
}

export function buildCachedPlanChatRequest(input: CachedPlanChatInput): CachedPlanChatResult {
  const tracker = input.tracker ?? new PromptCacheTracker({ conversationId: input.conversationId });
  const { assembly, record } = tracker.beginTurn(input.blocks, input.turn);
  const chat = buildPlanChatRequest({ model: input.model, messages: assembly.messages, tools: input.tools, maxTokens: input.maxTokens });
  logTurnMetric(record, input.metricsDir ?? resolveCodingMetricsDir());
  return { chat, cache: { hints: assembly.cacheHints, gatewayHeader: assembly.gatewayHeader, record } };
}

export interface DurableToolProposal {
  artifactId: string;
  sourceRunId: string;
  content: string | null;
  calls: Array<{ callId: string; name: string; arguments: string }>;
}

/** Reads the gateway chat step from the plan and parses the durable proposal artifact. */
export function proposalFromView(view: WorkspaceView, artifactContent: string): DurableToolProposal | null {
  const step = view.plan?.steps.find((item) => item.capabilityId === "inference.chat.9router");
  if (!step || !view.run || !view.artifact || view.artifact.mediaType !== TOOL_PROPOSAL_MEDIA_TYPE) return null;
  const rawChat = step.arguments?.chat;
  const chatValue = rawChat && typeof rawChat === "object" && !Array.isArray(rawChat)
    && (rawChat as Record<string, unknown>).kind === "literal"
    ? (rawChat as Record<string, unknown>).value
    : rawChat;
  let chat: GatewayChatRequest;
  try {
    chat = parseGatewayChatRequest(chatValue);
  } catch {
    return null;
  }
  let proposal: GatewayToolProposal;
  try {
    proposal = parseGatewayToolProposal(JSON.parse(artifactContent), chat.tools);
  } catch {
    return null;
  }
  return {
    artifactId: view.artifact.id,
    sourceRunId: view.run.id,
    content: proposal.content,
    calls: proposal.toolCalls.map((call) => ({ callId: call.id, name: call.function.name, arguments: call.function.arguments })),
  };
}

export function isTextResultArtifact(view: WorkspaceView): boolean {
  return Boolean(view.artifact && TEXT_RESULT_MEDIA_TYPES.includes(view.artifact.mediaType ?? ""));
}

/** Short human summary of exact arguments; never rewrites the arguments themselves. */
export function describeToolArguments(argsJson: string): string {
  try {
    const value = JSON.parse(argsJson) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof value.relativePath === "string") parts.push(value.relativePath);
    if (typeof value.lineLimit === "number" && Number.isSafeInteger(value.lineLimit)) parts.push(`${value.lineLimit} linhas`);
    if (parts.length) return parts.join(" · ");
  } catch { /* fall through to raw preview */ }
  const raw = argsJson.trim();
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw || "(sem argumentos)";
}

/** Actionable state for a call that cannot become a governed plan on this surface. */
export function toolPlanFailureMessage(code: string, name: string): string {
  if (code === "gateway_tool_unavailable") {
    return `Ferramenta "${name}" não está no catálogo executável desta superfície (gateway_tool_unavailable). Nenhuma execução alternativa foi feita.`;
  }
  if (code === "gateway_tool_results_incomplete") {
    return `O resultado durável da ferramenta "${name}" está incompleto para continuar (gateway_tool_results_incomplete). Repita apenas após revisar o estado no proxy.`;
  }
  return `Falha ao preparar o plano de "${name}" (${code}). Nenhuma execução foi feita; a proposta permanece no proxy.`;
}

/** Bounded transcript rendering; the full bytes stay in the canonical artifact. */
export function formatToolResultForTranscript(name: string, content: string, receiptId: string | null): string {
  const bounded = content.length > TRANSCRIPT_TOOL_RESULT_MAX_CHARS
    ? `${content.slice(0, TRANSCRIPT_TOOL_RESULT_MAX_CHARS)}…`
    : content;
  const receipt = receiptId ? `recibo ${receiptId.slice(0, 12)}` : "recibo pendente";
  return `⚙ ${name} · ${receipt}\n${bounded}`;
}
