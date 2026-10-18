import { t, getLang } from "./i18n.ts";
import { chromeText } from "./ui-chrome.ts";
import { approveActiveContext } from "./context-link.ts";
import { localizedContextError, localizedDiagnostic, operationText } from "./operation-ui.ts";
/**
 * Uptokey TUI — controller.
 *
 * Owns every operational decision of the terminal client so the renderer only
 * draws state and forwards intentions. Effects never happen here: they are
 * prepared as canonical plans in the core, approved with the native W5
 * signature and observed through the journal (runs, receipts, artifacts).
 *
 *   pedido → contexto (core) → resposta → proposta revisável → W5 → bytes →
 *   verificação no runner → recibo → retomada
 */
import { EventEmitter } from "node:events";
import { TuiFeatures } from "./features.ts";
import { loadTaskIntegration } from "./task-integration.ts";
import { createHash, randomUUID } from "node:crypto";
import { TuiClient, TuiHttpError, type TuiInferenceDestination } from "./client.ts";
import { TuiStore, type Message } from "./state.ts";
import { ConversationService, ConversationServiceError, TURN_UNDO_PREFIX, composeHistory, type ComposedHistory, type DispatchMessage, type NativeToolExecutionContext, type TurnRestoreRecord } from "./conversations.ts";
import { WorkspaceService, WorkspaceServiceError, isSettledStatus, type ProjectManifestEntry, type ProjectTaskView, type RuntimeProfile, type WorkspaceView } from "./workspace.ts";
import { SUBAGENT_MAX_TOKENS, TASK_TERMINAL, integrationPrompt, subagentMessages, type ChildLabel, type ChildResult, type DelegationSpec, getChildStatusText, getTaskStatusText } from "./delegation.ts";
import { resolveProjectBinding, type BindingCandidate, type ProjectBinding } from "./project-binding.ts";
import { ContextSet, describeReadError } from "./context-set.ts";
import { buildProposal, changeSetFor, describeFile, failureFeedback, intentionText, splitFileHunks, type ChangeProposal } from "./change-proposal.ts";
import { markdownFromCanonicalExport, projectFileReference, type ChatFileReference } from "./artifact-actions.ts";
import { writeClipboard } from "./clipboard.ts";
import { EDIT_PROTOCOL_INSTRUCTIONS } from "./edit-blocks.ts";
import { buildRepoMap, formatRepoMap } from "./repo-map.ts";
import { buildRunRequest, chooseVerification, interpretReport, RUNNER_SETUP_HINT, type VerificationChoice } from "./verification.ts";
import { createStreamCoalescer } from "./stream-coalescing.ts";
import { liveToolActivity, liveTurnItems } from "./live-activity.ts";
import { toolResultStatus, type CompletedToolStatus } from "./tool-result-status.ts";
import { claimsSuccess } from "./success-claim.ts";
import { isTestCommand, passedVerificationDigest, successfulWrite } from "./verification-evidence.ts";
import { chooseToolset, compactEditProtocol, selectToolset } from "./toolset.ts";
import { diffLines, diffStats, splitLines } from "./line-diff.ts";
import { outputReserve, type ContextBudget } from "./context-budget.ts";
import { sanitizeForDisplay } from "./sanitize.ts";
import type { TranscriptItem } from "./transcript.ts";
import { loadConnections, providerSetupUrl, openLoopbackUrl, type ConnectionsSnapshot } from "./connections.ts";
import type { GitOperationInput, GitStatusView } from "./workspace.ts";
import { parseCommandLine, profileForProgram } from "./shell-words.ts";
import { executeHooks, loadHooksSource, type HookDefinition, type HookPhase, type HooksSource } from "./hooks.ts";
import { getHookTrust, hashHooksSource, revokeHookTrust, trustHooks } from "./hook-trust.ts";
import { discoverSkills, skillsContext, type SkillView } from "./skills.ts";
import { LspClient, applyTextEdits, effectiveServer, formatDiagnostics, grantLspConsent, hasLspConsent, resolveProgram, revokeLspConsent, serverForFile, type ServerSpec } from "./lsp.ts";
import { readFile, writeFile, stat, link, rename, unlink } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { BoundApprovalRequest, BoundRunRequest } from "./approvals.ts";
import { PROJECT_READ_TOOLS, projectReadExecutor } from "./project-read-tools.ts";
import { nativeWebTools, nativeWebExecutor } from "./native-web-tools.ts";
import { NATIVE_WRITE_TOOLS, nativeWriteExecutor } from "./native-write-tools.ts";
import { NATIVE_EDIT_PROTOCOL, AUTONOMY_PROTOCOL } from "./coding-protocol.ts";
import { nativeMcpTools, nativeMcpExecutor } from "./native-mcp-tools.ts";
import { nativeServiceExecutor, nativeServiceTools } from "./native-service-tools.ts";
import { PROGRESS_TOOLS, progressExecutor, todosFromResults, type TodoItem } from "./native-progress-tools.ts";
import { QUESTION_TOOLS, questionExecutor, type QuestionInfo } from "./native-question-tools.ts";
import { DELEGATE_TOOLS, DELEGATE_TOOL_NAME, nativeDelegateExecutor } from "./native-delegate-tools.ts";
import { NATIVE_COMMAND_TOOLS, nativeCommandExecutor } from "./native-command-tools.ts";
import { SHADOW_BASH_TOOLS, shadowBashExecutor, clearShadowBashSessions } from "./shadow-bash.ts";
import { NATIVE_CODING_TOOLS, nativeCodingExecutor, type NativeDiagnosticsResult } from "./native-coding-tools.ts";
import { loadDestinationPreference, saveDestinationPreference } from "./destination-preference.ts";
import { prepareMediaInput as prepareCanonicalMediaInput, resolveMediaArtifact, MediaInputError, type MediaInputPart, type PreparedMediaInput } from "./media-input.ts";
import { connectionText } from "./frontend/uptokey/integration-connections.ts";
import { TuiAccount } from "./account.ts";
import { HOSTED_PROVIDER, type TuiHostedModel } from "./hosted.ts";
import { hostedText } from "./hosted-ui.ts";
import { accountErrorText } from "./account-ui.ts";

export type Mode = "build" | "plan";

export interface SteerItem {
  id: string;
  text: string;
  /** pending → submitted (sent as the next turn) → applied (accepted by the core). */
  state: "pending" | "submitted" | "applied";
}

export interface DispatchInfo {
  messages: number;
  bytes: number;
  compactedMessages: number;
  contextFiles: number;
  tokens: { input: number | null; state: string } | null;
  at: number;
}

export interface ControllerView {
  binding: ProjectBinding | null;
  bindingCandidates: BindingCandidate[] | null;
  bindingError: string | null;
  mode: Mode;
  toolsEnabled: boolean;
  /** Autonomy: tool effects (edits, commands, web, LSP start) run without asking each time; the turn keeps going until done. */
  autonomy: boolean;
  toolsAvailable: string[];
  steer: SteerItem[];
  /** Task list kept by the model through update_todos (restored from the conversation's tool results). */
  todos: TodoItem[];
  /** A structured question from the model awaiting the person (ask_user); null when none. */
  question: { id: string; questions: QuestionInfo[] } | null;
  proposal: ChangeProposal | null;
  approvals: BoundApprovalRequest[];
  attention: BoundRunRequest | null;
  lastDispatch: DispatchInfo | null;
  signerAvailable: boolean;
  /** Offered after an applied change; Enter/`/verificar` runs it. */
  verifyOffer: VerificationChoice | null;
  /** Last failure that a correction turn can use. */
  correction: { kind: "verification" | "edits"; text: string } | null;
  busy: string | null;
  instructionsSource: string | null;
  manifestFiles: string[];
  connections: ConnectionsSnapshot | null;
  /** Conversation budget from the core ledger, when configured. */
  budget: { limitMicros: number | null; spentMicros: number | null; reservedMicros: number | null } | null;
  git: GitStatusView | null;
  hooks: { count: number; rejected: number; trusted: boolean; hash: string; path: string } | null;
  /** A language server waits for the person's consent to start in this folder. */
  lspConsentRequest: { spec: ServerSpec; paths: string[]; then: "diagnostics" | { rename: { target: string; newName: string } } | { actions: string } | { locate: { kind: "references" | "definition"; target: string } } } | null;
  /** Result of /referencias or /definicao: locations from the language server, shown by the frontend. */
  lspLocations: { kind: "references" | "definition"; target: string; items: Array<{ path: string; line: number; column: number; preview: string }> } | null;
  skills: SkillView[];
  activeSkills: string[];
  artifacts: ArtifactView[];
  artifactsNextCursor?: string | null;
  /** Delegated tasks of the bound project (core journal) with the labels known to this session. */
  tasks: TrackedTask[];
  /** Subagent results waiting for the single integration turn (`/integrar`). */
  integration: { taskId: string; objective: string; prompt: string } | null;
  /** Background-generated map of the project structure for the LLM. */
  repoMapText: string | null;
}

export interface TrackedTask { task: ProjectTaskView; labels: ChildLabel[] }

export interface ArtifactView { id: string; mediaType: string; filename: string | null; byteLength: number; sha256: string; runId: string; createdAt: string }

export interface ControllerOptions {
  cwd: string;
  baseUrl: string;
  token?: string;
  projectHint?: string;
  model?: string;
  resume?: string;
  temporary?: boolean;
  client?: TuiClient;
  sign?: ((nonce: string) => string) | null;
  loadSigner?: () => Promise<((nonce: string) => string) | null>;
  loadToken?: (show:(message:string)=>void,signal:AbortSignal)=>Promise<string|undefined>;
  /** Remembered choice among several bindings of the same folder. */
  preferredBinding?: { projectId: string; rootBindingId: string };
  /** Processing policy for new conversations (existing ones keep their own). */
  processingPolicy?: "local_only" | "external_allowed";
  /**
   * Folders named in a request (`@dir` or a plain path) rebind the project automatically ("auto", the previous
   * interface's behaviour). The OpenTUI frontend asks the person first and binds explicitly, so it passes "off".
   */
  folderMentionBinding?: "auto" | "off";
}

interface LiveItem { item: TranscriptItem; after: string | null }

const SYSTEM_BASE = () => t("system_base_assistante");


export class TuiController extends EventEmitter {
  readonly instanceId = randomUUID();
  readonly store = new TuiStore();
  readonly context = new ContextSet();
  readonly client: TuiClient;
  readonly account: TuiAccount;
  readonly conversations: ConversationService;
  readonly workspace: WorkspaceService;
  readonly features: TuiFeatures;
  readonly view: ControllerView = {
    binding: null, bindingCandidates: null, bindingError: null, mode: "build",
    toolsEnabled: false, autonomy: process.env.UPTOKEY_TUI_AUTONOMY === "1", toolsAvailable: [], steer: [], todos: [], question: null, proposal: null, approvals: [], attention: null,
    lastDispatch: null, signerAvailable: false, verifyOffer: null, correction: null, busy: null,
    instructionsSource: null, manifestFiles: [], connections: null, budget: null, git: null, hooks: null, lspConsentRequest: null, lspLocations: null, skills: [], activeSkills: [], artifacts: [], tasks: [], integration: null, repoMapText: null,
  };
  private compactionSuggested = new Set<string>();
  private hooks: { source: HooksSource; hash: string; trusted: boolean } | null = null;
  private live: LiveItem[] = [];
  private sign: ((nonce: string) => string) | null = null;
  private turnAbort: AbortController | null = null;
  private effectAbort: AbortController | null = null;
  private shellTail: Promise<void> = Promise.resolve();
  private pendingShells = new Set<AbortController>();
  private instructions: string | null = null;
  private profiles: RuntimeProfile[] = [];
  private taskLabels = new Map<string, ChildLabel[]>();
  private manifestEntries: ProjectManifestEntry[] = [];
  private disposed = false;
  private bindingPath: string;
  private bindingHint: string | undefined;
  private bindingGeneration = 0;
  private conversationOpenGeneration = 0;
  private modelSelectionGeneration = 0;
  private bindingAbort: AbortController | null = null;
  private repoMapAbort: AbortController | null = null;
  private readonly lifecycleAbort=new AbortController();
  private readonly options: ControllerOptions;
  private emitScheduled = false;
  private readonly preparedMediaContexts = new WeakMap<PreparedMediaInput, () => void>();
  hostedModels: readonly TuiHostedModel[] = [];
  hostedCatalogError: "account_reauthentication_required" | "hosted_model_unavailable" | null = null;
  private hostedIdentity = "";
  private hostedGeneration = 0;
  private hostedLoading: Promise<void> | null = null;
  private started = false;
  private rememberedHosted: { model: string; processingPolicy: "local_only" | "external_allowed" } | undefined;

  constructor(options: ControllerOptions) {
    super();
    this.options = options;
    this.bindingPath = options.cwd;
    this.bindingHint = options.projectHint;
    this.client = options.client ?? new TuiClient({ baseUrl: options.baseUrl, ...(options.token ? { token: options.token } : {}) });
    this.account = new TuiAccount(this.client);
    this.account.on("change", () => { this.changed(); if (!this.account.view.busy) void this.refreshHostedModels(); });
    this.conversations = new ConversationService(this.client);
    this.workspace = new WorkspaceService(this.client);
    this.conversations.setMediaResolver(async (conversation, part, model, destination, signal) => {
      const validate = this.captureContext(signal);
      if (!conversation.projectId || !part.artifactRef || part.type !== "image" && part.type !== "audio") throw new MediaInputError("attachment_unavailable");
      const media = await resolveMediaArtifact({ client: this.client, workspace: this.workspace, projectId: conversation.projectId, artifactId: part.artifactRef, kind: part.type, model, destination, signal });
      validate();
      return media;
    });
    this.features = new TuiFeatures(this, () => this.ensureConversation());
    if (options.temporary) this.store.dispatch({ type: "storage_policy_changed", storagePolicy: "temporary" });
    if (options.model) this.store.dispatch({ type: "model_selected", model: options.model });
    if (options.processingPolicy) this.store.dispatch({ type: "processing_policy_changed", processingPolicy: options.processingPolicy });
    this.workspace.setStoragePolicy(this.store.state.storagePolicy);
    this.store.on("change", () => { this.workspace.setStoragePolicy(this.store.state.storagePolicy); this.changed(); });
    this.context.onChange(() => this.changed());
    if (options.sign) { this.sign = options.sign; this.view.signerAvailable = true; }
  }

  /** Coalesces many state changes of one tick into a single render. */
  private changed(): void {
    if (this.emitScheduled || this.disposed) return;
    this.emitScheduled = true;
    queueMicrotask(() => { this.emitScheduled = false; if (!this.disposed) this.emit("change"); });
  }

