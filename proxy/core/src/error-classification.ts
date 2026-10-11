/** Classify upstream HTTP / transport failures into retry vs fallback vs fail-fast. */

export type ErrorAction = "retry" | "fallback" | "fail_fast";

export type ClassifiedKind =
  | "auth"
  | "forbidden"
  | "billing"
  | "timeout"
  | "rate_limit"
  | "server"
  | "client"
  | "connection"
  | "unknown";

export interface ClassifiedError {
  kind: ClassifiedKind;
  action: ErrorAction;
  status?: number;
  reason: string;
  retryable: boolean;
}

export function classifyHttpStatus(status: number): ClassifiedError {
  // Hard auth: never transient-retry the same key; sticky-invalidate via ProviderRejections; fallback to another connection may still run.
  if (status === 401) return { kind: "auth", action: "fallback", status, reason: "http_401", retryable: false };
  if (status === 403) return { kind: "forbidden", action: "fallback", status, reason: "http_403", retryable: false };
  if (status === 402) return { kind: "billing", action: "fallback", status, reason: "http_402", retryable: false };
  if (status === 408) return { kind: "timeout", action: "retry", status, reason: "http_408", retryable: true };
  if (status === 429) return { kind: "rate_limit", action: "retry", status, reason: "http_429", retryable: true };
  if (status >= 500 && status <= 599) return { kind: "server", action: "fallback", status, reason: `http_${status}`, retryable: true };
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    return { kind: "client", action: "fail_fast", status, reason: `http_${status}`, retryable: false };
  }
  if (status >= 400 && status < 500) {
    return { kind: "client", action: "fail_fast", status, reason: `http_${status}`, retryable: false };
  }
  return { kind: "unknown", action: "fallback", status, reason: `unexpected_status_${status}`, retryable: false };
}

export function classifyDispatchError(error: unknown): ClassifiedError {
  if (isTimeoutError(error)) {
    // Adapter / idle deadlines already consumed their wait budget — fall back instead of double-waiting.
    return { kind: "timeout", action: "fallback", reason: "timeout", retryable: true };
  }
  if (isConnectionError(error)) {
    return { kind: "connection", action: "fallback", reason: "connection", retryable: true };
  }
  return { kind: "unknown", action: "fallback", reason: "dispatch_error", retryable: false };
}

export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; code?: string; cause?: { code?: string }; message?: string };
  const code = err.cause?.code ?? err.code;
  if (code === "ETIMEDOUT" || code === "ABORT_ERR") return true;
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
    if (message.includes("timeout") || message.includes("deadline")) return true;
    // Adapter deadlines abort with AbortError — treat as timeout when message hints.
    if (message.includes("abort") && message.includes("time")) return true;
  }
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  return message.includes("timeout") || message.includes("deadline") || message === "provider_response_idle_timeout";
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "CERT_HAS_EXPIRED"].includes(code ?? "");
}
