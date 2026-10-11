export const CONVERSATION_SCHEMA_VERSION = 1;
export const CONVERSATION_CONTRACT_VERSION = 1;
export const CONVERSATION_TITLE_MIN = 1;
export const CONVERSATION_TITLE_MAX = 160;
export const CONVERSATION_MESSAGE_TEXT_MAX_BYTES = 65536;
export const CONVERSATION_MAX_PARTS_PER_MESSAGE = 32;
export const CONVERSATION_LIST_DEFAULT_LIMIT = 50;
export const CONVERSATION_LIST_MAX_LIMIT = 200;
export const CONVERSATION_MAX_MESSAGES_PER_CONVERSATION = 100000;
export const CONVERSATION_CLIENT_MESSAGE_ID_MAX = 100;
export const CONVERSATION_MAX_IMPORT_SESSIONS = 40;
export const CONVERSATION_MAX_IMPORT_MESSAGES = 5000;
export declare const CONVERSATION_ROLES: readonly ['user', 'assistant', 'tool'];
export type ConversationRole = typeof CONVERSATION_ROLES[number];
export declare const CONVERSATION_PART_TYPES: readonly ['text', 'image', 'audio', 'video', 'file', 'tool_call', 'tool_result', 'citation', 'status'];
export type ConversationPartType = typeof CONVERSATION_PART_TYPES[number];
export declare const CONVERSATION_RUN_STATES: readonly ['queued', 'streaming', 'awaiting_action', 'completed', 'interrupted', 'failed', 'cancelled', 'unknown', 'needs_attention'];
export type ConversationRunState = typeof CONVERSATION_RUN_STATES[number];
export declare const CONVERSATION_EVENT_TYPES: readonly ['message.created', 'message.branch', 'run.linked', 'run.state', 'conversation.updated', 'conversation.archived'];
export type ConversationEventType = typeof CONVERSATION_EVENT_TYPES[number];
export declare const CONVERSATION_STORAGE_POLICIES: readonly ['local', 'temporary', 'cloud'];
export type ConversationStoragePolicy = typeof CONVERSATION_STORAGE_POLICIES[number];
export declare const CONVERSATION_PROCESSING_POLICIES: readonly ['local_only', 'external_allowed'];
export type ConversationProcessingPolicy = typeof CONVERSATION_PROCESSING_POLICIES[number];
export interface Conversation {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly archivedAt: string | null;
  readonly activeBranchId: string;
  readonly instructionProfileRef?: string;
  readonly instructionProfileRevision?: number;
  readonly storagePolicy?: ConversationStoragePolicy;
  readonly processingPolicy?: ConversationProcessingPolicy;
  readonly cloudSyncOptIn?: boolean;
}
export function parseConversation(input: unknown): Conversation;
export function canonicalConversation(input: unknown): string;
export interface ConversationPolicyPatch {
  readonly storagePolicy?: 'local' | 'cloud';
  readonly processingPolicy?: ConversationProcessingPolicy;
  readonly cloudSyncOptIn?: boolean;
}
export function parseConversationPolicyPatch(input: unknown): ConversationPolicyPatch;
export interface MessagePartText { readonly callId: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; }
export interface MessagePartToolResult { readonly callId: string; readonly receiptId: string; readonly output: unknown; }
export interface MessagePart {
  readonly id: string;
  readonly messageId: string;
  readonly type: ConversationPartType;
  readonly text?: string | MessagePartText | MessagePartToolResult;
  readonly artifactRef?: string | null;
  readonly callId?: string;
  readonly name?: string;
}
export function parseMessagePart(input: unknown): MessagePart;
export interface ConversationMessage {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly conversationId: string;
  readonly parentId: string | null;
  readonly branchId: string;
  readonly role: ConversationRole;
  readonly clientMessageId: string;
  readonly createdAt: string;
  readonly revision: number;
}
export function parseMessage(input: unknown): ConversationMessage;
export interface SendMessageInput {
  readonly conversationId: string;
  readonly parentId: string | null;
  readonly clientMessageId: string;
  readonly expectedRevision: number;
  readonly parts: readonly unknown[];
  readonly modelSelectionRef: string | null;
  readonly contextRefs: readonly string[];
}
export function parseSendMessage(input: unknown): SendMessageInput;
export interface RunLink {
  readonly conversationId: string;
  readonly messageId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly providerId?: string;
  readonly accountRef?: string;
  readonly modelId: string;
  readonly state: ConversationRunState;
  readonly lastSequence: number;
}
export function parseRunLink(input: unknown): RunLink;
export interface ConversationEvent {
  readonly id: string;
  readonly conversationId: string;
  readonly runId: string | null;
  readonly sequence: number;
  readonly type: ConversationEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
export function parseConversationEvent(input: unknown): ConversationEvent;
export interface ListQuery {
  readonly after: string | null;
  readonly limit: number;
  readonly query: string | null;
  readonly includeArchived: boolean;
}
export function parseListQuery(input: unknown): ListQuery;
export interface ImportSessionMessage { readonly role: 'user' | 'assistant'; readonly content: string; }
export interface ImportSession { readonly id: string; readonly title: string; readonly messages: readonly ImportSessionMessage[]; }
export interface ImportSessionsInput { readonly origin: 'quimera-chat-sessions-v1' | 'utk-chat'; readonly sessions: readonly ImportSession[]; }
export function parseImportSessions(input: unknown): ImportSessionsInput;
export function canonicalImportPayload(input: unknown): string;
/** Stable error codes published by conversation.js (runtime array, not frozen). */
export declare const CONVERSATION_ERROR_TYPES: readonly ['conversation_invalid', 'conversation_not_found', 'conversation_conflict', 'conversation_limit_exceeded', 'invalid_part', 'payload_too_large', 'message_conflict', 'message_not_found', 'run_link_conflict', 'import_invalid', 'operation_replayed', 'cloud_sync_not_opted_in'];
export type ConversationErrorType = typeof CONVERSATION_ERROR_TYPES[number];
