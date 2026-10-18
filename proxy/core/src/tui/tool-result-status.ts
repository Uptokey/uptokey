/** One interpretation of canonical tool outcomes for live activity and reopened history. */
export type CompletedToolStatus = "done" | "error" | "rejected";

export function toolResultStatus(output: unknown): CompletedToolStatus {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return "done"; }
  }
  if (!value || typeof value !== "object") return "done";
  const result = value as { status?: unknown; reason?: unknown; runStatus?: unknown; error?: unknown };
  if (result.status === "failed" || result.status === "timed_out") return "error";
  // A deliberate refusal or cancelled execution is terminal, but is not a tool failure or success.
  const declined = result.reason === "user_declined" || result.reason === "declined_by_person";
  if (result.status === "not_executed" || result.status === "aborted" || result.status === "cancelled" || declined || result.runStatus === "cancelled") return "rejected";
  if (result.status === "not_completed" || typeof result.error === "string") return "error";
  return "done";
}
