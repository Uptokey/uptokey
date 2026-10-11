export const GATEWAY_CONTRACT_VERSION: 1;
export const GATEWAY_CHAT_CONTRACT_REVISION: 5;
export const GATEWAY_WIRE_MAX_BYTES: number;
export const GATEWAY_CHAT_MAX_BYTES: number;
export const GATEWAY_CHAT_MULTIMODAL_MAX_BYTES: number;
export const GATEWAY_AUDIO_PART_MAX_BYTES: number;
export const GATEWAY_AUDIO_FORMATS: readonly string[];
export const GATEWAY_PREVIEW_MAX_BYTES: number;
export const GATEWAY_TOOL_CONTRACT_VERSION: 1;
export const GATEWAY_TOOL_MAX_COUNT: 16;
export const GATEWAY_TOOL_MAX_BYTES: 65536;
export const GATEWAY_PROTOCOL_CONTRACT_VERSION: 1;
/** Exact original JSON; not proof of semantic compatibility or authorization. */
export interface GatewayProtocolRequest {readonly schemaVersion:1;readonly protocol:'openai-responses'|'anthropic-messages';readonly body:string;}
export function parseGatewayProtocolRequest(input:unknown):GatewayProtocolRequest;
export interface GatewayFunctionTool {
  readonly type: 'function';
  readonly function: Readonly<{name:string;description?:string;parameters:Readonly<Record<string,unknown>>;strict?:boolean}>;
}
export interface GatewayToolProposal {
  readonly schemaVersion: 1;
  readonly content: string|null;
  readonly toolCalls: ReadonlyArray<Readonly<{id:string;type:'function';function:Readonly<{name:string;arguments:string}>}>>;
}
/** Parsing is not authorization, schema execution, or tool dispatch. */
export function parseGatewayFunctionTools(input:unknown):readonly GatewayFunctionTool[];
export function canonicalGatewayFunctionTools(input:unknown):string;
/** Requires names from the approved request; arguments stay exact JSON object strings. */
export function parseGatewayToolProposal(input:unknown,approvedTools:unknown):GatewayToolProposal;
export interface GatewayToolPlanRequest {readonly expectedRevision:number;readonly artifactId:string;readonly callId:string;}
export function parseGatewayToolPlanRequest(input:unknown):GatewayToolPlanRequest;
export interface GatewayToolResultPlanRequest {readonly expectedRevision:number;readonly resultArtifactId:string;}
export function parseGatewayToolResultPlanRequest(input:unknown):GatewayToolResultPlanRequest;
export type GatewayChatTextPart = Readonly<{type:'text';text:string}>;
/** OpenAI-compatible audio part; `data` is base64 and bounded by GATEWAY_AUDIO_PART_MAX_BYTES. */
export type GatewayChatAudioPart = Readonly<{type:'input_audio';input_audio:Readonly<{data:string;format:string}>}>;
export type GatewayChatPart = GatewayChatTextPart | GatewayChatAudioPart;
export type GatewayChatContent = string | readonly GatewayChatPart[];
export type GatewayChatMessage = Readonly<{role:'system'|'user'|'assistant';content:GatewayChatContent}>
  | Readonly<{role:'assistant';content:string|null;tool_calls:GatewayToolProposal['toolCalls']}>
  | Readonly<{role:'tool';content:string;tool_call_id:string}>;
export interface GatewayWireRequest {
  readonly schemaVersion: 1;
  readonly driver: '9router';
  readonly driverRevision: string;
  readonly provider: string;
  readonly model: string;
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<{ 'content-type': 'application/json'; accept?: 'application/json' | 'text/event-stream' }>;
  readonly body: string;
}
export function parseGatewayWireRequest(input: unknown): GatewayWireRequest;
export function canonicalGatewayWirePayload(input: unknown): string;
export interface GatewayChatRequest {
  readonly model: string;
  readonly messages: readonly GatewayChatMessage[];
  readonly stream: boolean;
  readonly max_tokens: number;
  /** Supplied values remain exact; absence delegates to the configured provider. */
  readonly temperature?: number;
  readonly top_p?: number;
  readonly tools?: readonly GatewayFunctionTool[];
  readonly tool_choice?: 'auto'|'none'|'required'|Readonly<{type:'function';function:Readonly<{name:string}>}>;
  readonly parallel_tool_calls?: boolean;
}
export function parseGatewayChatRequest(input: unknown): GatewayChatRequest;
export function canonicalGatewayChatPayload(input: unknown): string;
export interface GatewayRunPreview {
  readonly runId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly text: string;
  readonly truncated: boolean;
}
export function parseGatewayRunPreview(input:unknown):GatewayRunPreview;
