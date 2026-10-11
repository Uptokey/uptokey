/** Native model commands use the existing project runner and its signed W5 plan.
 * The TUI never spawns the program. Output belongs to the canonical artifact;
 * only identifiers and process outcomes are retained in conversation metadata.
 */
import { randomUUID } from "node:crypto";
import { parseProjectRunRequest, parseProjectVerificationReport } from "@uptokey/sync-contract/project-agent";
import type { TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor } from "./conversations.ts";
import { executeNativeApprovedPlan, type NativePlanHost } from "./native-web-tools.ts";
import { RUNNER_SETUP_HINT } from "./verification.ts";
import { t } from "./i18n.ts";

export const NATIVE_COMMAND_TOOLS: readonly TuiFunctionTool[] = [{ type: "function", function: {
  name: "execute_command",
  description: "Run structured argv in the bound project's isolated Node or Python container after review and approval. Default snapshot is read-only. Optional execution creates a disposable writable snapshot with exact output files saved as artifacts; promote_run_outputs separately reviews application to the project. Container network stays disabled. Approved HTTPS dependencies with SHA256 are staged at .uptokey-dependencies/<path> for offline npm/pip commands; this does not resolve arbitrary online packages or persist installs. Runtime availability is reported accurately; no host fallback.",
  parameters: { type: "object", properties: {
    argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64, description: "Executable followed by separate arguments. No implicit shell or host execution." },
    profile: { type: "string", enum: ["node-app", "python-app"], description: "Isolated runtime image for the program." },
    workdir: { type: "string", description: "Directory relative to the bound project; defaults to its root (.)." },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
    execution: { type:"object", properties: {
      writable:{type:"boolean",const:true}, outputPaths:{type:"array",items:{type:"string"},maxItems:32,description:"Exact project-relative files to keep as artifacts; no glob or directory. 1 MiB per file, 4 MiB total."},
      dependencies:{type:"array",maxItems:32,items:{type:"object",properties:{url:{type:"string"},sha256:{type:"string"},path:{type:"string"}},required:["url","sha256","path"],additionalProperties:false},description:"Exact public HTTPS archives with verified SHA256; no redirects, credentials or query strings. Offline installation only."},
      resources:{type:"object",properties:{cpus:{type:"number",minimum:0.25,maximum:4,multipleOf:0.25},memoryMiB:{type:"integer",minimum:64,maximum:2048},diskMiB:{type:"integer",minimum:32,maximum:512}},required:["cpus","memoryMiB","diskMiB"],additionalProperties:false},
    },required:["writable","outputPaths"],additionalProperties:false },
  }, required: ["argv", "profile"], additionalProperties: false },
} }, {type:"function",function:{name:"promote_run_outputs",description:"Review and apply selected UTF-8 files produced by a previous isolated execution using its output manifest artifact. Requires separate user approval, verifies original project state and reuses the governed project writer. Never applies automatically or overwrites drift.",parameters:{type:"object",properties:{outputManifestArtifactId:{type:"string"},paths:{type:"array",items:{type:"string"},minItems:1,maxItems:32}},required:["outputManifestArtifactId","paths"],additionalProperties:false}}}];

const isolation = { kind: "oci_container", network: "none", projectSnapshot: "read_only", hostExecution: false } as const;
function literal(value: unknown): unknown {
  return value && typeof value === "object" && "kind" in value && value.kind === "literal" && "value" in value ? value.value : undefined;
}

