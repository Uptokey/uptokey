/** Capability consumers. All effects and durable outputs belong to the workspace core. */
import { createHash } from "node:crypto";
import { parseMediaConfigurationInfo, type ManagedMediaKind, type MediaConfigurationInfo } from "@uptokey/sync-contract/media-profile";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseImageRequest } from "@uptokey/sync-contract/image";
import { parseVideoRequest } from "@uptokey/sync-contract/video";
import { parseSpeechRequest } from "@uptokey/sync-contract/speech";
import { inspectTranscriptionAudio, parseTranscriptionRequest, parseTranscriptionResult, TRANSCRIPTION_AUDIO_MAX_BYTES, type TranscriptionAudioMediaType } from "@uptokey/sync-contract/transcription";
import { cosineSimilarity, parseEmbeddingsManifest, parseEmbeddingsRequest, EMBEDDINGS_INPUTS_MAX, EMBEDDINGS_INPUT_MAX_BYTES, EMBEDDINGS_TOTAL_MAX_BYTES } from "@uptokey/sync-contract/embeddings";
import { parseFilesystemReadRequest, type FilesystemReadTool } from "@uptokey/sync-contract/filesystem";
import { parseBrowserReadRequest, parseBrowserFillRequest } from "@uptokey/sync-contract/browser";
import { parseMultiModelPlan, parseMultimodelRun, type MultiModelPlan, type MultimodelRun } from "@uptokey/sync-contract/multimodel";
import { parseWorkspaceView, WorkspaceServiceError, type WorkspaceService, type WorkspaceView } from "./workspace.ts";
import type { TuiClient } from "./client.ts";

export type MediaKind = "image" | "video" | "speech" | "transcription" | "embeddings";
export interface CapabilityContext {
  projectId: string;
  rootBindingId?: string;
  rootPath?: string;
  conversationId?: string;
  model?: string;
  storagePolicy: "local" | "temporary";
  processingPolicy: "local_only" | "external_allowed";
}
export interface CapabilityResult { view: WorkspaceView; artifacts: string[]; text: string | null; transcript: string | null }
export interface RagSource { path: string; sha256: string; startLine: number; endLine: number; text: string; score: number }
export interface RagResult { sources: RagSource[]; context: string; embeddingResult: CapabilityResult }
export interface BrowserMcpCatalog { available: boolean; fillAvailable: boolean; allowedOrigin: string | null }
export interface McpToolView {
  id: FilesystemReadTool | "browser.page.inspect" | "browser.form.fill";
  owner: "filesystem" | "browser";
  effect: "read" | "write";
  description: string;
  allowedOrigin?: string;
}
export interface McpToolCatalog { tools: McpToolView[]; filesystemAvailable: boolean; browserAvailable: boolean }
export interface ComparisonInput {
  objective: string;
  members: Array<{ modelId: string; connectionId: string; task?: string }>;
  /** Explicit maximum supplied/reviewed by the person. Never inferred from balance. */
  maxCostMicros: string;
  maxTokens?: number;
  maxElapsedMs?: number;
}
export interface ComparisonResult { plan: MultiModelPlan; run: MultimodelRun; outputs: Array<{ memberId: string; artifactId: string; text: string }> }
export interface CapabilityActionsOptions {
  client: TuiClient;
  workspace: WorkspaceService;
  context: () => CapabilityContext;
  /** The controller owns human review, conversation admission, W5 and run cancellation. */
  approveAndRun: (view: WorkspaceView, summary: string, signal?: AbortSignal) => Promise<WorkspaceView>;
  approveComparison: (plan: MultiModelPlan, summary: string, signal?: AbortSignal) => Promise<boolean>;
  sign: (nonce: string) => string;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base = (id: string) => `/v1/workspace/projects/${encodeURIComponent(id)}`;
function error(code: string): never { throw new WorkspaceServiceError(code); }
const mediaParsers = { image: parseImageRequest, video: parseVideoRequest, speech: parseSpeechRequest, transcription: parseTranscriptionRequest, embeddings: parseEmbeddingsRequest };

export class TuiCapabilityActions {
  private readonly options: CapabilityActionsOptions;
  constructor(options: CapabilityActionsOptions) { this.options = options; }

