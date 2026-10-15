/**
 * Uptokey TUI — State management.
 * Central state store com eventos tipados para o ciclo de vida do TUI.
 */
import { EventEmitter } from "node:events";
import type { ModelDestination } from "./client.ts";
import type { TuiHostedDestination } from "./hosted.ts";

export type ConnectionPhase = "disconnected" | "connecting" | "authenticated" | "expired" | "incompatible" | "error";
export type TurnPhase = "idle" | "composing" | "submitting" | "streaming" | "waiting_tool" | "waiting_approval" | "completed" | "failed" | "cancelling" | "cancelled";
export type ViewMode = "chat" | "editor" | "diff" | "files" | "agents" | "settings" | "help";
export type StoragePolicy = "local" | "temporary";
export type ProcessingPolicy = "local_only" | "external_allowed";

export interface Conversation {
  id: string;
  title?: string;
  updatedAt?: string;
  storagePolicy?: StoragePolicy;
  processingPolicy?: ProcessingPolicy;
}

export interface StreamToolCall {
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error" | "approved" | "rejected";
  result?: string;
  startedAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string; result?: string }>;
  streaming?: boolean;
  interrupted?: "failed" | "cancelled";
  /** Cost in USD for this message (assistant only). */
  cost?: number;
  /** Token counts for this message. */
  tokens?: { input: number; output: number };
  /** Idempotency key recorded by the core (identifies TUI intentions on reload). */
  clientMessageId?: string;
  /** Relative paths of context references persisted with the message. */
  attachments?: string[];
  /** Canonical artifact identity only; bytes are fetched under authorization when needed. */
  mediaAttachments?: Array<{ kind: "image" | "audio"; artifactId: string; name?: string }>;
  /** Present on a canonical compaction summary message. */
  compaction?: { covered: number; throughMessageId: string };
  /** Public admitted route from canonical assistant metadata, never a credential. */
  destination?: ModelDestination;
  /** Verified broker destination retained for reopening, revalidated before the next dispatch. */
  hostedDestination?: TuiHostedDestination;
  hostedRequestId?: string;
  /** Durable tool results (callId, receipt and bounded output). */
  toolResults?: Array<{ callId: string; receiptId: string; output: string }>;
}

export interface TuiState {
  connection: ConnectionPhase;
  coreVersion: string;
  view: ViewMode;
  turn: TurnPhase;
  conversations: Conversation[];
  activeConversation: Conversation | null;
  messages: Message[];
  streamBuffer: string;
  /** Tool calls accumulating during the current streaming turn. */
  streamingToolCalls: StreamToolCall[];
  draft: string;
  models: Array<{ id: string; owned_by?: string }>;
  selectedModel: string;
  connections: Array<{ provider: string; status: string }>;
  storagePolicy: StoragePolicy;
  processingPolicy: ProcessingPolicy;
  error: string | null;
  commandPaletteOpen: boolean;
  projectRoot: string | null;
  activeProject: { id: string; name?: string; rootBindingId?: string; rootPath?: string } | null;
  /** Running token estimate for the active context. */
  estimatedTokens: number;
  /** Cumulative cost for the session (USD). */
  sessionCost: number;
}

export function createInitialState(): TuiState {
  return {
    connection: "disconnected",
    coreVersion: "",
    view: "chat",
    turn: "idle",
    storagePolicy: "local",
    processingPolicy: "local_only",
    conversations: [],
    activeConversation: null,
    messages: [],
    streamBuffer: "",
    streamingToolCalls: [],
    draft: "",
    models: [],
    selectedModel: "",
    connections: [],
    error: null,
    commandPaletteOpen: false,
    projectRoot: null,
    activeProject: null,
    estimatedTokens: 0,
    sessionCost: 0,
  };
}

export type StateEvent =
  | { type: "connection_changed"; phase: ConnectionPhase; version?: string }
  | { type: "view_changed"; view: ViewMode }
  | { type: "turn_changed"; turn: TurnPhase }
  | { type: "storage_policy_changed"; storagePolicy: StoragePolicy }
  | { type: "processing_policy_changed"; processingPolicy: ProcessingPolicy }
  | { type: "conversations_loaded"; conversations: Conversation[] }
  | { type: "conversation_selected"; conversation: Conversation | null }
  | { type: "messages_loaded"; messages: Message[] }
  | { type: "message_added"; message: Message }
  | { type: "stream_delta"; text: string }
  | { type: "stream_tool_call"; toolCall: StreamToolCall }
  | { type: "stream_tool_result"; id: string; result: string; isError: boolean }
  | { type: "stream_complete"; messageId: string; content?: string; cost?: number; tokens?: { input: number; output: number } }
  | { type: "stream_interrupted"; messageId: string; phase: "failed" | "cancelled" }
  | { type: "draft_changed"; draft: string }
  | { type: "models_loaded"; models: Array<{ id: string; owned_by?: string }> }
  | { type: "model_selected"; model: string }
  | { type: "connections_loaded"; connections: Array<{ provider: string; status: string }> }
  | { type: "error"; error: string | null }
  | { type: "command_palette"; open: boolean }
  | { type: "project_root"; root: string | null }
  | { type: "project_selected"; project: { id: string; name?: string; rootBindingId?: string; rootPath?: string } | null }
  | { type: "tokens_updated"; estimated: number }
  | { type: "cost_updated"; delta: number };

