import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import type { ChatCompletionRequest } from "./types.ts";
import {isProvider} from "./provider-registry.ts";
import {parseRequiredCapabilities} from "@uptokey/sync-contract/connections";

const FORBIDDEN_ROOT_FIELDS = new Set([
  "apikey", "authorization", "accesstoken", "providertoken", "byok", "secret", "credential", "credentials"
]);

const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
// The shared projection also receives native Anthropic names (up to 128).
// Protocol/provider-specific limits remain the responsibility of their adapters.
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function hasForbiddenInferenceCredentialField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => FORBIDDEN_ROOT_FIELDS.has(key.toLowerCase().replace(/[-_]/g, "")));
}

export function projectInferenceRequest(value: unknown): ChatCompletionRequest | undefined {
  let projected: unknown;
  try { projected = JSON.parse(canonicalJson(value)); } catch { return undefined; }
  return validProjectedShape(projected) ? projected : undefined;
}

export function validInferenceRequestShape(value: unknown): value is ChatCompletionRequest {
  return projectInferenceRequest(value) !== undefined;
}

function validProjectedShape(value: unknown): value is ChatCompletionRequest {
  if (!record(value) || !Array.isArray(value.messages) || value.messages.length > 4_096) return false;
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 200)) return false;
  if (value.stream !== undefined && typeof value.stream !== "boolean") return false;
  if (value.uptokey_require_model !== undefined && typeof value.uptokey_require_model !== "boolean") return false;
  if (value.uptokey_require_model === true && typeof value.model !== "string") return false;
  if (value.uptokey_provider !== undefined &&
    (typeof value.uptokey_provider !== "string" || !isProvider(value.uptokey_provider) || value.uptokey_require_model !== true)) return false;
  if (value.uptokey_account !== undefined && (typeof value.uptokey_account !== "string" ||
    !/^(?:conn:)?[A-Za-z0-9_-]{1,100}$/.test(value.uptokey_account))) return false;
  if (value.uptokey_routing_combo !== undefined && (typeof value.uptokey_routing_combo !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.uptokey_routing_combo))) return false;
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > 128 || !value.tools.every(tool =>
    record(tool) && (tool.type !== 'function' || record(tool.function) && typeof tool.function.name === 'string' && FUNCTION_NAME.test(tool.function.name))))) return false;
  if (value.response_format !== undefined && (!record(value.response_format) || !["text", "json_object", "json_schema"].includes(String(value.response_format.type)))) return false;
  if (value.uptokey_cost_mode !== undefined && !["any", "no_api_charge", "economic", "within_limit"].includes(value.uptokey_cost_mode as any)) return false;
  if (value.uptokey_cost_limit_micros !== undefined && (typeof value.uptokey_cost_limit_micros !== "number" || value.uptokey_cost_limit_micros < 0 || !Number.isSafeInteger(value.uptokey_cost_limit_micros))) return false;
  if (value.uptokey_cost_mode === "within_limit" && value.uptokey_cost_limit_micros === undefined) return false;
  if (value.uptokey_require_input !== undefined) {
    try { parseRequiredCapabilities(value.uptokey_require_input); } catch { return false; }
  }
  return value.messages.every(validMessage);
}

function validMessage(message: unknown): boolean {
  if (!record(message) || typeof message.role !== "string" || !MESSAGE_ROLES.has(message.role)) return false;
  if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128 || !message.tool_calls.every(call =>
    record(call) && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 256 &&
    (call.type !== 'function' || record(call.function) && typeof call.function.name === 'string' && FUNCTION_NAME.test(call.function.name) && typeof call.function.arguments === 'string')))) return false;
  if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || message.tool_call_id.length < 1 || message.tool_call_id.length > 256)) return false;
  if (message.content !== undefined) return validContent(message.content);
  if (message.role !== "assistant") return false;
  return Array.isArray(message.tool_calls) && message.tool_calls.length >= 1 && message.tool_calls.length <= 128 && message.tool_calls.every(record)
    || record(message.function_call);
}

function validContent(content: unknown): boolean {
  if (content === null || typeof content === "string") return true;
  return Array.isArray(content) && content.length <= 4_096 && content.every((part) => record(part) && typeof part.type === "string" && part.type.length >= 1 && part.type.length <= 64);
}
