/** The terminal uses the existing signed account broker. No provider key or browser cookie enters this layer. */
import { ACCOUNT_REF } from "../account-login-protocol.ts";
import { readAccountHostedRequest, ACCOUNT_HOSTED_MAX_RESPONSE_BYTES } from "../account-hosted-protocol.ts";
import { readHostedJson } from "../../../contratos/hosted-json.js";
import { parseHostedRequest } from "../../../contratos/hosted-request.js";
import { projectHostedCatalog } from "../../../contratos/hosted-catalog.js";
import { parseHostedClientResult } from "../../../contratos/hosted-result.js";
import { projectHostedReceipt } from "../../../contratos/hosted-receipt.js";

export const HOSTED_PROVIDER = "uptokey-hosted";
export interface TuiHostedDestination {
  readonly accountRef: string;
  readonly revision: number;
  readonly modelId: string;
  readonly priceVersion: string;
  readonly maxOutputTokens: number;
}
export interface TuiHostedModel extends TuiHostedDestination {
  readonly contextTokens: number;
  readonly label: string;
  /** The broker catalog declares that this model relays function tools; tools still execute locally under W5. */
  readonly toolCalls: boolean;
}
// Presentation of existing aliases, shared with the web product vocabulary. This never creates an available model.
const LABELS: Readonly<Record<string, string>> = {
  "google-gemini-3-5-flash-lite": "Gemini 3.5 Flash-Lite", "google-gemini-3-8-flash": "Gemini 3.8 Flash",
  "uptokey-free-fast": "Uptokey Fast", "uptokey-free": "Uptokey General", "uptokey-free-reasoning": "Uptokey Reasoning",
  "uptokey-free-code": "Uptokey Code", "uptokey-free-ovh-reasoning": "Uptokey OVH Reasoning",
};
export type HostedTransport = (path: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;
export function validateHostedDestination(value: TuiHostedDestination): TuiHostedDestination {
  if (!ACCOUNT_REF.test(value.accountRef) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.modelId) ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(value.priceVersion) || !Number.isSafeInteger(value.maxOutputTokens) ||
      value.maxOutputTokens < 1 || value.maxOutputTokens > 1_000_000) throw Error("hosted_model_unavailable");
  return Object.freeze({ accountRef: value.accountRef, revision: value.revision, modelId: value.modelId,
    priceVersion: value.priceVersion, maxOutputTokens: value.maxOutputTokens });
}
async function request(transport: HostedTransport, body: unknown, signal = new AbortController().signal, chat = false) {
  const input = readAccountHostedRequest(body);
  const response = await transport("/local/account/hosted", { method: "POST", body: JSON.stringify(input), signal,
    headers: { "content-type": "application/json" } }, chat ? 140_000 : 15_000);
  if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel(); throw Error("account_response_invalid");
  }
  const value = await readHostedJson(response.body, chat ? ACCOUNT_HOSTED_MAX_RESPONSE_BYTES : 262_144, signal);
  return { status: response.status, value };
}
export async function loadHostedModels(transport: HostedTransport, accountRef: string, revision: number, signal?: AbortSignal): Promise<TuiHostedModel[]> {
  const { status, value } = await request(transport, { operation: "models", accountRef, revision, payload: {} }, signal);
  if (status !== 200) throw Error(status === 401 ? "account_reauthentication_required" : "hosted_model_unavailable");
  const row = value as Record<string, unknown>;
  if (row.accountRef !== accountRef || row.revision !== revision) throw Error("account_share_conflict");
  const catalog = projectHostedCatalog(row);
  if (row.executionEnabled !== true) return [];
  return catalog.models.filter(model => model.price.inputMicrosPerMillion === 0 && model.price.outputMicrosPerMillion === 0)
    .map(model => Object.freeze({ ...validateHostedDestination({ accountRef, revision, modelId: model.id,
      priceVersion: model.price.version, maxOutputTokens: Math.min(model.limits.outputTokens, 4096) }), contextTokens: model.limits.contextTokens, label: LABELS[model.id] ?? model.id,
      toolCalls: (model as { toolCalls?: true }).toolCalls === true }));
}
type HostedDispatch = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: unknown };
/** Text and declared tool exchanges only; media parts are refused by the contract, never dropped. */
export function hostedInput(destination: TuiHostedDestination, requestId: string, messages: ReadonlyArray<HostedDispatch>, tools?: readonly unknown[]) {
  const target = validateHostedDestination(destination);
  const wire = messages.map((message) => ({ role: message.role, content: message.content ?? "",
    ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}), ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}) }));
  return parseHostedRequest({ requestId, model: target.modelId, messages: wire, expectedPriceVersion: target.priceVersion, maxOutputTokens: target.maxOutputTokens, ...(tools?.length ? { tools } : {}) });
}
export async function sendHosted(transport: HostedTransport, destination: TuiHostedDestination, requestId: string,
  messages: ReadonlyArray<HostedDispatch>, processingPolicy?: string, signal?: AbortSignal, tools?: readonly unknown[]) {
  if (processingPolicy !== "external_allowed") throw Error("local_processing_denied");
  const target = validateHostedDestination(destination);
  const payload = hostedInput(target, requestId, messages, tools);
  signal?.throwIfAborted();
  // Exactly one POST. A lost reply keeps the same durable request ID; it is never retried as another inference.
  let result: ReturnType<typeof parseHostedClientResult> = { status: "outcome_unknown", requestId };
  try {
    const { status, value } = await request(transport, { operation: "chat", accountRef: target.accountRef, revision: target.revision, payload }, signal, true);
    const row = value as Record<string, unknown>;
    if (row.accountRef === target.accountRef && row.revision === target.revision) {
      result = parseHostedClientResult(row, status, requestId);
      if (result.status === "completed" && result.priceVersion !== target.priceVersion) result = { status: "outcome_unknown", requestId };
    }
  } catch { /* Unknown after dispatch: receipt lookup, never automatic resubmission. */ }
  signal?.throwIfAborted();
  return result;
}
export async function getHostedReceipt(transport: HostedTransport, target: Pick<TuiHostedDestination, "accountRef" | "revision">, requestId: string, signal?: AbortSignal) {
  const { status, value } = await request(transport, { operation: "receipt", ...target, payload: { requestId } }, signal);
  const row = value as Record<string, unknown>;
  if (status !== 200 || row.accountRef !== target.accountRef || row.revision !== target.revision) throw Error("account_share_conflict");
  const receipt = projectHostedReceipt(row);
  if (receipt.requestId !== requestId) throw Error("hosted_receipt_invalid");
  return receipt;
}
