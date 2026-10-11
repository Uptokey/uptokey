/**
 * Fail-closed redaction for MCP tool results and audit logs.
 * Provider keys, local tokens, and prompt bodies must never leave the boundary.
 */
const SECRET_KEY_NAMES = /^(?:api[_-]?key|authorization|token|secret|password|passwd|credential|access[_-]?key|private[_-]?key|client[_-]?secret|bearer)$/i;
// Mantido alinhado com `scrub.ts` (detector de telemetria): os dois são gates fail-closed para o
// MESMO conjunto de chaves BYOK. `gsk_` (Groq, provider core) e a chave de conta Z.AI
// (32 hex + "." + 16 alfanum, sem prefixo) existiam só em scrub.ts e passavam livres pelo gate MCP.
const SECRET_VALUE = /(?:utk_(?:local|device|bootstrap|control|live)_[A-Za-z0-9_.-]{20,}|gsk_[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|\bAQ\.[A-Za-z0-9_-]{20,}|\bLLM\|[0-9]{1,32}\|[A-Za-z0-9._-]{8,}|csk-[A-Za-z0-9_-]{20,}|\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b|Bearer\s+[A-Za-z0-9._~+\/-]+=*|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g;
const PROMPT_KEY_NAMES = /^(?:prompt|messages|input|content|system|user|assistant|text|body)$/i;

export type RedactionMode = "tool_result" | "audit_log";

export interface RedactionOptions {
  mode: RedactionMode;
  /** When true, prompt-like fields are replaced even if not matching secret patterns. */
  stripPrompts: boolean;
}

const DEFAULT_TOOL: RedactionOptions = { mode: "tool_result", stripPrompts: false };
const DEFAULT_AUDIT: RedactionOptions = { mode: "audit_log", stripPrompts: true };

export function redactForToolResult<T>(value: T): T {
  return redactValue(value, DEFAULT_TOOL, 0) as T;
}

export function redactForAuditLog<T>(value: T): T {
  return redactValue(value, DEFAULT_AUDIT, 0) as T;
}

export function assertNoSecretMaterial(value: unknown, label = "payload"): void {
  const raw = JSON.stringify(value, secretReplacer);
  SECRET_VALUE.lastIndex = 0;
  if (SECRET_VALUE.test(raw)) throw new Error(`mcp_secret_leak_blocked:${label}`);
  if (containsSecretShapedStrings(value)) throw new Error(`mcp_secret_leak_blocked:${label}`);
}

function secretReplacer(_key: string, value: unknown): unknown {
  return value;
}

function containsSecretShapedStrings(value: unknown, depth = 0): boolean {
  if (depth > 32 || value == null) return false;
  if (typeof value === "string") {
    SECRET_VALUE.lastIndex = 0;
    return SECRET_VALUE.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsSecretShapedStrings(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      if (SECRET_KEY_NAMES.test(key) && typeof child === "string" && child.length > 0 && child !== "[redacted]") return true;
      return containsSecretShapedStrings(child, depth + 1);
    });
  }
  return false;
}

function redactValue(value: unknown, options: RedactionOptions, depth: number): unknown {
  if (depth > 32) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAMES.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      if (options.stripPrompts && PROMPT_KEY_NAMES.test(key) && (typeof child === "string" || Array.isArray(child) || (child && typeof child === "object"))) {
        out[key] = "[prompt_redacted]";
        continue;
      }
      out[key] = redactValue(child, options, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

function redactString(value: string): string {
  return value.replace(SECRET_VALUE, "[redacted]");
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value, DEFAULT_TOOL, 0)) ?? "";
  } catch {
    return String(value);
  }
}
