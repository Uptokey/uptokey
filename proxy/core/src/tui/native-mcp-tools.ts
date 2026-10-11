/** Native BYOK MCP tools over the core's existing W5 filesystem/MCP service.
 * Respects the same canonical approval rules and signatures as web tools.
 */
import { parseWorkspaceView } from "./workspace.ts";
import { parseFilesystemReadRequest } from "@uptokey/sync-contract/filesystem";
import type { TuiFunctionTool } from "./client.ts";
import { executeNativeApprovedPlan, type NativePlanHost } from "./native-web-tools.ts";
import type { NativeReadToolExecutor } from "./conversations.ts";

export async function nativeMcpTools(workspace: NativePlanHost["workspace"], signal?: AbortSignal): Promise<TuiFunctionTool[]> {
  const catalog = await workspace.getFilesystemCatalog(signal);
  if (!catalog?.available) return [];
  const tools: TuiFunctionTool[] = [];
  for (const tool of catalog.tools) {
    if (tool.name === "read_text_file" || tool.name === "list_directory" || tool.name === "get_file_info") {
      tools.push({
        type: "function",
        function: {
          name: `mcp_${tool.name}`,
          description: tool.name === "list_directory" 
            ? "List files in the connected MCP server root. Separate from the local project root." 
            : tool.name === "get_file_info" ? "Inspect file metadata in the connected MCP server root." : "Read a text file from the connected MCP server root.",
          parameters: {
            type: "object",
            properties: {
              relativePath: { type: "string", description: "Path relative to the MCP server root." },
              ...(tool.name === "read_text_file" ? { lineLimit: { type: "integer", minimum: 1, maximum: catalog.schemaVersion === 2 ? catalog.limits?.maxLines ?? 1000 : 1000 } } : {})
            },
            required: ["relativePath"],
            additionalProperties: false
          }
        }
      });
    }
  }
  return tools;
}

export function nativeMcpExecutor(options: NativePlanHost & { client: import("./client.ts").TuiClient }): NativeReadToolExecutor {
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
    
    if (!["mcp_list_directory", "mcp_read_text_file", "mcp_get_file_info"].includes(call.name)) throw new Error("conversation_tool_unavailable");
    const toolName = call.name.slice(4) as "list_directory" | "read_text_file" | "get_file_info";
    const allowed = toolName === "read_text_file" ? ["relativePath", "lineLimit"] : ["relativePath"];
    if (Object.keys(call.arguments).some(key => !allowed.includes(key)) || typeof call.arguments.relativePath !== "string") throw new Error("filesystem_read_invalid");
    
    const catalog = await options.workspace.getFilesystemCatalog(signal);
    await check();
    const descriptor = catalog?.available && catalog.tools.find(item => item.name === toolName);
    if (!descriptor || !catalog?.profileDigest) throw new Error("mcp_tool_unavailable");

    const request = parseFilesystemReadRequest({ 
      schemaVersion: 1, 
      tool: toolName, 
      relativePath: call.arguments.relativePath, 
      ...(toolName === "read_text_file" ? { lineLimit: call.arguments.lineLimit ?? Math.min(200, catalog.schemaVersion === 2 ? catalog.limits?.maxLines ?? 1000 : 1000) } : {}), 
      profileDigest: catalog.profileDigest, 
      schemaDigest: descriptor.schemaDigest 
    });

    const capabilityId = toolName === "read_text_file" ? "filesystem.text.read" : "filesystem.metadata.inspect";
    const summary = `MCP ${toolName}: ${request.relativePath}`;
    const initial = await options.workspace.refresh(options.projectId, signal);
    await check();

    const response = await options.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(options.projectId)}/filesystem-plans`, {
      method: "POST", body: JSON.stringify({ expectedRevision: initial.revision, request }), signal,
    });
    const planned = parseWorkspaceView(await response.json());
    const plan = planned.plan;
    if (planned.projectId !== options.projectId || !plan || plan.steps.length !== 1 || plan.steps[0]?.capabilityId !== capabilityId) throw new Error("mcp_plan_mismatch");
    const bound = plan.steps[0].arguments?.request;
    if (!bound || typeof bound !== "object" || !("kind" in bound) || bound.kind !== "literal" || !("value" in bound)
      || JSON.stringify(parseFilesystemReadRequest(bound.value)) !== JSON.stringify(request)) throw new Error("mcp_plan_mismatch");
    
    await check();
    const settled = await executeNativeApprovedPlan(options, planned, summary, context, signal);
    if (!settled) {
      const outcome = { status: "not_executed", reason: "user_declined", tool: call.name };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }

    const runId = settled.run?.id;
    const receipt = settled.receipts.find(item => item.runId === runId && item.capabilityId === capabilityId && item.status === "succeeded")
      ?? settled.receipts.find(item => item.runId === runId && item.capabilityId === capabilityId);
    const artifactId = receipt?.outputArtifactRefs[0];
    if (settled.run?.status !== "succeeded" || receipt?.status !== "succeeded" || !artifactId) {
      const outcome = { status: "not_completed", tool: call.name, runId, runStatus: settled.run?.status ?? "unknown", ...(receipt ? { receiptId: receipt.id } : {}) };
      return { output: JSON.stringify(outcome), persistedOutput: outcome, ...(receipt ? { receiptId: receipt.id } : {}) };
    }

    await check();
    const bytes = await options.workspace.readArtifact(options.projectId, artifactId, signal);
    const utf8 = Buffer.from(bytes, "utf8");
    let end = Math.min(utf8.length, 48_000);
    while (end < utf8.length && end > 0 && (utf8[end]! & 0xc0) === 0x80) end--;
    const result = utf8.subarray(0, end).toString("utf8");
    await check();

    const metadata = { status: "succeeded", tool: call.name, runId, receiptId: receipt.id, artifactId, contextTruncated: end < utf8.length, contentPersisted: false };
    return { output: JSON.stringify({ ...metadata, source: result }), persistedOutput: metadata, receiptId: receipt.id };
  };
}