export function nativeCommandExecutor(options: NativePlanHost & { rootBindingId: string }): NativeReadToolExecutor {
  return async (call, signal, context) => {
    if (!context) throw new Error("conversation_admission_unavailable");
    const check = async () => {
      signal?.throwIfAborted();
      if (!options.stillBound()) throw new Error("project_binding_changed");
      await context.assertCurrent();
      if (!options.stillBound()) throw new Error("project_binding_changed");
    };
    await check();
    if(call.name==='promote_run_outputs'){
      if(Object.keys(call.arguments).sort().join(',')!=='outputManifestArtifactId,paths'||typeof call.arguments.outputManifestArtifactId!=='string'||!Array.isArray(call.arguments.paths)||call.arguments.paths.some(p=>typeof p!=='string'))throw new Error('command_promotion_invalid');
      const current=await options.workspace.refresh(options.projectId,signal);await check();
      const planned=await options.workspace.createRunPromotionPlan(options.projectId,{expectedRevision:current.revision,rootBindingId:options.rootBindingId,outputManifestArtifactId:call.arguments.outputManifestArtifactId,paths:call.arguments.paths as string[]},signal);
      const step=planned.plan?.steps[0];
      if(planned.projectId!==options.projectId||planned.plan?.steps.length!==1||step?.capabilityId!=='workspace.project.write'||literal(step.arguments?.root_binding_id)!==options.rootBindingId)throw new Error('command_promotion_plan_mismatch');
      const changeSet=literal(step.arguments?.change_set) as {operations?:{type:string;path:string}[]}|undefined;
      if(!changeSet?.operations||changeSet.operations.some(op=>!['mkdir','create','replace'].includes(op.type)||op.type!=='mkdir'&&!(call.arguments.paths as string[]).includes(op.path)))throw new Error('command_promotion_plan_mismatch');
      await check();const settled=await executeNativeApprovedPlan(options,planned,t('cmd_summary_promote',{paths:(call.arguments.paths as string[]).join(', ')}),context,signal);
      const receipt=settled?.receipts.find(item=>item.runId===settled.run?.id&&item.capabilityId==='workspace.project.write');
      const output={tool:call.name,status:!settled?'not_executed':receipt?.status==='succeeded'&&settled.run?.status==='succeeded'?'succeeded':'not_completed',...(receipt?{receiptId:receipt.id}:{}),runId:settled?.run?.id,paths:call.arguments.paths};
      return {output:JSON.stringify(output),persistedOutput:output,...(receipt?{receiptId:receipt.id}:{})};
    }
    if (call.name !== "execute_command") throw new Error("conversation_tool_unavailable");
    if (Object.keys(call.arguments).some(key => !["argv", "profile", "workdir", "timeoutMs", "execution"].includes(key))
      || !["node-app", "python-app"].includes(String(call.arguments.profile))) throw new Error("command_request_invalid");
    const request = parseProjectRunRequest({
      taskId: `tui-command-${randomUUID()}`, manifestDigest: "0".repeat(64), runtimeProfileId: call.arguments.profile,
      actionId: "exec", argv: call.arguments.argv, relativeWorkingDirectory: call.arguments.workdir ?? ".",
      timeoutMs: call.arguments.timeoutMs ?? 180000, outputLimitBytes: 49152, artifactInputRefs: [],
      ...(call.arguments.execution!==undefined?{execution:call.arguments.execution}:{}),
    });
    if (request.timeoutMs > 300000 || request.argv![0]!.startsWith("-")) throw new Error("command_request_invalid");
    const profiles = await options.workspace.getRuntimeProfiles(signal);
    await check();
    const profile = profiles.find(item => item.id === request.runtimeProfileId);
    if (!profile?.available || profile.isolation !== "oci_container" || !profile.defaultActions.includes("exec")) {
      const outcome = { status: "not_executed", tool: call.name, reason: profile?.diagnostic ?? (!profile?.available ? "runtime_unavailable" : "runtime_action_unavailable"), profile: request.runtimeProfileId, isolation, setup: RUNNER_SETUP_HINT };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const manifest = await options.workspace.getManifest(options.projectId, options.rootBindingId, signal);
    await check();
    const sealedRequest = parseProjectRunRequest({ ...request, manifestDigest: manifest.snapshotDigest });
    const current = await options.workspace.refresh(options.projectId, signal);
    await check();
    const requestInput = { ...sealedRequest, artifactInputRefs: [...sealedRequest.artifactInputRefs],...(sealedRequest.execution?{execution:{writable:true as const,outputPaths:[...sealedRequest.execution.outputPaths],dependencies:sealedRequest.execution.dependencies?.map(d=>({...d})),...(sealedRequest.execution.resources?{resources:{...sealedRequest.execution.resources}}:{})}}:{}) };
    const planned = await options.workspace.createRunPlan(options.projectId, { expectedRevision: current.revision, rootBindingId: options.rootBindingId, request: requestInput }, signal);
    const step = planned.plan?.steps[0];
    const capabilityId=request.execution?.dependencies?.length?'workspace.project.dependency-run':'workspace.project.run';
    if (planned.projectId !== options.projectId || planned.plan?.steps.length !== 1 || step?.capabilityId !== capabilityId
      || literal(step.arguments?.root_binding_id) !== options.rootBindingId
      || JSON.stringify(parseProjectRunRequest(literal(step.arguments?.request))) !== JSON.stringify(sealedRequest)) throw new Error("command_plan_mismatch");
    await check();
    const summary = t("cmd_summary_run", { argv: JSON.stringify(request.argv), workdir: request.relativeWorkingDirectory, profile: profile.name, mode: t(request.execution ? "cmd_mode_writable" : "cmd_mode_read_only") });
    const settled = await executeNativeApprovedPlan(options, planned, summary, context, signal);
    if (!settled) {
      const outcome = { status: "not_executed", tool: call.name, reason: "user_declined" };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const runId = settled.run?.id;
    const receipt = settled.receipts.find(item => item.runId === runId && item.capabilityId === capabilityId);
    const artifactId = receipt?.outputArtifactRefs[0];
    if (settled.run?.status !== "succeeded" || receipt?.status !== "succeeded" || !artifactId) {
      const outcome = { status: "not_completed", tool: call.name, runId, runStatus: settled.run?.status ?? "unknown", ...(receipt ? { receiptId: receipt.id } : {}) };
      return { output: JSON.stringify(outcome), persistedOutput: outcome, ...(receipt ? { receiptId: receipt.id } : {}) };
    }
    await check();
    const report = parseProjectVerificationReport(JSON.parse(await options.workspace.readArtifact(options.projectId, artifactId, signal)));
    if (report.runId !== runId || report.taskId !== sealedRequest.taskId || report.manifestDigest !== manifest.snapshotDigest) throw new Error("command_report_mismatch");
    await check();
    let outputManifest:unknown;
    const outputManifestArtifactId=request.execution?.outputPaths.length&&receipt.outputArtifactRefs.length>1?receipt.outputArtifactRefs.at(-1):undefined;
    if(outputManifestArtifactId){outputManifest=JSON.parse(await options.workspace.readArtifact(options.projectId,outputManifestArtifactId,signal));await check();}
    const metadata = { status: report.checks.some(item => item.status === "fail") ? "failed" : !report.checks.length || report.checks.some(item => item.status !== "pass") ? "not_executed" : "succeeded", tool: call.name,
      runId, receiptId: receipt.id, artifactId, profile: request.runtimeProfileId, isolation:{...isolation,projectSnapshot:request.execution?'disposable_writable':'read_only'},...(outputManifestArtifactId?{outputManifestArtifactId}:{}),
      checks: report.checks.map(item => ({ id: item.id, status: item.status, ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) })) };
    return { output: JSON.stringify({ ...metadata, report,...(outputManifest?{outputManifest}:{}) }), persistedOutput: metadata, receiptId: receipt.id };
  };
}
