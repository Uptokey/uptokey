export type HostedMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;
export type HostedRequest = {
  requestId: string;
  model: string;
  messages: readonly HostedMessage[];
  maxOutputTokens?: number;
  expectedPriceVersion?: string;
};
export function parseHostedRequest(value: unknown): HostedRequest;
