export type HostedCompletedResult = {status: "completed"; requestId: string; content: string; currency: "USD";
  chargedMicros: number; priceVersion: string; usage: {inputTokens: number; outputTokens: number; cachedInputTokens?: number};
  finishReason?: "stop" | "length" | "tool_calls";
  /** Present exactly when finishReason is "tool_calls"; the client executes them under its own approvals. */
  toolCalls?: Array<{id: string; name: string; arguments: string}>};
export type HostedClientResult = HostedCompletedResult
  | {status: "outcome_unknown" | "reconciliation_required"; requestId: string}
  | {status: "already_submitted"; requestId: string; settlement: "reserved" | "settled"}
  | {status: "rejected"; requestId: string; error: string};
export const HOSTED_CLIENT_ERRORS: Readonly<Record<string, number>>;
export function parseHostedClientResult(value: unknown, httpStatus: number, requestId: string): HostedClientResult;
export function parseHostedToolCalls(value: unknown): Array<{id: string; name: string; arguments: string}> | null | undefined;