  private capture(external = false, signal?: AbortSignal): CapabilityContext {
    signal?.throwIfAborted();
    const context = { ...this.options.context() };
    if (!context.projectId) error("capability_project_required");
    if (context.storagePolicy !== "local") error("operation_blocked_temporary_session");
    if (external && context.processingPolicy !== "external_allowed") error("capability_external_processing_required");
    return context;
  }
  private check(context: CapabilityContext, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const current = this.options.context();
    if (context.projectId !== current.projectId || context.rootBindingId !== current.rootBindingId || context.rootPath !== current.rootPath || context.conversationId !== current.conversationId
      || context.storagePolicy !== current.storagePolicy || context.processingPolicy !== current.processingPolicy) error("capability_context_changed");
  }
  private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.options.client.fetchRaw(path, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
    const value: unknown = await response.json();
    if (!response.ok) {
      const code = record(value) && record(value.error) && typeof value.error.type === "string" && /^[a-z0-9_:-]{1,160}$/i.test(value.error.type) ? value.error.type : `capability_request_failed_${response.status}`;
      throw new WorkspaceServiceError(code, response.status);
    }
    return value;
  }
  async catalog(kind: MediaKind, signal?: AbortSignal): Promise<{ available: boolean; model: string | null; operations: string[] }> {
    if (!Object.hasOwn(mediaParsers, kind)) error("capability_kind_invalid");
    const value = await this.json(`/v1/workspace/${kind}`, undefined, signal);
    if (!record(value) || typeof value.available !== "boolean" || !(value.model === null || typeof value.model === "string")) error("capability_catalog_invalid");
    return { available: value.available as boolean, model: value.model as string | null, operations: Array.isArray(value.operations) ? value.operations.filter((x): x is string => typeof x === "string") : [] };
  }
  /** Managed media configuration (GET/POST /v1/workspace/<kind>/config), the same contract the PWA uses. */
  async mediaConfiguration(kind: ManagedMediaKind, signal?: AbortSignal): Promise<MediaConfigurationInfo> {
    // Listing the connections first turns providers saved by the TUI into connections the media services can use.
    await this.json("/v1/connections", undefined, signal).catch(() => undefined);
    return parseMediaConfigurationInfo(await this.json(`/v1/workspace/${kind}/config`, undefined, signal));
  }
  async configureMedia(kind: ManagedMediaKind, input: Record<string, unknown>, signal?: AbortSignal): Promise<MediaConfigurationInfo> {
    return parseMediaConfigurationInfo(await this.json(`/v1/workspace/${kind}/config`, input, signal));
  }
  /** Live voice profile (GET /v1/workspace/voice): state and the saved OpenAI connections it can use. */
  async voiceProfile(signal?: AbortSignal): Promise<{ configured: boolean; model: string; profileRevision: number; connectionId?: string; connections: Array<{ id: string; label: string }> }> {
    // Listing the connections first turns providers saved by the TUI into connections the voice can use.
    await this.json("/v1/connections", undefined, signal).catch(() => undefined);
    const value = await this.json("/v1/workspace/voice", undefined, signal);
    if (!record(value) || !Array.isArray(value.connections)) error("voice_profile_invalid");
    const connections = (value.connections as unknown[]).filter((item): item is { id: string; label: string } => record(item) && typeof item.id === "string" && typeof item.label === "string");
    return { configured: value.configured === true, model: typeof value.model === "string" ? value.model : "", profileRevision: typeof value.profileRevision === "number" ? value.profileRevision : 0, ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}), connections };
  }
  async configureVoice(input: { connectionId: string; expectedRevision: number; model: string }, signal?: AbortSignal): Promise<{ configured: boolean }> {
    const value = await this.json("/v1/workspace/voice/config", input, signal);
    return { configured: record(value) && value.configured === true };
  }
  async mcpCatalog(signal?: AbortSignal) { return this.options.workspace.getFilesystemCatalog(signal); }
  async browserCatalog(signal?: AbortSignal): Promise<BrowserMcpCatalog> {
    const value = await this.json("/v1/workspace/browser", undefined, signal);
    if (!record(value) || typeof value.available !== "boolean" || typeof value.fillAvailable !== "boolean"
      || !(value.allowedOrigin === null || typeof value.allowedOrigin === "string")) error("browser_catalog_invalid");
    if (value.available) {
      if (typeof value.allowedOrigin !== "string") error("browser_catalog_invalid");
      try {
        const parsed = parseBrowserReadRequest({ schemaVersion: 1, url: `${value.allowedOrigin}/` });
        if (new URL(parsed.url).origin !== value.allowedOrigin) error("browser_catalog_invalid");
      } catch { error("browser_catalog_invalid"); }
    } else if (value.fillAvailable || value.allowedOrigin !== null) error("browser_catalog_invalid");
    return { available: value.available as boolean, fillAvailable: value.fillAvailable as boolean, allowedOrigin: value.allowedOrigin as string | null };
  }
  /** Only executable configured owners are listed. Caller-supplied MCP descriptors never become authority. */
  async mcpTools(signal?: AbortSignal): Promise<McpToolCatalog> {
    const [filesystem, browser] = await Promise.all([this.mcpCatalog(signal), this.browserCatalog(signal)]);
    signal?.throwIfAborted();
    const tools: McpToolView[] = filesystem?.available ? filesystem.tools.map(tool => ({ id: tool.name, owner: "filesystem", effect: "read",
      description: tool.name === "read_text_file" ? "Ler linhas de um arquivo na raiz MCP configurada" : tool.name === "list_directory" ? "Listar a pasta na raiz MCP configurada" : "Consultar metadados de arquivo" })) : [];
    if (browser.available && browser.allowedOrigin) {
      tools.push({ id: "browser.page.inspect", owner: "browser", effect: "read", allowedOrigin: browser.allowedOrigin, description: "Abrir e inspecionar uma página na origem de navegador configurada" });
      if (browser.fillAvailable) tools.push({ id: "browser.form.fill", owner: "browser", effect: "write", allowedOrigin: browser.allowedOrigin, description: "Preencher campos de texto por rótulo, sem enviar formulário" });
    }
    return { tools, filesystemAvailable: filesystem?.available === true, browserAvailable: browser.available };
  }

  async runBrowser(url: string, signal?: AbortSignal): Promise<CapabilityResult> { return this.browserOperation(url, undefined, signal); }
  async fillBrowser(url: string, fields: readonly { label: string; value: string }[], signal?: AbortSignal): Promise<CapabilityResult> { return this.browserOperation(url, fields, signal); }
  private async browserOperation(url: string, fields: readonly { label: string; value: string }[] | undefined, signal?: AbortSignal): Promise<CapabilityResult> {
    // The existing browser owner admits only its explicit loopback origin, never an Internet URL.
    const context = this.capture(false, signal);
    const request = fields === undefined ? parseBrowserReadRequest({ schemaVersion: 1, url }) : parseBrowserFillRequest({ schemaVersion: 1, url, fields });
    const catalog = await this.browserCatalog(signal);
    this.check(context, signal);
    if (!catalog.available || fields !== undefined && !catalog.fillAvailable) error("browser_unavailable");
    if (new URL(request.url).origin !== catalog.allowedOrigin) error("browser_origin_denied");
    const route = fields === undefined ? "browser-plans" : "browser-fill-plans";
    const view = await this.prepare(context, route, request, signal);
    const capability = fields === undefined ? "browser.page.inspect" : "browser.form.fill";
    if (view.plan?.steps.length !== 1 || view.plan.steps[0]?.capabilityId !== capability) error("browser_plan_unbound");
    return this.run(context, view, fields === undefined ? `MCP navegador: inspecionar ${request.url}` : `MCP navegador: preencher ${fields.map(field => field.label).join(", ")} em ${request.url} (sem enviar)`, signal);
  }

  private async prepare(context: CapabilityContext, route: string, request: unknown, signal?: AbortSignal): Promise<WorkspaceView> {
    const current = await this.options.workspace.refresh(context.projectId, signal);
    this.check(context, signal);
    const view = parseWorkspaceView(await this.json(`${base(context.projectId)}/${route}`, { expectedRevision: current.revision, request }, signal));
    this.check(context, signal);
    if (view.projectId !== context.projectId || !view.plan || view.run) error("capability_plan_unbound");
    return view;
  }
  async prepareMedia(kind: MediaKind, input: Record<string, unknown>, signal?: AbortSignal): Promise<WorkspaceView> {
    const context = this.capture(true, signal), catalog = await this.catalog(kind, signal);
    this.check(context, signal);
    if (!catalog.available || !catalog.model) error(`${kind}_unavailable`);
    const defaults = kind === "image" ? { n: 1, size: "1024x1024", operation: "generate", inputRefs: [] }
      : kind === "video" ? { duration: 5, aspectRatio: "16:9", resolution: "720p", generateAudio: false, inputRefs: [] }
      : kind === "transcription" ? { timestamps: false } : {};
    const request = mediaParsers[kind]({ ...defaults, ...input, schemaVersion: 1, model: input.model ?? catalog.model });
    if (request.model !== catalog.model) error(`${kind}_model_invalid`);
    return this.prepare(context, `${kind}-plans`, request, signal);
  }
  private async run(context: CapabilityContext, view: WorkspaceView, summary: string, signal?: AbortSignal): Promise<CapabilityResult> {
    this.check(context, signal);
    const settled = await this.options.approveAndRun(view, summary, signal);
    this.check(context, signal);
    if (!view.plan || settled.projectId !== context.projectId || settled.plan?.id !== view.plan.id || settled.plan.digest !== view.plan.digest || settled.run?.planId !== view.plan.id) error("capability_result_unbound");
    if (settled.run.status !== "succeeded") error(`capability_run_${settled.run.status}`);
    const receipts = settled.receipts.filter(receipt => receipt.runId === settled.run!.id && receipt.status === "succeeded");
    const artifacts = [...new Set(receipts.flatMap(receipt => receipt.outputArtifactRefs))];
    if (!receipts.length || !settled.artifact || !artifacts.includes(settled.artifact.id)) error("capability_receipt_missing");
    const text = /^(text\/|application\/json$)/.test(settled.artifact.mediaType ?? "")
      ? await this.options.workspace.readArtifact(context.projectId, settled.artifact.id, signal) : null;
    this.check(context, signal);
    return { view: settled, artifacts, text, transcript: null };
  }
  async runMedia(kind: MediaKind, input: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityResult> {
    const context = this.capture(true, signal);
    const view = await this.prepareMedia(kind, input, signal);
    const result = await this.run(context, view, `${kind}: ${String(input.prompt ?? input.input ?? (kind === "embeddings" ? "representações vetoriais das fontes selecionadas" : "áudio selecionado")).slice(0, 240)}`, signal);
    if (kind === "transcription") result.transcript = parseTranscriptionResult(JSON.parse(result.text ?? "null")).text;
    return result;
  }
  async resumeVideo(jobArtifactId: string, signal?: AbortSignal): Promise<CapabilityResult> {
    const context = this.capture(true, signal), current = await this.options.workspace.refresh(context.projectId, signal);
    this.check(context, signal);
    const view = parseWorkspaceView(await this.json(`${base(context.projectId)}/video-resume-plans`, { expectedRevision: current.revision, jobArtifactId }, signal));
    if (view.projectId !== context.projectId || !view.plan || view.run) error("capability_plan_unbound");
    return this.run(context, view, "Retomar a consulta e obtenção do vídeo existente", signal);
  }
  async transcribeAudio(bytes: Uint8Array, mediaType: TranscriptionAudioMediaType, options: { language?: string; timestamps?: boolean } = {}, signal?: AbortSignal): Promise<CapabilityResult> {
    const context = this.capture(true, signal);
    if (bytes.byteLength > TRANSCRIPTION_AUDIO_MAX_BYTES) error("transcription_audio_too_large");
    const audio = new Uint8Array(bytes);
    inspectTranscriptionAudio(audio, mediaType);
    const current = await this.options.workspace.refresh(context.projectId, signal);
    this.check(context, signal);
    const saved = await this.json(`${base(context.projectId)}/audio-import`, { expectedRevision: current.revision, mediaType, audioBase64: Buffer.from(audio).toString("base64") }, signal);
    this.check(context, signal);
    if (!record(saved) || saved.projectId !== context.projectId || typeof saved.artifactId !== "string") error("capability_audio_import_invalid");
    return this.runMedia("transcription", { ...options, audio: { artifactId: saved.artifactId, sha256: hash(audio), byteLength: audio.byteLength, mediaType } }, signal);
  }
  /** Explicitly selected existing audio inside the exact active project root. No arbitrary file read. */
  async transcribeFile(path: string, options: { language?: string; timestamps?: boolean } = {}, signal?: AbortSignal): Promise<CapabilityResult> {
    const context = this.capture(true, signal);
    if (!context.rootPath || !context.rootBindingId || isAbsolute(path) || !path || path.includes(":")) error("transcription_path_invalid");
    this.check(context, signal);
    const extension = path.split(".").at(-1)?.toLowerCase();
    const mediaType = ({ mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4" } as const)[extension as "mp3"];
    if (!mediaType) error("transcription_audio_type_invalid");
    const bytes = await this.options.workspace.readFile(context.projectId, context.rootBindingId, path, signal).catch(e => {
      if (e instanceof Error && e.message.includes("413")) error("transcription_audio_too_large");
      throw e;
    });
    this.check(context, signal);
    return this.transcribeAudio(bytes, mediaType, options, signal);
  }
  async runMcp(tool: FilesystemReadTool, relativePath: string, lineLimit = 200, signal?: AbortSignal): Promise<CapabilityResult> {
    const context = this.capture(false, signal), catalog = await this.mcpCatalog(signal);
    this.check(context, signal);
    const descriptor = catalog?.available && catalog.tools.find(item => item.name === tool);
    if (!descriptor || !catalog?.profileDigest) error("mcp_tool_unavailable");
    const request = parseFilesystemReadRequest({ schemaVersion: 1, tool, relativePath, ...(tool === "read_text_file" ? { lineLimit } : {}), profileDigest: catalog!.profileDigest, schemaDigest: descriptor.schemaDigest });
    return this.run(context, await this.prepare(context, "filesystem-plans", request, signal), `MCP ${tool}: ${relativePath}`, signal);
  }
  /** Selected files are read by the authorized core; the persisted embedding manifest binds every ranked chunk. */
  async rag(query: string, paths: string[], signal?: AbortSignal): Promise<RagResult> {
    const context = this.capture(true, signal);
    if (!context.rootBindingId || !query.trim() || !paths.length || new Set(paths).size !== paths.length || paths.length > 10) error("rag_selection_invalid");
    const chunks: Array<Omit<RagSource, "score">> = [];
    let total = Buffer.byteLength(query);
    for (const path of paths) {
      const file = await this.options.workspace.readProjectFile(context.projectId, context.rootBindingId!, path, signal);
      this.check(context, signal);
      if (!file) error("rag_source_missing");
      const lines = file!.text.split("\n");
      let text = "", start = 1;
      const flush = (end: number) => { if (text.trim()) { total += Buffer.byteLength(text); chunks.push({ path, sha256: file!.sha256, startLine: start, endLine: end, text }); } text = ""; start = end + 1; };
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]! + (index < lines.length - 1 ? "\n" : "");
        if (Buffer.byteLength(line) > EMBEDDINGS_INPUT_MAX_BYTES) error("rag_line_too_large");
        if (Buffer.byteLength(text + line) > EMBEDDINGS_INPUT_MAX_BYTES) flush(index);
        text += line;
      }
      flush(lines.length);
    }
    if (!chunks.length || chunks.length + 1 > EMBEDDINGS_INPUTS_MAX || total > EMBEDDINGS_TOTAL_MAX_BYTES) error("rag_selection_too_large");
    const texts = [query, ...chunks.map(chunk => chunk.text)];
    const embeddingResult = await this.runMedia("embeddings", { inputs: texts.map(text => ({ kind: "text", text })) }, signal);
    const manifest = parseEmbeddingsManifest(JSON.parse(embeddingResult.text ?? "null"));
    if (manifest.inputs.length !== texts.length || manifest.inputs.some((input, index) => input.index !== index || input.sha256 !== hash(texts[index]!) || input.byteLength !== Buffer.byteLength(texts[index]!))) error("rag_manifest_unbound");
    const sources = chunks.map((chunk, index) => ({ ...chunk, score: cosineSimilarity(manifest.vectors[0]!, manifest.vectors[index + 1]!) }))
      .filter((chunk): chunk is RagSource => chunk.score !== null).sort((a, b) => b.score - a.score).slice(0, 5);
    if (!sources.length) error("rag_vectors_unrankable");
    // Do not send stale file contents if a source changed while inference was awaiting approval.
    for (const path of new Set(sources.map(source => source.path))) {
      const current = await this.options.workspace.readProjectFile(context.projectId, context.rootBindingId!, path, signal);
      if (!current || current.sha256 !== sources.find(source => source.path === path)!.sha256) error("rag_source_changed");
    }
    this.check(context, signal);
    return { sources, embeddingResult, context: sources.map(source => `[${source.path}:${source.startLine}-${source.endLine}; sha256=${source.sha256}]\n${source.text}`).join("\n\n") };
  }

  async compare(input: ComparisonInput, signal?: AbortSignal): Promise<ComparisonResult> { return this.panel("compare", input, signal); }
  async delegateModels(input: ComparisonInput, signal?: AbortSignal): Promise<ComparisonResult> { return this.panel("subagents", input, signal); }
  async listComparisons(signal?: AbortSignal): Promise<MultimodelRun[]> {
    const context = this.capture(false, signal), value = await this.json(`${base(context.projectId)}/multimodel-runs`, undefined, signal);
    this.check(context, signal);
    if (!record(value) || !Array.isArray(value.runs)) error("comparison_response_invalid");
    const runs = value.runs.map(parseMultimodelRun);
    if (runs.some(run => run.projectId !== context.projectId)) error("comparison_run_unbound");
    return runs;
  }
  async getComparison(runId: string, signal?: AbortSignal): Promise<MultimodelRun> { return this.comparisonAction(runId, undefined, signal); }
  /** Core reload reconciles persisted branches; it never replays inference. */
  async reloadComparison(runId: string, signal?: AbortSignal): Promise<MultimodelRun> { return this.comparisonAction(runId, "reload", signal); }
  async cancelComparison(runId: string): Promise<MultimodelRun> { return this.comparisonAction(runId, "cancel"); }
  private async comparisonAction(runId: string, action?: "reload" | "cancel", signal?: AbortSignal): Promise<MultimodelRun> {
    const context = this.capture(false, signal);
    const run = parseMultimodelRun(await this.json(`${base(context.projectId)}/multimodel-runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`, action ? {} : undefined, signal));
    this.check(context, signal);
    if (run.projectId !== context.projectId || run.id !== runId) error("comparison_run_unbound");
    return run;
  }
  private async panel(mode: "compare" | "subagents", input: ComparisonInput, signal?: AbortSignal): Promise<ComparisonResult> {
    const context = this.capture(true, signal);
    if (!input.objective.trim() || input.objective.length > 8000 || input.members.length < 2 || input.members.length > 8 || !/^[1-9][0-9]{0,15}$/.test(input.maxCostMicros)) {
      error("comparison_input_invalid");
    }
    let raw = await this.json(base(context.projectId), undefined, signal);
    this.check(context, signal);
    if (!record(raw) || !Number.isSafeInteger(raw.revision)) error("capability_response_invalid");
    // /plans captures context, never starts execution. An empty selection avoids including unrelated project data.
    raw = await this.json(`${base(context.projectId)}/plans`, { expectedRevision: raw.revision, objective: input.objective, selectedEntryIds: [], selectedArtifactIds: [], sourceIds: ["crossref"] }, signal);
    this.check(context, signal);
    if (!record(raw) || !record(raw.plan) || typeof raw.plan.contextSnapshotId !== "string" || !Number.isSafeInteger(raw.revision)) error("comparison_snapshot_missing");
    const elapsed = input.maxElapsedMs ?? 120_000, tokens = input.maxTokens ?? 2048;
    const plan = parseMultiModelPlan(await this.json(`${base(context.projectId)}/multimodel-plans`, {
      expectedRevision: raw.revision, mode, principalModel: input.members[0]!.modelId,
      members: input.members.map((member, index) => ({ id: `member_${index + 1}`, role: "worker", ...member, task: member.task ?? input.objective, allowedCapabilityIds: [], contextRefs: [] })),
      analystModel: null, finalModel: null, limits: { maxMembers: input.members.length, maxConcurrency: Math.min(3, input.members.length), maxDepth: 0, maxCalls: input.members.length, maxElapsedMs: elapsed, maxCostMicros: input.maxCostMicros, maxTokens: tokens },
      quorum: { minSuccess: input.members.length, graceMs: 0, deadlineMs: elapsed }, contextSnapshotId: raw.plan.contextSnapshotId,
    }, signal));
    this.check(context, signal);
    if (plan.projectId !== context.projectId) error("comparison_plan_unbound");
    if (!await this.options.approveComparison(plan, `${mode === "compare" ? "Comparar" : "Delegar a"} ${plan.members.map(member => member.modelId).join(", ")}; teto ${plan.limits.maxCostMicros} micros`, signal)) error("comparison_declined");
    this.check(context, signal);
    const command = { planId: plan.id, planDigest: plan.digest }, route = `${base(context.projectId)}/multimodel-plans/${encodeURIComponent(plan.id)}/consent`;
    const challenge = await this.json(`${route}/challenge`, command, signal);
    this.check(context, signal);
    if (!record(challenge) || typeof challenge.challengeId !== "string" || typeof challenge.nonce !== "string" || !challenge.nonce || challenge.nonce.length > 4096) error("consent_challenge_invalid");
    const signature = this.options.sign(challenge.nonce as string);
    if (!signature || signature.length > 1024) error("consent_signature_invalid");
    let run: MultimodelRun;
    try { run = parseMultimodelRun(await this.json(`${route}/complete`, { command, challengeId: challenge.challengeId, signature }, signal)); }
    catch (original) {
      // Lost acknowledgement may have admitted a run. Reconcile, never repeat the consent POST.
      const listed = await this.json(`${base(context.projectId)}/multimodel-runs`).catch(() => null);
      const matches = record(listed) && Array.isArray(listed.runs) ? listed.runs.map(parseMultimodelRun).filter(item => item.planId === plan.id && item.planDigest === plan.digest) : [];
      if (matches.length !== 1) throw original;
      run = matches[0]!;
    }
    const assertBound = (value: MultimodelRun) => { if (value.projectId !== context.projectId || value.planId !== plan.id || value.planDigest !== plan.digest) error("comparison_run_unbound"); };
    assertBound(run);
    try {
      const until = Date.now() + elapsed + 10_000;
      while (run.status === "running" || run.status === "draft") {
        this.check(context, signal);
        if (Date.now() > until) error("comparison_observation_timeout");
        await delay(250, undefined, { signal });
        const next = parseMultimodelRun(await this.json(`${base(context.projectId)}/multimodel-runs/${encodeURIComponent(run.id)}`, undefined, signal));
        assertBound(next); if (next.id !== run.id) error("comparison_run_unbound"); run = next;
      }
      this.check(context, signal);
      const outputs: ComparisonResult["outputs"] = [];
      for (const branch of run.branches) for (const artifactId of branch.artifactRefs) {
        outputs.push({ memberId: branch.memberId, artifactId, text: await this.options.workspace.readArtifact(context.projectId, artifactId, signal) });
      }
      this.check(context, signal);
      return { plan, run, outputs };
    } catch (original) {
      if (run.status === "running" || run.status === "draft") {
        try { await this.json(`${base(context.projectId)}/multimodel-runs/${encodeURIComponent(run.id)}/cancel`, {}); }
        catch { throw new WorkspaceServiceError("comparison_cancel_unconfirmed", null, "unknown"); }
      }
      throw original;
    }
  }
}