export class TuiStore extends EventEmitter {
  state: TuiState;
  /** Selection generation also distinguishes leaving and returning to the same conversation. */
  conversationRevision = 0;

  constructor() {
    super();
    this.state = createInitialState();
  }

  dispatch(event: StateEvent): void {
    switch (event.type) {
      case "connection_changed":
        this.state.connection = event.phase;
        if (event.version) this.state.coreVersion = event.version;
        break;
      case "view_changed":
        this.state.view = event.view;
        this.state.commandPaletteOpen = false;
        break;
      case "turn_changed":
        this.state.turn = event.turn;
        if (event.turn === "idle" || event.turn === "cancelled" || event.turn === "failed") {
          this.state.streamingToolCalls = [];
        }
        break;
      case "storage_policy_changed":
        this.state.storagePolicy = event.storagePolicy;
        break;
      case "processing_policy_changed":
        this.state.processingPolicy = event.processingPolicy;
        break;
      case "conversations_loaded":
        this.state.conversations = event.conversations;
        break;
      case "conversation_selected":
        this.conversationRevision++;
        this.state.activeConversation = event.conversation;
        if (event.conversation?.storagePolicy) this.state.storagePolicy = event.conversation.storagePolicy;
        if (event.conversation?.processingPolicy) this.state.processingPolicy = event.conversation.processingPolicy;
        this.state.turn = "idle";
        this.state.error = null;
        this.state.estimatedTokens = 0;
        this.state.messages = [];
        this.state.streamBuffer = "";
        this.state.streamingToolCalls = [];
        break;
      case "messages_loaded":
        this.state.messages = event.messages;
        // Recompute token estimate
        this.state.estimatedTokens = Math.ceil(
          event.messages.reduce((s, m) => s + m.content.length, 0) / 4
        );
        break;
      case "message_added":
        this.state.messages = [...this.state.messages, event.message];
        this.state.estimatedTokens = Math.ceil(
          this.state.messages.reduce((s, m) => s + m.content.length, 0) / 4
        );
        break;
      case "stream_delta":
        this.state.streamBuffer += event.text;
        break;
      case "stream_tool_call":
        this.state.streamingToolCalls = [
          ...this.state.streamingToolCalls.filter((t) => t.id !== event.toolCall.id),
          event.toolCall,
        ];
        this.state.turn = "waiting_tool";
        break;
      case "stream_tool_result": {
        this.state.streamingToolCalls = this.state.streamingToolCalls.map((t) =>
          t.id === event.id
            ? { ...t, status: event.isError ? "error" : "done", result: event.result }
            : t
        );
        // Check if all tool calls are resolved
        const allDone = this.state.streamingToolCalls.every((t) => t.status !== "running");
        if (allDone) this.state.turn = "streaming";
        break;
      }
      case "stream_interrupted": {
        if (this.state.streamBuffer) {
          this.state.messages = [...this.state.messages, {
            id: event.messageId, role: "assistant", content: this.state.streamBuffer,
            timestamp: new Date().toISOString(), interrupted: event.phase,
          }];
        }
        this.state.streamBuffer = "";
        this.state.streamingToolCalls = [];
        this.state.turn = event.phase;
        break;
      }
      case "stream_complete": {
        const toolCallsForMsg = this.state.streamingToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
          result: tc.result,
        }));
        const finalMsg: Message = {
          id: event.messageId,
          role: "assistant",
          content: event.content ?? this.state.streamBuffer,
          timestamp: new Date().toISOString(),
          toolCalls: toolCallsForMsg.length > 0 ? toolCallsForMsg : undefined,
          cost: event.cost,
          tokens: event.tokens,
        };
        this.state.messages = [...this.state.messages, finalMsg];
        this.state.streamBuffer = "";
        this.state.streamingToolCalls = [];
        this.state.turn = "completed";
        if (event.cost) this.state.sessionCost += event.cost;
        if (event.tokens) {
          this.state.estimatedTokens = Math.ceil(
            this.state.messages.reduce((s, m) => s + m.content.length, 0) / 4
          );
        }
        break;
      }
      case "draft_changed":
        this.state.draft = event.draft;
        break;
      case "models_loaded":
        this.state.models = event.models;
        // Inventory discovery is not activation. The controller restores or
        // explicitly selects both the model and its admitted destination.
        break;
      case "model_selected":
        this.state.selectedModel = event.model;
        break;
      case "connections_loaded":
        this.state.connections = event.connections;
        break;
      case "error":
        this.state.error = event.error;
        break;
      case "command_palette":
        this.state.commandPaletteOpen = event.open;
        break;
      case "project_root":
        this.state.projectRoot = event.root;
        break;
      case "project_selected":
        this.state.activeProject = event.project;
        if (event.project?.rootPath) this.state.projectRoot = event.project.rootPath;
        break;
      case "tokens_updated":
        this.state.estimatedTokens = event.estimated;
        break;
      case "cost_updated":
        this.state.sessionCost += event.delta;
        break;
    }
    this.emit("change", this.state);
  }
}


