/** A request presented for consent, independent of the terminal renderer. */
export interface ApprovalRequest {
  id: string;
  type: "file_write" | "file_delete" | "command" | "network" | "tool_call";
  description: string;
  detail?: string;
  diff?: string;
  risk: "low" | "medium" | "high";
  tool?: string;
  args?: string;
  planId?: string;
  runId?: string;
  riskBadge?: string;
  riskSummary?: string;
  path?: string;
}