  get state() { return this.store.state; }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.store.dispatch({ type: "connection_changed", phase: "connecting" });
    const health = await this.client.health();
    if (health.status !== "ok") {
      this.store.dispatch({ type: "connection_changed", phase: "disconnected" });
      // Opening the TUI must remain useful while the daemon is booting.  The
      // shell retries the canonical launcher; an unavailable daemon is an
      // onboarding state, not a failed conversation.
      return;
    }
    if(!this.options.token&&this.options.loadToken){
      try{this.options.token=await this.options.loadToken(message=>this.notice('info',message),this.lifecycleAbort.signal);}
      catch(error){this.store.dispatch({type:'connection_changed',phase:'expired'});this.notice('error',t("ctl_identity_failed",{reason:errorText(error)}));return;}
    }
    if (this.options.token) {
      const ok = await this.client.authenticate(this.options.token);
      if (!ok) {
        this.store.dispatch({ type: "connection_changed", phase: "expired" });
        this.notice("error", t('credencial_da_tui_recusada_pel'), t("ctl_auth_hint"));
        return;
      }
    } else {
      this.store.dispatch({ type: "connection_changed", phase: "expired" });
      // Pairing is deliberately silent here.  The cover offers the connection
      // action and the first real request still receives the precise auth
      // error.  A startup error transcript made an empty TUI look broken.
      return;
    }
    this.store.dispatch({ type: "connection_changed", phase: "authenticated", version: health.version });
    // Account continuity is independent of folders, conversations and BYOK availability.
    void this.account.refresh();
    if (!this.sign && this.options.loadSigner) {
      try { this.sign = await this.options.loadSigner(); this.view.signerAvailable = this.sign !== null; }
      catch { this.notice("warning", t('identidade_nativa_indispon_vel'), t("ctl_doctor_hint")); }
    }
    let models = await this.client.getModels().catch(() => [] as Array<{ id: string; owned_by?: string }>);
    await this.refreshConnections();
    // `/v1/models` may intentionally omit entries while admission is rebuilt.
    // The connection snapshot is authoritative for a configured BYOK
    // destination; use its observed models as a local fallback, never a
    // static or fabricated catalog.
    if (models.length === 0) {
      const observed = this.view.connections?.providers
        .filter((provider) => provider.eligible && provider.models.length)
        .flatMap((provider) => provider.models.map((id) => ({ id, owned_by: provider.id })));
      if (observed?.length) models = [...new Map(observed.map((model) => [model.id, model])).values()];
    }
    this.store.dispatch({ type: "models_loaded", models });
    // Restore the last real destination from the core's persisted provider
    // profile. Never choose the first catalog entry: catalog-only models are
    // visible for onboarding but are not an active connection.
    const snapshot = this.view.connections;
    const eligible = snapshot?.providers.filter((p) => p.eligible && p.models.length) ?? [];
    const remembered = await loadDestinationPreference(this.client.url).catch(() => {
      this.notice("warning", t("model_preference_read_failed"));
      return undefined;
    });
    this.rememberedHosted = remembered?.providerId === HOSTED_PROVIDER ? remembered : undefined;
    const savedOwner = remembered && eligible.find(p => p.id === remembered.providerId && p.models.includes(remembered.model));
    const requested = this.options.model && models.some((m) => m.id === this.options.model) ? this.options.model : undefined;
    const owner = requested
      ? eligible.find((p) => p.models.includes(requested))
      : savedOwner ?? eligible.find((p) => p.defaultModel && models.some((m) => m.id === p.defaultModel));
    const restoredModel = requested ?? (savedOwner ? remembered!.model : owner?.defaultModel);
    if (restoredModel && owner) {
      const restoringSaved = !requested && savedOwner === owner && remembered?.model === restoredModel;
      const combo = restoringSaved && remembered?.routingComboId && snapshot?.combos.some(c => c.id === remembered.routingComboId)
        ? remembered.routingComboId : requested ? undefined : snapshot?.combos.find((c) => c.id === `tui-${owner.id}`)?.id;
      this.client.setSelectedProvider(owner.id, combo);
      this.store.dispatch({ type: "model_selected", model: restoredModel });
      // A new conversation restores the explicit provider choice. A resumed
      // conversation still loads its own canonical policy below.
      if (!this.options.processingPolicy && !this.options.resume) {
        const policy = restoringSaved ? remembered!.processingPolicy : (combo && owner.kind !== "local" ? "external_allowed" : "local_only");
        this.store.dispatch({ type: "processing_policy_changed", processingPolicy: policy });
      }
    } else {
      this.store.dispatch({ type: "model_selected", model: "" });
      this.client.setSelectedProvider();
    }
    // No configured provider is a valid first-run state.  Keep the transcript
    // empty so the cover remains the onboarding surface.
    await this.bindProject(this.options.preferredBinding);
    if (this.options.resume) await this.openConversation(this.options.resume);
    this.started = true;
    await this.chooseHostedDefault();
    void this.refreshConversationList();
  }

  /** Catalog is loaded once per verified account revision, never once per render or stream delta. */
  async refreshHostedModels(force = false): Promise<void> {
    const account = this.account.view;
    const ref = account.session?.authenticated && account.available?.currentAccountRef;
    const revision = account.available?.revision;
    const identity = ref && revision !== undefined ? `${ref}:${revision}` : "";
    if (identity && identity === this.hostedIdentity && this.hostedLoading) return this.hostedLoading;
    if (identity === this.hostedIdentity && !force) return this.hostedLoading ?? undefined;
    this.hostedIdentity = identity;
    const generation = ++this.hostedGeneration;
    this.hostedModels = [];
    this.hostedCatalogError = null;
    const selectedHosted = this.client.getSelectedDestination().hosted;
    if (selectedHosted && (!identity || selectedHosted.accountRef !== ref || selectedHosted.revision !== revision)) {
      this.turnAbort?.abort(); this.client.setSelectedProvider();
      this.store.dispatch({ type: "model_selected", model: "" });
    }
    this.emit("modelsChanged"); this.changed();
    if (!identity || !ref || revision === undefined || this.disposed) return;
    const pending = (async () => {
      try {
        const models = await this.client.getHostedModels(ref, revision, this.lifecycleAbort.signal);
        if (this.disposed || generation !== this.hostedGeneration) return;
        this.hostedModels = models;
        const current = this.client.getSelectedDestination().hosted;
        if (current && !models.some(model => model.modelId === current.modelId && model.accountRef === current.accountRef && model.revision === current.revision)) {
          this.turnAbort?.abort(); this.client.setSelectedProvider();
          this.store.dispatch({ type: "model_selected", model: "" });
        } else if (current) {
          // A refreshed catalog can rotate the price version without changing the model or account.
          this.client.setHostedDestination(models.find(model => model.modelId === current.modelId)!);
        }
        this.emit("modelsChanged"); this.changed();
        await this.chooseHostedDefault();
      } catch (error) {
        // A stale successful snapshot cannot keep claiming availability after a failed explicit refresh.
        if (this.disposed || generation !== this.hostedGeneration) return;
        // Only successful catalogs are cached. The next explicit account/status refresh
        // can retry this same account revision; no timer or state-change retry loop.
        this.hostedIdentity = "";
        this.hostedCatalogError = error instanceof Error && error.message === "account_reauthentication_required"
          ? "account_reauthentication_required" : "hosted_model_unavailable";
        if (this.client.getSelectedDestination().hosted) {
          this.turnAbort?.abort(); this.client.setSelectedProvider();
          this.store.dispatch({ type: "model_selected", model: "" });
        }
        this.notice("warning", this.hostedCatalogError === "account_reauthentication_required"
          ? accountErrorText(this.hostedCatalogError) : hostedText("unavailable"));
        this.emit("modelsChanged"); this.changed();
      }
    })();
    this.hostedLoading = pending;
    await pending;
    if (this.hostedLoading === pending) this.hostedLoading = null;
  }

  /** Explicit model-list recovery; concurrent clicks share the same catalog read. */
  retryHostedModels(): Promise<void> {
    return this.refreshHostedModels(true);
  }

  private async chooseHostedDefault(): Promise<void> {
    if (!this.started || this.disposed || this.state.selectedModel || this.options.model || this.options.resume || this.options.processingPolicy) return;
    const saved = this.rememberedHosted;
    if (saved?.processingPolicy === "local_only") return;
    const model = this.hostedModels.find(item => item.modelId === saved?.model) ?? this.hostedModels[0];
    if (!model || this.state.activeConversation) return;
    // The server catalog, not a product hardcode, determines the eligible default.
    this.client.setHostedDestination(model);
    this.store.dispatch({ type: "processing_policy_changed", processingPolicy: "external_allowed" });
    this.store.dispatch({ type: "model_selected", model: model.modelId });
  }

  dispose(): void {
    this.disposed = true;
    this.repoMapAbort?.abort();
    ++this.hostedGeneration;
    this.lifecycleAbort.abort();
    this.account.dispose();
    this.features.dispose();
    for (const client of this.lspClients.values()) client.stop();
    this.lspClients.clear();
    this.turnAbort?.abort();
    this.effectAbort?.abort();
    this.client.destroy();
    clearShadowBashSessions(this.instanceId);
    this.removeAllListeners();
  }

  /** Binds the working folder by exact root identity (never by name or first root). */
  async bindProject(preferred?: { projectId: string; rootBindingId: string }, explicitPath?: string): Promise<void> {
    const target = explicitPath ?? this.bindingPath;
    const generation = ++this.bindingGeneration;
    this.bindingAbort?.abort();
    const abort = new AbortController(); this.bindingAbort = abort;
    if (explicitPath !== undefined) { this.features.cancel(); this.turnAbort?.abort(); this.effectAbort?.abort(); }
    const signal = AbortSignal.any([abort.signal, this.lifecycleAbort.signal]);
    let outcome;
    try { outcome = await resolveProjectBinding(this.workspace, { rootPath: target, projectHint: explicitPath === undefined ? this.bindingHint : undefined, preferred, create: true, signal }); }
    catch (error) { if (signal.aborted || generation !== this.bindingGeneration) return; this.notice("error", t("ctl_bind_failed", { reason: errorText(error) })); return; }
    finally { if (this.bindingAbort === abort) this.bindingAbort = null; }
    if (signal.aborted || generation !== this.bindingGeneration || this.disposed) return;
    if (outcome.kind === "ambiguous") {
      this.bindingPath = outcome.rootPath;
      if (explicitPath !== undefined) this.bindingHint = undefined;
      this.view.bindingCandidates = outcome.candidates;
      this.notice("warning", t("ctl_folder_many_projects", { count: outcome.candidates.length }), t("ctl_folder_many_projects_hint"));
      this.changed();
      return;
    }
    if (outcome.kind === "error") {
      this.view.bindingError = outcome.code;
      this.notice("error", t("ctl_bind_project_failed", { code: outcome.code }), t("ctl_bind_project_failed_hint"));
      this.changed();
      return;
    }
    if (this.view.binding && (this.view.binding.projectId !== outcome.binding.projectId || this.view.binding.rootBindingId !== outcome.binding.rootBindingId)
      || (!this.view.binding && this.state.activeConversation)) {
      const storagePolicy = this.state.storagePolicy;
      this.newConversation();
      this.store.dispatch({ type: "storage_policy_changed", storagePolicy });
      this.view.approvals = []; this.view.attention = null; this.view.artifacts = []; this.view.tasks = [];
      this.view.integration = null; this.view.git = null; this.view.lspConsentRequest = null; this.taskLabels.clear();
      this.hooks = null; this.view.hooks = null;
    }
    this.bindingPath = outcome.binding.rootPath;
    if (explicitPath !== undefined) this.bindingHint = undefined;
    this.applyBinding(outcome.binding);
    if (outcome.created) this.notice("info", t("folder_bound_to_project", { project: outcome.binding.projectName }));
  }

  /** The person's explicit path binds a folder without restarting or changing cwd. */
  async rebindProject(path: string): Promise<void> {
    let target = path.trim();
    if (target.length >= 2 && ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'")))) target = target.slice(1, -1);
    if (!target || target.length > 2048 || /[\x00-\x1f]/.test(target)) { this.notice("error", t("project_path_prompt")); return; }
    await this.bindProject(undefined, resolvePath(this.view.binding?.rootPath ?? this.bindingPath, target));
  }

  chooseBinding(candidate: BindingCandidate): Promise<void> {
    this.view.bindingCandidates = null;
    return this.bindProject({ projectId: candidate.projectId, rootBindingId: candidate.rootBindingId });
  }

  private applyBinding(binding: ProjectBinding): void {
    this.repoMapAbort?.abort();
    const repoMapAbort = new AbortController();
    this.repoMapAbort = repoMapAbort;
    this.view.repoMapText = null;
    if(this.view.binding&&this.view.binding.rootBindingId!==binding.rootBindingId){
      this.turnAbort?.abort();this.features.cancel();void this.features.debugger?.dispose();
      for(const client of this.lspClients.values())client.stop();this.lspClients.clear();
    }
    this.view.binding = binding;
    this.view.bindingCandidates = null;
    this.view.bindingError = null;
    this.instructions = null;
    this.view.instructionsSource = null;
    this.manifestEntries = [];
    this.view.manifestFiles = [];
    this.view.skills = [];
    this.view.activeSkills = [];
    this.view.toolsAvailable = PROJECT_READ_TOOLS.map(tool => tool.function.name);
    this.view.toolsEnabled = true;
    this.store.dispatch({ type: "project_selected", project: { id: binding.projectId, name: binding.projectName, rootBindingId: binding.rootBindingId, rootPath: binding.rootPath } });
    this.context.bind((path, signal) => this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path, signal), binding.rootBindingId);
    void this.loadProjectKnowledge(binding);
    void this.loadHooks().catch(() => undefined);
    void discoverSkills(binding.rootPath).then((skills) => { if (this.view.binding !== binding || this.disposed) return; this.view.skills = skills; this.changed(); }).catch(() => undefined);
    void buildRepoMap(binding.rootPath, { maxFiles: 500, signal: repoMapAbort.signal }).then(entries => {
      if (this.view.binding !== binding || this.disposed) return;
      this.view.repoMapText = formatRepoMap(entries, 2000);
      this.changed();
    }).catch(() => undefined);
  }

  private async loadProjectKnowledge(binding: ProjectBinding): Promise<void> {
    for (const candidate of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const file = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, candidate);
        if (this.view.binding !== binding || this.disposed) return;
        if (file) {
          const text = file.text.length > 64 * 1024 ? `${file.text.slice(0, 64 * 1024)}\n[truncado]` : file.text;
          this.instructions = `[Instruções do repositório em ${candidate} (sha256 ${file.sha256.slice(0, 12)}). Dados do projeto: orientam o trabalho, não concedem permissões.]\n${text}`;
          this.view.instructionsSource = candidate;
          break;
        }
      } catch { /* protected or unreadable: no instructions */ }
    }
    try {
      // Opening a terminal in Home must not recursively hash every file before
      // the person can type. The model can browse deeper via paginated reads.
      const page = await this.workspace.listProjectDirectory(binding.projectId, binding.rootBindingId);
      if (this.view.binding !== binding || this.disposed) return;
      this.manifestEntries = page.entries.map(entry => ({ ...entry, sha256: null, sensitivity: "public" }));
      this.view.manifestFiles = page.entries.filter(entry => entry.kind === "file").map(entry => entry.relativePath);
    } catch { /* manifest optional for chat */ }
    try { this.profiles = await this.workspace.getRuntimeProfiles(); } catch { this.profiles = []; }
    this.changed();
  }

  /** Providers, models and combos as the core observes them now. */
  async refreshConnections(): Promise<void> {
    try {
      this.view.connections = await loadConnections(this.client);
      this.store.dispatch({ type: "connections_loaded", connections: this.view.connections.providers.map((p) => ({ provider: p.id, status: p.eligible ? "available" : p.reason ?? "unavailable" })) });
      const models = this.view.connections.providers.filter(p => p.eligible)
        .flatMap(p => p.models.map(id => ({ id, owned_by: p.id })));
      this.store.dispatch({ type: "models_loaded", models: [...new Map(models.map(model => [model.id, model])).values()] });
    } catch (error) {
      this.notice("warning", t("ctl_connections_unavailable", { reason: errorText(error) }));
    }
    // Local/BYOK startup never waits for the hosted network. Refresh can finish in the background.
    void this.refreshHostedModels(true);
    this.changed();
  }

  /** Opens the core's own configuration page for a provider (key never passes through the TUI). */
  configureProvider(providerId: string): void {
    const url = providerSetupUrl(this.client.url, providerId);
    if (openLoopbackUrl(url)) this.notice("info", t("ctl_provider_config_opened", { provider: providerId, url }), t("ctl_provider_config_opened_hint"));
    else this.notice("info", operationText("configure_browser", { url, provider: providerId }));
  }

  async refreshBudget(): Promise<void> {
    const id = this.store.state.activeConversation?.id;
    if (!id) { this.view.budget = null; return; }
    try {
      const res = await this.client.fetchRaw(`/v1/workspace/conversations/${encodeURIComponent(id)}/budget`);
      if (!res.ok) { this.view.budget = null; return; }
      const body = await res.json() as Record<string, unknown>;
      const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
      this.view.budget = { limitMicros: num(body.limitMicros), spentMicros: num(body.spentMicros ?? body.settledMicros ?? body.consumedMicros), reservedMicros: num(body.reservedMicros) };
    } catch { this.view.budget = null; }
    this.changed();
  }

  /**
   * Writes the canonical export of the active conversation to a file chosen by
   * the person. Refuses to overwrite unless `force`; temporary conversations
   * are refused by the core itself.
   */
  async exportRunOutput(arg: string): Promise<void> {
    const { parseFlags } = await import("./commands.ts");
    const { args, hasFlag, error } = parseFlags(arg, ["limpar", "clear"]);
    if (error) { this.notice("error", error); return; }
    const runId = args.join(' ').trim();
    if (!runId) { this.notice("info", t('inform_execution_id')); return; }
    const projectId = this.view.binding?.projectId;
    if (!projectId) { this.notice("error", t('nenhuma_pasta_vinculada')); return; }
    const revalidate = this.captureContext();
    try {
      const output = await this.client.readProjectRunOutput(projectId, runId, 0);
      revalidate();
      if (!output) { this.notice("error", t('output_not_found')); return; }
      const content = output.events.map(e => `[${e.channel}] ${e.text}`).join("\n");
      const outPath = resolvePath(this.options.cwd, `run-output-${runId}.log`);
      const { writeFile } = await import("node:fs/promises");
      revalidate();
      await writeFile(outPath, content, "utf8");
      revalidate();
      if (hasFlag("limpar") || hasFlag("clear")) {
        await this.client.deleteProjectRunOutput(projectId, runId).catch(() => undefined);
        revalidate();
      }
      this.notice("info", t("ctl_output_exported", { path: outPath }));
    } catch (e) {
      if ((e as Error).message === "context_changed") return;
      this.notice("error", t("ctl_output_read_failed", { reason: errorText(e) }));
    }
  }

  async exportConversation(target: string, force = false, open = false): Promise<void> {
    const id = this.store.state.activeConversation?.id;
    if (!id) { this.notice("info", t('nenhuma_conversa_ativa_para_ex')); return; }
    const path = isAbsolute(target) ? target : resolvePath(this.options.cwd, target);
    const revalidate = this.captureContext();
    try {
      if (!force) {
        const exists = await stat(path).then(() => true, () => false);
        revalidate();
        if (exists) { this.notice("warning", t("ctl_export_exists", { path }), t("ctl_export_exists_hint")); return; }
      }
      const res = await this.client.fetchAuth(`/v1/workspace/conversations/${encodeURIComponent(id)}/export`);
      revalidate();
      let body = await res.text();
      revalidate();
      if (!res.ok) throw new Error(`conversation_export_failed_${res.status}`);
      let buffer: Buffer;
      if (path.toLowerCase().endsWith(".md")) {
        let md = markdownFromCanonicalExport(JSON.parse(body));
        if (!md.endsWith("\n")) md += "\n";
        if (process.platform === "win32") md = md.replace(/(?<!\r)\n/g, "\r\n");
        buffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(md, "utf8")]);
      } else {
        buffer = Buffer.from(body.endsWith("\n") ? body : `${body}\n`, "utf8");
      }
      await this.writeChosenFile(path, buffer, force, revalidate);
      revalidate();
      this.notice("info", t("chat_exported_to_path", { path, bytes: buffer.byteLength }));
      
      if (open) {
        await this.openExportedFile(path, revalidate);
      }
    } catch (error) {
      if ((error as Error).message === "context_changed") return;
      this.notice("error", t("ctl_export_failed", { reason: errorText(error) }));
    }
  }

  /**
   * Imports conversations from a file: a TUI/PWA export (text messages are
   * carried) or an `utk-chat`/`quimera-chat-sessions-v1` bundle. Idempotent in
   * the core by content digest.
   */
  async importConversations(source: string): Promise<void> {
    const path = isAbsolute(source) ? source : resolvePath(this.options.cwd, source);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      let payload: unknown = raw;
      if (raw.schemaVersion === 1 && raw.conversation && Array.isArray(raw.messages)) {
        const conversation = raw.conversation as Record<string, unknown>;
        const messages = (raw.messages as Array<Record<string, unknown>>)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: (Array.isArray(m.parts) ? m.parts : []).filter((p: Record<string, unknown>) => p.type === "text").map((p: Record<string, unknown>) => String(p.text ?? "")).join(""), createdAt: String(m.createdAt ?? new Date().toISOString()) }))
          .filter((m) => m.content);
        payload = { origin: "utk-chat", sessions: [{ id: String(conversation.id ?? "import"), title: conversation.title ?? null, messages, createdAt: String(conversation.createdAt ?? new Date().toISOString()), updatedAt: String(conversation.updatedAt ?? new Date().toISOString()) }] };
      }
      const res = await this.client.fetchAuth("/v1/workspace/conversations/import", { method: "POST", body: JSON.stringify(payload) });
      const result = await res.json() as { imported?: boolean; conversationIds?: string[] };
      await this.refreshConversationList();
      this.notice("info", result.imported === false ? t("ctl_import_duplicate") : t("ctl_import_done", { count: result.conversationIds?.length ?? 0 }), t("ctl_import_done_hint"));
    } catch (error) {
      this.notice("error", t("ctl_import_failed", { reason: errorText(error) }));
    }
  }

  async refreshConversationList(): Promise<void> {
    try {
      const convs = await this.conversations.list();
      this.store.dispatch({ type: "conversations_loaded", conversations: convs.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })) });
    } catch { /* list is optional */ }
  }

  // ─── transcript projection ─────────────────────────────────────────────

  /** Canonical messages + live effect items + the streaming answer. */
  items(): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    const byAfter = new Map<string | null, TranscriptItem[]>();
    for (const live of this.live) byAfter.set(live.after, [...(byAfter.get(live.after) ?? []), live.item]);
    const placed = new Set<string>();
    const pushLive = (after: string | null) => { for (const item of byAfter.get(after) ?? []) { items.push(item); placed.add(item.id); } };
    pushLive(null);
    for (const message of this.store.state.messages) {
      items.push(...messageItems(message));
      pushLive(message.id);
    }
    for (const live of this.live) if (!placed.has(live.item.id)) items.push(live.item);
    const state = this.store.state;
    const turnLive = state.streamBuffer || state.turn === "streaming" || state.turn === "submitting";
    if (turnLive) items.push(...liveTurnItems(state));
    if (turnLive) {
      items.push({ kind: "assistant", id: "streaming", text: state.streamBuffer, streaming: true });
    }
    return items;
  }

  private lastMessageId(): string | null {
    return this.store.state.messages.at(-1)?.id ?? null;
  }

  private upsertLive(item: TranscriptItem): void {
    const index = this.live.findIndex((l) => l.item.id === item.id);
    if (index >= 0) this.live[index] = { item, after: this.live[index]!.after };
    else this.live.push({ item, after: this.lastMessageId() });
    this.changed();
  }

  notice(level: "info" | "warning" | "error", text: string, hint?: string): void {
    this.upsertLive({ kind: "notice", id: `notice-${randomUUID()}`, level, text, ...(hint ? { hint } : {}) });
  }

  // ─── input routing ─────────────────────────────────────────────────────

  get busy(): boolean {
    const turn = this.store.state.turn;
    return !!this.features?.busy || !!this.features?.review || this.features?.audio.active === true || this.features?.voice?.snapshot.state === "active" || turn === "submitting" || turn === "streaming" || turn === "waiting_tool";
  }

  /** Plain text from the composer (slash commands are routed by the command registry). */
  async submit(text: string, options: { media?: PreparedMediaInput } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !options.media && !this.context.size) return;
    if (options.media) {
      const validate = this.preparedMediaContexts.get(options.media);
      if (!validate) throw new MediaInputError("attachment_unavailable");
      validate();
    }
    if (this.busy) {
      if (options.media) throw new MediaInputError("attachment_changed");
      this.view.steer.push({ id: `steer-${randomUUID()}`, text: trimmed, state: "pending" });
      this.changed();
      return;
    }
    await this.runTurn(trimmed, options);
  }

  async prepareMediaInput(parts: readonly MediaInputPart[]): Promise<PreparedMediaInput> {
    const validate = this.captureContext();
    const destination = this.client.getSelectedDestination();
    const model = this.state.selectedModel || "auto";
    const assertCurrent = () => { validate(); if (this.client.getSelectedDestination() !== destination || (this.state.selectedModel || "auto") !== model) throw new MediaInputError("attachment_changed"); };
    const media = await prepareCanonicalMediaInput({ client: this.client, workspace: this.workspace, binding: this.view.binding, destination, model,
      storagePolicy: this.state.storagePolicy, processingPolicy: this.state.processingPolicy, parts, assertCurrent });
    this.preparedMediaContexts.set(media, assertCurrent);
    return media;
  }

  private questionAnswer: ((answers: string[][] | null) => void) | null = null;

  /** Shows the model's questions and waits for the person; cancellation or a new question settles it as declined. */
  askQuestion(questions: QuestionInfo[], signal?: AbortSignal): Promise<string[][] | null> {
    this.questionAnswer?.(null);
    return new Promise((resolve) => {
      const id = `question-${randomUUID()}`;
      const settle = (answers: string[][] | null) => {
        if (this.view.question?.id !== id) return;
        signal?.removeEventListener("abort", abort);
        this.view.question = null;
        this.questionAnswer = null;
        this.changed();
        resolve(answers);
      };
      const abort = () => settle(null);
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener("abort", abort, { once: true });
      this.view.question = { id, questions };
      this.questionAnswer = settle;
      this.changed();
    });
  }

  answerQuestion(id: string, answers: unknown): boolean {
    const pending = this.view.question;
    if (!pending || pending.id !== id || !Array.isArray(answers) || answers.length > pending.questions.length) return false;
    const valid = answers.map((answer) => Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 500).slice(0, 6) : []);
    this.questionAnswer?.(valid);
    return true;
  }

  rejectQuestion(id: string): boolean {
    if (this.view.question?.id !== id) return false;
    this.questionAnswer?.(null);
    return true;
  }

  /** Removes a pending redirection before it is sent. */
  cancelSteer(id: string): boolean {
    const index = this.view.steer.findIndex((s) => s.id === id && s.state === "pending");
    if (index < 0) return false;
    this.view.steer.splice(index, 1);
    this.changed();
    return true;
  }

  /** Cancels the active turn or effect. Returns false when nothing was running. */
  cancel(): boolean {
    let cancelled = this.features.cancel();
    for (const pending of this.pendingShells) { pending.abort(); cancelled = true; }
    // A native tool review is part of its model turn. Closing the review alone
    // is a decline; Cancel must also prevent a paid model continuation.
    if (this.turnAbort) { this.turnAbort.abort(); cancelled = true; }
    if (this.effectAbort) { this.effectAbort.abort(); cancelled = true; }
    return cancelled;
  }

  /** Captures the current active conversation, storage policy, and project binding to validate later. */
  private captureContext(signal?: AbortSignal): () => void {
    const conversationId = this.store.state.activeConversation?.id;
    const storagePolicy = this.store.state.storagePolicy;
    const projectId = this.view.binding?.projectId;
    const rootBindingId = this.view.binding?.rootBindingId;
    const revision = this.store.conversationRevision;
    return () => {
      signal?.throwIfAborted();
      if (
        this.store.state.activeConversation?.id !== conversationId ||
        this.store.conversationRevision !== revision ||
        this.store.state.storagePolicy !== storagePolicy ||
        this.view.binding?.projectId !== projectId ||
        this.view.binding?.rootBindingId !== rootBindingId
      ) {
        throw new Error("context_changed");
      }
    };
  }

  // ─── conversation ──────────────────────────────────────────────────────

  private async ensureConversation(): Promise<string> {
    const active = this.store.state.activeConversation;
    if (active) return active.id;
    const created = await this.conversations.create(undefined, this.view.binding?.projectId, {
      storagePolicy: this.store.state.storagePolicy, processingPolicy: this.store.state.processingPolicy,
    });
    this.store.dispatch({ type: "conversation_selected", conversation: { id: created.id, title: created.title, storagePolicy: created.storagePolicy, processingPolicy: created.processingPolicy } });
    this.live = [];
    return created.id;
  }

  async openConversation(id: string): Promise<void> {
    const generation = ++this.conversationOpenGeneration;
    const bindingGeneration = this.bindingGeneration;
    const previousRevision = this.store.conversationRevision;
    const previousDestination = this.client.getSelectedDestination();
    const previousModel = this.store.state.selectedModel;
    this.features.cancel();
    this.turnAbort?.abort();
    this.effectAbort?.abort();
    this.view.steer = [];
    this.view.todos = [];
    this.view.proposal = null;
    this.view.approvals = [];
    this.view.attention = null;
    this.view.verifyOffer = null;
    this.view.correction = null;
    this.view.integration = null;
    this.view.budget = null;
    this.live = [];
    const revision = this.store.conversationRevision + 1;
    try {
      const conversation = await this.conversations.getConversation(id);
      if (this.disposed || generation !== this.conversationOpenGeneration || this.store.conversationRevision !== previousRevision || this.bindingGeneration !== bindingGeneration) return;
      if (conversation.storagePolicy === "cloud") throw new Error("conversation_cloud_policy_unsupported");
      this.store.dispatch({ type: "conversation_selected", conversation: { id, title: conversation.title ?? undefined, storagePolicy: conversation.storagePolicy === "temporary" ? "temporary" : "local", processingPolicy: conversation.processingPolicy === "external_allowed" ? "external_allowed" : "local_only" } });
      const messages = await this.conversations.loadMessages(id);
      if (this.disposed || generation !== this.conversationOpenGeneration || this.store.conversationRevision !== revision || this.bindingGeneration !== bindingGeneration) return;
      // Resume the admitted account, even when it has since become unavailable.
      // The router revalidates that exact identity; another account is never substituted.
      // This is restoration, not a new selection or permission/policy mutation.
      if (this.client.getSelectedDestination() === previousDestination && this.store.state.selectedModel === previousModel) {
        const routed = [...messages].reverse().find(message => message.destination || message.hostedDestination);
        if (routed?.hostedDestination) {
          this.client.setHostedDestination(routed.hostedDestination);
          this.store.dispatch({ type: "model_selected", model: routed.hostedDestination.modelId });
        } else if (routed?.destination) {
          this.client.setSelectedDestination(routed.destination);
          this.store.dispatch({ type: "model_selected", model: routed.destination.modelId });
        }
      }
      this.store.dispatch({ type: "messages_loaded", messages });
      this.view.todos = todosFromResults(messages.flatMap((message) => message.toolResults ?? []));
      if (conversation.projectId && this.view.binding && conversation.projectId !== this.view.binding.projectId) {
        this.notice("warning", t('esta_conversa_pertence_a_outro'), t('leitura_e_alteracoes_usam_projeto'));
      }
    } catch (error) {
      if (this.disposed || generation !== this.conversationOpenGeneration || this.bindingGeneration !== bindingGeneration) return;
      this.notice("error", t('nao_foi_possivel_abrir_conversa', { error: errorText(error) }));
    }
  }

  /**
   * Next conversation is temporary: the core keeps it in memory only, it never
   * enters saved history/search, and project writes are refused while active.
   */
  newTemporaryConversation(): void {
    this.newConversation();
    this.store.dispatch({ type: "storage_policy_changed", storagePolicy: "temporary" });
    this.notice("info", t('conversa_tempor_ria_nada_desta'), t("ctl_temporary_hint"));
  }

  newConversation(): void {
    this.conversationOpenGeneration++;
    this.features.cancel();
    this.features.comparison = null;
    this.turnAbort?.abort();
    this.effectAbort?.abort();
    this.effectAbort = null;
    this.live = [];
    this.view.steer = [];
    this.view.todos = [];
    this.view.proposal = null;
    this.view.verifyOffer = null;
    this.view.correction = null;
    this.view.integration = null;
    this.view.attention = null;
    this.view.approvals = [];
    this.view.budget = null;
    this.store.dispatch({ type: "conversation_selected", conversation: null });
    if (!this.options.temporary) this.store.dispatch({ type: "storage_policy_changed", storagePolicy: "local" });
  }

  /** Reloads the canonical thread so transcript ids match the store. */
  private async reloadMessages(conversationId: string): Promise<void> {
    try {
      const messages = await this.conversations.loadMessages(conversationId);
      if (this.store.state.activeConversation?.id !== conversationId) return;
      const lastBefore = this.store.state.messages.at(-1)?.id;
      this.store.dispatch({ type: "messages_loaded", messages });
      this.view.todos = todosFromResults(messages.flatMap((message) => message.toolResults ?? []));
      // Live items anchored to optimistic ids move to the canonical tail.
      const known = new Set(messages.map((m) => m.id));
      for (const live of this.live) if (live.after && !known.has(live.after)) live.after = messages.at(-1)?.id ?? null;
      void lastBefore;
    } catch { /* keep optimistic view; next reload will reconcile */ }
  }

  // ─── chat turn ─────────────────────────────────────────────────────────

  private systemMessages(webTools: readonly string[] = [], mcpTools: readonly string[] = [], nativeWrite = false, destination = this.client.getSelectedDestination(), model = this.store.state.selectedModel, editProtocol?: string): DispatchMessage[] {
    const binding = this.view.binding;
    const parts = [SYSTEM_BASE()];
    const providerId = destination.providerId;
    const provider = model ? this.view.connections?.providers.find((candidate) => candidate.eligible && candidate.id === providerId) : undefined;
    parts.push(destination.hosted
      ? t("system_provider_effective", { provider: "Uptokey", id: HOSTED_PROVIDER, model: model! }) : provider
      ? t("system_provider_effective", { provider: provider.displayName, id: provider.id, model: model! })
      : t("system_provider_none"));
    const hosted = destination.hosted;
    // A hosted model without declared tool support stays a text model and is told so.
    const hostedTools = hosted ? this.hostedModels.find((item) => item.modelId === model)?.toolCalls === true : false;
    if (hosted && !hostedTools) parts.push(`Use only project context supplied in this conversation${binding ? ` for ${binding.projectName}` : ""}. No file, command or web tools are available to this model. Ask for missing context; never claim to have read, changed or tested files without an actual result.`);
    else if (binding) parts.push(t("system_project_bound", { projectName: binding.projectName, rootPath: binding.rootPath, accessMode: binding.accessMode === "read_only" ? t("system_access_read_only") : t("system_access_read_write"), tools: PROJECT_READ_TOOLS.map(tool => tool.function.name).join(", "), toolsStatus: this.view.toolsEnabled ? t("system_tools_enabled") : t("system_tools_disabled") }));
    else parts.push(t("system_project_unbound"));
    if (this.view.manifestFiles.length) {
      const listed = this.view.manifestFiles.slice(0, 300);
      parts.push(t("system_manifest_index", { total: this.view.manifestFiles.length, partial: this.view.manifestFiles.length > listed.length ? t("system_manifest_partial", { listed: listed.length }) : "", listed: listed.join("\n") }));
    }
    if (webTools.length) parts.push(t("system_web_tools", { tools: webTools.join(", ") }));
    if (mcpTools.length) parts.push(t("system_mcp_tools", { tools: mcpTools.join(", ") }));
    if (binding && this.view.toolsEnabled && this.signer && !hosted) parts.push(t("system_execute_command"));
    if (this.view.repoMapText) parts.push(this.view.repoMapText);
    parts.push(this.view.mode !== "build" ? t("system_plan_mode") : hosted ? "Propose edits using the relative file path followed by SEARCH/REPLACE blocks:\npath/to/file\n<<<<<<< SEARCH\nexact supplied current content\n=======\nreplacement\n>>>>>>> REPLACE\nFor a new file, SEARCH is empty. Proposed edits are reviewed and applied by Uptokey, not by you. Never claim they were applied before an actual result." : nativeWrite ? (editProtocol ?? NATIVE_EDIT_PROTOCOL) : t("system_edit_protocol"));
    if (nativeWrite && this.view.autonomy) parts.push(AUTONOMY_PROTOCOL);
    const out: DispatchMessage[] = [{ role: "system", content: parts.join("\n\n") }];
    if (this.instructions) out.push({ role: "system", content: this.instructions });
    const active = this.view.skills.filter((s) => this.view.activeSkills.includes(s.id));
    if (active.length) out.push({ role: "system", content: skillsContext(active) });
    return out;
  }

  private async resolveMentions(text: string, signal: AbortSignal): Promise<void> {
    const mentions = [...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1]!.replace(/[),.;:!?]+$/, ""));
    for (const mention of new Set(mentions)) {
      if (!this.view.binding) break;
      const entry = await this.context.add(mention, signal);
      if (entry.state === "error" && (entry.error === t("not_a_regular_file") || entry.error === t("ctx_err_not_regular", { path: "" }).replace(/^:\s*|:\s*$/g, ""))) {
        this.context.remove(entry.id);
        // A directory mention is never read as a file; the frontend that binds folders itself leaves the binding alone.
        if (this.options.folderMentionBinding === "off") continue;
        const previousBinding = this.view.binding;
        await this.rebindProject(mention);
        if (this.view.bindingCandidates) {
          this.notice("info", t("ctl_folder_mentioned", { mention }), t("ctl_folder_mentioned_hint"));
        } else if (this.view.binding && this.view.binding !== previousBinding) {
          this.notice("info", t("ctl_folder_switched", { mention }));
        }
        continue;
      }
      if (entry.state === "missing" || entry.state === "error") this.notice("warning", t("ctl_mention_failed", { mention, reason: entry.error ?? t("ctl_not_read") }));
    }

    if (this.options.folderMentionBinding === "off") return;
    const { stat } = await import("node:fs/promises");
    const { resolve, isAbsolute, relative } = await import("node:path");

    const candidates: string[] = [];

    // 1. Quoted strings (double, single, backticks)
    for (const m of text.matchAll(/["'`]([^"'`\r\n]+?)["'`]/g)) {
      const val = m[1]?.trim();
      if (val && (val.includes("/") || val.includes("\\") || /\.[\w-]+$/.test(val) || this.view.manifestFiles.some(path => path === val || path.startsWith(`${val}/`)))) candidates.push(val);
    }

    // 2. Trigger phrases: analise <path>, trabalhe na pasta <path>, leia <path>, etc.
    // A dot belongs to a filename; sentence punctuation is removed only at its end.
    // Quoted paths with spaces must remain one candidate, never also a truncated word.
    const triggerRegex = /(?:^|\s)(?:analise|analisar|trabalhe na pasta|trabalhe no diretório|trabalhe em|veja na pasta|veja o arquivo|leia o arquivo|leia a pasta|leia|abra|explore|folder|directory|path|pasta|diretório)\s+(?:a pasta\s+|o arquivo\s+|o diretório\s+|em\s+)?(?:["'`]([^"'`\r\n]+)["'`]|([^\s"'`,;!?]+))/gi;
    for (const m of text.matchAll(triggerRegex)) {
      const val = (m[1] ?? m[2])?.replace(/[),.;:!?]+$/, "").trim();
      if (val) candidates.push(val);
    }

    // 3. Relative or absolute path syntax with slashes
    for (const m of text.matchAll(/(?:^|\s)((?:\/|[A-Za-z]:[\\/]|~[\\/]|\.\.?[\\/]|[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+)[^\s"'`]*)/g)) {
      const val = m[1]?.replace(/[),.;:!?]+$/, "").trim();
      if (val) candidates.push(val);
    }

    const uniqueCandidates = [...new Set(candidates.filter((c) => !mentions.includes(c) && !/^[a-z][a-z\d+.-]*:\/\//i.test(c)))];

    for (const p of uniqueCandidates) {
      if (this.view.binding) {
        const rootPath = this.view.binding.rootPath;
        const normalized = p.replaceAll("\\", "/");
        if (normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
          this.notice("warning", t("natural_path_outside_root"));
          continue;
        }
        if (isAbsolute(p)) {
          const rel = relative(rootPath, p);
          if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
            this.notice("warning", t("natural_path_outside_root"));
            continue;
          }
        }

        const relPath = (isAbsolute(p) ? relative(rootPath, p) : p).replace(/^(?:\.\/|\.\\)+/, "").replaceAll("\\", "/");
        if (relPath) {
          const file = await this.workspace.readProjectFile(this.view.binding.projectId, this.view.binding.rootBindingId, relPath, signal).catch(() => null);
          if (file) {
            await this.context.add(relPath, signal);
            this.notice("info", t("natural_path_resolved", { path: relPath }));
            continue;
          }

          const dir = await this.workspace.listProjectDirectory(this.view.binding.projectId, this.view.binding.rootBindingId, relPath).catch(() => null);
          if (dir && dir.entries && (dir.entries.length > 0 || relPath === "")) {
            this.notice("info", t("natural_path_resolved", { path: relPath }));
            continue;
          }
        }
      }

      try {
        const absPath = resolve(this.options.cwd, p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ""));
        const s = await stat(absPath);
        if (s.isDirectory()) {
          const previousBinding = this.view.binding;
          await this.rebindProject(absPath);
          if (this.view.bindingCandidates) {
            this.notice("warning", t("natural_path_ambiguous"), t("ctl_folder_many_projects_hint"));
          } else if (this.view.binding && this.view.binding !== previousBinding) {
            this.notice("info", t("natural_path_resolved", { path: p }));
          }
          continue;
        }
      } catch {
        // Path does not exist on disk
      }

      this.notice("warning", t("natural_path_not_found", { path: p }));
    }
  }

  private async runTurn(text: string, options: { steer?: SteerItem; media?: PreparedMediaInput } = {}): Promise<void> {
    if (this.store.state.connection !== "authenticated") {
      this.notice("error", t('sem_conex_o_autenticada_com_o_'), t("ctl_doctor_hint"));
      return;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    const model = this.store.state.selectedModel || "auto";
    const destination = options.media?.destination ?? this.client.getSelectedDestination();
    const expectedProcessingPolicy = this.store.state.processingPolicy;
    const revision = this.store.conversationRevision;
    this.view.correction = null;
    this.view.verifyOffer = null;
    this.store.dispatch({ type: "turn_changed", turn: "submitting" });
    const coalescer = createStreamCoalescer({ leading: true, onFlush: (event) => { if (event.type === "text") { this.store.dispatch({ type: "stream_delta", text: event.data }); this.emit("delta", event.data); } } });
    // The model's reasoning is shown while it streams (coalesced like the answer); it is not part of the answer text.
    const thinking = createStreamCoalescer({ leading: true, onFlush: (event) => { if (event.type === "text") this.store.dispatch({ type: "stream_reasoning", text: event.data }); } });
    const toolActivity = liveToolActivity((event) => this.store.dispatch(event));
    let conversationId: string | null = null;
    let userMessageId: string | null = null;
    let storedBefore = -1;
    try {
      conversationId = await this.ensureConversation();
      const localRevision = this.store.conversationRevision;
      await this.resolveMentions(text, abort.signal);
      if (options.media) this.preparedMediaContexts.get(options.media)!();
      const snapshot = this.view.binding ? await this.context.snapshotForDispatch(abort.signal) : { references: [], block: "", bytes: 0, notices: [] };
      for (const note of snapshot.notices) this.notice("warning", note);
      if (!(await this.runHooks("pre-send", text))) { this.store.dispatch({ type: "turn_changed", turn: "idle" }); return; }
      storedBefore = this.store.state.messages.filter((message) => message.role === "user" && message.content === text && !message.id.startsWith("pending-")).length;
      const optimistic: Message = { id: `pending-${randomUUID()}`, role: "user", content: text, timestamp: new Date().toISOString(), ...(snapshot.references.length ? { attachments: snapshot.references.map((r) => r.relativePath) } : {}) };
      this.store.dispatch({ type: "message_added", message: optimistic });
      if (options.steer) options.steer.state = "submitted";
      this.store.dispatch({ type: "turn_changed", turn: "streaming" });
      const binding = this.view.binding;
      // Hosted models use the same local, governed tools only when the broker declares tool support for them.
      const useReadTools = binding && this.view.toolsEnabled && (!destination.hosted || this.hostedModels.find((item) => item.modelId === model)?.toolCalls === true);
      const sign = this.signer;
      const webTools = useReadTools && sign && expectedProcessingPolicy === "external_allowed"
        ? await nativeWebTools(this.client, abort.signal).catch(error => { abort.signal.throwIfAborted(); if (errorCode(error) !== "tui_transport_unavailable") this.notice("warning", t("ctl_web_unavailable", { reason: errorText(error) })); return []; }) : [];
      const mcpToolsList = useReadTools && sign
        ? await nativeMcpTools(this.workspace, abort.signal).catch(error => { abort.signal.throwIfAborted(); if (errorCode(error) !== "tui_transport_unavailable") this.notice("warning", t("ctl_mcp_unavailable", { reason: errorText(error) })); return []; }) : [];
      const stillBound = () => this.view.binding === binding && this.store.state.activeConversation?.id === conversationId && !this.disposed;
      const readTool = useReadTools ? projectReadExecutor(this.workspace, binding, stillBound) : null;
      const webTool = useReadTools && sign ? nativeWebExecutor({ client: this.client, workspace: this.workspace, conversations: this.conversations,
        projectId: binding.projectId, model, sign, stillBound, confirm: (title, body, signal) => this.approve(title, body, signal) }) : null;
      const mcpTool = useReadTools && sign && mcpToolsList.length ? nativeMcpExecutor({ client: this.client, workspace: this.workspace, conversations: this.conversations,
        projectId: binding.projectId, model, sign, stillBound, confirm: (title, body, signal) => this.approve(title, body, signal) }) : null;
      const commandTool = useReadTools && sign ? nativeCommandExecutor({ workspace: this.workspace, conversations: this.conversations,
        projectId: binding.projectId, rootBindingId: binding.rootBindingId, model, sign, stillBound, client: this.client, onStreamDelta: (text) => { this.store.dispatch({ type: "stream_delta", text }); this.emit("delta", text); }, confirm: (title, body, signal) => this.approve(title, body, signal) }) : null;
      const codingTool = useReadTools && binding ? nativeCodingExecutor({ workspace: this.workspace, binding, stillBound, diagnostics: (paths, signal, context) => this.nativeDiagnostics(paths, signal, context), lspDefinition: (path, line, column, signal, context) => this.nativeLspDefinition(path, line, column, signal, context), lspReferences: (path, line, column, signal, context) => this.nativeLspReferences(path, line, column, signal, context) }) : null;
      const shadowBashTool = useReadTools && sign && binding ? shadowBashExecutor({
        workspace: this.workspace,
        conversations: this.conversations,
        projectId: binding.projectId,
        rootBindingId: binding.rootBindingId,
        model,
        sign,
        ownerId: this.instanceId,
        cwd: binding.rootPath,
        client: this.client,
        stillBound,
        confirm: (title, body, signal) => this.approve(title, body, signal),
        onStreamDelta: (text) => { this.store.dispatch({ type: "stream_delta", text }); this.emit("delta", text); }
      }) : null;
      const writeTool = useReadTools && sign && binding && this.view.mode === "build" && this.store.state.storagePolicy !== "temporary" ? nativeWriteExecutor({
        workspace: this.workspace, conversations: this.conversations, projectId: binding.projectId, rootBindingId: binding.rootBindingId, model, sign, stillBound,
        readOnly: binding.accessMode === "read_only", confirm: (title, body, signal) => this.approve(title, body, signal),
        diagnostics: (paths, signal, context) => this.nativeDiagnostics(paths, signal, context),
        onWritten: (paths) => { for (const path of paths) if (!this.view.manifestFiles.includes(path)) this.view.manifestFiles.push(path); this.changed(); },
      }) : null;
      // Connected MCP services (ready, external processing allowed): each call is a W5 plan with its own receipt.
      const services = useReadTools && sign && expectedProcessingPolicy === "external_allowed"
        ? await nativeServiceTools(this.client, abort.signal).catch(error => { abort.signal.throwIfAborted(); if (errorCode(error) !== "tui_transport_unavailable") this.notice("warning", t("ctl_mcp_unavailable", { reason: errorText(error) })); return { tools: [], bindings: new Map() }; })
        : { tools: [], bindings: new Map() };
      const serviceTool = services.tools.length && sign && binding ? nativeServiceExecutor({ client: this.client, workspace: this.workspace, conversations: this.conversations, bindings: services.bindings,
        projectId: binding.projectId, model, sign, stillBound, confirm: (title, body, signal) => this.approve(title, body, signal) }) : null;
      const progressTool = progressExecutor((todos) => { if (stillBound()) { this.view.todos = todos; this.changed(); } });
      const questionTool = questionExecutor((questions, signal) => stillBound() ? this.askQuestion(questions, signal) : Promise.resolve(null));
      // In-turn delegation: offered only where `/delegate` itself could run (signed W5, persistent session,
      // external processing allowed, governed lane available), nested in this turn's binding and conversation.
      const gateway = useReadTools && sign && binding && expectedProcessingPolicy === "external_allowed" && this.store.state.storagePolicy !== "temporary"
        ? await this.workspace.getGatewayInfo(abort.signal).catch(() => { abort.signal.throwIfAborted(); return { available: false, model: null }; }) : null;
      const delegateTool = gateway?.available && gateway.model && sign && binding ? nativeDelegateExecutor({ workspace: this.workspace, conversations: this.conversations,
        projectId: binding.projectId, rootBindingId: binding.rootBindingId, model, sign, stillBound, client: this.client, gatewayModel: gateway.model,
        files: () => this.view.manifestFiles, contextBlock: snapshot.block, confirm: (title, body, signal) => this.approve(title, body, signal),
        onProgress: (task, labels) => {
          if (!stillBound()) return;
          const childLabels: ChildLabel[] = labels.map((label) => ({ label, kind: "subagent", model: gateway.model }));
          this.taskLabels.set(task.id, childLabels);
          this.upsertLive(this.taskItem(`task-${task.id}`, task.objective.replace(/\s+/g, " ").slice(0, 200), task, childLabels));
        } }) : null;
      const tools = [...PROJECT_READ_TOOLS, ...PROGRESS_TOOLS, ...QUESTION_TOOLS, ...(delegateTool ? DELEGATE_TOOLS : []), ...(writeTool ? NATIVE_WRITE_TOOLS : []), ...(codingTool ? NATIVE_CODING_TOOLS : []), ...webTools, ...mcpToolsList, ...services.tools, ...(commandTool ? NATIVE_COMMAND_TOOLS : []), ...(shadowBashTool ? SHADOW_BASH_TOOLS : [])];
      let nativeWriteApplied = false;
      // Only a passing test on the current project snapshot can substantiate a success claim.
      let verifiedManifestDigest: string | null = null;
      const executeWrite: import('./conversations.ts').NativeReadToolExecutor = async (call, signal, context) => {
        if (!writeTool) throw new Error('conversation_tool_unavailable');
        const result = await writeTool(call, signal, context);
        if (successfulWrite(result)) { nativeWriteApplied = true; verifiedManifestDigest = null; }
        return result;
      };
      const executeRun = (run: import('./conversations.ts').NativeReadToolExecutor | null): import('./conversations.ts').NativeReadToolExecutor => async (call, signal, context) => {
        if (!run) throw new Error('conversation_tool_unavailable');
        const testCommand = isTestCommand(call);
        if (testCommand) verifiedManifestDigest = null;
        // Host tests lack the isolated runner's manifest in their report. Bind their result to an unchanged snapshot.
        const hostSnapshot = testCommand && call.name === "shadow_bash_run" && binding
          ? await this.workspace.getManifest(binding.projectId, binding.rootBindingId, signal).then(manifest => manifest.snapshotDigest).catch(() => null) : null;
        const result = await run(call, signal, context);
        if (call.name === "promote_run_outputs") {
          if (successfulWrite(result)) { nativeWriteApplied = true; verifiedManifestDigest = null; }
        } else if (testCommand) verifiedManifestDigest = passedVerificationDigest(call, result, hostSnapshot);
        return result;
      };
      // Compact set for small local models (measured 18/10: same solves, faster, ~35% less prompt); services and MCP stay.
      const toolset = chooseToolset({ providerKind: this.view.connections?.providers.find((provider) => provider.id === destination.providerId)?.kind, model });
      const offered = selectToolset(tools, toolset, new Set([...mcpToolsList, ...services.tools].map(tool => tool.function.name)));
      const offeredNames = new Set(offered.map(tool => tool.function.name));
      if (useReadTools) this.view.toolsAvailable = [...offeredNames];
      const system = this.systemMessages(webTools.map(tool => tool.function.name).filter(name => offeredNames.has(name)), mcpToolsList.map(tool => tool.function.name), writeTool !== null, destination, model,
        toolset === "compact" && writeTool !== null ? compactEditProtocol(offeredNames) : undefined);
      const stream = this.conversations.sendTurn({
        conversationId, model, destination, system, expectedProcessingPolicy, userText: text,
        ...(useReadTools ? { tools: offered, maxToolRounds: this.view.autonomy ? 100 : 16, executeReadTool: ((call, signal, context) => call.name === "update_todos" ? progressTool(call, signal, context) : call.name === "ask_user" ? questionTool(call, signal, context) : call.name === DELEGATE_TOOL_NAME && delegateTool ? delegateTool(call, signal, context) : NATIVE_WRITE_TOOLS.some(tool => tool.function.name === call.name) ? executeWrite(call, signal, context) : NATIVE_COMMAND_TOOLS.some(tool => tool.function.name === call.name) ? executeRun(commandTool)(call, signal, context) : NATIVE_CODING_TOOLS.some(t => t.function.name === call.name) ? codingTool!(call, signal, context) : SHADOW_BASH_TOOLS.some(t => t.function.name === call.name) ? executeRun(shadowBashTool)(call, signal, context) : call.name === "web_fetch" || call.name === "web_search" ? webTool!(call, signal, context) : call.name.startsWith("mcp_") ? mcpTool!(call, signal, context) : serviceTool && services.bindings.has(call.name) ? serviceTool(call, signal, context) : readTool!(call, signal, context)) as import("./conversations.ts").NativeReadToolExecutor } : {}),
        contextBlock: snapshot.block, references: snapshot.references, signal: abort.signal, ...(options.media ? { media: options.media } : {}),
        onAccepted: ({ messageId }) => { userMessageId = messageId; if (options.steer) options.steer.state = "applied"; this.changed(); },
        onDispatch: (messages, compaction) => this.recordDispatch(model, messages, compaction, snapshot.references.length),
        ...(this.contextBudgetFor(model, destination) ? { contextBudget: this.contextBudgetFor(model, destination)! } : {}),
        onBudget: (outcome) => {
          if (outcome.pruned) this.notice("info", t("ctx_budget_pruned", { count: outcome.pruned }), t("ctx_budget_pruned_hint"));
        },
        concurrentReadTools: PROJECT_READ_TOOLS.map((tool) => tool.function.name),
        takeSteer: () => {
          const next = this.view.steer.find((item) => item.state === "pending");
          if (!next) return null;
          next.state = "submitted";
          this.changed();
          return { id: next.id, text: next.text };
        },
        onSteerDelivered: (id) => {
          const item = this.view.steer.find((entry) => entry.id === id);
          if (item) item.state = "applied";
          this.view.steer = this.view.steer.filter((entry) => entry.state !== "applied");
          this.changed();
        },
      });
      for await (const event of stream) {
        if (abort.signal.aborted || this.store.conversationRevision !== localRevision) break;
        if (event.type === "text") coalescer.push({ type: "text", data: event.data });
        else if (event.type === "reasoning") thinking.push({ type: "text", data: event.data });
        else if (event.type === "tool_call") { thinking.flushNow(); toolActivity.call(event.data); }
        else if (event.type === "tool_result") toolActivity.result(event.data);
      }
      thinking.flushNow();
      coalescer.flushNow();
      if (this.store.conversationRevision !== localRevision) return;
      const answer = this.store.state.streamBuffer;
      this.store.dispatch({ type: "stream_complete", messageId: `answer-${randomUUID()}` });
      this.store.dispatch({ type: "turn_changed", turn: "idle" });
      await this.reloadMessages(conversationId);
      const sourceId = this.store.state.messages.at(-1)?.id ?? null;
      if (this.view.mode === "build" && !nativeWriteApplied) await this.proposeFrom(answer, sourceId);
      if (nativeWriteApplied) await this.offerVerificationAfterEdits(answer, verifiedManifestDigest, localRevision).catch(() => undefined);
      void this.runHooks("post-response", answer);
    } catch (error) {
      coalescer.discard();
      thinking.discard();
      if (this.store.conversationRevision !== revision && this.store.state.activeConversation?.id !== conversationId) return;
      const cancelled = abort.signal.aborted;
      this.store.dispatch({ type: "stream_interrupted", messageId: `partial-${randomUUID()}`, phase: cancelled ? "cancelled" : "failed" });
      if (conversationId) await this.reloadMessages(conversationId).catch(() => undefined);
      if (!cancelled && userMessageId === null && storedBefore >= 0 && errorCode(error) === "tui_transport_unavailable") {
        const storedAfter = this.store.state.messages.filter((message) => message.role === "user" && message.content === text && !message.id.startsWith("pending-")).length;
        if (storedAfter > storedBefore) this.notice("warning", t("ctl_send_stored_no_answer"), t("ctl_send_stored_no_answer_hint"));
        else { this.notice("error", t("ctl_send_not_delivered"), t("ctl_doctor_hint")); this.emit("draft", text); }
      } else if (!cancelled) this.reportTurnError(error, userMessageId !== null);
      // A pre-admission attachment refusal returns to the composer; no new user message or provider request exists.
      if (!cancelled && userMessageId === null && (errorCode(error).startsWith("attachment_") || errorCode(error) === "conversation_attachment_resolution_required")) {
        const key = errorCode(error) === "attachment_size" ? "attachment_size" : "attachment_unavailable";
        throw Object.assign(new Error(connectionText(key)), { code: key });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      if (this.store.state.turn === "submitting" || this.store.state.turn === "streaming") this.store.dispatch({ type: "turn_changed", turn: "idle" });
      this.changed();
    }
    await this.drainSteer();
  }

  private reportTurnError(error: unknown, accepted: boolean): void {
    const code = error instanceof ConversationServiceError ? error.code : errorCode(error);
    if (code.startsWith("account_")) { this.notice("warning", accountErrorText(code)); return; }
    if (["hosted_outcome_unknown", "hosted_reconciliation_required", "hosted_already_submitted"].includes(code)) { this.notice("warning", hostedText("unknown")); return; }
    if (["hosted_daily_quota_exceeded", "hosted_sponsorship_daily_exhausted", "hosted_credit_insufficient", "hosted_sybil_limit_exceeded"].includes(code)) { this.notice("info", hostedText("quota")); return; }
    if (code.startsWith("hosted_")) { this.notice("warning", hostedText("unavailable")); return; }
    if (code.startsWith("attachment_") || ["input_image_undeclared", "input_audio_undeclared", "input_capability_undeclared", "conversation_attachment_resolution_required"].includes(code)) {
      this.notice("warning", connectionText(code === "attachment_size" ? "attachment_size" : "attachment_unavailable"));
      return;
    }
    if (code === "conversation_tool_result_pending") {
      this.notice("warning", t('a_conversa_tem_uma_chamada_de_'), t("ctl_pending_tool_hint"));
      return;
    }
    if (code === "stream_interrupted") { this.notice("error", t('a_resposta_foi_interrompida_an'), t("ctl_stream_interrupted_hint")); return; }
    if (code === "local_processing_denied") {
      this.notice("warning", t('esta_conversa_s_permite_proces'), t("ctl_local_only_hint"));
      return;
    }
    if (code === "auth_401") { this.notice("error", t('a_credencial_da_tui_foi_recusa'), t("ctl_auth_hint")); return; }
    if (code === "auth_403" || code === "scope_denied" || code === "model_scope_denied") { this.notice("error", t("ctl_policy_denied", { code }), t("ctl_policy_denied_hint")); return; }
    if (code === "tui_transport_unavailable" && accepted) {
      this.notice("error", t('conex_o_perdida_depois_do_envi'), t("ctl_not_resent"));
      return;
    }
    this.notice("error", t("ctl_send_failed", { reason: errorText(error) }));
  }

  async summarizeProject(keywords?: string): Promise<void> {
    const binding = this.view.binding;
    if (!binding || this.busy) { this.notice("info", t('no_linked_project_or_busy')); return; }
    
    this.notice("info", t('generating_project_summary'));
    
    try {
      const { buildPlanChatRequest, filesystemToolsFromCatalog, TUI_TURN_MAX_TOKENS } = await import("./tool-plans.ts");
      const catalog = await this.workspace.getFilesystemCatalog();
      const tools = filesystemToolsFromCatalog(catalog);
      const snapshot = await this.context.snapshotForDispatch();
      const prompt = `Resuma o projeto atual de forma estruturada e concisa.${keywords ? ` Foco nas palavras-chave: ${keywords}.` : ""} Ignore arquivos irrelevantes.\n\n${snapshot.block}`;
      const chat = buildPlanChatRequest({ model: this.store.state.selectedModel || "auto", messages: [{ role: "user", content: prompt }], tools, maxTokens: TUI_TURN_MAX_TOKENS });
      const view = await this.workspace.refresh(binding.projectId);
      const planned = await this.workspace.createChatPlan(binding.projectId, { expectedRevision: view.revision, chat });
      const request = { runId: crypto.randomUUID(), planId: planned.plan!.id, projectId: binding.projectId, conversationRevision: 0, userText: "Resumo", risk: "low" as const };
      
      this.observed.add(request.runId);
      const settled = await this.workspace.waitForSettledRun(request.projectId, { planId: request.planId, runId: request.runId });
      this.observed.delete(request.runId);
      
      const artifact = settled.artifact;
      if (artifact && artifact.mediaType === "text/plain") {
        const text = await this.workspace.readArtifact(request.projectId, artifact.id);
        this.upsertLive({ kind: "assistant", id: `summary-${Date.now()}`, text: `[${t("ctl_quick_summary")}]\n${keywords ? `${t("ctl_keywords", { keywords })}\n` : ""}\n${text}` });
      } else {
        this.notice("warning", t('model_no_text_summary'));
      }
    } catch (error) {
      this.notice("error", operationText("summary_failed", { reason: errorText(error) }));
    }
  }

  // ─── commands and hooks in the isolated runner (`exec`, no shell) ─────

  /**
   * `!programa args`: structured argv executed by the canonical runner in the
   * hardened container (network none, read-only snapshot). The person's Enter
   * on the `!` line is the approval, sent as the W5 signature; nothing runs on
   * the host. Returns the exit code when it ran.
   */
  async runShell(line: string): Promise<number | null> {
    const parsed = parseCommandLine(line);
    if (!parsed.ok) { this.notice("warning", t("ctl_command_refused", { reason: (parsed as { ok: false; reason: string }).reason }), t("ctl_command_refused_hint")); return null; }
    const itemId = `exec-${randomUUID()}`;
    const title = `$ ${parsed.argv.join(" ")}`;
    const previous = this.shellTail;
    let release!: () => void;
    this.shellTail = new Promise<void>(resolve => { release = resolve; });
    const pending = new AbortController();
    const signal = AbortSignal.any([pending.signal, this.lifecycleAbort.signal]);
    const validate = this.captureContext(signal);
    const queued = this.pendingShells.size > 0 || this.busy || !!this.turnAbort || !!this.effectAbort || !!this.view.busy;
    this.pendingShells.add(pending);
    if (queued) this.upsertLive({ kind: "run", id: itemId, title, state: "preparing", detail: t('aguarde_a_opera_o_atual_termin') });
    try {
      // A visible final stream delta is not yet a committed assistant message.
      // Wait through turn cleanup and serialize shell requests before admitting
      // another intention on the same conversation revision.
      const ready = await new Promise<boolean>(resolve => {
        let previousDone = false;
        const finish = (ready: boolean) => { this.off("change", check); signal.removeEventListener("abort", check); resolve(ready); };
        const check = () => {
          try { validate(); } catch { finish(false); return; }
          if (previousDone && !this.busy && !this.turnAbort && !this.effectAbort && !this.view.busy) finish(true);
        };
        this.on("change", check);
        signal.addEventListener("abort", check, { once: true });
        void previous.then(() => { previousDone = true; check(); });
        check();
      });
      if (!ready) { if (!this.disposed) this.upsertLive({ kind: "run", id: itemId, title, state: "cancelled" }); return null; }
      validate();
      this.pendingShells.delete(pending);
      return await this.execInRunner(parsed.argv, { itemId, title, intention: t("ctl_intent_run_command", { command: parsed.argv.join(" ") }) });
    } finally { this.pendingShells.delete(pending); release(); }
  }

  private async execInRunner(argv: string[], options: { title: string; intention: string; itemId?: string }): Promise<number | null> {
    const binding = this.view.binding;
    const itemId = options.itemId ?? `exec-${randomUUID()}`;
    const update = (state: "preparing" | "running" | "passed" | "failed" | "blocked" | "cancelled", detail?: string, receipt?: string | null) =>
      this.upsertLive({ kind: "run", id: itemId, title: options.title, state, ...(detail ? { detail } : {}), ...(receipt ? { receipt } : {}) });
    if (!binding) { update("blocked", t("no_bound_folder")); return null; }
    if (!this.sign) { update("blocked", t("ctl_no_native_identity")); return null; }
    if (this.store.state.storagePolicy === "temporary") { update("blocked", t("ctl_temporary_no_runs")); return null; }
    const abort = new AbortController();
    let runId: string | undefined;
    const cancelRun = () => { if (runId) void this.workspace.cancelRun(binding.projectId, runId).catch(() => this.notice("warning", t('cancelamento_ainda_n_o_confirm'))); };
    abort.signal.addEventListener("abort", cancelRun, { once: true });
    this.effectAbort = abort;
    this.view.busy = operationText("executing");
    update("preparing");
    try {
      if (!this.profiles.length) this.profiles = await this.workspace.getRuntimeProfiles(abort.signal);
      const manifest = await this.workspace.getManifest(binding.projectId, binding.rootBindingId, abort.signal);
      this.manifestEntries = manifest.entries;
      const profileId = profileForProgram(argv[0]!, manifest.entries.map((e) => e.relativePath));
      const profile = this.profiles.find((p) => p.id === profileId);
      if (!profileId || !profile) { update("blocked", operationText("runner_profile_missing")); return null; }
      if (!profile.available) { update("blocked", `${t("ctl_runner_unavailable", { reason: profile.diagnostic ?? "runtime_unavailable" })}\n${t("runner_setup_hint")}`); return null; }
      const conversationId = await this.ensureConversation();
      const intention = await this.conversations.appendIntention(conversationId, options.intention, `tui_exec_${itemId}`);
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const request = { ...buildRunRequest({ profileId, actionId: "exec", reason: "exec" }, manifest.snapshotDigest), argv };
      const planned = await this.workspace.createRunPlan(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, request }, abort.signal);
      const plan = planned.plan!;
      const requestId = randomUUID();
      update("running");
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId }, this.sign, abort.signal, { conversationId, requestId: intention.requestId });
      runId = admitted.run?.id;
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      if (abort.signal.aborted) { cancelRun(); abort.signal.throwIfAborted(); }
      const settled = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId, runId }, { signal: abort.signal, timeoutMs: 330_000 });
      await this.conversations.linkRun(conversationId, { messageId: intention.messageId, requestId: intention.requestId, runId, projectId: binding.projectId, modelId: "runner", state: settled.run?.status ?? "unknown" }).catch(() => undefined);
      const receipt = settled.receipts.find((r) => r.runId === runId && r.status === "succeeded");
      if (settled.run?.status !== "succeeded" || !settled.artifact) { update("failed", t("ctl_run_not_assumed", { status: settled.run?.status ?? "?" }), receipt?.id ?? null); return null; }
      const report = interpretReport(await this.workspace.readArtifact(binding.projectId, settled.artifact.id, abort.signal));
      update(report.state, report.detail + (report.state === "blocked" ? `\n${RUNNER_SETUP_HINT}` : ""), receipt?.id ?? null);
      await this.conversations.appendRunResult(conversationId, intention.messageId, `${options.title}: ${report.summary} (run ${runId}${receipt ? `, ${t("receipt_short", { id: receipt.id })}` : ""}).\n${report.failureText.slice(0, 4000)}`, `tui_exec_result_${itemId}`).catch(() => undefined);
      if (report.state === "failed") this.view.correction = { kind: "verification", text: `\`${argv.join(" ")}\`${t("runner_isolated_failed", { output: report.failureText })}` };
      await this.reloadMessages(conversationId);
      return report.state === "passed" ? 0 : report.state === "failed" ? 1 : null;
    } catch (error) {
      update(abort.signal.aborted ? "cancelled" : "failed", abort.signal.aborted ? undefined : localizedDiagnostic(errorCode(error)));
      return null;
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      abort.signal.removeEventListener("abort", cancelRun);
      this.view.busy = null;
      this.changed();
    }
  }

  /** Reads the hooks file (discovery executes nothing) and its trust state. */
  async loadHooks(): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    const source = await loadHooksSource(binding.rootPath);
    const hash = hashHooksSource(source.raw);
    const trusted = source.raw ? (await getHookTrust(binding.rootPath, source.raw)) !== null : false;
    if (this.view.binding !== binding || this.disposed) return;
    this.hooks = { source, hash, trusted };
    this.view.hooks = source.path ? { count: source.hooks.length, rejected: source.rejected.length, trusted, hash, path: source.path } : null;
    if (source.hooks.length && !trusted) this.notice("info", t("ctl_hooks_found", { count: source.hooks.length }), t("ctl_hooks_found_hint"));
    this.changed();
  }

  hookDefinitions(): { hooks: HookDefinition[]; rejected: Array<{ index: number; reason: string }>; hash: string; trusted: boolean } | null {
    return this.hooks ? { hooks: this.hooks.source.hooks, rejected: this.hooks.source.rejected, hash: this.hooks.hash, trusted: this.hooks.trusted } : null;
  }

  /**
   * Trusts exactly the hooks the person reviewed: the file is re-read and its
   * hash must equal `reviewedHash`, otherwise nothing is trusted.
   */
  async trustReviewedHooks(reviewedHash: string): Promise<boolean> {
    const binding = this.view.binding;
    if (!binding) return false;
    const current = await loadHooksSource(binding.rootPath);
    if (hashHooksSource(current.raw) !== reviewedHash) { this.notice("warning", t('o_arquivo_de_hooks_mudou_depoi'), t("ctl_hooks_changed_hint")); await this.loadHooks(); return false; }
    await trustHooks(binding.rootPath, current.raw);
    await this.loadHooks();
    this.notice("info", t("ctl_hooks_trusted", { hash: reviewedHash.slice(0, 12) }));
    return true;
  }

  async revokeHooks(): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    await revokeHookTrust(binding.rootPath);
    await this.loadHooks();
  }

  /** Runs the matching trusted hooks of a phase through the isolated runner. */
  private async runHooks(phase: HookPhase, target: string): Promise<boolean> {
    const state = this.hooks;
    if (!state || !state.source.hooks.length || this.store.state.storagePolicy === "temporary") return true;
    const outcome = await executeHooks(state.source.hooks, phase, target, {
      trusted: state.trusted,
      run: async (hook) => {
        const code = await this.execInRunner(hook.argv, { title: `hook ${phase}: ${hook.command}`, intention: `Hook confiado (hash ${state.hash.slice(0, 12)}) na fase ${phase}: \`${hook.command}\`.` });
        return code === null ? { ran: false, reason: t("ctl_hook_not_run") } : { ran: true, exitCode: code, output: "" };
      },
    });
    if (!outcome.allow) this.notice("warning", t("ctl_hook_blocked", { message: outcome.message ?? "" }));
    return outcome.allow;
  }

  // ─── skills, artifacts and the main interface ─────────────────────────

  /** Activates/deactivates a skill for the next turns (text only, nothing executes). */
  toggleSkill(id: string): void {
    const skill = this.view.skills.find((s) => s.id === id);
    if (!skill) return;
    const active = this.view.activeSkills.includes(id);
    this.view.activeSkills = active ? this.view.activeSkills.filter((x) => x !== id) : [...this.view.activeSkills, id];
    this.notice("info", active ? t("ctl_skill_off", { name: skill.name }) : t("ctl_skill_on", { name: skill.name, hash: skill.sha256.slice(0, 12) }));
  }

  /** Canonical artifacts of the project (results of runs), newest first. */
  async refreshArtifacts(options: { more?: boolean } = {}): Promise<ArtifactView[]> {
    const binding = this.view.binding;
    if (!binding) return [];
    const cursor = options.more ? this.view.artifactsNextCursor : null;
    if (options.more && !cursor) return this.view.artifacts;
    try {
      const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(binding.projectId)}/artifacts?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
      const body = await res.json() as { artifacts?: Array<Record<string, unknown>>; nextCursor?: string | null };
      if (this.view.binding !== binding) return [];
      const page = (body.artifacts ?? []).map((a) => ({
        id: String(a.id), mediaType: String(a.mediaType ?? ""), filename: typeof a.filename === "string" ? a.filename : null,
        byteLength: Number(a.byteLength ?? 0), sha256: String(a.sha256 ?? ""), runId: String(a.runId ?? ""), createdAt: String(a.createdAt ?? ""),
      }));
      this.view.artifacts = [...new Map([...(options.more ? this.view.artifacts : []), ...page].map(item => [item.id, item])).values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      this.view.artifactsNextCursor = typeof body.nextCursor === "string" && body.nextCursor !== cursor ? body.nextCursor : null;
    } catch (error) { this.notice("warning", t("ctl_artifacts_unavailable", { reason: errorText(error) })); }
    this.changed();
    return this.view.artifacts;
  }

  async readTextArtifact(id: string): Promise<string> {
    const binding = this.view.binding;
    const artifact = this.view.artifacts.find(item => item.id === id);
    if (!binding || !artifact) throw new Error("artifact_missing");
    const bytes = await this.artifactBytes(binding.projectId, artifact);
    if (this.view.binding !== binding) throw new Error("project_binding_changed");
    if (!this.textArtifact(artifact.mediaType)) throw new Error("artifact_binary");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private textArtifact(mediaType: string): boolean {
    return mediaType.startsWith("text/") || /^application\/(?:json|[^;]+\+json|xml|javascript)(?:;|$)/.test(mediaType);
  }

  private async artifactBytes(projectId: string, artifact: Pick<ArtifactView, "id" | "mediaType" | "byteLength" | "sha256">): Promise<Buffer> {
    let bytes: Buffer;
    if (this.textArtifact(artifact.mediaType)) bytes = Buffer.from(await this.workspace.readArtifact(projectId, artifact.id), "utf8");
    else {
      const response = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}/media`);
      if (!response.ok) throw new Error(`artifact_read_failed_${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("artifact_integrity_mismatch");
    return bytes;
  }

  /** Bytes are prepared and checked before atomically publishing the chosen destination. */
  private assertExportAllowed(): void {
    if (this.state.storagePolicy === "temporary") throw new Error("temporary_export_forbidden");
  }

  private async writeChosenFile(path: string, bytes: Buffer, force: boolean, revalidate?: () => void): Promise<void> {
    this.assertExportAllowed();
    const temporaryPath = `${path}.uptokey-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      this.assertExportAllowed();
      revalidate?.();
      if (force) await rename(temporaryPath, path);
      else await link(temporaryPath, path); // Atomic no-overwrite, including a concurrent creator.
    } finally { await unlink(temporaryPath).catch(() => {}); }
  }

  async chatFileReferences(messageId?: string): Promise<ChatFileReference[]> {
    const binding = this.view.binding, conversationId = this.state.activeConversation?.id;
    if (!binding || !conversationId) return [];
    const { thread } = await this.conversations.thread(conversationId);
    if (this.view.binding !== binding || this.state.activeConversation?.id !== conversationId) throw new Error("conversation_changed");
    const refs: ChatFileReference[] = [];
    for (const message of thread) {
      if (messageId && message.id !== messageId) continue;
      for (const part of message.parts) {
        const file = projectFileReference(binding.projectId, message.id, part);
        if (file) refs.push(file);
        if (part.artifactRef) {
          if (!this.view.artifacts.length) await this.refreshArtifacts();
          while (!this.view.artifacts.some(item => item.id === part.artifactRef) && this.view.artifactsNextCursor) await this.refreshArtifacts({ more: true });
          const artifact = this.view.artifacts.find(item => item.id === part.artifactRef);
          if (artifact && artifact.id === part.artifactRef) refs.push({ kind: "artifact", projectId: binding.projectId, messageId: message.id, artifactId: artifact.id, filename: artifact.filename ?? artifact.id, mediaType: artifact.mediaType, sha256: artifact.sha256, byteLength: artifact.byteLength });
        }
      }
    }
    if (this.view.binding !== binding || this.state.activeConversation?.id !== conversationId) throw new Error("conversation_changed");
    return [...new Map(refs.map(ref => [ref.kind === "artifact" ? `${ref.messageId}:a:${ref.artifactId}` : `${ref.messageId}:f:${ref.rootBindingId}:${ref.path}:${ref.sha256}`, ref])).values()];
  }

  private assertChatFile(ref: ChatFileReference): void {
    const binding = this.view.binding;
    if (!binding || binding.projectId !== ref.projectId || ref.kind === "project-file" && binding.rootBindingId !== ref.rootBindingId) throw new Error("project_binding_changed");
    if (!this.state.messages.some(message => message.id === ref.messageId)) throw new Error("conversation_changed");
  }

  async readChatFile(ref: ChatFileReference): Promise<{ text: string | null; path: string; mediaType: string }> {
    this.assertChatFile(ref);
    if (ref.kind === "project-file") {
      const file = await this.workspace.readProjectFile(ref.projectId, ref.rootBindingId, ref.path);
      this.assertChatFile(ref);
      if (!file || file.sha256 !== ref.sha256 || file.byteLength !== ref.byteLength) throw new Error("project_file_changed");
      return { text: file.text, path: ref.path, mediaType: "text/plain" };
    }
    const bytes = await this.artifactBytes(ref.projectId, { ...ref, id: ref.artifactId });
    this.assertChatFile(ref);
    return { text: this.textArtifact(ref.mediaType) ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null, path: ref.filename, mediaType: ref.mediaType };
  }

  async copyChatFile(ref: ChatFileReference, scope: "content" | "path"): Promise<void> {
    this.assertExportAllowed();
    const value = await this.readChatFile(ref);
    if (scope === "content" && value.text === null) throw new Error("artifact_binary");
    this.assertChatFile(ref);
    this.assertExportAllowed();
    await writeClipboard(scope === "path" ? value.path : value.text!);
    this.notice("info", t("file_copied"));
  }

  async saveChatFile(ref: ChatFileReference, target: string, force = false): Promise<boolean> {
    try {
      this.assertChatFile(ref);
      if (!target.trim()) throw new Error("file_destination_required");
      const value = ref.kind === "artifact" ? await this.artifactBytes(ref.projectId, { ...ref, id: ref.artifactId }) : Buffer.from((await this.readChatFile(ref)).text!, "utf8");
      this.assertChatFile(ref);
      await this.writeChosenFile(isAbsolute(target) ? target : resolvePath(this.options.cwd, target), value, force, () => this.assertChatFile(ref));
      this.notice("info", t("file_saved", { path: target }));
      return true;
    } catch (error) { this.notice("error", `${t("file_save_failed")} (${errorText(error)})`); return false; }
  }

  /** Saves an artifact to a file chosen by the person (explicit destination; no overwrite unless forced). */
  async saveArtifact(id: string, target: string, force = false): Promise<void> {
    const binding = this.view.binding;
    const artifact = this.view.artifacts.find((a) => a.id === id) ?? (await this.refreshArtifacts()).find((a) => a.id === id);
    if (!binding || !artifact) { this.notice("error", t('artefato_n_o_encontrado_neste_')); return; }
    const path = isAbsolute(target) ? target : resolvePath(this.options.cwd, target);
    try {
      const bytes = await this.artifactBytes(binding.projectId, artifact);
      if (this.view.binding !== binding) throw new Error("project_binding_changed");
      await this.writeChosenFile(path, bytes, force);
      this.notice("info", operationText("artifact_saved", { path, media: artifact.mediaType, bytes: artifact.byteLength, hash: artifact.sha256.slice(0, 12) }));
    } catch (error) {
      this.notice("error", t("ctl_artifact_not_saved", { reason: errorText(error) }));
    }
  }

  /** Opens the main Uptokey interface (local PWA) for content better served there. */
  openMainInterface(): void {
    const url = new URL("/chat", this.client.url).toString();
    if (openLoopbackUrl(url)) this.notice("info", operationText("browser_opened", { url }));
    else this.notice("info", operationText("browser_open", { url }));
  }

  async approveWorkspaceContext(input: string): Promise<void> {
    const active = this.state.activeConversation;
    const binding = this.view.binding;
    if (!active || !binding) { this.notice("info", chromeText("context_link_project")); return; }
    const generation = this.conversationOpenGeneration;
    const revision = this.store.conversationRevision;
    const assertCurrent = () => {
      if (this.disposed || this.state.activeConversation?.id !== active.id || this.view.binding !== binding
          || this.conversationOpenGeneration !== generation || this.store.conversationRevision !== revision) throw new Error("context_link_context_changed");
    };
    try {
      await approveActiveContext(input, {
        conversationId: active.id, projectId: binding.projectId, assertCurrent,
        conversation: () => this.conversations.getConversation(active.id),
        approve: body => this.client.fetchAuth("/local/workspace/session/context/approve", { method: "POST", body: JSON.stringify(body) }),
      });
      this.notice("info", chromeText("context_link_approved"));
    } catch (error) {
      const code = errorText(error);
      this.notice(code === "context_link_usage" ? "info" : "error", chromeText(code === "context_link_usage" ? "context_link_usage"
        : code === "context_link_context_changed" || code === "context_link_conflict" ? "context_link_changed"
        : code === "context_link_expired" ? "context_link_expired" : "context_link_failed"));
    }
  }

  // ─── language servers (consented, supervised; edits become proposals) ─

  private lspClients = new Map<string, LspClient>();

  /** The native model turn waits for consent and receives actual diagnostics. */
  async nativeDiagnostics(paths: string[], signal?: AbortSignal, context?: NativeToolExecutionContext): Promise<NativeDiagnosticsResult> {
    const binding = this.view.binding;
    const result: NativeDiagnosticsResult = { status: "not_executed", files: [], unavailable: [], serverCount: 0 };
    const check = async () => {
      signal?.throwIfAborted();
      await context?.assertCurrent();
      signal?.throwIfAborted();
      if (!binding || this.view.binding !== binding || this.disposed) throw new Error("project_binding_changed");
    };
    await check();
    const servers = new Map<string, LspClient | null>();
    for (const path of paths) {
      await check();
      const requested = serverForFile(path);
      if (!requested) { result.unavailable.push({ path, reason: "lsp_language_unsupported" }); continue; }
      const spec = effectiveServer(requested, binding!.rootPath);
      if (!servers.has(spec.id)) {
        if (!(await hasLspConsent(spec, binding!.rootPath))) {
          const accepted = await this.approve(t("lsp_consent_title", { server: spec.id }), t("lsp_consent_body", { command: spec.command, root: binding!.rootPath }), signal);
          await check();
          if (!accepted) { servers.set(spec.id, null); result.unavailable.push({ path, reason: "lsp_consent_declined" }); continue; }
          await grantLspConsent(spec, binding!.rootPath);
          await check();
        }
        const client = await this.lspClientFor(spec, { auto: true, paths: [path] });
        await check();
        servers.set(spec.id, client);
        if (client) result.serverCount++;
      }
      const client = servers.get(spec.id);
      if (!client) { result.unavailable.push({ path, reason: "lsp_server_unavailable" }); continue; }
      try {
        const file = await this.workspace.readProjectFile(binding!.projectId, binding!.rootBindingId, path, signal);
        await check();
        if (!file) { result.unavailable.push({ path, reason: "project_file_not_found" }); continue; }
        const uri = client.sync(path, file.text);
        const diagnostics = await client.waitDiagnostics(uri, 6_000, signal);
        await check();
        result.files.push({ path, diagnostics });
      } catch (error) {
        await check();
        result.unavailable.push({ path, reason: errorText(error) });
      }
    }
    result.status = result.files.length ? result.unavailable.length ? "partial" : "completed" : "not_executed";
    return result;
  }

  private async prepareLspForNavigation(path: string, signal?: AbortSignal, context?: NativeToolExecutionContext): Promise<LspClient | null> {
    const binding = this.view.binding;
    const check = async () => {
      signal?.throwIfAborted();
      await context?.assertCurrent();
      signal?.throwIfAborted();
      if (!binding || this.view.binding !== binding || this.disposed) throw new Error("project_binding_changed");
    };
    await check();
    const requested = serverForFile(path);
    if (!requested) throw new Error("lsp_language_unsupported");
    const spec = effectiveServer(requested, binding!.rootPath);
    if (!(await hasLspConsent(spec, binding!.rootPath))) {
      const accepted = await this.features.confirm(t("lsp_consent_title", { server: spec.id }), t("lsp_consent_body", { command: spec.command, root: binding!.rootPath }), signal);
      await check();
      if (!accepted) throw new Error("lsp_consent_declined");
      await grantLspConsent(spec, binding!.rootPath);
      await check();
    }
    const client = await this.lspClientFor(spec, { auto: true, paths: [path] });
    await check();
    if (!client) throw new Error("lsp_server_unavailable");
    const file = await this.workspace.readProjectFile(binding!.projectId, binding!.rootBindingId, path, signal);
    await check();
    if (!file) throw new Error("project_file_not_found");
    client.sync(path, file.text);
    return client;
  }

  async nativeLspDefinition(path: string, line: number, column: number, signal?: AbortSignal, context?: NativeToolExecutionContext) {
    const client = await this.prepareLspForNavigation(path, signal, context);
    if (!client) throw new Error("lsp_server_unavailable");
    const result = await client.definition(path, { line: line - 1, character: column - 1 });
    return result.map(loc => ({ path: client.relativeFromUri(loc.uri) || loc.uri, line: loc.range.start.line + 1, column: loc.range.start.character + 1 }));
  }

  async nativeLspReferences(path: string, line: number, column: number, signal?: AbortSignal, context?: NativeToolExecutionContext) {
    const client = await this.prepareLspForNavigation(path, signal, context);
    if (!client) throw new Error("lsp_server_unavailable");
    const result = await client.references(path, { line: line - 1, character: column - 1 });
    return result.map(loc => ({ path: client.relativeFromUri(loc.uri) || loc.uri, line: loc.range.start.line + 1, column: loc.range.start.character + 1 }));
  }

  private async lspClientFor(requested: ServerSpec, options: { auto: boolean; paths: string[]; then?: "diagnostics" | { rename: { target: string; newName: string } } | { actions: string } | { locate: { kind: "references" | "definition"; target: string } } }): Promise<LspClient | null> {
    const binding = this.view.binding;
    if (!binding) return null;
    const spec = effectiveServer(requested, binding.rootPath);
    const existing = this.lspClients.get(spec.id);
    if (existing?.running) return existing;
    if (!(await hasLspConsent(spec, binding.rootPath))) {
      if (!options.auto) {
        this.view.lspConsentRequest = { spec, paths: options.paths, then: options.then ?? "diagnostics" };
        this.changed();
      }
      return null;
    }
    const program = resolveProgram(spec.command);
    if (!program) {
      if (!options.auto) this.notice("warning", t("lsp_not_found", { command: spec.command }), t("lsp_install_hint", { install: spec.install }));
      return null;
    }
    const client = new LspClient(spec, binding.rootPath, program);
    try { await client.start(); }
    catch (error) {
      client.stop();
      if (!options.auto) this.notice("error", t("lsp_start_failed", { command: spec.command, reason: errorText(error) }));
      return null;
    }
    if (this.view.binding !== binding || this.disposed) { client.stop(); throw new Error("project_binding_changed"); }
    this.lspClients.set(spec.id, client);
    return client;
  }

  /** Grants the pending consent (person's explicit gesture) and continues the request. */
  async grantLspConsent(): Promise<void> {
    const request = this.view.lspConsentRequest;
    const binding = this.view.binding;
    this.view.lspConsentRequest = null;
    if (!request || !binding) return;
    await grantLspConsent(request.spec, binding.rootPath);
    if (request.then === "diagnostics") await this.lspDiagnostics(request.paths);
    else if ('actions' in request.then) await this.lspCodeActions(request.then.actions);
    else if ('locate' in request.then) await this.lspLocate(request.then.locate.kind, request.then.locate.target);
    else await this.lspRename(request.then.rename.target, request.then.rename.newName);
  }

  declineLspConsent(): void {
    if (this.view.lspConsentRequest) this.notice("info", t("lsp_not_started", { command: this.view.lspConsentRequest.spec.command }));
    this.view.lspConsentRequest = null;
    this.changed();
  }

  async revokeLsp(): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    for (const [id, client] of this.lspClients) { client.stop(); this.lspClients.delete(id); }
    for (const spec of new Set([...this.view.manifestFiles.map((f) => { const spec = serverForFile(f); return spec && effectiveServer(spec, binding.rootPath); })].filter((s): s is ServerSpec => s !== null))) await revokeLspConsent(spec, binding.rootPath);
    this.notice("info", t('servidores_de_linguagem_parado'));
  }

  /**
   * Diagnostics for files (content read by the core, sent to the consented
   * server). With `auto`, runs only where consent already exists.
   */
  async lspDiagnostics(paths: string[], options: { auto?: boolean } = {}): Promise<number> {
    const binding = this.view.binding;
    if (!binding || !paths.length) { if (!options.auto) this.notice("info", t('informe_arquivos_diagnosticos_')); return 0; }
    const bySpec = new Map<string, { spec: ServerSpec; paths: string[] }>();
    for (const path of paths) {
      const spec = serverForFile(path);
      if (!spec) { if (!options.auto) this.notice("info", t("lsp_no_server_ext", { path })); continue; }
      bySpec.set(spec.id, { spec, paths: [...(bySpec.get(spec.id)?.paths ?? []), path] });
    }
    let errors = 0;
    for (const { spec, paths: group } of bySpec.values()) {
      const client = await this.lspClientFor(spec, { auto: options.auto === true, paths: group });
      if (!client) continue;
      const itemId = `lsp-${spec.id}-${randomUUID()}`;
      this.upsertLive({ kind: "run", id: itemId, title: t("lsp_diag_running", { server: spec.id, files: group.join(", ") }), state: "running" });
      const lines: string[] = [];
      let found = 0;
      try {
        for (const path of group) {
          const file = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path);
          if (!file) continue;
          const uri = client.sync(path, file.text);
          const diagnostics = await client.waitDiagnostics(uri);
          const serious = diagnostics.filter((d) => (d.severity ?? 1) <= 2);
          found += diagnostics.filter((d) => (d.severity ?? 1) === 1).length;
          if (serious.length) lines.push(formatDiagnostics(path, serious));
        }
        errors += found;
        this.upsertLive({ kind: "run", id: itemId, title: found ? t("lsp_diag_errors", { server: spec.id, count: found }) : t("lsp_diag_clean", { server: spec.id }), state: found ? "failed" : "passed", ...(lines.length ? { detail: lines.join("\n") } : {}) });
        if (found) this.view.correction = { kind: "verification", text: `O servidor de linguagem (${spec.id}) reportou erros:\n${lines.join("\n")}\nCorrija-os.` };
      } catch (error) {
        this.upsertLive({ kind: "run", id: itemId, title: t("lsp_diag_failed", { server: spec.id }), state: "failed", detail: `(${errorText(error)})` });
      }
    }
    this.changed();
    return errors;
  }

  /**
   * Rename via the language server; the returned edits become a reviewable
   * proposal over the current bytes (read by the core) — never written here.
   * `target` is `caminho:linha:coluna` (1-based).
   */
  async lspRename(target: string, newName: string): Promise<void> {
    const binding = this.view.binding;
    const match = /^(.+):(\d+):(\d+)$/.exec(target.trim());
    if (!binding || !match || !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(newName)) { this.notice("info", t('uso_renomear_caminho_linha_col')); return; }
    const [, path, line, column] = match;
    const spec = serverForFile(path!);
    if (!spec) { this.notice("info", t("lsp_no_server_ext", { path: path! })); return; }
    const client = await this.lspClientFor(spec, { auto: false, paths: [path!], then: { rename: { target, newName } } });
    if (!client) return;
    try {
      const before = await this.workspace.getManifest(binding.projectId, binding.rootBindingId);
      const file = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path!);
      if (!file) { this.notice("error", t("ctl_file_missing", { path: path! })); return; }
      client.sync(path!, file.text);
      const edits = await client.rename(path!, { line: Number(line) - 1, character: Number(column) - 1 }, newName);
      if (!edits.size) { this.notice("info", t('o_servidor_n_o_prop_s_altera_e')); return; }
      const files = [];
      for (const [rel, list] of edits) {
        const current = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, rel);
        if (!current) throw new Error(`lsp_edit_target_missing:${rel}`);
        if (before.entries.find(entry => entry.relativePath === rel)?.sha256 !== current.sha256) throw new Error(`lsp_source_changed:${rel}`);
        files.push(describeFile(rel, current.text, current.sha256, applyTextEdits(current.text, list)));
      }
      const proposal: ChangeProposal = { id: randomUUID(), sourceMessageId: null, files, failures: [], rejectedBlocks: [], state: "proposed", message: operationText("rename_proposal", { name: newName, server: spec.id }) };
      this.view.proposal = proposal;
      this.upsertLive(this.proposalItem(proposal));
      this.emit("review", proposal);
    } catch (error) {
      this.notice("error", t("ctl_rename_failed", { reason: errorText(error) }));
    }
  }

  /** LSP actions are reviewed as a concrete edit; command-only actions never execute implicitly. */
  /**
   * /referencias and /definicao: asks the language server for the locations of the symbol at `caminho:linha:coluna`
   * over the bytes the core reads; each location keeps its line text so the person sees it without opening the file.
   */
  async lspLocate(kind: "references" | "definition", target: string): Promise<boolean> {
    const binding = this.view.binding;
    const match = /^(.+):(\d+):(\d+)$/.exec(target.trim());
    if (!binding || !match) { this.notice("info", t("lsp_locate_usage")); return false; }
    const [, path, line, column] = match;
    const spec = serverForFile(path!);
    if (!spec) { this.notice("info", t("lsp_no_server_ext", { path: path! })); return false; }
    const client = await this.lspClientFor(spec, { auto: false, paths: [path!], then: { locate: { kind, target } } });
    if (!client) return false;
    try {
      const file = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path!);
      if (!file) { this.notice("error", t("ctl_file_missing", { path: path! })); return false; }
      client.sync(path!, file.text);
      const position = { line: Number(line) - 1, character: Number(column) - 1 };
      const locations = kind === "references" ? await client.references(path!, position) : await client.definition(path!, position);
      if (this.view.binding !== binding) throw new Error("project_binding_changed");
      const texts = new Map<string, string[]>();
      const items: Array<{ path: string; line: number; column: number; preview: string }> = [];
      for (const location of locations.slice(0, 200)) {
        const relativePath = client.relativeFromUri(location.uri);
        if (!relativePath) continue;
        if (!texts.has(relativePath)) texts.set(relativePath, ((await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, relativePath).catch(() => null))?.text ?? "").split(/\r?\n/));
        const lineIndex = location.range.start.line;
        items.push({ path: relativePath, line: lineIndex + 1, column: location.range.start.character + 1, preview: (texts.get(relativePath)?.[lineIndex] ?? "").trim().slice(0, 160) });
      }
      this.view.lspLocations = { kind, target, items };
      this.changed();
      if (!items.length) this.notice("info", t(kind === "references" ? "lsp_no_references" : "lsp_no_definition", { target }));
      return items.length > 0;
    } catch (error) {
      this.notice("error", t("lsp_locate_failed", { reason: errorText(error) }));
      return false;
    }
  }

  async lspCodeActions(target: string): Promise<void> {
    const binding=this.view.binding,match=/^(.+):(\d+):(\d+)$/.exec(target.trim());
    if(!binding||!match){this.notice('info',t('uso_acoes_codigo_caminho_linha'));return;}
    const [,path,line,column]=match,spec=serverForFile(path!);
    if(!spec){this.notice('info',t('nenhum_servidor_de_linguagem_d'));return;}
    const client=await this.lspClientFor(spec,{auto:false,paths:[path!],then:{actions:target}});
    if(!client)return;
    try{
      const before=await this.workspace.getManifest(binding.projectId,binding.rootBindingId);
      const file=await this.workspace.readProjectFile(binding.projectId,binding.rootBindingId,path!);
      if(!file)throw new Error('lsp_source_missing');
      client.sync(path!,file.text);
      const position={line:Number(line)-1,character:Number(column)-1};
      const actions=await client.codeActions(path!,{start:position,end:position});
      if(!actions.length){this.notice('info',t('nenhuma_a_o_dispon_vel_nesta_p'));return;}
      for(const action of actions){
        if(action.disabled)continue;
        if(!await this.features.confirm(t('ctl_code_action'),action.title))continue;
        if(this.view.binding?.rootBindingId!==binding.rootBindingId)throw new Error('lsp_context_changed');
        const edits=await client.resolveCodeActionEdits(action),files=[];
        for(const [rel,list] of edits){
          const current=await this.workspace.readProjectFile(binding.projectId,binding.rootBindingId,rel);
          if(!current||before.entries.find(entry=>entry.relativePath===rel)?.sha256!==current.sha256)throw new Error(`lsp_source_changed:${rel}`);
          files.push(describeFile(rel,current.text,current.sha256,applyTextEdits(current.text,list)));
        }
        if(!files.length){this.notice('info',t('esta_a_o_n_o_cont_m_altera_es_'));return;}
        const proposal:ChangeProposal={id:randomUUID(),sourceMessageId:null,files,failures:[],rejectedBlocks:[],state:'proposed',message:action.title};
        this.view.proposal=proposal;this.upsertLive(this.proposalItem(proposal));this.emit('review',proposal);return;
      }
    }catch(error){this.notice('error',t('ctl_action_failed',{reason:errorText(error)}));}
  }

  // ─── git (read through the core; effects as W5 plans) ─────────────────

  async refreshGit(): Promise<GitStatusView | null> {
    const binding = this.view.binding;
    if (!binding) return null;
    try { this.view.git = await this.workspace.gitStatus(binding.projectId, binding.rootBindingId); }
    catch (error) { this.view.git = null; this.notice("warning", t("ctl_git_unavailable", { reason: errorText(error) })); }
    this.changed();
    return this.view.git;
  }

  async gitDiff(path: string, staged: boolean): Promise<string> {
    const binding = this.view.binding;
    if (!binding) return "";
    try { return (await this.workspace.gitDiff(binding.projectId, binding.rootBindingId, path, staged)).diff; }
    catch (error) { return t("ctl_diff_unavailable", { reason: errorText(error) }); }
  }

  /**
   * Stage/unstage/commit as an approved plan executed by the core (no repo
   * hooks, no remotes). The report artifact is the source of the outcome.
   */
  async gitApply(operation: GitOperationInput): Promise<void> {
    const binding = this.view.binding;
    if (!binding || !this.sign) { this.notice("error", t('git_indispon_vel_pasta_ou_iden')); return; }
    if (this.store.state.storagePolicy === "temporary") { this.notice("warning", t('sess_o_tempor_ria_opera_es_git')); return; }
    const title = operation.kind === "commit" ? `git commit: ${operation.message.split("\n")[0]!.slice(0, 60)}` : `git ${operation.kind === "stage" ? "add" : "restore --staged"}: ${operation.paths.slice(0, 3).join(", ")}${operation.paths.length > 3 ? ` (+${operation.paths.length - 3})` : ""}`;
    const itemId = `git-${randomUUID()}`;
    const abort = new AbortController();
    this.effectAbort = abort;
    this.view.busy = "Git";
    this.upsertLive({ kind: "run", id: itemId, title, state: "preparing" });
    try {
      const conversationId = await this.ensureConversation();
      const intention = await this.conversations.appendIntention(conversationId, t("ctl_intent_git", { title }), `tui_git_${itemId}`);
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const planned = await this.workspace.createGitPlan(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, operation }, abort.signal);
      const plan = planned.plan!;
      const requestId = randomUUID();
      this.upsertLive({ kind: "run", id: itemId, title, state: "running" });
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId }, this.sign, abort.signal, { conversationId, requestId: intention.requestId });
      const runId = admitted.run?.id;
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      const settled = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId, runId }, { signal: abort.signal });
      await this.conversations.linkRun(conversationId, { messageId: intention.messageId, requestId: intention.requestId, runId, projectId: binding.projectId, modelId: "git", state: settled.run?.status ?? "unknown" }).catch(() => undefined);
      const receipt = settled.receipts.find((r) => r.runId === runId && r.status === "succeeded");
      if (settled.run?.status !== "succeeded" || !settled.artifact) {
        const notSent = settled.receipts.some((r) => r.status === "not_sent");
        this.upsertLive({ kind: "run", id: itemId, title, state: "failed", detail: notSent ? t("ctl_git_changed") : t("ctl_run_status", { status: settled.run?.status ?? "?" }) });
        return;
      }
      const report = JSON.parse(await this.workspace.readArtifact(binding.projectId, settled.artifact.id, abort.signal)) as { exitCode?: number; stdout?: string; stderr?: string; headAfter?: string | null };
      const ok = report.exitCode === 0;
      this.upsertLive({ kind: "run", id: itemId, title, state: ok ? "passed" : "failed", receipt: receipt?.id ?? null, detail: [report.stdout, report.stderr].filter(Boolean).join("\n").trim().slice(0, 4000) || (ok ? `HEAD ${report.headAfter?.slice(0, 10) ?? ""}` : "") });
      await this.conversations.appendRunResult(conversationId, intention.messageId, receipt ? t(ok ? "ctl_git_result_ok_receipt" : "ctl_git_result_failed_receipt", { title, run: runId, receipt: receipt.id }) : t(ok ? "ctl_git_result_ok" : "ctl_git_result_failed", { title, run: runId }), `tui_git_result_${itemId}`).catch(() => undefined);
      await this.refreshGit();
      await this.reloadMessages(conversationId);
    } catch (error) {
      this.upsertLive({ kind: "run", id: itemId, title, state: abort.signal.aborted ? "cancelled" : "failed", detail: `(${errorText(error)}) nada foi presumido.` });
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  /** Window of the selected destination from catalog/broker metadata; unknown windows are not budgeted. */
  private contextBudgetFor(model: string, destination: TuiInferenceDestination): ContextBudget | undefined {
    const hosted = destination.hosted ? this.hostedModels.find((item) => item.modelId === model) : undefined;
    const window = hosted?.contextTokens ?? this.view.connections?.models.find((m) => m.id === model)?.contextWindow ?? null;
    if (!window || !Number.isSafeInteger(window) || window <= 0) return undefined;
    return { window, reserveOutput: outputReserve(window, hosted?.maxOutputTokens) };
  }

  /** Suggests compaction once per conversation when the last dispatch nears the model window. */
  private suggestCompaction(model: string, tokens: number | null): void {
    const id = this.store.state.activeConversation?.id;
    const window = this.view.connections?.models.find((m) => m.id === model)?.contextWindow ?? null;
    if (!id || tokens === null || !window || this.compactionSuggested.has(id)) return;
    if (tokens / window < 0.7) return;
    this.compactionSuggested.add(id);
    this.notice("warning", t("ctl_context_usage", { percent: Math.round((tokens / window) * 100), model, tokens, window }), t("ctl_context_usage_hint"));
  }

  private recordDispatch(model: string, messages: DispatchMessage[], compaction: ComposedHistory["compaction"], contextFiles: number): void {
    const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    this.view.lastDispatch = { messages: messages.length, bytes, compactedMessages: compaction?.covered ?? 0, contextFiles, tokens: null, at: Date.now() };
    this.emit("dispatch", { model, messages, compaction });
    this.changed();
    // Token count from the canonical catalog (loaded lazily; never a local chars/4 guess).
    void import("../token-estimate.ts").then(({ detailedTokenEstimate }) => {
      const estimate = detailedTokenEstimate({ model, messages: messages as never } as never);
      if (estimate && this.view.lastDispatch && this.view.lastDispatch.bytes === bytes) {
        this.view.lastDispatch.tokens = { input: estimate.input, state: estimate.state };
        this.suggestCompaction(model, estimate.input);
        this.changed();
      }
    }).catch(() => undefined);
  }

  /** Pending redirections become the next turn(s), in order, after the current one. */
  private async drainSteer(): Promise<void> {
    // A redirection taken at a tool boundary but not delivered (the turn ended first) is still pending.
    for (const item of this.view.steer) if (item.state === "submitted") item.state = "pending";
    const next = this.view.steer.find((s) => s.state === "pending");
    if (!next || this.busy || this.disposed) {
      this.view.steer = this.view.steer.filter((s) => s.state === "pending");
      return;
    }
    this.view.steer = this.view.steer.filter((s) => s.state === "pending");
    await this.runTurn(next.text, { steer: next });
    this.view.steer = this.view.steer.filter((s) => s !== next);
    this.changed();
  }

  // ─── proposals ─────────────────────────────────────────────────────────

  private async proposeFrom(answer: string, sourceMessageId: string | null): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    const proposal = await buildProposal(answer, (path) => this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path), sourceMessageId);
    
    // Epic 2.2: Shadow LSP Verification
    if (proposal && proposal.files.length > 0 && proposal.failures.length === 0) {
      const bySpec = new Map<string, { spec: import("./lsp.ts").ServerSpec; files: import("./change-proposal.ts").ProposedFile[] }>();
      for (const file of proposal.files) {
        const spec = serverForFile(file.path);
        if (spec) bySpec.set(spec.id, { spec, files: [...(bySpec.get(spec.id)?.files ?? []), file] });
      }

      for (const { spec, files } of bySpec.values()) {
        const client = await this.lspClientFor(spec, { auto: true, paths: files.map(f => f.path) });
        if (!client) continue;

        try {
          for (const file of files) {
            let baselineErrors = new Set<string>();
            if (file.before !== null) {
              const uriBefore = client.sync(file.path, file.before);
              const baseline = await client.waitDiagnostics(uriBefore, 4000);
              baselineErrors = new Set(baseline.filter((d) => (d.severity ?? 1) <= 2).map((d) => `${d.range.start.line}:${d.message}`));
            }

            const uriAfter = client.sync(file.path, file.after);
            const diagnostics = await client.waitDiagnostics(uriAfter, 4000);
            const newErrors = diagnostics.filter((d) => (d.severity ?? 1) <= 2 && !baselineErrors.has(`${d.range.start.line}:${d.message}`));
            const firstError = newErrors[0];

            if (firstError) {
              proposal.failures.push({
                path: file.path,
                line: (firstError.range?.start?.line ?? 0) + 1,
                reason: `LSP Shadow Verification falhou (${spec.id}) introduziu o(s) seguinte(s) erro(s):\n${formatDiagnostics(file.path, newErrors)}`
              });
              proposal.state = "failed";
            }
          }
        } catch (e) {
          // Ignore LSP timeouts in shadow mode so we don't completely block
        }
      }
    }

    this.presentProposal(proposal);
  }

  private presentProposal(proposal: ChangeProposal | null): void {
    if (!proposal) return;
    if (proposal.failures.length || proposal.rejectedBlocks.length) {
      this.view.correction = { kind: "edits", text: failureFeedback(proposal) };
      const details = [...proposal.failures.map((f) => `${f.path}: ${f.reason}`), ...proposal.rejectedBlocks.map((r) => `${r.path ?? "?"}: ${r.reason}`)];
      this.notice("warning", t(details.length === 1 ? "ctl_blocks_unapplicable_one" : "ctl_blocks_unapplicable", { count: details.length, details: details.slice(0, 3).join("; ") }), t("ctl_blocks_unapplicable_hint"));
    } else if (this.view.correction?.kind === "edits") this.view.correction = null;
    if (!proposal.files.length) return;
    this.view.proposal = proposal;
    this.upsertLive(this.proposalItem(proposal));
    this.emit("review", proposal);
  }

  proposalItem(proposal: ChangeProposal): TranscriptItem {
    const stateMap: Record<ChangeProposal["state"], "proposed" | "applying" | "applied" | "conflict" | "rejected" | "failed"> = {
      proposed: "proposed", applying: "applying", applied: "applied", conflict: "conflict", rejected: "rejected", failed: "failed", unknown: "failed",
    };
    return {
      kind: "change", id: `change-${proposal.id}`, title: t('altera_o_proposta'),
      files: proposal.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, ...(f.preflight?.issue ? { status: f.preflight.issue === "base_hash_mismatch" ? t("ctl_status_conflict") : f.preflight.issue } : !f.selected ? { status: t("ctl_status_unselected") } : {}) })),
      state: stateMap[proposal.state], receipt: proposal.receiptId ?? null,
      ...(proposal.message ? { hint: proposal.message } : proposal.state === "proposed" ? { hint: t('revise_no_painel_ctrl_r_enter_') } : {}),
    };
  }

  /** Re-renders the proposal item after the person changes the selection. */
  upsertProposal(): void {
    if (this.view.proposal) this.upsertLive(this.proposalItem(this.view.proposal));
  }

  splitProposalHunks(fileIndex: number): boolean {
    const proposal = this.view.proposal;
    if (!proposal || !["proposed", "conflict"].includes(proposal.state) || this.effectAbort || this.busy || this.view.busy) return false;
    const file = proposal.files[fileIndex];
    if (!file || !splitFileHunks(file)) return false;
    proposal.message = t("ctl_hunks_split", { path: file.path });
    this.upsertProposal();
    return true;
  }

  private proposalSourceForRefresh() {
    if (this.disposed || this.busy || this.view.busy || this.turnAbort || this.effectAbort || this.state.turn === "cancelling" || !this.view.binding || !this.state.activeConversation || this.view.proposal?.state === "applying") return null;
    const proposal = this.view.proposal;
    const source = proposal ? (proposal.sourceMessageId ? this.state.messages.find((m) => m.id === proposal.sourceMessageId) : null) : this.state.messages.at(-1);
    return source?.role === "assistant" && !source.interrupted && !source.streaming && source.content.trim() ? source : null;
  }

  get canRefreshProposal(): boolean { return this.proposalSourceForRefresh() !== null; }

  /** Reparse the current completed answer without another model call; reads/W5 stay canonical. */
  async refreshProposal(): Promise<boolean> {
    const source = this.proposalSourceForRefresh();
    if (!source) return false;
    const previous = this.view.proposal;
    const binding = this.view.binding!;
    const revision = this.store.conversationRevision;
    const proposal = await buildProposal(source.content, path => this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, path), source.id);
    if (this.store.conversationRevision !== revision || this.view.binding !== binding || this.view.proposal !== previous || this.proposalSourceForRefresh() !== source) return false;
    if (previous) this.live = this.live.filter((l) => l.item.id !== `change-${previous.id}`);
    this.view.proposal = null;
    this.presentProposal(proposal);
    return this.view.proposal !== null;
  }

  rejectProposal(): void {
    const proposal = this.view.proposal;
    if (!proposal || proposal.state === "applying") return;
    proposal.state = "rejected";
    proposal.message = t("appr_discarded");
    this.upsertLive(this.proposalItem(proposal));
    this.view.proposal = null;
    this.changed();
  }

  /**
   * Applies the selected files/hunks: intention in the conversation → exact
   * ChangeSet → preflight → write plan → W5 consent (native signature) →
   * journal observation → receipt. Never retries blindly.
   */
  async applyProposal(): Promise<void> {
    const proposal = this.view.proposal;
    const binding = this.view.binding;
    if (!proposal || !binding || proposal.state === "applying") return;
    if (!this.sign) { this.notice("error", t('aprova_o_indispon_vel_identida')); return; }
    if (this.store.state.storagePolicy === "temporary") {
      this.notice("warning", t('sess_o_tempor_ria_gravar_arqui'), t("ctl_persistent_hint"));
      return;
    }
    const abort = new AbortController();
    this.effectAbort = abort;
    proposal.state = "applying";
    proposal.message = operationText("preparing_write");
    this.view.busy = t("ctl_busy_applying");
    this.upsertLive(this.proposalItem(proposal));
    try {
      const conversationId = await this.ensureConversation();
      const manifest = await this.workspace.getManifest(binding.projectId, binding.rootBindingId, abort.signal);
      const { changeSet, paths } = changeSetFor(proposal, manifest.snapshotDigest);
      const preflight = await this.workspace.preflightChangeSet(binding.projectId, binding.rootBindingId, changeSet, abort.signal);
      for (const entry of preflight.entries) {
        const file = proposal.files.find((f) => f.path === entry.path);
        const issue = preflight.issues.find((i) => i.path === entry.path);
        if (file) file.preflight = { status: entry.status, ...(issue ? { issue: issue.code } : {}) };
      }
      if (preflight.issues.length) {
        proposal.state = "conflict";
        proposal.message = t("ctl_preflight_failed", { issues: preflight.issues.map((i) => `${i.path}: ${i.code}`).join("; ") });
        return;
      }
      if (!(await this.runHooks("pre-write", paths.join("\n")))) { proposal.state = "proposed"; proposal.message = t("ctl_hook_blocked_write"); return; }
      if (!proposal.intention) {
        proposal.intention = await this.conversations.appendIntention(conversationId, intentionText(proposal, paths), `tui_change_${proposal.id}`);
      }
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const planned = await this.workspace.createChangeSetPlan(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, changeSet, objective: t("apply_reviewed_change_prompt", { paths: paths.join(", ") }).slice(0, 500) }, abort.signal);
      const plan = planned.plan!;
      proposal.planId = plan.id;
      proposal.runRequestId ??= randomUUID();
      proposal.message = t("status_approval_pending");
      this.upsertLive(this.proposalItem(proposal));
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId: proposal.runRequestId }, this.sign, abort.signal, { conversationId, requestId: proposal.intention.requestId });
      const runId = admitted.run?.id;
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      proposal.runId = runId;
      proposal.message = t("ctl_writing");
      this.upsertLive(this.proposalItem(proposal));
      const settled = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId: proposal.runRequestId, runId }, { signal: abort.signal });
      const receipt = settled.receipts.find((r) => r.runId === runId && r.status === "succeeded" && r.capabilityId === "workspace.project.write");
      await this.conversations.linkRun(conversationId, { messageId: proposal.intention.messageId, requestId: proposal.intention.requestId, runId, projectId: binding.projectId, modelId: this.store.state.selectedModel || "auto", state: settled.run?.status ?? "unknown" }).catch(() => undefined);
      if (settled.run?.status === "succeeded" && receipt) {
        proposal.state = "applied";
        proposal.receiptId = receipt.id;
        proposal.message = operationText("written", { paths: paths.join(", ") });
        await this.conversations.appendRunResult(conversationId, proposal.intention.messageId, t("ctl_change_applied", { run: runId, receipt: receipt.id, paths: paths.join(", ") }), `tui_change_result_${proposal.id}`).catch(() => undefined);
        this.offerVerification();
        void this.lspDiagnostics(paths, { auto: true });
      } else if (settled.run?.status === "needs_attention") {
        proposal.state = "unknown";
        proposal.message = t("ctl_result_uncertain", { run: runId.slice(0, 8) });
        this.view.attention = { id: `attention-${runId}`, type: "tool_call", description: operationText("write_interrupted"), risk: "high", projectId: binding.projectId, planId: plan.id, planDigest: plan.digest, runId, requestId: proposal.runRequestId, conversationRevision: this.store.conversationRevision, toolKind: "project-write" };
      } else {
        proposal.state = "failed";
        proposal.message = t("ctl_write_unconfirmed", { status: settled.run?.status ?? t("run_status_unknown") });
      }
      await this.reloadMessages(conversationId);
    } catch (error) {
      const code = error instanceof WorkspaceServiceError ? error.code : errorCode(error);
      if (abort.signal.aborted) { proposal.state = proposal.runId ? "unknown" : "proposed"; proposal.message = proposal.runId ? t("ctl_observation_cancelled") : t("ctl_cancelled_before_write"); }
      else if (error instanceof WorkspaceServiceError && error.outcome === "unknown") { proposal.state = "unknown"; proposal.message = t("ctl_ack_lost", { code }); }
      else if (code === "change_selection_empty") { proposal.state = "proposed"; proposal.message = operationText("no_files_selected"); }
      else { proposal.state = proposal.runId ? "unknown" : "failed"; proposal.message = operationText("apply_failed", { reason: localizedDiagnostic(code), next: operationText(proposal.runId ? "recover_write" : "nothing_written") }); }
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.upsertLive(this.proposalItem(proposal));
      if (proposal.state === "applied") this.view.proposal = null;
      this.changed();
    }
  }

  // ─── verification ──────────────────────────────────────────────────────

  private offerVerification(): void {
    const choice = chooseVerification(this.manifestEntries, this.profiles);
    this.view.verifyOffer = choice;
    if (choice) this.notice("info", t("ctl_verify_suggest", { profile: choice.profileId, action: choice.actionId, reason: choice.reason }), t("ctl_verify_suggest_hint"));
    this.changed();
  }

  /**
   * After a turn whose edits were applied, the project's verification is prepared for /test. When the answer claims
    * success without passing tests on the current snapshot, the claim is flagged as unverified.
   */
  private async offerVerificationAfterEdits(answer: string, verifiedManifestDigest: string | null, revision: number): Promise<void> {
    const binding = this.view.binding;
    let choice: VerificationChoice | null = null;
    let currentManifestDigest: string | null = null;
    if (binding) {
      try {
        if (!this.profiles.length) this.profiles = await this.workspace.getRuntimeProfiles();
        // The edit may have created the files that identify the project kind: read the current manifest.
        const manifest = await this.workspace.getManifest(binding.projectId, binding.rootBindingId);
        currentManifestDigest = manifest.snapshotDigest;
        this.manifestEntries = manifest.entries;
        choice = chooseVerification(manifest.entries, this.profiles);
      } catch {
        choice = chooseVerification(this.manifestEntries, this.profiles);
      }
    }
    if (this.store.conversationRevision !== revision || this.view.binding !== binding) return;
    this.view.verifyOffer = choice;
    if ((!verifiedManifestDigest || verifiedManifestDigest !== currentManifestDigest) && claimsSuccess(answer)) {
      this.notice("warning", t("ctl_claim_unverified"), choice ? t("ctl_claim_unverified_hint", { profile: choice.profileId, action: choice.actionId }) : t("ctl_claim_unverified_no_profile"));
    }
    this.changed();
  }

  /** Runs the canonical verification (W5 plan, isolated runner, report artifact). */
  async verify(choice?: VerificationChoice): Promise<void> {
    const binding = this.view.binding;
    if (!binding) { this.notice("error", t('sem_pasta_vinculada_nada_para__1')); return; }
    if (!this.sign) { this.notice("error", t('verifica_o_indispon_vel_identi')); return; }
    if (this.store.state.storagePolicy === "temporary") { this.notice("warning", t('sess_o_tempor_ria_execu_es_no_')); return; }
    const abort = new AbortController();
    this.effectAbort = abort;
    this.view.verifyOffer = null;
    this.view.busy = operationText("verifying");
    const itemId = `run-${randomUUID()}`;
    const update = (state: "preparing" | "awaiting_approval" | "running" | "passed" | "failed" | "blocked" | "cancelled", title: string, detail?: string, receipt?: string | null) =>
      this.upsertLive({ kind: "run", id: itemId, title, state, ...(detail ? { detail } : {}), ...(receipt ? { receipt } : {}) });
    try {
      if (!this.profiles.length) this.profiles = await this.workspace.getRuntimeProfiles(abort.signal);
      const manifest = await this.workspace.getManifest(binding.projectId, binding.rootBindingId, abort.signal);
      this.manifestEntries = manifest.entries;
      const selected = choice ?? chooseVerification(manifest.entries, this.profiles);
      if (!selected) { update("blocked", t("ctl_verify_no_profile"), t("ctl_verify_no_profile_hint")); return; }
      const profile = this.profiles.find((p) => p.id === selected.profileId);
      if (!profile?.available) {
        update("blocked", t("ctl_verify_unavailable", { profile: selected.profileId }), `${profile?.diagnostic ?? "runtime_unavailable"}\n${t("runner_setup_hint")}`);
        return;
      }
      update("preparing", t("ctl_verify_title", { profile: selected.profileId, action: selected.actionId }));
      const conversationId = await this.ensureConversation();
      const intention = await this.conversations.appendIntention(conversationId, t("ctl_intent_verify", { profile: selected.profileId, action: selected.actionId }), `tui_verify_${itemId}`);
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const planned = await this.workspace.createRunPlan(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, request: buildRunRequest(selected, manifest.snapshotDigest) }, abort.signal);
      const plan = planned.plan!;
      const requestId = randomUUID();
      update("running", t("ctl_verify_title", { profile: selected.profileId, action: selected.actionId }));
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId }, this.sign, abort.signal, { conversationId, requestId: intention.requestId });
      const runId = admitted.run?.id;
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      const settled = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId, runId }, { signal: abort.signal, timeoutMs: 330_000 });
      await this.conversations.linkRun(conversationId, { messageId: intention.messageId, requestId: intention.requestId, runId, projectId: binding.projectId, modelId: this.store.state.selectedModel || "auto", state: settled.run?.status ?? "unknown" }).catch(() => undefined);
      const receipt = settled.receipts.find((r) => r.runId === runId && r.status === "succeeded");
      if (settled.run?.status !== "succeeded" || !settled.artifact) {
        update("failed", t("ctl_verify_not_done", { status: settled.run?.status ?? "?" }), undefined, receipt?.id ?? null);
        return;
      }
      const report = interpretReport(await this.workspace.readArtifact(binding.projectId, settled.artifact.id, abort.signal));
      update(report.state, report.summary, report.detail + (report.state === "blocked" ? `\n${RUNNER_SETUP_HINT}` : ""), receipt?.id ?? null);
      await this.conversations.appendRunResult(conversationId, intention.messageId, `${t(receipt ? "ctl_verify_result_receipt" : "ctl_verify_result", { profile: selected.profileId, action: selected.actionId, summary: report.summary, run: runId, receipt: receipt?.id ?? "" })}\n${report.failureText.slice(0, 4000)}`, `tui_verify_result_${itemId}`).catch(() => undefined);
      if (report.state === "failed") {
        this.view.correction = { kind: "verification", text: t("verification_failed_prompt", { profile: selected.profileId, action: selected.actionId, output: report.failureText }) };
        this.notice("info", t('ctrl_f_ou_corrigir_pede_a_corr'));
      }
      await this.reloadMessages(conversationId);
    } catch (error) {
      if (abort.signal.aborted) update("cancelled", t("ctl_verify_cancelled"));
      else update("failed", t("ctl_verify_failed", { reason: errorText(error) }));
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  // ─── delegated tasks (subagents under one core grant) ──────────────────

  /**
   * Prepares exact child plans (read-only subagents on the governed gateway
   * lane, optional verification of the current state), then ONE root task
   * plan approved via W5 with conversation admission. The core aggregates the
   * grant, starts children in order, reserves budgets on the same ledger and
   * records receipts; this client only observes and integrates.
   */
  async delegate(spec: DelegationSpec): Promise<void> {
    const binding = this.view.binding;
    if (!binding) { this.notice("error", t('sem_pasta_vinculada_nada_para_')); return; }
    if (!this.sign) { this.notice("error", t('delega_o_indispon_vel_identida')); return; }
    if (this.store.state.storagePolicy === "temporary") { this.notice("warning", t('sess_o_tempor_ria_tarefas_dele'), t("ctl_persistent_hint")); return; }
    if (this.effectAbort || this.busy) { this.notice("info", t('aguarde_a_opera_o_atual_termin')); return; }
    const abort = new AbortController();
    this.effectAbort = abort;
    this.view.busy = operationText("delegating");

    const hasExplicitModel = spec.subtasks.some(s => typeof s !== "string" && Boolean(s.model));
    if (hasExplicitModel) {
      try {
        const conversationId = await this.ensureConversation();
        const revalidate = this.captureContext(abort.signal);

        if (!this.view.connections) {
          const { loadConnections } = await import("./connections.ts");
          this.view.connections = await loadConnections(this.client);
        }
        const connections = this.view.connections;

        const members: Array<{ modelId: string; connectionId: string; task?: string }> = [];
        const labels: string[] = [];

        for (const subtaskItem of spec.subtasks) {
          const subtask = typeof subtaskItem === "string" ? { task: subtaskItem, model: null } : subtaskItem;
          const hasOverride = !!subtask.model;
          const requestedModel = subtask.model || this.store.state.selectedModel;
          if (!requestedModel) {
            this.notice("error", t('model_unspecified'));
            return;
          }

          let connectionId: string | undefined;
          let modelId = requestedModel;

          if (hasOverride && requestedModel.includes("@")) {
            const parts = requestedModel.split("@");
            modelId = parts[0]!;
            connectionId = parts.slice(1).join("@");
          }

          if (!connectionId) {
            if (!hasOverride || modelId === this.store.state.selectedModel) {
              connectionId = this.client.getSelectedDestination().providerId;
            }
            if (!connectionId) {
              const provider = connections?.providers.find(p => p.models.includes(modelId) && p.eligible);
              connectionId = provider?.id;
            }
          }

          if (!connectionId || !connections?.providers.find(p => p.id === connectionId && p.models.includes(modelId))) {
            this.notice("error", t("ctl_unknown_model", { model: `${modelId}${connectionId && hasOverride ? `@${connectionId}` : ""}` }));
            return;
          }

          members.push({ modelId: modelId, connectionId: connectionId, task: subtask.task });
          labels.push(subtask.task.replace(/\s+/g, " ").slice(0, 120));
        }

        const title = spec.objective.replace(/\s+/g, " ").slice(0, 200);
        const intention = await this.conversations.appendIntention(
          conversationId,
          t(labels.length === 1 ? "ctl_intent_delegate_one" : "ctl_intent_delegate", { title, count: labels.length, children: labels.join("; ") }),
          `tui_task_${randomUUID()}`
        );
        revalidate();

        const input = {
          objective: spec.objective,
          members,
          maxCostMicros: this.view.budget?.limitMicros ? String(this.view.budget.limitMicros) : "1000000"
        };

        const result = await this.features.actions.delegateModels(input, abort.signal);

        revalidate();

        if (result) {
          const outputs = result.outputs.map(o => `${result.plan.members.find(m => m.id === o.memberId)?.modelId ?? o.memberId}\n${o.text}`).join('\n\n');

          await this.conversations.appendRunResult(
            conversationId,
            intention.messageId,
            `${t("ctl_multimodel_done", { plan: result.plan.id, run: result.run.id })}\n\n${outputs}`.slice(0, 32_000),
            `tui_task_result_${result.plan.id}`
          ).catch((error) => {
            try { revalidate(); } catch { return; }
            this.notice("warning", t("ctl_task_result_not_recorded", { reason: errorText(error) }));
          });
          revalidate();

          this.view.integration = { taskId: result.plan.id, objective: spec.objective, prompt: outputs };
          this.notice("info", t('resultados_dos_subagentes_pron'));

          if (spec.verify) {
            await this.verify();
          }
        }
      } catch (error) {
        if ((error as Error).message === "context_changed") return;
        if ((error as Error).name === "AbortError" && abort.signal.aborted) {
          this.notice("info", t('cancelled_before_authorization'));
          return;
        }
        const code = error instanceof WorkspaceServiceError ? error.code : errorCode(error);
        this.notice("error", operationText("delegate_failed", { reason: localizedDiagnostic(code), next: "" }).trim());
      } finally {
        if (this.effectAbort === abort) this.effectAbort = null;
        this.view.busy = null;
        this.changed();
      }
      return;
    }

    // Canonical project task delegation (subagents via governed gateway)
    const itemId = `task-${randomUUID()}`;
    const labels: ChildLabel[] = [];
    const title = spec.objective.replace(/\s+/g, " ").slice(0, 200);
    const show = (state: Extract<TranscriptItem, { kind: "task" }>["state"], detail?: string) =>
      this.upsertLive({ kind: "task", id: itemId, title, state, children: labels.map((l) => ({ label: l.label, status: getChildStatusText("pending"), model: l.model })), ...(detail ? { detail } : {}) });
    let rootRunId: string | null = null;
    try {
      const gateway = await this.workspace.getGatewayInfo(abort.signal);
      if (!gateway.available || !gateway.model) {
        show("blocked", t("ctl_subagents_need_gateway"));
        return;
      }
      for (const subtaskItem of spec.subtasks) {
        const text = typeof subtaskItem === "string" ? subtaskItem : subtaskItem.task;
        labels.push({ label: text.replace(/\s+/g, " ").slice(0, 120), kind: "subagent", model: gateway.model });
      }
      const manifest = await this.workspace.getManifest(binding.projectId, binding.rootBindingId, abort.signal);
      this.manifestEntries = manifest.entries;
      let verification: VerificationChoice | null = null;
      if (spec.verify) {
        if (!this.profiles.length) this.profiles = await this.workspace.getRuntimeProfiles(abort.signal);
        verification = chooseVerification(manifest.entries, this.profiles);
        const profile = verification ? this.profiles.find((p) => p.id === verification!.profileId) : undefined;
        if (!verification || !profile?.available) {
          show("blocked", `${t("ctl_verify_requested_unavailable", { reason: verification ? profile?.diagnostic ?? "runtime_unavailable" : t("ctl_verify_no_profile") })}\n${t("runner_setup_hint")}`);
          return;
        }
        labels.push({ label: t("ctl_verify_label", { profile: verification.profileId, action: verification.actionId }), kind: "verification", model: null });
      }
      show("preparing", operationText("task_preparing"));
      const snapshot = await this.context.snapshotForDispatch(abort.signal);
      const { buildPlanChatRequest } = await import("./tool-plans.ts");
      const childPlanIds: string[] = [];
      for (const [index, subtaskItem] of spec.subtasks.entries()) {
        const subtask = typeof subtaskItem === "string" ? subtaskItem : subtaskItem.task;
        const view = await this.workspace.refresh(binding.projectId, abort.signal);
        const chat = buildPlanChatRequest({
          model: gateway.model,
          messages: subagentMessages({ objective: spec.objective, subtask, index, total: spec.subtasks.length, files: manifest.entries.map((e) => e.relativePath), contextBlock: snapshot.block }),
          tools: [], maxTokens: SUBAGENT_MAX_TOKENS,
        });
        childPlanIds.push((await this.workspace.createChatPlan(binding.projectId, { expectedRevision: view.revision, chat }, abort.signal)).plan!.id);
      }
      if (verification) {
        const view = await this.workspace.refresh(binding.projectId, abort.signal);
        childPlanIds.push((await this.workspace.createRunPlan(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, request: buildRunRequest(verification, manifest.snapshotDigest) }, abort.signal)).plan!.id);
      }
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const plan = (await this.workspace.prepareTask(binding.projectId, { expectedRevision: view.revision, rootBindingId: binding.rootBindingId, objective: spec.objective, childPlanIds }, abort.signal)).plan!;
      const conversationId = await this.ensureConversation();
      const intention = await this.conversations.appendIntention(conversationId,
        t(labels.length === 1 ? "ctl_intent_delegate_one" : "ctl_intent_delegate", { title, count: labels.length, children: labels.map((l) => l.label).join("; ") }), `tui_task_${plan.id}`);
      show("awaiting_approval", t("ctl_task_awaiting"));
      const requestId = randomUUID();
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId }, this.sign, abort.signal, { conversationId, requestId: intention.requestId });
      rootRunId = admitted.run?.id ?? null;
      if (!rootRunId) throw new WorkspaceServiceError("run_not_admitted");
      const root = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId, runId: rootRunId }, { signal: abort.signal });
      await this.conversations.linkRun(conversationId, { messageId: intention.messageId, requestId: intention.requestId, runId: rootRunId, projectId: binding.projectId, modelId: gateway.model, state: root.run?.status ?? "unknown" }).catch(() => undefined);
      if (root.run?.status !== "succeeded") { show("failed", t("ctl_task_root_failed", { status: root.run?.status ?? "?" })); return; }
      show("running", operationText("task_registered"));
      const task = await this.observeTask(binding.projectId, rootRunId, labels, itemId, title, abort.signal);
      if (!task) { show("failed", t("ctl_task_missing")); return; }
      await this.settleTask(conversationId, intention.messageId, task, labels, spec.objective, abort.signal);
      await this.reloadMessages(conversationId);
    } catch (error) {
      const code = error instanceof WorkspaceServiceError ? error.code : errorCode(error);
      if (abort.signal.aborted) show(rootRunId ? "running" : "cancelled", rootRunId ? t("ctl_task_observation_stopped") : t("ctl_cancelled_before_approval"));
      else show("failed", operationText("delegate_failed", { reason: localizedDiagnostic(code), next: operationText(rootRunId ? "task_continue" : "nothing_executed") }));
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  private taskItem(itemId: string, title: string, task: ProjectTaskView, labels: readonly ChildLabel[], detail?: string): TranscriptItem {
    return {
      kind: "task", id: itemId, title, state: task.status,
      children: task.children.map((c, i) => ({ label: labels[i]?.label ?? operationText("child_plan", { index: i + 1, plan: c.planId.slice(0, 8) }), status: getChildStatusText(c.status) ?? c.status, model: labels[i]?.model ?? null, receipt: c.receiptIds.at(-1) ?? null })),
      detail: detail ?? `${getTaskStatusText(task.status)}${task.blockedReason ? ` · ${localizedDiagnostic(task.blockedReason)}` : ""} · ${t("ctl_task_limits", { calls: task.limits.maxCalls, tokens: task.limits.maxOutputTokens })}`,
    };
  }

  /** Observes the core projection until a terminal state, or a "ready" task whose next child did not start. */
  private async observeTask(projectId: string, rootRunId: string, labels: ChildLabel[], itemId: string, title: string, signal: AbortSignal): Promise<ProjectTaskView | null> {
    const deadline = Date.now() + 20 * 60_000;
    let task: ProjectTaskView | null = null;
    let signature = "", stableSince = Date.now();
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      task = task ? await this.workspace.getTask(projectId, task.id, signal) : (await this.workspace.listTasks(projectId, signal)).find((t) => t.rootRunId === rootRunId) ?? null;
      if (task) {
        this.taskLabels.set(task.id, labels);
        this.upsertLive(this.taskItem(itemId, title, task, labels));
        this.changed();
        if (TASK_TERMINAL.has(task.status)) return task;
        const next = `${task.status}:${task.children.map((c) => c.status).join(",")}`;
        if (next !== signature) { signature = next; stableSince = Date.now(); }
        else if (task.status === "ready" && Date.now() - stableSince > 8_000) {
          this.upsertLive(this.taskItem(itemId, title, task, labels, t("ctl_task_next_child_waiting")));
          return task;
        }
      } else if (Date.now() - stableSince > 30_000) return null;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 300);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new WorkspaceServiceError("timeout", null, "unknown", t("ctl_task_observation_timeout"));
  }

  /** Reads child artifacts, records the result in the conversation and offers the single integration turn. */
  private async settleTask(conversationId: string, intentionMessageId: string, task: ProjectTaskView, labels: readonly ChildLabel[], objective: string, signal: AbortSignal): Promise<void> {
    const binding = this.view.binding!;
    const results: ChildResult[] = [];
    const revalidate = this.captureContext(signal);
    for (const [index, child] of task.children.entries()) {
      revalidate();
      const label = labels[index] ?? { label: `filho ${index + 1}`, kind: "subagent" as const, model: null };
      const artifactId = child.artifactIds.at(-1);
      let text = "";
      if (artifactId) {
        const raw = await this.workspace.readArtifact(binding.projectId, artifactId, signal).catch((e) => {
          if (e.name === "AbortError" || signal.aborted) throw e;
          return "";
        });
        revalidate();
        if (label.kind === "verification") { const report = interpretReport(raw); text = `${report.summary}\n${report.failureText}`.trim(); }
        else text = raw;
      }
      results.push({ label: label.label, kind: label.kind, status: getChildStatusText(child.status) ?? child.status, receiptId: child.receiptIds.at(-1) ?? null, text });
    }
    revalidate();
    const summary = results.map((r, i) => `${i + 1}. ${r.label} — ${r.status}${r.receiptId ? ` (recibo ${r.receiptId})` : ""}\n${r.text.slice(0, 3_000)}`).join("\n\n");
    await this.conversations.appendRunResult(conversationId, intentionMessageId, `${t("ctl_task_result", { status: getTaskStatusText(task.status), task: task.id, run: task.rootRunId ?? "?" })}\n\n${summary}`.slice(0, 32_000), `tui_task_result_${task.id}`)
      .catch((error) => {
        try { revalidate(); } catch { return; }
        this.notice("warning", t("ctl_task_result_not_recorded_core", { reason: errorText(error) }));
      });
    revalidate();
    if (results.some((r) => r.kind === "subagent" && r.text.trim())) {
      this.view.integration = { taskId: task.id, objective, prompt: integrationPrompt(objective, results) };
      this.notice("info", t('resultados_dos_subagentes_pron'));
    }
  }

  /** Single integration turn: the main conversation turns subagent results into one reviewable proposal. */
  async integrateDelegation(taskId?:string): Promise<void> {
    if(this.busy){this.notice("info",t('aguarde_a_opera_o_atual'));return;}
    if(taskId){
      const binding=this.view.binding;if(!binding)return;
      try{const recovered=await loadTaskIntegration(this.workspace,{projectId:binding.projectId,rootBindingId:binding.rootBindingId,taskId});
        if(this.view.binding?.projectId!==binding.projectId||this.view.binding.rootBindingId!==binding.rootBindingId)throw new Error("task_context_changed");
        this.view.integration=recovered;
      }catch(error){this.notice("error",t("ctl_integration_failed",{reason:errorText(error)}));return;}
    }
    const integration = this.view.integration;
    if (!integration) { this.notice("info", t('nenhum_resultado_de_subagentes')); return; }
    if (this.busy) { this.notice("info", t('aguarde_a_opera_o_atual')); return; }
    this.view.integration = null;
    if (this.view.mode === "plan") this.notice("info", t('modo_planejar_a_integra_o_vir_'));
    await this.runTurn(integration.prompt);
  }

  async refreshTasks(): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    const revalidate = this.captureContext();
    try {
      const tasks = await this.workspace.listTasks(binding.projectId);
      revalidate();
      this.view.tasks = tasks.map((task) => ({ task, labels: this.taskLabels.get(task.id) ?? [] }));
    } catch (error) {
      if ((error as Error).message === "context_changed") return;
      this.notice("warning", t("ctl_tasks_unavailable", { reason: errorText(error) }));
    }
    this.changed();
  }

  /** Durable cancellation in the core; running children are cancelled by the executor. */
  async cancelTask(taskId: string): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    try {
      const task = await this.workspace.cancelTask(binding.projectId, taskId);
      this.notice("info", t("ctl_task_cancel_status", { task: taskId.slice(0, 8), status: getTaskStatusText(task.status) }));
    } catch (error) { this.notice("error", t("ctl_cancel_unconfirmed", { reason: errorText(error) })); }
    await this.refreshTasks();
  }

  /** Resume: the core revalidates authority, root and budgets before starting the next child. */
  async resumeTask(taskId: string): Promise<void> {
    const binding = this.view.binding;
    if (!binding) return;
    try {
      const task = await this.workspace.resumeTask(binding.projectId, taskId);
      this.notice("info", t("ctl_task_status", { task: taskId.slice(0, 8), status: getTaskStatusText(task.status) }));
    } catch (error) { this.notice("error", operationText("resume_failed", { reason: errorText(error) })); }
    await this.refreshTasks();
  }

  /** Sends the last failure (edits or verification) as an explicit correction turn. */
  async requestCorrection(): Promise<void> {
    const correction = this.view.correction;
    if (!correction || this.busy) return;
    this.view.correction = null;
    await this.runTurn(correction.text);
  }

  // ─── modes and context ─────────────────────────────────────────────────

  setMode(mode: Mode): void { this.view.mode = mode; this.changed(); }
  toggleMode(): Mode { this.setMode(this.view.mode === "build" ? "plan" : "build"); return this.view.mode; }

  /** Approval of one tool effect: automatic under autonomy, otherwise the person decides in the review panel. */
  approve(title: string, body: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return this.view.autonomy ? Promise.resolve(true) : this.features.confirm(title, body, signal);
  }

  setAutonomy(enabled: boolean): void {
    this.view.autonomy = enabled;
    this.notice("info", t(enabled ? "autonomy_on" : "autonomy_off"), enabled ? t("autonomy_on_hint") : undefined);
    this.changed();
  }

  setToolsEnabled(enabled: boolean): void {
    this.view.toolsEnabled = enabled && this.view.toolsAvailable.length > 0;
    if (enabled && !this.view.toolsAvailable.length) this.notice("warning", t('nenhuma_ferramenta_de_arquivos'));
    this.changed();
  }

  async addContext(path: string): Promise<void> {
    if (!this.view.binding) { this.notice("error", t('sem_pasta_vinculada_n_o_h_arqu')); return; }
    const entry = await this.context.add(path);
    if (entry.state !== "ready") this.notice("warning", `${path}: ${localizedContextError(entry.error ?? "read_failed")}.`);
  }

  setModel(model: string): void { this.modelSelectionGeneration++; this.client.setSelectedProvider(); this.store.dispatch({ type: "model_selected", model }); }

  /** An explicit newer choice wins even when it chooses the same model again. */
  get modelSelectionRevision(): number { return this.modelSelectionGeneration; }

  private async rememberDestination(): Promise<void> {
    const destination = this.client.getSelectedDestination();
    const model = this.store.state.selectedModel;
    if (!destination.providerId || !model || this.store.state.storagePolicy === "temporary") return;
    // Only the persisted fields: the selected destination also carries connection/model identity that the
    // preference file does not store (spreading it made every save fail validation).
    await saveDestinationPreference(this.client.url, { providerId: destination.providerId, ...(destination.routingComboId ? { routingComboId: destination.routingComboId } : {}), model, processingPolicy: this.store.state.processingPolicy }).catch(() => {
      this.notice("warning", t("model_preference_save_failed"));
    });
  }

  /** Explicit model choice in the provider picker also fixes its destination. */
  async selectProviderModel(model: string, providerId: string, routingComboId?: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (this.disposed || !isCurrent()) throw Error("context_changed");
    const generation = ++this.modelSelectionGeneration;
    const validateContext = this.captureContext();
    let expectedModel = this.state.selectedModel;
    let expectedDestination = this.client.getSelectedDestination();
    let expectedPolicy = this.state.processingPolicy;
    const check = (policy = true) => {
      validateContext();
      if (this.disposed || !isCurrent() || generation !== this.modelSelectionGeneration
        || this.state.selectedModel !== expectedModel || this.client.getSelectedDestination() !== expectedDestination
        || policy && this.state.processingPolicy !== expectedPolicy) throw Error("context_changed");
    };
    check();
    if (providerId === HOSTED_PROVIDER) {
      const available = this.account.view.available;
      const hosted = this.hostedModels.find(item => item.modelId === model && item.accountRef === available?.currentAccountRef && item.revision === available?.revision);
      if (!this.account.view.session?.authenticated || !hosted) throw Error("selected_model_unavailable");
      if (this.state.processingPolicy === "local_only") {
        await this.setProcessingPolicy("external_allowed", check);
        check(false);
        if ((this.state.processingPolicy as string) !== "external_allowed") throw Error("conversation_policy_update_failed");
        expectedPolicy = "external_allowed";
      }
      // Revalidate after the policy write, which may overlap logout or account adoption.
      if (!this.account.view.session?.authenticated || this.account.view.available?.currentAccountRef !== hosted.accountRef || this.account.view.available?.revision !== hosted.revision) throw Error("account_share_conflict");
      check();
      this.client.setHostedDestination(hosted);
      this.store.dispatch({ type: "model_selected", model });
      expectedModel = model; expectedDestination = this.client.getSelectedDestination();
      await this.rememberDestination();
      check();
      return;
    }
    const provider = this.view.connections?.providers.find(p => p.id === providerId);
    if (!provider?.eligible || !provider.models.includes(model)) throw new Error("selected_model_unavailable");
    if (provider?.kind !== "local" && this.store.state.processingPolicy === "local_only") {
      await this.setProcessingPolicy("external_allowed", check);
      check(false);
      if ((this.store.state.processingPolicy as string) !== "external_allowed") throw new Error("conversation_policy_update_failed");
      expectedPolicy = "external_allowed";
    }
    check();
    this.client.setSelectedProvider(providerId, routingComboId);
    // Publish the model only after its destination is installed. Store listeners
    // must never observe a new model paired with the previous/empty provider.
    this.store.dispatch({ type: "model_selected", model });
    expectedModel = model; expectedDestination = this.client.getSelectedDestination();
    await this.rememberDestination();
    check();
  }

  async checkHostedReceipt(requested = ""): Promise<void> {
    const requestId = requested.trim() || [...this.state.messages].reverse().find(message => message.hostedRequestId)?.hostedRequestId;
    const account = this.account.view.available;
    if (!requestId || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId) || !account?.currentAccountRef || !this.account.view.session?.authenticated) {
      this.notice("info", accountErrorText("account_share_conflict")); return;
    }
    try {
      const receipt = await this.client.getHostedReceipt(account.currentAccountRef, account.revision, requestId, this.lifecycleAbort.signal);
      if (this.account.view.available?.currentAccountRef !== account.currentAccountRef || this.account.view.available?.revision !== account.revision || !this.account.view.session?.authenticated) return;
      this.notice("info", receipt.state === "settled" ? hostedText("settled", { amount: new Intl.NumberFormat(getLang(), { style: "currency", currency: "USD" }).format((receipt.chargedMicros ?? 0) / 1_000_000) }) : hostedText("pending"));
    } catch { this.notice("warning", hostedText("unknown")); }
  }

  /**
   * Explicit choice of where this conversation may be processed. Recorded in
   * the canonical conversation (CAS); new conversations inherit it.
   */
  async setProcessingPolicy(policy: "local_only" | "external_allowed", assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    if(policy==='local_only'){this.turnAbort?.abort();this.features.cancel();}
    const active = this.store.state.activeConversation;
    if(!active||policy==='local_only')this.store.dispatch({ type: "processing_policy_changed", processingPolicy: policy });
    if (!active) { await this.rememberDestination(); this.notice("info", policy === "external_allowed" ? t("ctl_new_external") : t("ctl_new_local")); return; }
    try {
      const conversation = await this.conversations.getConversation(active.id);
      // A provider picker may have closed while its CAS revision was loading.
      // Revalidate before admitting a policy write; committed writes stay intact.
      assertCurrent?.();
      const response=await this.client.fetchAuth(`/v1/workspace/conversations/${encodeURIComponent(active.id)}/update`, { method: "POST", body: JSON.stringify({ expectedRevision: conversation.revision, policy:{processingPolicy: policy} }) });
      if(!response.ok)throw new Error(`conversation_policy_${response.status}`);
      if(this.store.state.activeConversation?.id!==active.id)return;
      this.store.dispatch({ type: "processing_policy_changed", processingPolicy: policy });
      this.store.state.activeConversation = { ...active, processingPolicy: policy };
      await this.rememberDestination();
      this.notice("info", policy === "external_allowed" ? t("ctl_this_external") : t("ctl_this_local"));
    } catch (error) {
      if (errorCode(error) === "context_changed") throw error;
      this.notice("error", t("ctl_processing_failed", { reason: errorText(error) }));
    }
    this.changed();
  }

  // ─── compaction, fork, branches ────────────────────────────────────────

  /**
   * Summarizes older messages through the model and stores the summary in the
   * conversation. The next dispatch sends the summary instead of those messages
   * (see composeHistory); the originals remain in the store.
   */
  async compact(keepRecent = 6): Promise<void> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId || this.busy) { this.notice("info", t('nada_para_compactar_agora')); return; }
    const abort = new AbortController();
    this.turnAbort = abort;
    const validateContext = this.captureContext(abort.signal);
    const model = this.state.selectedModel || "auto";
    const selectedDestination = this.client.getSelectedDestination();
    const processingPolicy = this.state.processingPolicy;
    const selectionRevision = this.modelSelectionGeneration;
    const check = () => {
      validateContext();
      if (this.disposed || this.state.processingPolicy !== processingPolicy || (this.state.selectedModel || "auto") !== model
        || this.client.getSelectedDestination() !== selectedDestination || this.modelSelectionGeneration !== selectionRevision) throw Error("context_changed");
    };
    this.view.busy = operationText("compacting");
    this.changed();
    try {
      const { thread } = await this.conversations.thread(conversationId);
      check();
      const history = composeHistory(thread, { toolMode: "text" });
      // Boundary: keep the last `keepRecent` messages verbatim and never split a tool pair.
      let boundaryIndex = thread.length - 1 - keepRecent;
      while (boundaryIndex > 0 && pairOpenAt(thread, boundaryIndex)) boundaryIndex--;
      if (boundaryIndex < 1) { this.notice("info", t('conversa_curta_demais_para_com')); return; }
      const covered = thread.slice(0, boundaryIndex + 1);
      const coveredHistory = composeHistory(covered, { toolMode: "text" }).messages;
      const prompt = [
        t("compaction_prompt_header"),
        t("compaction_prompt_instructions"),
        "",
        coveredHistory.map((m) => `### ${m.role}\n${m.content}`).join("\n\n"),
      ].join("\n");
      let summary = "";
      let destination = selectedDestination;
      if (destination.hosted) {
        destination = Object.freeze({ ...destination, hostedRequestId: `hosted-${randomUUID()}` });
        await this.conversations.appendAtTip(conversationId, "assistant", [{ type: "status", text: `hosted:v1 ${JSON.stringify({ requestId: destination.hostedRequestId, destination: destination.hosted, state: "pending" })}` }], destination.hostedRequestId!, undefined, check);
        check();
      }
      check();
      for await (const event of this.client.chatStream(model, [{ role: "user", content: prompt }], conversationId, processingPolicy, abort.signal, destination)) {
        check();
        if (event.type === "hosted_receipt") await this.conversations.appendAtTip(conversationId, "assistant", [{ type: "status", text: `hosted:v1 ${JSON.stringify({ ...JSON.parse(event.data), destination: destination.hosted })}` }], `${destination.hostedRequestId}:result`, undefined, check).catch(() => undefined);
        check();
        if (event.type === "text") summary += event.data;
        if (event.type === "done") break;
      }
      check();
      summary = sanitizeForDisplay(summary).trim();
      if (!summary) { this.notice("warning", t('o_modelo_n_o_produziu_resumo_n')); return; }
      const through = covered.at(-1)!;
      check();
      await this.conversations.appendCompaction(conversationId, { throughMessageId: through.id, covered: covered.length, summary, model }, check);
      check();
      void history;
      await this.reloadMessages(conversationId);
      check();
      this.notice("info", t("ctl_compacted", { count: covered.length }));
    } catch (error) {
      if (!abort.signal.aborted && errorCode(error) !== "context_changed") this.notice("error", operationText("compact_failed", { reason: errorText(error) }));
    } finally {
      if (this.turnAbort === abort) { this.turnAbort = null; this.view.busy = null; }
      this.changed();
    }
  }

  /** Durable fork from a message (default: the last one). */
  async fork(fromMessageId?: string): Promise<void> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId) { this.notice("info", t('nenhuma_conversa_ativa_para_ra')); return; }
    try {
      const { branchId } = await this.conversations.fork(conversationId, fromMessageId);
      await this.reloadMessages(conversationId);
      this.live = [];
      this.notice("info", operationText("branch_created", { id: branchId.slice(-8) }));
    } catch (error) {
      this.notice("error", t("ctl_fork_failed", { reason: errorText(error) }));
    }
  }

  async switchBranch(branchId: string): Promise<void> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId) return;
    try { await this.conversations.switchBranch(conversationId, branchId); this.live = []; await this.reloadMessages(conversationId); }
    catch (error) { this.notice("error", t("ctl_branch_failed", { reason: errorText(error) })); }
  }

  async closePendingToolCalls(): Promise<void> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId) return;
    try {
      const closed = await this.conversations.closePendingToolCalls(conversationId);
      this.notice("info", closed ? t(closed === 1 ? "ctl_calls_closed_one" : "ctl_calls_closed", { count: closed }) : t("ctl_no_pending_calls"));
      await this.reloadMessages(conversationId);
    } catch (error) { this.notice("error", operationText("record_failed", { reason: errorText(error) })); }
  }

  async deleteConversation(id: string): Promise<void> {
    await this.conversations.delete(id);
    if (this.store.state.activeConversation?.id === id) this.newConversation();
    await this.refreshConversationList();
  }

  // ─── tool-enabled turns (gateway chat plans; each inference needs W5) ──

  private async runToolTurn(text: string): Promise<void> {
    const binding = this.view.binding!;
    const abort = new AbortController();
    this.turnAbort = abort;
    this.store.dispatch({ type: "turn_changed", turn: "submitting" });
    try {
      const conversationId = await this.ensureConversation();
      const { buildPlanChatRequest, filesystemToolsFromCatalog, TUI_TURN_MAX_TOKENS } = await import("./tool-plans.ts");
      const catalog = await this.workspace.getFilesystemCatalog(abort.signal);
      const tools = filesystemToolsFromCatalog(catalog);
      const { thread } = await this.conversations.thread(conversationId);
      const history = composeHistory(thread, { toolMode: "text" }).messages
        .filter((m) => m.role !== "tool")
        .map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));
      const snapshot = await this.context.snapshotForDispatch(abort.signal);
      const user = snapshot.block ? `${text}\n\n${snapshot.block}` : text;
      const system = this.systemMessages().map((m) => {
        if (typeof m.content !== "string") throw new ConversationServiceError("conversation_attachment_resolution_required");
        return { role: "system" as const, content: m.content };
      });
      const chat = buildPlanChatRequest({ model: this.store.state.selectedModel || "auto", messages: [...system, ...history.slice(-100), { role: "user", content: user }], tools, maxTokens: TUI_TURN_MAX_TOKENS });
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const planned = await this.workspace.createChatPlan(binding.projectId, { expectedRevision: view.revision, chat }, abort.signal);
      const plan = planned.plan!;
      // The person's request is the intention that admits the inference run.
      const intention = await this.conversations.appendIntention(conversationId, text, `tui_plan_${plan.id}`);
      this.view.approvals = [...this.view.approvals, {
        id: `plan:${plan.id}`, type: "tool_call", toolKind: "chat-plan", admission: { conversationId, requestId: intention.requestId }, intentionMessageId: intention.messageId,
        description: t(tools.length === 1 ? "ctl_tools_inference_one" : "ctl_tools_inference", { count: tools.length, model: chat.model }),
        detail: t('plano_dur_vel_preparado_aprova'),
        tool: "chat-plan", args: JSON.stringify({ tools: tools.map((t) => t.function.name) }),
        planId: plan.id, planDigest: plan.digest, requestId: randomUUID(), projectId: binding.projectId,
        conversationRevision: this.store.conversationRevision, userText: text, risk: "low",
      }];
      await this.reloadMessages(conversationId);
      this.store.dispatch({ type: "turn_changed", turn: "waiting_approval" });
    } catch (error) {
      this.store.dispatch({ type: "turn_changed", turn: "idle" });
      this.notice("warning", t("ctl_tools_plan_unavailable", { reason: error instanceof WorkspaceServiceError ? error.code : errorText(error) }));
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      this.changed();
    }
  }

  /** Signer for approval actions bound to the native identity (null when unavailable). */
  get signer(): ((nonce: string) => string) | null { return this.sign; }

  setApprovals(next: BoundApprovalRequest[]): void { this.view.approvals = next; this.changed(); }

  private observed = new Set<string>();

  /** Bounded observation of an admitted plan run, streaming the gateway preview. */
  async observeRun(request: BoundRunRequest): Promise<void> {
    if (this.observed.has(request.runId)) return;
    this.observed.add(request.runId);
    let seen = "";
    this.store.dispatch({ type: "turn_changed", turn: "streaming" });
    try {
      const view = await this.workspace.waitForSettledRun(request.projectId, { planId: request.planId, ...(request.requestId ? { requestId: request.requestId } : {}), runId: request.runId }, {
        onPoll: (polled) => {
          const text = polled.gatewayPreview?.text ?? "";
          if (text.length > seen.length && text.startsWith(seen)) { this.store.dispatch({ type: "stream_delta", text: text.slice(seen.length) }); seen = text; }
        },
      });
      this.store.state.streamBuffer = "";
      await this.settlePlanRun(view, request);
    } catch (error) {
      this.store.dispatch({ type: "stream_interrupted", messageId: `partial-${randomUUID()}`, phase: "failed" });
      this.notice("error", t("ctl_run_error", { run: request.runId.slice(0, 8), reason: errorText(error) }));
    } finally {
      this.observed.delete(request.runId);
      if (this.store.state.turn === "streaming") this.store.dispatch({ type: "turn_changed", turn: this.view.approvals.length ? "waiting_approval" : "idle" });
    }
  }

  // ─── versions (canonical restore) ──────────────────────────────────────

  async listVersions(relativePath: string): Promise<Array<{ operationId: string; createdAt: string }>> {
    const binding = this.view.binding;
    if (!binding) return [];
    try { return (await this.workspace.listFileVersions(binding.projectId, binding.rootBindingId, relativePath)).versions; }
    catch (error) { this.notice("error", t("ctl_versions_unavailable", { reason: errorText(error) })); return []; }
  }

  /**
   * Restores a file to the preimage recorded by a previous write, as a new
   * reviewed plan over the current content, approved via W5.
   */
  async restoreVersion(relativePath: string, operationId: string): Promise<void> {
    const binding = this.view.binding;
    if (!binding || !this.sign) { this.notice("error", t('restaura_o_indispon_vel_pasta_')); return; }
    const abort = new AbortController();
    this.effectAbort = abort;
    this.view.busy = operationText("restoring");
    const itemId = `restore-${randomUUID()}`;
    try {
      const current = await this.workspace.readProjectFile(binding.projectId, binding.rootBindingId, relativePath, abort.signal);
      if (!current) { this.notice("error", t("ctl_restore_missing", { path: relativePath })); return; }
      const view = await this.workspace.refresh(binding.projectId, abort.signal);
      const prepared = await this.workspace.prepareFileRestore(binding.projectId, binding.rootBindingId, { relativePath, operationId, expectedSha256: current.sha256, expectedRevision: view.revision });
      const plan = prepared.view.plan!;
      const conversationId = await this.ensureConversation();
      const intention = await this.conversations.appendIntention(conversationId, t("ctl_intent_restore", { path: relativePath, operation: operationId }), `tui_restore_${operationId}_${current.sha256.slice(0, 12)}`);
      const requestId = randomUUID();
      this.upsertLive({ kind: "change", id: itemId, title: t("ctl_restore_title", { path: relativePath }), files: [{ path: relativePath, added: 0, removed: 0 }], state: "applying" });
      const admitted = await this.workspace.approveAndStart(binding.projectId, { planId: plan.id, planDigest: plan.digest, requestId }, this.sign, abort.signal, { conversationId, requestId: intention.requestId });
      const runId = admitted.run?.id;
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      const settled = await this.workspace.waitForSettledRun(binding.projectId, { planId: plan.id, requestId, runId }, { signal: abort.signal });
      const receipt = settled.receipts.find((r) => r.runId === runId && r.status === "succeeded" && r.capabilityId === "workspace.project.write");
      await this.conversations.linkRun(conversationId, { messageId: intention.messageId, requestId: intention.requestId, runId, projectId: binding.projectId, modelId: "restore", state: settled.run?.status ?? "unknown" }).catch(() => undefined);
      this.upsertLive({ kind: "change", id: itemId, title: t("ctl_restore_title", { path: relativePath }), files: [{ path: relativePath, added: 0, removed: 0 }], state: receipt ? "applied" : "failed", receipt: receipt?.id ?? null, ...(receipt ? {} : { hint: t("ctl_restore_unconfirmed", { status: settled.run?.status ?? "?" }) }) });
      await this.reloadMessages(conversationId);
    } catch (error) {
      this.upsertLive({ kind: "change", id: itemId, title: t("ctl_restore_title", { path: relativePath }), files: [{ path: relativePath, added: 0, removed: 0 }], state: "failed", hint: operationText("restore_failed", { reason: errorText(error) }) });
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  // ─── turn undo/redo (canonical reversal) ────────────────────────────────

  /** Reconcile the exact durable command; an unavailable journal never becomes a new write or a branch rollback. */
  private async settleTurnRestore(conversationId: string, record: TurnRestoreRecord, abort: AbortController, reviewed = false, observeOnly = false): Promise<WorkspaceView> {
    const binding = this.view.binding;
    const revision = this.store.conversationRevision;
    const check = () => {
      if (this.disposed || this.store.state.activeConversation?.id !== conversationId || this.store.conversationRevision !== revision
        || !binding || this.view.binding !== binding || binding.projectId !== record.projectId || binding.rootBindingId !== record.rootBindingId
        || this.store.state.storagePolicy === "temporary") throw new Error("context_changed");
    };
    const observe = async () => {
      // This read also reconciles an aborted/lost response. Do not reuse the cancelled write signal.
      const view = await this.workspace.refreshPlan(record.projectId, record.planId);
      check();
      if (view.plan?.digest !== record.planDigest || view.run && (view.run.planId !== record.planId || view.run.requestId !== record.runRequestId)) throw new Error("run_identity_changed");
      return view;
    };
    let view = await observe();
    if (!view.run) {
      if (observeOnly) throw new Error("turn_restore_recovery_pending");
      abort.signal.throwIfAborted();
      if (!this.sign) throw new Error("consent_signature_invalid");
      // After a restart, preparation without an admitted run gets a fresh review of the same sealed plan.
      if (!reviewed && !await this.features.confirm(t(record.kind === "undo" ? "undo_turn_title" : "redo_turn_title"),
        [t(record.kind === "undo" ? "undo_turn_body" : "redo_turn_body"), ...record.paths, record.planId, record.planDigest].join("\n"), abort.signal)) throw new Error("user_declined");
    }
    const intention = await this.conversations.recoverTurnRestoreIntention(conversationId, record, check);
    let runId = view.run?.id;
    const cancel = () => { if (runId) void this.workspace.cancelRun(record.projectId, runId).catch(() => undefined); };
    abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!view.run) {
        try {
          view = await this.workspace.approveAndStart(record.projectId, { planId: record.planId, planDigest: record.planDigest, requestId: record.runRequestId }, this.sign!, abort.signal,
            { conversationId, requestId: intention.requestId }, async () => {
              check();
              const current = await this.conversations.getConversation(conversationId);
              if (current.activeBranchId !== (record.kind === "undo" ? record.originalBranchId : record.rewindBranchId)) throw new Error("context_changed");
              check();
            });
        } catch (error) {
          // Approval/complete may already have committed. Only its exact journal identity decides what happened.
          view = await observe();
          if (!view.run) throw error;
        }
        runId = view.run?.id;
      }
      if (!runId) throw new WorkspaceServiceError("run_not_admitted");
      check();
      const link = { ...intention, runId, projectId: record.projectId, modelId: `turn-${record.kind}`, state: "unknown" };
      try { await this.conversations.linkRun(conversationId, link); }
      catch (error) {
        // A lost link ACK is success only if the canonical reader confirms that exact association.
        const linked = (await this.conversations.runs(conversationId)).find(item => item.messageId === intention.messageId && item.runId === runId && item.projectId === record.projectId && item.requestId === intention.requestId);
        if (!linked) throw error;
      }
      if (!isSettledStatus(view.run!.status)) {
        if (abort.signal.aborted) { cancel(); view = await observe(); }
        else {
          try { view = await this.workspace.waitForSettledRun(record.projectId, { planId: record.planId, requestId: record.runRequestId, runId }, { signal: abort.signal }); }
          catch { view = await observe(); }
        }
      }
      check();
      if (view.run?.id !== runId || view.run.requestId !== record.runRequestId) throw new Error("run_identity_changed");
      return view;
    } finally { abort.signal.removeEventListener("abort", cancel); }
  }

  /** The branch changes only after confirmed file writes and a recoverable link. A lost branch ACK is read back. */
  private async finishTurnRestore(conversationId: string, record: TurnRestoreRecord): Promise<void> {
    const binding = this.view.binding;
    const check = () => {
      if (this.disposed || this.store.state.activeConversation?.id !== conversationId || this.view.binding !== binding
        || binding?.projectId !== record.projectId || binding.rootBindingId !== record.rootBindingId) throw new Error("context_changed");
    };
    check();
    const target = record.kind === "undo" ? record.rewindBranchId : record.originalBranchId;
    const { conversation: current, thread } = await this.conversations.thread(conversationId);
    check();
    if (![record.originalBranchId, record.rewindBranchId].includes(current.activeBranchId)) throw new Error("context_changed");
    if (current.activeBranchId !== target) {
      const intention = thread.findIndex(message => message.id === record.messageId);
      if (intention < 0 || thread.slice(intention + 1).some(message => !message.clientMessageId.startsWith("tui_turn_"))) throw new Error("conversation_conflict");
      try { await this.conversations.switchBranch(conversationId, target, { revision: current.revision, activeBranchId: current.activeBranchId }); }
      catch (error) { if ((await this.conversations.getConversation(conversationId)).activeBranchId !== target) throw error; }
    }
    check();
    await this.conversations.completeTurnRestore(conversationId, record, check);
  }

  /**
   * Undoes one conversation turn: every recorded project write of the turn is
   * reversed by one reviewed W5 plan, then the conversation continues from the
   * message before the turn on a new branch (the original branch is kept).
   * Returns the turn's prompt text so the caller can restore it, or null when
   * nothing was undone. Commands or other external effects are never claimed
   * as reversed.
   */
  async undoTurn(messageId: string): Promise<{ prompt: string } | null> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId) { this.notice("info", t("nenhuma_conversa_ativa_para_ra")); return null; }
    const binding = this.view.binding;
    if (this.busy || this.effectAbort || this.view.busy) { this.notice("warning", t("undo_turn_busy")); return null; }
    const abort = new AbortController();
    this.effectAbort = abort;
    const itemId = `undo-${randomUUID()}`;
    this.view.busy = operationText("restoring");
    this.changed();
    try {
      const recovery = await this.conversations.turnRestoreRecords(conversationId);
      const current = await this.conversations.getConversation(conversationId);
      const pending = [...recovery.operations].reverse().find(record => record.kind === "undo" && record.turnMessageId === messageId
        && [record.originalBranchId, record.rewindBranchId].includes(current.activeBranchId) && !recovery.completed.has(record.clientMessageId));
      let retired: TurnRestoreRecord | null = null;
      if (pending) {
        const settled = await this.settleTurnRestore(conversationId, pending, abort);
        const receipt = settled.receipts.find(item => item.runId === settled.run?.id && item.status === "succeeded" && item.capabilityId === "workspace.project.write");
        if (settled.run?.status === "succeeded" && receipt) {
          await this.finishTurnRestore(conversationId, pending);
          await this.reloadMessages(conversationId);
          this.notice("info", t("undo_turn_done_files", { count: pending.paths.length }), t("undo_turn_redo_hint"));
          return { prompt: await this.conversations.turnRestorePrompt(conversationId, pending.turnMessageId) };
        }
        if (!settled.run || !isSettledStatus(settled.run.status) || settled.run.status === "succeeded") throw new Error("turn_restore_recovery_pending");
        if (settled.run.status === "needs_attention") {
          // The old sealed write must no longer be resumable before a replacement can be prepared.
          await this.workspace.cancelRun(pending.projectId, settled.run.id);
          const closed = await this.workspace.refreshPlan(pending.projectId, pending.planId);
          if (closed.run?.id !== settled.run.id || closed.run.requestId !== pending.runRequestId || closed.run.status !== "cancelled") throw new Error("turn_restore_recovery_pending");
        }
        retired = pending;
      }
      const plan = await this.conversations.rewindBranchId(conversationId, messageId);
      const first = plan.turn[0];
      if (!first || first.role !== "user" || first.clientMessageId.startsWith("tui_")) { this.notice("warning", t("undo_turn_not_user")); return null; }
      const prompt = first.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
      // Previous inverse runs are bookkeeping, not new forward effects of the original turn.
      const turnIds = new Set(plan.turn.filter(message => !message.clientMessageId.startsWith("tui_turn_")).map((m) => m.id));
      let linked = binding ? (await this.conversations.runs(conversationId)).filter((run) => turnIds.has(run.messageId) && run.projectId === binding.projectId) : [];
      for (const message of plan.turn) {
        if (message.role !== "user" || !message.clientMessageId.startsWith("tui_") || message.clientMessageId.startsWith("tui_turn_") || message.clientMessageId.startsWith("tui_steer_") || linked.some(run => run.messageId === message.id)) continue;
        // Missing forward links are not proof of no writes. Reconnect only a native intention whose plan identity
        // was persisted before admission; the core verifies its exact outbox -> plan -> run association.
        if (!binding || !message.clientMessageId.startsWith("tui_native_")) throw new Error("turn_restore_recovery_pending");
        const planId = message.clientMessageId.slice("tui_native_".length);
        const observed = await this.workspace.refreshPlan(binding.projectId, planId, abort.signal);
        if (!observed.run || observed.run.planId !== planId) throw new Error("turn_restore_recovery_pending");
        const intention = await this.conversations.recoverNativeIntention(conversationId, message, this.captureContext());
        const link = { ...intention, runId: observed.run.id, projectId: binding.projectId, modelId: "turn-recovery", state: "unknown" };
        try { await this.conversations.linkRun(conversationId, link); }
        catch (error) {
          const confirmed = (await this.conversations.runs(conversationId)).some(run => run.messageId === intention.messageId && run.runId === observed.run!.id && run.requestId === intention.requestId && run.projectId === binding.projectId);
          if (!confirmed) throw error;
        }
        if (!isSettledStatus(observed.run.status)) await this.workspace.waitForSettledRun(binding.projectId, { planId, runId: observed.run.id, requestId: observed.run.requestId }, { signal: abort.signal });
        linked = (await this.conversations.runs(conversationId)).filter(run => turnIds.has(run.messageId) && run.projectId === binding.projectId);
      }
      const order = new Map(plan.turn.map((m, index) => [m.id, index]));
      const runIds = [...new Set(linked.sort((a, b) => (order.get(a.messageId) ?? 0) - (order.get(b.messageId) ?? 0)).map((run) => run.runId))];
      let reversed: string[] = [];
      let otherEffects: Array<{ capabilityId: string }> = [];
      if (runIds.length && binding) {
        if (!this.sign) { this.notice("error", t("restaura_o_indispon_vel_pasta_")); return null; }
        this.view.busy = operationText("restoring");
        this.changed();
        const view = await this.workspace.refresh(binding.projectId, abort.signal);
        const prepared = await this.workspace.prepareTurnRestore(binding.projectId, binding.rootBindingId, { runIds, expectedRevision: view.revision }, abort.signal);
        otherEffects = prepared.otherEffects;
        if (prepared.kind === "refused") {
          if (prepared.code === "turn_restore_conflict") { this.notice("error", t("undo_turn_conflict", { paths: prepared.conflicts.join(", ") })); return null; }
          if (prepared.code !== "turn_restore_nothing_to_restore") { this.notice("error", t("undo_turn_failed", { reason: prepared.code })); return null; }
        } else {
          // The new canonical preparation checked every expected hash; only now may a settled failed inverse be retired.
          if (retired) await this.conversations.retireTurnRestore(conversationId, retired, this.captureContext());
          const files = prepared.files.map((file) => ({ path: file.path, ...diffStats(diffLines(splitLines(file.before ?? ""), splitLines(file.after ?? ""))), status: file.action }));
          const effects = [...new Set(otherEffects.map((e) => e.capabilityId))];
          const body = [t("undo_turn_body"), "", ...prepared.files.map((file) => `${t(`undo_turn_action_${file.action}`)} ${file.path}`), ...(effects.length ? ["", t("undo_turn_other_effects", { effects: effects.join(", ") })] : [])].join("\n");
          if (!await this.features.confirm(t("undo_turn_title"), body, abort.signal)) { this.notice("info", t("undo_turn_declined")); return null; }
          const requestId = randomUUID();
          const planned = prepared.view.plan!;
          const intention = await this.conversations.appendTurnRestoreIntention(conversationId, t("undo_turn_intention", { paths: prepared.files.map((f) => f.path).join(", ") }), `${TURN_UNDO_PREFIX}${plan.branchId}`,
            { kind: "undo", projectId: binding.projectId, rootBindingId: binding.rootBindingId, originalBranchId: plan.originalBranchId, rewindBranchId: plan.branchId,
              turnMessageId: messageId, planId: planned.id, planDigest: planned.digest, runRequestId: requestId, paths: prepared.files.map(file => file.path) }, this.captureContext());
          this.upsertLive({ kind: "change", id: itemId, title: t("undo_turn_title"), files, state: "applying" });
          const settled = await this.settleTurnRestore(conversationId, intention, abort, true);
          const receipt = settled.receipts.find((r) => r.runId === settled.run?.id && r.status === "succeeded" && r.capabilityId === "workspace.project.write");
          if (settled.run?.status !== "succeeded" || !receipt) {
            // Files were not confirmed reversed: the conversation stays on the original branch.
            this.upsertLive({ kind: "change", id: itemId, title: t("undo_turn_title"), files, state: "failed", hint: t("ctl_restore_unconfirmed", { status: settled.run?.status ?? "?" }) });
            await this.reloadMessages(conversationId);
            return null;
          }
          this.upsertLive({ kind: "change", id: itemId, title: t("undo_turn_title"), files, state: "applied", receipt: receipt.id });
          reversed = prepared.files.map((file) => file.path);
          await this.finishTurnRestore(conversationId, intention);
        }
      }
      // A genuine no-write turn also owns an exact tip/revision; a concurrent prompt must never be hidden.
      if (!reversed.length) {
        const { conversation: current, thread } = await this.conversations.thread(conversationId);
        if (current.activeBranchId !== plan.originalBranchId || thread.at(-1)?.id !== plan.turn.at(-1)?.id) throw new Error("conversation_conflict");
        const marker = await this.conversations.appendMessage(conversationId, "assistant", [{ type: "status", text: "turn-undo:v1" }], thread.at(-1)?.id ?? null, current.revision, `${TURN_UNDO_PREFIX}${plan.branchId}`);
        try { await this.conversations.switchBranch(conversationId, plan.branchId, { revision: marker.revision, activeBranchId: current.activeBranchId }); }
        catch (error) { if ((await this.conversations.getConversation(conversationId)).activeBranchId !== plan.branchId) throw error; }
      }
      this.live = this.live.filter((live) => live.item.id === itemId);
      await this.reloadMessages(conversationId);
      const effects = [...new Set(otherEffects.map((e) => e.capabilityId))];
      this.notice("info", reversed.length ? t("undo_turn_done_files", { count: reversed.length }) : t("undo_turn_done_conversation"), effects.length ? t("undo_turn_other_effects", { effects: effects.join(", ") }) : t("undo_turn_redo_hint"));
      return { prompt };
    } catch (error) {
      this.upsertLive({ kind: "change", id: itemId, title: t("undo_turn_title"), files: [], state: "failed", hint: t("undo_turn_failed", { reason: errorText(error) }) });
      return null;
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  /** Redoes the turn undone by the active rewind branch: reverses the undo's writes and returns to the original branch. */
  async redoTurn(): Promise<boolean> {
    const conversationId = this.store.state.activeConversation?.id;
    if (!conversationId) { this.notice("info", t("nenhuma_conversa_ativa_para_ra")); return false; }
    if (this.busy || this.effectAbort || this.view.busy) { this.notice("warning", t("undo_turn_busy")); return false; }
    const abort = new AbortController();
    this.effectAbort = abort;
    const itemId = `redo-${randomUUID()}`;
    this.view.busy = operationText("restoring");
    this.changed();
    try {
      let { conversation, thread } = await this.conversations.thread(conversationId);
      let recovery = await this.conversations.turnRestoreRecords(conversationId);
      // A writing undo whose link/branch ACK was lost must be reconciled before it can be redone.
      const pendingUndo = [...recovery.operations].reverse().find(item => item.kind === "undo" && item.originalBranchId === conversation.activeBranchId && !recovery.completed.has(item.clientMessageId));
      if (pendingUndo) {
        const settled = await this.settleTurnRestore(conversationId, pendingUndo, abort, false, true);
        if (settled.run?.status !== "succeeded" || !settled.receipts.some(item => item.runId === settled.run?.id && item.status === "succeeded" && item.capabilityId === "workspace.project.write")) throw new Error("turn_restore_recovery_pending");
        await this.finishTurnRestore(conversationId, pendingUndo);
        ({ conversation, thread } = await this.conversations.thread(conversationId));
        recovery = await this.conversations.turnRestoreRecords(conversationId);
      }
      const record = await this.conversations.turnUndoFor(conversationId, conversation.activeBranchId);
      if (!record) {
        // The final branch switch may have committed without its ACK/completion marker.
        const pending = [...recovery.operations].reverse().find(item => item.kind === "redo" && item.originalBranchId === conversation.activeBranchId && !recovery.completed.has(item.clientMessageId));
        if (!pending) { this.notice("info", t("redo_turn_none")); return false; }
        const settled = await this.settleTurnRestore(conversationId, pending, abort, false, true);
        if (settled.run?.status !== "succeeded" || !settled.receipts.some(item => item.runId === settled.run?.id && item.status === "succeeded" && item.capabilityId === "workspace.project.write")) throw new Error("turn_restore_recovery_pending");
        await this.finishTurnRestore(conversationId, pending);
        await this.reloadMessages(conversationId);
        this.notice("info", t("redo_turn_done"));
        return true;
      }
      // Messages added after the undo belong to this branch; redo would discard their context.
      const forkPoint = /^fork_([0-9a-f-]{36})_/.exec(conversation.activeBranchId)?.[1] ?? null;
      const ordinary = thread.filter(message => !message.clientMessageId.startsWith("tui_turn_"));
      if (ordinary.length && ordinary.at(-1)!.id !== forkPoint) { this.notice("warning", t("redo_turn_diverged")); return false; }
      let undoRun = (await this.conversations.runs(conversationId)).find((run) => run.messageId === record.messageId);
      if (!undoRun && !record.noWrites) {
        const operation = recovery.operations.find(item => item.messageId === record.messageId && item.kind === "undo");
        if (!operation) throw new Error("turn_restore_recovery_pending");
        const settled = await this.settleTurnRestore(conversationId, operation, abort, false, true);
        if (settled.run?.status !== "succeeded" || !settled.receipts.some(item => item.runId === settled.run?.id && item.status === "succeeded" && item.capabilityId === "workspace.project.write")) throw new Error("turn_restore_recovery_pending");
        undoRun = (await this.conversations.runs(conversationId)).find(item => item.messageId === record.messageId);
        if (!undoRun) throw new Error("turn_restore_recovery_pending");
      }
      const binding = this.view.binding;
      if (undoRun) {
        if (!binding || binding.projectId !== undoRun.projectId || !this.sign) { this.notice("error", t("restaura_o_indispon_vel_pasta_")); return false; }
        this.view.busy = operationText("restoring");
        this.changed();
        const pending = [...recovery.operations].reverse().find(item => item.kind === "redo" && item.rewindBranchId === conversation.activeBranchId && !recovery.completed.has(item.clientMessageId));
        let retired: TurnRestoreRecord | null = null;
        if (pending) {
          const settled = await this.settleTurnRestore(conversationId, pending, abort);
          if (settled.run?.status === "succeeded" && settled.receipts.some(item => item.runId === settled.run?.id && item.status === "succeeded" && item.capabilityId === "workspace.project.write")) {
            await this.finishTurnRestore(conversationId, pending);
            await this.reloadMessages(conversationId);
            this.notice("info", t("redo_turn_done"));
            return true;
          }
          if (!settled.run || !isSettledStatus(settled.run.status) || settled.run.status === "succeeded") throw new Error("turn_restore_recovery_pending");
          if (settled.run.status === "needs_attention") {
            await this.workspace.cancelRun(pending.projectId, settled.run.id);
            const closed = await this.workspace.refreshPlan(pending.projectId, pending.planId);
            if (closed.run?.id !== settled.run.id || closed.run.requestId !== pending.runRequestId || closed.run.status !== "cancelled") throw new Error("turn_restore_recovery_pending");
          }
          retired = pending;
        }
        const view = await this.workspace.refresh(binding.projectId, abort.signal);
        const prepared = await this.workspace.prepareTurnRestore(binding.projectId, binding.rootBindingId, { runIds: [undoRun.runId], expectedRevision: view.revision }, abort.signal);
        if (prepared.kind === "refused") { this.notice("error", prepared.code === "turn_restore_conflict" ? t("undo_turn_conflict", { paths: prepared.conflicts.join(", ") }) : t("undo_turn_failed", { reason: prepared.code })); return false; }
        if (retired) await this.conversations.retireTurnRestore(conversationId, retired, this.captureContext());
        const files = prepared.files.map((file) => ({ path: file.path, ...diffStats(diffLines(splitLines(file.before ?? ""), splitLines(file.after ?? ""))), status: file.action }));
        const body = [t("redo_turn_body"), "", ...prepared.files.map((file) => `${t(`undo_turn_action_${file.action}`)} ${file.path}`)].join("\n");
        if (!await this.features.confirm(t("redo_turn_title"), body, abort.signal)) { this.notice("info", t("undo_turn_declined")); return false; }
        const requestId = randomUUID();
        const planned = prepared.view.plan!;
        const intention = await this.conversations.appendTurnRestoreIntention(conversationId, t("redo_turn_intention", { paths: prepared.files.map((f) => f.path).join(", ") }), `tui_turn_redo_${requestId}`,
          { kind: "redo", projectId: binding.projectId, rootBindingId: binding.rootBindingId, originalBranchId: record.branchId, rewindBranchId: conversation.activeBranchId,
            turnMessageId: record.messageId, planId: planned.id, planDigest: planned.digest, runRequestId: requestId, paths: prepared.files.map(file => file.path) }, this.captureContext());
        this.upsertLive({ kind: "change", id: itemId, title: t("redo_turn_title"), files, state: "applying" });
        const settled = await this.settleTurnRestore(conversationId, intention, abort, true);
        const receipt = settled.receipts.find((r) => r.runId === settled.run?.id && r.status === "succeeded" && r.capabilityId === "workspace.project.write");
        if (settled.run?.status !== "succeeded" || !receipt) {
          // The rewind branch and durable command stay available until the exact outcome is confirmed.
          this.upsertLive({ kind: "change", id: itemId, title: t("redo_turn_title"), files, state: "failed", hint: t("ctl_restore_unconfirmed", { status: settled.run?.status ?? "?" }) });
          await this.reloadMessages(conversationId);
          return false;
        }
        this.upsertLive({ kind: "change", id: itemId, title: t("redo_turn_title"), files, state: "applied", receipt: receipt.id });
        await this.finishTurnRestore(conversationId, intention);
      } else {
        const latest = await this.conversations.thread(conversationId);
        const ordinary = latest.thread.filter(message => !message.clientMessageId.startsWith("tui_turn_"));
        if (latest.conversation.activeBranchId !== conversation.activeBranchId || ordinary.length && ordinary.at(-1)!.id !== forkPoint) throw new Error("conversation_conflict");
        try { await this.conversations.switchBranch(conversationId, record.branchId, { revision: latest.conversation.revision, activeBranchId: latest.conversation.activeBranchId }); }
        catch (error) { if ((await this.conversations.getConversation(conversationId)).activeBranchId !== record.branchId) throw error; }
      }
      this.live = this.live.filter((live) => live.item.id === itemId);
      await this.reloadMessages(conversationId);
      this.notice("info", t("redo_turn_done"));
      return true;
    } catch (error) {
      this.upsertLive({ kind: "change", id: itemId, title: t("redo_turn_title"), files: [], state: "failed", hint: t("undo_turn_failed", { reason: errorText(error) }) });
      return false;
    } finally {
      if (this.effectAbort === abort) this.effectAbort = null;
      this.view.busy = null;
      this.changed();
    }
  }

  setAttention(next: BoundRunRequest | null): void { this.view.attention = next; this.changed(); }

  /**
   * Settles a tool-plan run: text answers are persisted with their tool
   * structure; proposals become separate tool plans; results continue only
   * through a server-reconstructed continuation plan.
   */
  async settlePlanRun(view: WorkspaceView, request: BoundRunRequest, ctxConvId?: string): Promise<void> {
    const conversationId = ctxConvId ?? request.admission?.conversationId ?? this.store.state.activeConversation?.id;
    const isCtxActive = () => this.view.binding?.projectId === request.projectId && (!conversationId || this.store.state.activeConversation?.id === conversationId);
    const { isTextResultArtifact, proposalFromView, describeToolArguments, toolPlanFailureMessage, formatToolResultForTranscript } = await import("./tool-plans.ts");
    const run = view.run;
    if (!run || run.id !== request.runId) { this.notice("error", t('a_identidade_do_run_mudou_dura')); return; }
    if (run.status !== "succeeded") {
      if (isCtxActive()) {
        this.store.dispatch({ type: "turn_changed", turn: "idle" });
        if (run.status === "needs_attention") this.view.attention = request;
        this.notice(run.status === "needs_attention" ? "warning" : "error", t("ctl_run_not_rerun", { run: run.id.slice(0, 8), status: run.status }));
      }
      return;
    }
    if (request.toolKind === "tool-call" && view.artifact && isTextResultArtifact(view)) {
      const content = await this.workspace.readArtifact(request.projectId, view.artifact.id);
      const receipt = view.receipts.find((r) => r.runId === run.id && r.status === "succeeded");
      if (isCtxActive()) this.upsertLive({ kind: "tool", id: `tool-${run.id}`, name: request.tool ?? "ferramenta", summary: describeToolArguments(request.args ?? "{}"), status: "done", detail: formatToolResultForTranscript(request.tool ?? "ferramenta", content, receipt?.id ?? null), receipt: receipt?.id ?? null });
      if (conversationId && request.callId) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(request.args ?? "{}") as Record<string, unknown>; } catch { /* keep empty */ }
        await this.conversations.appendAtTip(conversationId, "assistant", [{ type: "tool_call", text: { callId: request.callId, name: request.tool ?? "ferramenta", arguments: args } }], `tui_toolcall_${request.callId}`).catch(() => undefined);
        await this.conversations.appendAtTip(conversationId, "tool", [{ type: "tool_result", text: { callId: request.callId, receiptId: receipt?.id ?? "", output: content.slice(0, 16_000) } }], `tui_toolresult_${request.callId}`).catch((error) => this.notice("warning", t("ctl_tool_result_not_recorded", { reason: errorText(error) })));
      }
      try {
        const continuation = await this.workspace.createToolResultPlan(request.projectId, { expectedRevision: view.revision, resultArtifactId: view.artifact.id });
        if (continuation.plan) {
          this.view.approvals = [...this.view.approvals, { id: `plan:${continuation.plan.id}`, type: "tool_call", toolKind: "tool-result",
            description: t("ctl_continue_after", { tool: request.tool ?? t("ctl_tool") }), detail: t('continua_o_reconstru_da_pelo_p'),
            tool: "chat-plan", args: "{}", planId: continuation.plan.id, planDigest: continuation.plan.digest, requestId: randomUUID(),
            projectId: request.projectId, conversationRevision: this.store.conversationRevision, userText: request.userText, risk: "low" }];
          this.store.dispatch({ type: "turn_changed", turn: "waiting_approval" });
        }
      } catch (error) {
        const code = error instanceof WorkspaceServiceError ? error.code : "tool_result_plan_failed";
        if (code !== "gateway_tool_results_incomplete") this.notice("warning", t("ctl_no_continuation", { code }));
        this.store.dispatch({ type: "turn_changed", turn: this.view.approvals.length ? "waiting_approval" : "idle" });
      }
      this.changed();
      return;
    }
    if (view.artifact?.mediaType === "application/json") {
      const content = await this.workspace.readArtifact(request.projectId, view.artifact.id);
      const proposal = proposalFromView(view, content);
      if (!proposal) { this.notice("error", t('proposta_de_ferramenta_inv_lid')); this.store.dispatch({ type: "turn_changed", turn: "idle" }); return; }
      if (proposal.content) this.upsertLive({ kind: "assistant", id: `plan-text-${run.id}`, text: proposal.content });
      const added: BoundApprovalRequest[] = [];
      for (const call of proposal.calls) {
        try {
          const toolPlan = await this.workspace.createToolPlan(request.projectId, { expectedRevision: view.revision, artifactId: proposal.artifactId, callId: call.callId });
          if (!toolPlan.plan) throw new WorkspaceServiceError("workspace_plan_missing");
          added.push({ id: `tool:${proposal.artifactId}:${call.callId}`, type: "tool_call", toolKind: "tool-call", description: `${t("ctl_tool")}: ${call.name}`,
            detail: `${describeToolArguments(call.arguments)} · ${t("ctl_own_plan")}`, tool: call.name, args: call.arguments,
            planId: toolPlan.plan.id, planDigest: toolPlan.plan.digest, planRevision: toolPlan.revision, requestId: randomUUID(), projectId: request.projectId,
            conversationRevision: this.store.conversationRevision, artifactId: proposal.artifactId, callId: call.callId, sourceRunId: proposal.sourceRunId, userText: request.userText, risk: "low" });
          this.upsertLive({ kind: "tool", id: `toolprop-${call.callId}`, name: call.name, summary: describeToolArguments(call.arguments), status: "pending" });
        } catch (error) {
          const code = error instanceof WorkspaceServiceError ? error.code : "tool_plan_failed";
          this.upsertLive({ kind: "tool", id: `toolprop-${call.callId}`, name: call.name, summary: toolPlanFailureMessage(code, call.name), status: "error" });
        }
      }
      this.view.approvals = [...this.view.approvals, ...added];
      this.store.dispatch({ type: "turn_changed", turn: this.view.approvals.length ? "waiting_approval" : "idle" });
      return;
    }
    const finalText = view.artifact && isTextResultArtifact(view) ? await this.workspace.readArtifact(request.projectId, view.artifact.id) : "";
    this.store.dispatch({ type: "turn_changed", turn: "idle" });
    if (conversationId) {
      try {
        if (request.admission && request.intentionMessageId) {
          await this.conversations.linkRun(conversationId, { messageId: request.intentionMessageId, requestId: request.admission.requestId, runId: run.id, projectId: request.projectId, modelId: this.store.state.selectedModel || "auto", state: run.status }).catch(() => undefined);
        }
        await this.conversations.appendAtTip(conversationId, "assistant", [{ type: "text", text: finalText || "(sem texto)" }], `tui_plan_answer_${request.planId}`);
      } catch (error) {
        this.notice("warning", t("ctl_answer_not_recorded", { reason: errorText(error) }));
      }
      await this.reloadMessages(conversationId);
    }
    if (this.view.mode === "build" && finalText) await this.proposeFrom(finalText, this.store.state.messages.at(-1)?.id ?? null);
  }

  private async openExportedFile(path: string, revalidate: () => void): Promise<void> {
    const { spawn } = await import("node:child_process");
    revalidate();
    const { platform } = await import("node:os");
    revalidate();

    await new Promise<void>((resolve) => {
      let child;
      if (platform() === "win32") {
        child = spawn("powershell.exe", windowsOpenerArgs(path), { stdio: "ignore", windowsHide: true });
      } else {
        const [cmd, args] = platform() === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
        child = spawn(cmd, args as string[], { stdio: "ignore", windowsHide: true });
      }

      child.on("error", (e) => {
        this.notice("warning", t("ctl_opener_failed", { reason: errorText(e) }));
        resolve();
      });
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          this.notice("warning", t("ctl_opener_exit", { code: String(code) }));
        }
        resolve();
      });
    });
  }
}

