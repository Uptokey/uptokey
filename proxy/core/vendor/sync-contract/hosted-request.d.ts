export type HostedToolCall = Readonly<{ id: string; type: "function"; function: Readonly<{ name: string; arguments: string }> }>;
export type HostedMessage =
  | Readonly<{ role: "system" | "user"; content: string }>
  | Readonly<{ role: "assistant"; content: string; tool_calls?: readonly HostedToolCall[] }>
  | Readonly<{ role: "tool"; content: string; tool_call_id: string }>;
/** A function tool declared by the client; the hosted service only relays it to the model, it never executes it. */
export type HostedTool = Readonly<{ type: "function"; function: Readonly<{ name: string; description?: string; parameters: Record<string, unknown> }> }>;
export type HostedRequest = {
  requestId: string;
  model: string;
  messages: readonly HostedMessage[];
  maxOutputTokens?: number;
  expectedPriceVersion?: string;
  tools?: readonly HostedTool[];
};
export function parseHostedRequest(value: unknown): HostedRequest;
