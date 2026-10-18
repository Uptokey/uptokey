/** Connected MCP services as model tools. The catalog, schema digests and execution belong to the core's
 * service access (remote MCP client, pinned origin, redaction); the terminal only offers the tools of services
 * that are ready, validated by their declared input schema, and runs each call as one W5 plan with approval
 * and receipt. Nothing is executed during discovery and no success is reported without a receipt. */
import { parseServiceCatalog, type ServiceView } from "@uptokey/sync-contract/service-access";
import { t } from "./i18n.ts";
import type { TuiClient, TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor } from "./conversations.ts";
import { executeNativeApprovedPlan, type NativePlanHost } from "./native-web-tools.ts";
import { parseWorkspaceView } from "./workspace.ts";

const MAX_TOOLS = 32;
const MAX_OUTPUT = 48_000;

interface ServiceToolBinding { serviceId: string; serviceRevision: number; operationId: string; effect: "read_external" | "write_external"; label: string }

/** Model-safe name: prefix, service and operation, within the provider's 64-character tool-name limit. */
export function serviceToolName(serviceId: string, operationId: string): string | null {
  const name = `svc_${serviceId}__${operationId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) ? name : null;
}

export async function nativeServiceTools(client: TuiClient, signal?: AbortSignal): Promise<{ tools: TuiFunctionTool[]; bindings: Map<string, ServiceToolBinding> }> {
  const tools: TuiFunctionTool[] = [];
  const bindings = new Map<string, ServiceToolBinding>();
  const response = await client.fetchAuth("/v1/workspace/services", { signal });
  const catalog = parseServiceCatalog(await response.json());
  for (const service of catalog.services as ServiceView[]) {
    if (service.kind !== "mcp" || service.state !== "ready" || !service.enabled) continue;
    for (const operation of service.operations) {
      const name = serviceToolName(service.id, operation.id);
      if (!name || bindings.has(name) || tools.length >= MAX_TOOLS) continue;
      bindings.set(name, { serviceId: service.id, serviceRevision: service.revision, operationId: operation.id, effect: operation.effect, label: `${service.label}: ${operation.label}` });
      tools.push({ type: "function", function: { name, description: `${service.label} — ${operation.label} (${operation.effect === "read_external" ? "reads" : "changes"} data in this connected service; every call is approved and receipted)`.slice(0, 1024), parameters: operation.inputSchema } });
    }
  }
  return { tools, bindings };
}

export function nativeServiceExecutor(options: NativePlanHost & { client: TuiClient; bindings: ReadonlyMap<string, ServiceToolBinding> }): NativeReadToolExecutor {
  return async (call, signal, context) => {
    if (!context) throw new Error("conversation_admission_unavailable");
    const check = async () => {
      signal?.throwIfAborted();
      if (!options.stillBound()) throw new Error("project_binding_changed");
      await context.assertCurrent();
      if (context.processingPolicy !== "external_allowed") throw new Error("local_processing_denied");
      if (!options.stillBound()) throw new Error("project_binding_changed");
    };
    await check();
    const binding = options.bindings.get(call.name);
    if (!binding) throw new Error("conversation_tool_unavailable");
    const initial = await options.workspace.refresh(options.projectId, signal);
    await check();
    // The core re-validates parameters against the discovered schema digest; an invalid call never becomes a plan.
    const response = await options.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(options.projectId)}/service-plans`, {
      method: "POST", signal,
      body: JSON.stringify({ expectedRevision: initial.revision, serviceId: binding.serviceId, serviceRevision: binding.serviceRevision, operationId: binding.operationId, parameters: call.arguments }),
    });
    if (!response.ok) {
      // The canonical refusal (for example service_input_invalid) tells the model what to correct; nothing ran.
      const body = await response.json().catch(() => ({})) as { error?: { type?: unknown } };
      const reason = typeof body.error?.type === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(body.error.type) ? body.error.type : `http_${response.status}`;
      const outcome = { status: "not_executed", tool: call.name, reason };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const planned = parseWorkspaceView(await response.json());
    const plan = planned.plan;
    const capability = `service.${binding.serviceId}.${binding.effect === "read_external" ? "read" : "write"}`;
    if (planned.projectId !== options.projectId || !plan || plan.steps.length !== 1 || plan.steps[0]?.capabilityId !== capability) throw new Error("service_plan_mismatch");
    await check();
    const summary = t("service_tool_summary", { service: binding.label });
    const settled = await executeNativeApprovedPlan(options, planned, summary, context, signal, `${binding.label}\n${JSON.stringify(call.arguments, null, 2).slice(0, 4000)}`);
    if (!settled) {
      const outcome = { status: "not_executed", reason: "user_declined", tool: call.name };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const runId = settled.run?.id;
    const receipt = settled.receipts.find((item) => item.runId === runId && item.capabilityId === capability);
    const artifactId = receipt?.outputArtifactRefs[0];
    if (settled.run?.status !== "succeeded" || receipt?.status !== "succeeded" || !artifactId) {
      const outcome = { status: "not_completed", tool: call.name, runId, runStatus: settled.run?.status ?? "unknown", ...(receipt ? { receiptId: receipt.id } : {}) };
      return { output: JSON.stringify(outcome), persistedOutput: outcome, ...(receipt ? { receiptId: receipt.id } : {}) };
    }
    await check();
    const text = await options.workspace.readArtifact(options.projectId, artifactId, signal);
    const metadata = { status: "succeeded", tool: call.name, service: binding.serviceId, operation: binding.operationId, runId, receiptId: receipt.id, artifactId, truncated: text.length > MAX_OUTPUT };
    return { output: JSON.stringify({ ...metadata, result: text.slice(0, MAX_OUTPUT) }), persistedOutput: metadata, receiptId: receipt.id };
  };
}