/** A tool call at or before `index` whose result comes after it. */
function pairOpenAt(thread: ReadonlyArray<{ parts: Array<{ type: string; text?: unknown }> }>, index: number): boolean {
  const open = new Set<string>();
  for (let i = 0; i <= index; i++) {
    for (const part of thread[i]!.parts) {
      if (part.type === "tool_call") open.add((part.text as { callId: string }).callId);
      if (part.type === "tool_result" && typeof part.text === "object") open.delete((part.text as { callId: string }).callId);
    }
  }
  return open.size > 0;
}

/**
 * Windows opener: Start-Process with the path as a single-quoted literal inside an -EncodedCommand script. Nothing
 * parses the path as a command line (explorer.exe splits on commas, takes a leading "/" as a switch and exits 1 even
 * on success); only quote characters need doubling, including the typographic ones PowerShell also accepts as quotes.
 * A missing association or a vanished file makes PowerShell exit non-zero, which the caller reports.
 */
export function windowsOpenerArgs(path: string): string[] {
  const literal = path.replace(/['‘’‚‛]/g, (quote) => quote + quote);
  const script = `$ErrorActionPreference = 'Stop'; Invoke-Item -LiteralPath '${literal}'`;
  return ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/** The machine code of an error: what decisions compare. */
export function errorCode(error: unknown): string {
  if (error instanceof WorkspaceServiceError || error instanceof ConversationServiceError) return error.code;
  if (error instanceof TuiHttpError) return error.code ?? error.message;
  if (error instanceof Error) return error.message.slice(0, 120);
  return "error";
}
/** What the person reads: the meaning of a known code in their language, the code kept for diagnosis. */
export function errorText(error: unknown): string {
  return localizedDiagnostic(errorCode(error));
}
type DurableToolResult = NonNullable<Message["toolResults"]>[number];
// Cache only classification, never parsed payloads; released conversations remain collectible.
const toolResultStatuses = new WeakMap<DurableToolResult, { output: string; status: CompletedToolStatus }>();

function durableToolResultStatus(result: DurableToolResult): CompletedToolStatus {
  const known = toolResultStatuses.get(result);
  if (known && known.output === result.output) return known.status;
  const status = toolResultStatus(result.output);
  toolResultStatuses.set(result, { output: result.output, status });
  return status;
}

/** Maps one canonical message to transcript items (text, tool calls/results, compaction). */
export function messageItems(message: Message): TranscriptItem[] {
  // The rewind marker of an undone turn carries no conversation content.
  if (message.role === "assistant" && !message.content && message.clientMessageId?.startsWith(TURN_UNDO_PREFIX)) return [];
  if (message.compaction) return [{ kind: "compaction", id: message.id, covered: message.compaction.covered, summary: message.content }];
  if (message.role === "user") {
    const intention = message.clientMessageId?.startsWith("tui_change_") || message.clientMessageId?.startsWith("tui_verify_");
    return [{ kind: "user", id: message.id, text: message.content, ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(message.mediaAttachments?.length ? { mediaAttachments: message.mediaAttachments } : {}), ...(intention ? { steer: false } : {}) }];
  }
  if (message.role === "tool") {
    return (message.toolResults ?? []).map((result) => ({ kind: "tool" as const, id: `${message.id}:${result.callId}`, name: operationText("tool_result"), summary: result.callId, status: durableToolResultStatus(result), detail: result.output, receipt: result.receiptId || null }));
  }
  const items: TranscriptItem[] = [];
  if (message.content || !message.toolCalls?.length) {
    items.push({ kind: "assistant", id: message.id, text: message.content, ...(message.interrupted ? { interrupted: message.interrupted } : {}) });
  }
  for (const call of message.toolCalls ?? []) {
    const result = message.toolResults?.find(result => result.callId === call.id);
    const status = result ? durableToolResultStatus(result) : call.result !== undefined ? toolResultStatus(call.result) : "pending";
    items.push({ kind: "tool", id: `${message.id}:${call.id}`, name: call.name, summary: call.arguments.length > 120 ? `${call.arguments.slice(0, 120)}…` : call.arguments, status, ...(result ? { detail: result.output, receipt: result.receiptId || null } : call.result !== undefined ? { detail: call.result } : {}) });
  }
  // One measurement per canonical message: it travels with the message's first item.
  const first = items[0];
  if (message.usage && first && (first.kind === "assistant" || first.kind === "tool")) first.usage = message.usage;
  return items;
}
