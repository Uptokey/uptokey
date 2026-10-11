/**
 * Uptokey backend for the vendored OpenCode frontend.
 *
 * The frontend expects an SDK client and a GlobalEvent stream. Here both are served in-process by the
 * canonical TuiController (which talks to the Node core over its authenticated HTTP transports), so there is
 * one owner of identity, conversations, workspace effects and receipts. Nothing is cached as a second source of
 * truth: every read is derived from the controller, and unsupported endpoints fail explicitly.
 */
import { resolve as resolvePath } from "node:path"
import type { Agent, Command, Event, GlobalEvent, Model, Path, Project, Provider, Session } from "@opencode-ai/sdk/v2"
import { COMMANDS, resolveSlash, runCommand, type PanelName, type UiActions } from "../../../commands.ts"
import type { TuiController } from "../../../controller.ts"
import type { ModelView, ProviderView } from "../../../connections.ts"
import { SessionMirror } from "./mirror.ts"
import { createTimeAssigner, projectTranscript, type ProjectedMessage } from "./projection.ts"
import { createApprovalActions, type BoundRunRequest } from "../../../approvals.ts"
import { mentionedFolders } from "./folder-mentions.ts"
import { PathIndex, type IndexedPath } from "./path-index.ts"
import { PermissionMirror } from "./permissions.ts"
import { StableIds } from "./stable-ids.ts"
import { classifyIntent, isHighRisk } from "../../../jev-intent.ts"
import { evaluateToolCall } from "../../../jev-tool-guard.ts"
import { jev } from "../../../jev-client.ts"
import { verifyCompactionQuality } from "../../../jev-compact-quality.ts"
import { ui } from "../i18n.ts"
import { PROVIDER_SETUP_PRESETS, type ProviderSetupService } from "../../../provider-setup.ts"
import { withUnsupported } from "./unsupported.ts"
import { appendFileSync, writeSync } from "node:fs"
import { transcriptCodeBlockText } from "../../../clipboard.ts"
import { selectionUi } from "../integration-selection.ts"
import { preparePromptParts, type PromptPart } from '../prompt-parts.ts'
import type { PromptInfo } from '../prompt-info.ts'
import { connectionText } from '../integration-connections.ts'
import { terminalText } from '../integration-terminal.ts'

/** Title the core gives a conversation created without one (workspace/conversations.ts::createConversation). */
const DEFAULT_CORE_TITLE = "Nova conversa"

/** Development trace (UPTOKEY_TUI_DEBUG_LOG=<file>): one JSON line per backend decision, never prompt text or credentials. */
function trace(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.UPTOKEY_TUI_DEBUG_LOG
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`)
  } catch {
    // tracing must never affect the interface
  }
}

export interface BackendOptions {
  controller: TuiController
  cwd: string
  home: string
  state: string
  config: string
  /** Panels requested by Uptokey commands (/modelos, /arquivos…). The frontend decides how to present each one. */
  openPanel?: (name: PanelName, arg?: string) => void
  /** Ends the frontend; code 75 asks the launcher to reopen in the linear screen-reader interface. */
  exit?: (code?: number) => void
  /** Provider onboarding service (OS vault + config). Absent when the vault is unavailable. */
  providerSetup?: ProviderSetupService
  initialConnect?: string
}

/** Order of the provider list after the connected ones (most used first); unknown providers follow by name. */
const PROVIDER_PRIORITY = [/\bopenai\b(?!.*compat)/i, /anthropic|claude/i, /gemini|google/i, /deepseek/i, /groq/i, /openrouter/i, /xai|grok/i, /mistral/i, /ollama/i, /lm ?studio/i]

export interface ProviderChoice {
  id: string
  label: string
  local: boolean
  configured: boolean
  eligible: boolean
  executable: boolean
  /** Fixed endpoint of the preset; empty when the person must supply one. */
  endpointUrl: string
}

const AGENTS: Agent[] = [
  { name: "build", description: "Reads, edits and runs in the project; every effect asks for approval.", mode: "primary", native: true, permission: [], options: {} },
  { name: "autonomous", description: "Edits, runs and fixes until the task is done, without asking at each step (a receipt for every effect).", mode: "primary", native: true, permission: [], options: {}, color: "#F96300" } as Agent,
  { name: "plan", description: "Plans without effects on the project.", mode: "primary", native: true, permission: [], options: {} },
]

function ok<T>(data: T) {
  return Promise.resolve({ data, error: undefined as undefined })
}

function fail(name: string, message: string) {
  return { data: undefined, error: { name, data: { message } } }
}

export class UptokeyBackend {
  readonly directory: string
  readonly client: any
  private readonly handlers = new Set<(event: GlobalEvent) => void>()
  private readonly times = createTimeAssigner()
  private readonly mirror: SessionMirror
  private ready: Promise<void>
  private sequence = 0
  private lastTurn = ""
  private lastSessionKey = ""
  private boundRoot: string | null | undefined = undefined
  private shownLocations: unknown = null
  private lastAudioSecond = -1
  /** Last model the core reported, and last one the window itself sent (only the former is followed). */
  private followedModel: string | undefined
  private frontendModel: string | undefined
  private disposed = false
  /** The conversation the frontend is showing; a different controller-side change navigates the frontend. */
  private shownSession = ""
  /** > 0 while the frontend itself is creating a conversation: it navigates by the returned id, not by event. */
  private creating = 0
  private readonly handleControllerChange = () => this.sync()
  /** A debug session the person confirmed opens its panel (state, stack, variables, breakpoints, output). */
  private readonly handleDebugger = () => {
    trace("debugger.open")
    this.emit({ type: "uptokey.panel.open", properties: { name: "debugger" } })
  }
  /** Dictation and audio transcription hand their text to the composer (never sent by themselves). */
  private readonly handleDraft = (text: unknown) => {
    if (typeof text !== "string" || !text) return
    trace("composer.draft", { length: text.length })
    this.emit({ type: "tui.prompt.append", properties: { text } } as never)
  }
  private readonly created = new Map<string, number>()
  private readonly permissions = new PermissionMirror()
  private readonly stableIds = new StableIds()
  private readonly approvalInFlight = new Set<string>()
  private readonly approvalRequestIds = new Map<string, string>()
  private readonly recoveredDrafts = new Map<string, PromptInfo>()
  private modelInputs = new Map<string, {image:boolean;audio:boolean;toolcall:boolean}>()

  constructor(private readonly options: BackendOptions) {
    this.directory = options.cwd
    this.mirror = new SessionMirror("")
    this.pathIndex = new PathIndex(options.controller.workspace)
    this.ready = options.controller.start().then(() => this.refreshModelInputs()).catch(() => undefined)
    this.client = this.createClient()
    options.controller.on("change", this.handleControllerChange)
    options.controller.on("draft", this.handleDraft)
    options.controller.on("debugger", this.handleDebugger)
  }

  dispose() {
    this.disposed = true
    this.options.controller.off("change", this.handleControllerChange)
    this.options.controller.off("draft", this.handleDraft)
    this.options.controller.off("debugger", this.handleDebugger)
    this.handlers.clear()
    this.recoveredDrafts.clear()
  }

  recoverDraft(sessionID:string, draft:PromptInfo) {
    this.recoveredDrafts.set(sessionID, structuredClone(draft))
    this.emit({type:'uptokey.prompt.restore',properties:{sessionID}})
  }

  takeRecoveredDraft(sessionID:string):PromptInfo|undefined {
    const draft=this.recoveredDrafts.get(sessionID)
    if(draft)this.recoveredDrafts.delete(sessionID)
    return draft
  }

  private async refreshModelInputs() {
    const next=new Map<string,{image:boolean;audio:boolean;toolcall:boolean}>()
    try {
      const response=await this.controller.client.fetchAuth('/local/connections')
      if(!response.ok)throw new Error('connections_unavailable')
      const value=await response.json() as {connections?:Array<{providerId?:string;enabled?:boolean;priority?:number;modelIds?:string[];imageInputModels?:string[];audioInputModels?:string[];toolModels?:string[]}>}
      const profiles=Array.isArray(value.connections)?value.connections:[]
      // Match the router's priority selection. A less preferred account must not advertise another account's input.
      const selected=new Map<string,(typeof profiles)[number]>()
      for(const profile of profiles){if(!profile.enabled||typeof profile.providerId!=='string')continue;const prior=selected.get(profile.providerId);if(!prior||(profile.priority??0)>(prior.priority??0))selected.set(profile.providerId,profile)}
      for(const [provider,profile] of selected)for(const model of profile.modelIds??[]){
        if(typeof model!=='string')continue
        next.set(`${provider}:${model}`,{image:profile.imageInputModels?.includes(model)===true,audio:profile.audioInputModels?.includes(model)===true,toolcall:profile.toolModels?.includes(model)===true})
      }
    }catch{ /* A failed capability read exposes text only; admission revalidates before any media import. */ }
    if(!this.disposed)this.modelInputs=next
  }

  get controller() {
    return this.options.controller
  }

  /** The active (or next) conversation keeps nothing on disk: local prompt files must not record it either. */
  get temporary() {
    return this.options.controller.state.storagePolicy === "temporary"
  }

  /** Resolves when the controller finished its startup handshake (health, identity, connections, binding). */
  whenReady() {
    return this.ready
  }

  subscribe(handler: (event: GlobalEvent) => void) {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(payload: { type: string; properties: Record<string, unknown> }) {
    const event = { directory: this.directory, payload: { id: `uptokey-event-${++this.sequence}`, ...payload } } as GlobalEvent
    for (const handler of this.handlers) handler(event)
  }

  /** Called once the frontend listens: the model the core already selected (--model, saved choice) is shown and used. */
  replayModel() {
    const selected = this.options.controller.state.selectedModel
    if (!selected || selected === this.frontendModel) return
    this.followedModel = selected
    trace("model.follow", { selected, frontend: this.frontendModel ?? null, replay: true })
    this.emit({ type: "uptokey.model.follow", properties: this.destination() } as never)
  }

  /** The window opens on the first agent (build); a session started with --autonomy shows "autonomous" instead. */
  replayAgent() {
    const controller = this.options.controller
    const agent = controller.view.mode === "plan" ? "plan" : controller.view.autonomy ? "autonomous" : "build"
    this.followedAgent = agent
    this.emit({ type: "uptokey.agent.follow", properties: { name: agent } } as never)
  }

  get providerSetup() {
    return this.options.providerSetup
  }

  get initialConnect(){return this.options.initialConnect}

  /** Providers the person can connect, merged from the setup presets and what the core observes. */
  providerChoices(): ProviderChoice[] {
    const observed = this.options.controller.view.connections?.providers ?? []
    const choices = observed.map((provider): ProviderChoice => {
      const preset = PROVIDER_SETUP_PRESETS.find((item) => item.id === provider.id)
      return {
        id: provider.id,
        label: preset?.label ?? provider.displayName,
        local: preset?.local ?? provider.kind === "local",
        configured: provider.configured,
        eligible: provider.eligible,
        executable: preset !== undefined || (provider.executable && provider.kind !== "catalog"),
        endpointUrl: preset?.endpointUrl ?? "",
      }
    })
    for (const preset of PROVIDER_SETUP_PRESETS) {
      if (choices.some((choice) => choice.id === preset.id)) continue
      choices.push({ id: preset.id, label: preset.label, local: preset.local, configured: false, eligible: false, executable: true, endpointUrl: preset.endpointUrl })
    }
    // The window shows only the first rows: connected providers first, then the most used ones, then the rest by name.
    const rank = (choice: ProviderChoice) => {
      const known = PROVIDER_PRIORITY.findIndex((pattern) => pattern.test(`${choice.id} ${choice.label}`))
      return known < 0 ? PROVIDER_PRIORITY.length : known
    }
    return choices.sort((a, b) =>
      Number(b.configured) - Number(a.configured) || Number(b.executable) - Number(a.executable) || rank(a) - rank(b) || a.label.localeCompare(b.label))
  }

  /** Brave Search key of the person: sent once to the core, which keeps it in its vault (web:brave); never stored here. */
  async configureWebSearchKey(key: string): Promise<{ braveAvailable: boolean }> {
    const response = await this.options.controller.client.fetchAuth("/v1/workspace/web/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) })
    const body = (await response.json().catch(() => null)) as { engines?: Array<{ id?: unknown; available?: unknown }>; error?: { type?: unknown } } | null
    if (!response.ok) throw new Error(typeof body?.error?.type === "string" ? body.error.type : `web_config_${response.status}`)
    return { braveAvailable: body?.engines?.some((engine) => engine.id === "brave" && engine.available === true) === true }
  }

  /** After a committed setup: reload what the core observes, select the new destination and refresh the frontend lists. */
  async finishProviderSetup(providerId: string, modelId: string, routingComboId: string) {
    const controller = this.options.controller
    await controller.refreshConnections()
    await controller.selectProviderModel(modelId, providerId, routingComboId)
    await this.refreshModelInputs()
    this.refreshAll()
    // The new provider is in the window's list only after this refresh: announce the choice again for it.
    this.followedModel = controller.state.selectedModel
    this.emit({ type: "uptokey.model.follow", properties: this.destination() } as never)
  }

  // ─── state derived from the controller ───────────────────────────────

  private get activeId() {
    return this.options.controller.state.activeConversation?.id
  }

  private destination() {
    const controller = this.options.controller
    const selected = controller.client.getSelectedDestination()
    const providerID = selected.providerId ?? this.providerOf(controller.state.selectedModel) ?? "uptokey"
    return { providerID, modelID: controller.state.selectedModel }
  }

  private providerOf(modelID: string) {
    return this.options.controller.view.connections?.providers.find((provider) => provider.eligible && provider.models.includes(modelID))?.id
  }

  /** Agent (build / autonomous / plan) last shown in the prompt. */
  followedAgent: string | undefined
  private readonly pathIndex: PathIndex
  private indexedRoot = ""

  /** Paths of the bound project, fuzzy-ranked from a bounded crawl of the same paginated listing the controller uses. */
  private async findPaths(query: string, limit: number): Promise<IndexedPath[]> {
    const binding = this.options.controller.view.binding
    if (!binding) return []
    if (this.indexedRoot !== binding.rootBindingId) {
      this.pathIndex.reset()
      this.indexedRoot = binding.rootBindingId
    }
    const crawl = this.pathIndex.ensure(binding)
    // A first search waits briefly for the crawl; later ones answer from what is already indexed.
    await Promise.race([crawl, new Promise((resolve) => setTimeout(resolve, this.pathIndex.size === 0 ? 2000 : 150))])
    return this.pathIndex.find(query, limit)
  }

  private projectID() {
    return this.options.controller.view.binding?.projectId ?? "global"
  }

  private sessionInfo(id: string, title?: string | null, updatedAt?: string): Session {
    const updated = updatedAt ? Date.parse(updatedAt) || Date.now() : Date.now()
    const created = this.created.get(id) ?? updated
    this.created.set(id, created)
    return {
      id,
      slug: id.slice(-8),
      projectID: this.projectID(),
      directory: this.directory,
      title: title ?? "",
      version: "uptokey",
      time: { created, updated },
    }
  }

  private sessions(): Session[] {
    const state = this.options.controller.state
    const list = state.conversations.map((conversation) => this.sessionInfo(conversation.id, conversation.title, conversation.updatedAt))
    const active = state.activeConversation
    if (active && !list.some((session) => session.id === active.id)) list.push(this.sessionInfo(active.id, active.title, active.updatedAt))
    return [...list].sort((a, b) => a.id.localeCompare(b.id))
  }

  private toModel(provider: ProviderView, id: string, view?: ModelView): Model {
    const inputs=this.modelInputs.get(`${provider.id}:${id}`)
    return {
      id,
      providerID: provider.id,
      api: { id, url: "", npm: "uptokey" },
      name: id,
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: inputs?.toolcall??provider.capabilities.includes('tools'),
        input: { text: true, audio: inputs?.audio===true, image: inputs?.image===true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: view?.contextWindow ?? 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
    }
  }

  private toProvider(provider: ProviderView, models: ModelView[]): Provider {
    const entries = provider.models.map((id) => [id, this.toModel(provider, id, models.find((model) => model.id === id))] as const)
    return { id: provider.id, name: provider.displayName, source: "api", env: [], options: {}, models: Object.fromEntries(entries) }
  }

  private connectedProviders(): Provider[] {
    const snapshot = this.options.controller.view.connections
    if (!snapshot) return []
    return snapshot.providers.filter((provider) => provider.eligible && provider.models.length > 0).map((provider) => this.toProvider(provider, snapshot.models))
  }

  private defaults(providers: Provider[]) {
    const snapshot = this.options.controller.view.connections
    return Object.fromEntries(
      providers.flatMap((provider) => {
        const preferred = snapshot?.providers.find((item) => item.id === provider.id)?.defaultModel
        const first = preferred && provider.models[preferred] ? preferred : Object.keys(provider.models)[0]
        return first ? [[provider.id, first] as const] : []
      }),
    )
  }

  private projection(): ProjectedMessage[] {
    const controller = this.options.controller
    const destination = this.destination()
    const hints = new Map(controller.state.messages.map((message) => [message.id, Date.parse(message.timestamp) || undefined] as const))
    return projectTranscript(this.stableIds.apply(controller.items()), {
      sessionID: this.activeId ?? "",
      providerID: destination.providerID,
      modelID: destination.modelID,
      agent: controller.view.mode === "plan" ? "plan" : controller.view.autonomy ? "autonomous" : "build",
      cwd: this.directory,
      time: (id, hint) => this.times.assign(id, hint),
      hint: (itemID) => hints.get(itemID.split(":")[0]!),
      now: Date.now,
    })
  }

  // ─── event translation ───────────────────────────────────────────────

  /** Called on every coalesced controller change. */
  private sync() {
    if (this.disposed) return
    const controller = this.options.controller
    // Moving to another project folder changes what the window shows (folder in the footer, its conversations):
    // the frontend reloads paths, project and sessions from this backend.
    const root = controller.view.binding?.rootPath ?? null
    // The first link to the window's own folder is not a switch (the frontend already shows that folder).
    const shownBefore = this.boundRoot ?? this.directory
    const comparable = (value: string) => (process.platform === "win32" ? resolvePath(value).toLowerCase() : resolvePath(value))
    if (this.boundRoot !== undefined && comparable(root ?? this.directory) !== comparable(shownBefore)) {
      trace("project.switched", { to: root })
      this.emit({ type: "server.instance.disposed", properties: { directory: this.directory } })
    }
    this.boundRoot = root
    // A model chosen through the core (/modelo <id>) and not by the window's picker: the prompt follows it.
    const selected = controller.state.selectedModel
    if (selected && selected !== this.followedModel) {
      this.followedModel = selected
      trace("model.follow", { selected, frontend: this.frontendModel ?? null })
      if (selected !== this.frontendModel) this.emit({ type: "uptokey.model.follow", properties: this.destination() } as never)
    }
    // Autonomy or mode changed by a command (/autonomy, /plan): the agent shown in the prompt (Tab) follows it.
    const agent = controller.view.mode === "plan" ? "plan" : controller.view.autonomy ? "autonomous" : "build"
    if (agent !== this.followedAgent) {
      this.followedAgent = agent
      this.emit({ type: "uptokey.agent.follow", properties: { name: agent } } as never)
    }
    // Recording from the microphone is always visible: elapsed time, a level meter and how to stop.
    const audio = controller.features.audio
    if (audio.active) {
      const second = Math.floor(audio.durationMs / 1000)
      if (second !== this.lastAudioSecond) {
        this.lastAudioSecond = second
        const bars = Math.max(0, Math.min(8, Math.round(audio.rms * 40)))
        this.emit({ type: "tui.toast.show", properties: { message: ui("mic_recording", { seconds: second, level: "▮".repeat(bars) + "▯".repeat(8 - bars) }), variant: "warning", duration: 1600 } } as never)
      }
    } else this.lastAudioSecond = -1
    // /referencias and /definicao (also after the language-server consent): show the locations when they arrive.
    const locations = controller.view.lspLocations
    if (locations && locations !== this.shownLocations) {
      this.shownLocations = locations
      if (locations.items.length) this.emit({ type: "uptokey.panel.open", properties: { name: "locations" } })
    }
    const active = this.activeId
    const sessionKey = active ? `${active}:${controller.store.conversationRevision}` : ""
    if (sessionKey !== this.lastSessionKey) {
      this.lastSessionKey = sessionKey
      this.mirror.setSession(active ?? "")
      this.stableIds.reset()
      this.times.reset()
      // Compactions that existed before this session was shown were judged (or not) when they happened.
      for (const item of controller.items()) if (item.kind === "compaction") this.checkedCompactions.add(item.id)
      this.permissions.reset()
    }
    if (this.creating === 0 && (active ?? "") !== this.shownSession) {
      this.shownSession = active ?? ""
      trace("navigate", { to: active ?? null })
      this.emit({ type: "uptokey.session.navigate", properties: { sessionID: active ?? null } })
    }
    if (!active) {
      // A decision raised outside a conversation (e.g. /depurar typed on the home screen asks to confirm the debug
      // session) can only be shown in a session: open one so the person sees it, instead of a silent wait.
      const decision = Boolean(controller.features.review) || controller.view.approvals.length > 0 || Boolean(controller.view.proposal) || Boolean(controller.view.lspConsentRequest)
      if (decision && this.creating === 0) {
        this.creating++
        void this.ensureSession()
          .catch(() => undefined)
          .finally(() => {
            this.creating--
            this.sync()
          })
      }
      this.toastHomeNotices()
      return
    }
    // Notices raised while a conversation is shown are part of its transcript; never toast them again later.
    for (const item of controller.items()) if (item.kind === "notice") this.toasted.add(item.id)

    const projected = this.projection()
    this.checkCompactions()
    if (process.env.UPTOKEY_TUI_DEBUG_LOG) {
      trace("sync.projection", {
        turn: controller.state.turn,
        messages: projected.map((message) => `${message.info.role[0]}:${message.info.id.slice(-6)}[${message.parts.map((part) => `${part.type}${part.type === "text" ? `:${part.text.length}` : ""}`).join(",")}]`).join(" "),
      })
    }
    let result = this.mirror.diff(projected)
    if (result.resync) {
      for (const event of this.mirror.clear()) this.emit(event as any)
      this.times.reset()
      result = this.mirror.diff(this.projection())
    }
    for (const event of result.events) this.emit(event as any)
    for (const event of this.permissions.diff(active, controller.view.proposal, controller.view.approvals, controller.features.review ?? this.lspConfirmation())) this.emit(event)

    const session = controller.state.activeConversation
    if (session) this.emit({ type: "session.updated", properties: { sessionID: session.id, info: this.sessionInfo(session.id, session.title, session.updatedAt) } })
    const turn = controller.state.turn
    const busy = controller.busy || Boolean(controller.view.busy) || turn === "streaming" || turn === "submitting" || turn === "waiting_tool"
    const status = busy ? "busy" : "idle"
    if (status !== this.lastTurn) {
      this.lastTurn = status
      this.emit({ type: "session.status", properties: { sessionID: active, status: { type: status } } })
    }
  }

  /** Development trace (see UPTOKEY_TUI_DEBUG_LOG). */
  trace(event: string, data: Record<string, unknown> = {}) {
    trace(event, data)
  }

  /** Subscribes to controller changes (panels re-read `controller.view`). */
  onChange(handler: () => void) {
    this.options.controller.on("change", handler)
    return () => {
      this.options.controller.off("change", handler)
    }
  }

  /** Fuzzy search over the bound project's paths. */
  searchPaths(query: string, limit: number) {
    return this.findPaths(query, limit)
  }

  /** Text may leave the device for a semantic judgment only when the conversation allows external processing. */
  private get externalAllowed() {
    return this.options.controller.state.processingPolicy === "external_allowed"
  }

  /**
   * Jev's judgment of a request before it is sent: a destructive intent with enough probability asks the person
   * first. Only Jev's own answer triggers the question (the keyword fallback would interrupt ordinary edits).
   */
  async judgeRequest(text: string): Promise<{ confirm: boolean; percent: number; fallback: boolean }> {
    if (!text.trim()) return { confirm: false, percent: 0, fallback: true }
    const result = await classifyIntent(text, { externalAllowed: this.externalAllowed, timeoutMs: 1500 })
    trace("jev.intent", { category: result.category, confidence: Math.round(result.confidence * 100), fallback: result.fallback })
    return { confirm: !result.fallback && isHighRisk(result), percent: Math.round(result.confidence * 100), fallback: result.fallback }
  }

  /** Jev's reading of a decision waiting for approval (alignment with the request, destruction, scope). */
  async judgeDecision(input: { toolName: string; toolArgs: string; description?: string }) {
    const lastUser = [...this.options.controller.state.messages].reverse().find((message) => message.role === "user")
    const result = await evaluateToolCall(
      { userRequest: lastUser?.content ?? "", toolName: input.toolName, toolArgs: input.toolArgs, ...(input.description ? { toolDescription: input.description } : {}) },
      { externalAllowed: this.externalAllowed, timeoutMs: 2000 },
    )
    trace("jev.guard", { tool: input.toolName, fallback: result.fallback })
    return result
  }

  resetJev() {
    jev().reset()
  }

  private readonly checkedCompactions = new Set<string>()
  private readonly toasted = new Set<string>()

  /**
   * On the home screen there is no transcript to carry the controller's notices (an error from a command typed
   * there, a missing adapter, a refused operation): show each new one once as a toast, so feedback is never silent.
   */
  private toastHomeNotices() {
    for (const item of this.options.controller.items()) {
      if (item.kind !== "notice" || this.toasted.has(item.id)) continue
      this.toasted.add(item.id)
      const message = item.hint ? `${item.text}\n${item.hint}` : item.text
      this.emit({ type: "tui.toast.show", properties: { message, variant: item.level === "info" ? "info" : item.level === "warning" ? "warning" : "error", duration: 8000 } } as never)
    }
  }

  /**
   * After a compaction, Jev checks whether the summary kept the goal, decisions, pending changes, approvals, open
   * errors and next steps; a weak summary is reported so the person can keep the full history instead.
   */
  private checkCompactions() {
    const controller = this.options.controller
    for (const item of controller.items()) {
      if (item.kind !== "compaction" || this.checkedCompactions.has(item.id)) continue
      this.checkedCompactions.add(item.id)
      void verifyCompactionQuality(item.summary, controller.state.messages, { externalAllowed: this.externalAllowed, timeoutMs: 3000 }).then((result) => {
        trace("jev.compaction", { fallback: result.fallback, overall: Math.round(result.overallScore * 100), acceptable: result.acceptable })
        if (result.fallback || result.acceptable) return
        const missing = (Object.keys(result.scores) as Array<keyof typeof result.scores>).filter((key) => result.scores[key] < 0.55).map((key) => ui(`jev_inv_${key}`))
        controller.notice("warning", ui("jev_compaction_weak", { missing: missing.join(", ") }), ui("jev_compaction_hint"))
      })
    }
  }

  /** Availability of Jev for the doctor panel and the review prompt. */
  jevStatus() {
    return jev().status(this.externalAllowed)
  }

  /** A folder the person named in the request text that is not the bound project (deterministic, local). */
  async detectFolder(text: string): Promise<string | undefined> {
    await this.ready
    return (await mentionedFolders(text, this.options.controller.view.binding?.rootPath))[0]
  }

  /** Binds a folder the person confirmed. Returns true when the bound project actually changed. */
  async bindFolder(folder: string): Promise<boolean> {
    const controller = this.options.controller
    const before = controller.view.binding?.rootBindingId
    await controller.rebindProject(folder)
    return controller.view.binding !== null && controller.view.binding.rootBindingId !== before
  }

  /** Review actions on the pending change proposal (selection state lives in the controller, not here). */
  readonly review = {
    toggleFile: (index: number) => {
      const file = this.options.controller.view.proposal?.files[index]
      if (!file) return
      file.selected = !file.selected
      this.options.controller.upsertProposal()
    },
    toggleHunk: (fileIndex: number, hunkIndex: number) => {
      const file = this.options.controller.view.proposal?.files[fileIndex]
      if (!file) return
      const set = file.selectedHunks ?? new Set(file.hunks.map((_, index) => index))
      if (set.has(hunkIndex)) set.delete(hunkIndex)
      else set.add(hunkIndex)
      file.selectedHunks = set
      this.options.controller.upsertProposal()
    },
    split: (fileIndex: number) => this.options.controller.splitProposalHunks(fileIndex),
  }

  private approvalActions() {
    const controller = this.options.controller
    return createApprovalActions({
      requests: () => controller.view.approvals,
      current: () => ({ conversationRevision: controller.store.conversationRevision, projectId: controller.view.binding?.projectId }),
      workspace: controller.workspace,
      sign: controller.signer ?? undefined,
      inFlight: this.approvalInFlight,
      requestIds: this.approvalRequestIds,
      beforeApprove: async () => ({ allow: true }),
      remove: (id) => controller.setApprovals(controller.view.approvals.filter((request) => request.id !== id)),
      bindRun: (id, runId) => controller.setApprovals(controller.view.approvals.map((request) => (request.id === id ? { ...request, runId } : request))),
      notice: (message) => controller.notice("warning", message),
      attention: (request) => {
        if (request.runId && request.planId && request.projectId) controller.setAttention(request as BoundRunRequest)
      },
      observed: async (request, status) => {
        if (["running", "done", "error"].includes(status) && request.runId && request.planId && request.projectId) await controller.observeRun(request as BoundRunRequest)
      },
    })
  }

  /**
   * Starting a language server runs a program on this machine for this folder: the controller keeps the request until
   * the person answers; the consent recorded is for this exact command, arguments and resolved program.
   */
  private lspConfirmation(): { id: string; title: string; body: string } | null {
    const request = this.options.controller.view.lspConsentRequest
    const root = this.options.controller.view.binding?.rootPath
    if (!request || !root) return null
    const { spec } = request
    return {
      id: `lsp-consent-${spec.id}`,
      title: ui("lsp_consent_title", { server: spec.id }),
      body: [
        ui("lsp_consent_intro"),
        "",
        ui("lsp_consent_command", { command: [spec.command, ...spec.args].join(" ") }),
        ui("lsp_consent_folder", { folder: root }),
        ui("lsp_consent_files", { files: request.paths.join(", ") || "—" }),
        "",
        ui("lsp_consent_scope"),
      ].join("\n"),
    }
  }

  /** The person decided. Effects still go through the verified plan, native signature and receipt in the controller. */
  async permissionReply(requestID: string, reply: "once" | "reject") {
    const controller = this.options.controller
    if (requestID.startsWith("lsp-consent-") && controller.view.lspConsentRequest) {
      if (reply === "once") await controller.grantLspConsent()
      else controller.declineLspConsent()
      this.sync()
      return
    }
    if (controller.view.proposal?.id === requestID) {
      if (reply === "once") await controller.applyProposal()
      else controller.rejectProposal()
      this.sync()
      return
    }
    if (controller.features.review?.id === requestID) {
      controller.features.respond(requestID, reply === "once")
      this.sync()
      return
    }
    const actions = this.approvalActions()
    if (reply === "once") await actions.approve(requestID)
    else await actions.reject(requestID)
    this.sync()
  }

  /** Providers/connections changed: the frontend rebuilds its provider, model and session lists. */
  refreshAll() {
    this.emit({ type: "server.instance.disposed", properties: { directory: this.directory } })
  }

  private ui(): UiActions {
    const controller = this.options.controller
    return {
      openPanel: (name, arg) => {
        this.options.openPanel?.(name, arg)
        this.emit({ type: "uptokey.panel.open", properties: { name, ...(arg ? { arg } : {}) } })
      },
      closePanel: () => this.emit({ type: "uptokey.panel.close", properties: {} }),
      setDraft: (text) => this.appendToPrompt(text),
      exit: () => this.options.exit?.(),
      startService: async () => {
        await controller.start()
      },
      // Tool details, theme and copy map to the frontend's own commands and clipboard (OSC 52 + system).
      toggleExpanded: () => this.emit({ type: "uptokey.keymap.dispatch", properties: { command: "session.toggle.actions" } }),
      setLinear: (on) => {
        // The launcher reopens the same conversation in the linear interface (no alternate screen) for screen readers.
        const fd = Number(process.env.UPTOKEY_TUI_HANDOFF_FD)
        if (!on || !Number.isInteger(fd) || fd < 3) return controller.notice("info", on ? ui("linear_mode_on") : ui("linear_mode_off"))
        try {
          writeSync(fd, JSON.stringify({ screenReader: true, conversationId: controller.state.activeConversation?.id ?? null }))
        } catch {
          return controller.notice("info", ui("linear_mode_on"))
        }
        this.options.exit?.(75)
      },
      setTheme: (name) => this.emit({ type: "uptokey.theme", properties: { name } }),
      copyTranscript: async (scope) => {
        if (controller.state.storagePolicy === "temporary") return controller.notice("warning", selectionUi("temporary_export_forbidden"))
        const messages = controller.store.state.messages.filter((message) => !message.id.startsWith("pending-"))
        const text =
          scope === "response"
            ? ([...messages].reverse().find((message) => message.role === "assistant")?.content ?? "")
            : messages
                .filter((message) => message.role === "user" || message.role === "assistant")
                .map((message) => `## ${message.role === "user" ? ui("copy_label_user") : ui("copy_label_assistant")}\n\n${message.content}`)
                .join("\n\n")
        if (!text.trim()) return controller.notice("info", ui("copy_nothing"))
        this.emit({ type: "uptokey.copy", properties: { text, message: scope === "response" ? ui("copied_response") : ui("copied_conversation") } })
      },
      copyCodeBlock: async () => {
        if (controller.state.storagePolicy === "temporary") return controller.notice("warning", selectionUi("temporary_export_forbidden"))
        const answer = [...controller.store.state.messages].reverse().find((message) => message.role === "assistant")?.content ?? ""
        const code = transcriptCodeBlockText([{ kind: "assistant", id: "copy-response", text: answer }])
        if (!code) return controller.notice("info", ui("copy_no_code"))
        this.emit({ type: "uptokey.copy", properties: { text: code, message: ui("copied_code") } })
      },
      beginTranscriptSelection: () => this.emit({ type: "uptokey.selection.begin", properties: {} }),
      showChatFiles: () => this.emit({ type: "uptokey.panel.open", properties: { name: "file-actions" } }),
    }
  }

  /** Text placed in the composer (a command that still needs its argument, a request about a file). */
  appendToPrompt(text: string) {
    this.emit({ type: "tui.prompt.append", properties: { text } } as never)
  }

  /** Runs an Uptokey command from a panel exactly as if it had been typed. */
  async runUptokeyCommand(command: (typeof COMMANDS)[number], arg = "") {
    await runCommand(command, { controller: this.options.controller, ui: this.ui() }, arg)
  }

  /** Opens a conversation chosen in a panel (search results) and shows it. */
  async openConversation(id: string) {
    await this.openSession(id)
    this.emit({ type: "uptokey.session.navigate", properties: { sessionID: id } })
  }

  /** /revisar: announces the pending decisions again so their review opens (in a conversation if needed). */
  showPendingDecisions() {
    this.permissions.reset()
    this.sync()
  }

  private async openSession(sessionID: string) {
    const controller = this.options.controller
    this.shownSession = sessionID
    if (controller.state.activeConversation?.id === sessionID) return
    await controller.openConversation(sessionID)
    this.sync()
  }

  private async ensureSession(): Promise<string> {
    const controller = this.options.controller
    // The controller creates conversations lazily on first send; the frontend needs an id before navigating.
    return (controller as unknown as { ensureConversation(): Promise<string> }).ensureConversation()
  }

  /**
   * A conversation still carrying the core's default title gets one from its first request, through the canonical
   * CAS-gated update route (same store, same principal). A revision conflict or failure leaves the title unchanged.
   */
  private async titleFromFirstRequest(conversationId: string, text: string) {
    const line = text.split("\n").map((value) => value.trim()).find(Boolean)
    if (!line || line.startsWith("/")) return
    const controller = this.options.controller
    const chars = [...line.replace(/\s+/g, " ")]
    const title = chars.length > 60 ? `${chars.slice(0, 59).join("").trimEnd()}…` : chars.join("")
    // The message append of the same turn also moves the revision: a 409 re-reads it and tries again (bounded).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const conversation = await controller.conversations.getConversation(conversationId)
        if (conversation.title && conversation.title !== DEFAULT_CORE_TITLE) return
        const response = await controller.client.fetchRaw(`/v1/workspace/conversations/${encodeURIComponent(conversationId)}/update`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision: conversation.revision, title }),
        })
        trace("session.autotitle", { status: response.status, attempt })
        if (response.status === 409) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * (attempt + 1)))
          continue
        }
        if (response.ok) {
          const active = controller.state.activeConversation
          if (active?.id === conversationId) active.title = title
          void controller.refreshConversationList().then(() => this.sync(), () => undefined)
          this.sync()
        }
        return
      } catch (error) {
        // Transport failure: the write outcome is unknown and is not replayed; the title may stay the default.
        trace("session.autotitle.failed", { error: error instanceof Error ? error.message : String(error), attempt })
        return
      }
    }
  }

  private async selectDestination(providerID: string, modelID: string) {
    const controller = this.options.controller
    const current = controller.client.getSelectedDestination()
    this.frontendModel = modelID
    if (current.providerId === providerID && controller.state.selectedModel === modelID) return
    await controller.selectProviderModel(modelID, providerID)
  }

  // ─── the SDK client ──────────────────────────────────────────────────

  private createClient() {
    const self = this
    const controller = this.options.controller
    const gate = async <T>(fn: () => T | Promise<T>) => {
      await self.ready
      return fn()
    }
    const known = {
      global: {
        async upgrade() {
            return fail("UnsupportedByUptokey", terminalText('frontend_missing'))
        },
      },
      instance: {
        dispose: () => ok(true),
      },
      config: {
        providers: () =>
          gate(async () => {
            await self.refreshModelInputs()
            const providers = self.connectedProviders()
            return { data: { providers, default: self.defaults(providers) }, error: undefined }
          }),
        get: () => gate(() => ({ data: {}, error: undefined })),
      },
      provider: {
        list: () =>
          gate(async () => {
            await self.refreshModelInputs()
            const snapshot = controller.view.connections
            const connected = self.connectedProviders()
            const all = (snapshot?.providers ?? []).map((provider) => self.toProvider(provider, snapshot?.models ?? []))
            return { data: { all, default: self.defaults(connected), connected: connected.map((provider) => provider.id) }, error: undefined }
          }),
        auth: () => ok({}),
      },
      experimental: {
        capabilities: { get: () => ok({ backgroundSubagents: false }) },
        console: { get: () => ok({ consoleManagedProviders: [], switchableOrgCount: 0 }) },
        resource: { list: () => ok({}) },
      },
      app: {
        agents: () => ok(AGENTS),
      },
      path: {
        get: () =>
          ok<Path>({
            home: self.options.home,
            state: self.options.state,
            config: self.options.config,
            // The folder shown is the linked project's root; events keep routing by the window's own directory.
            worktree: controller.view.binding?.rootPath ?? self.directory,
            directory: controller.view.binding?.rootPath ?? self.directory,
          }),
      },
      project: {
        current: () =>
          gate(() => {
            const binding = controller.view.binding
            const project: Project = {
              id: self.projectID(),
              worktree: binding?.rootPath ?? self.directory,
              name: binding?.projectName,
              time: { created: 0, updated: 0 },
              sandboxes: [],
            }
            return { data: project, error: undefined }
          }),
        directories: () => ok([]),
      },
      command: {
        list: () =>
          ok(
            COMMANDS.flatMap((command) =>
              command.slash.map(
                (name): Command => ({ name, description: command.title, source: "command", template: "", hints: command.arg ? [command.arg] : [] }),
              ),
            ),
          ),
      },
      lsp: { status: () => ok([]) },
      mcp: { status: () => ok({}) },
      formatter: { status: () => ok([]) },
      vcs: {
        get: () => gate(() => ({ data: controller.view.git ? { branch: (controller.view.git as { branch?: string }).branch } : undefined, error: undefined })),
        status: () => ok([]),
      },
      find: {
        files: (params: { query?: string }) => gate(async () => ({ data: (await self.findPaths(params.query ?? "", 5)).map((entry) => entry.path), error: undefined })),
      },
      v2: {
        fs: {
          find: (params: { query?: string; limit?: string | number }) =>
            gate(async () => ({
              data: { data: await self.findPaths(params.query ?? "", Number(params.limit ?? 20)), location: { directory: self.directory } },
              error: undefined,
            })),
        },
      },
      permission: {
        reply: async (params: { requestID: string; reply: "once" | "always" | "reject" }) => {
          // Standing grants do not exist: "always" is never honoured as broader than this one decision.
          await self.permissionReply(params.requestID, params.reply === "reject" ? "reject" : "once")
          return { data: true, error: undefined }
        },
      },
      session: {
        list: () => gate(() => ({ data: self.sessions(), error: undefined })),
        status: () => ok({}),
        async get(params: { sessionID: string }) {
          await self.ready
          await self.openSession(params.sessionID)
          const state = controller.state.activeConversation
          if (!state || state.id !== params.sessionID) return fail("NotFoundError", "conversation_not_found")
          return { data: self.sessionInfo(state.id, state.title, state.updatedAt), error: undefined }
        },
        async messages(params: { sessionID: string; limit?: number }) {
          await self.ready
          await self.openSession(params.sessionID)
          const projected = self.projection()
          return { data: projected.slice(-(params.limit ?? 100)), error: undefined }
        },
        todo: () => ok([]),
        diff: () => ok([]),
        async create(params: { model?: { providerID: string; id: string } }) {
          await self.ready
          if (params.model) await self.selectDestination(params.model.providerID, params.model.id).catch(() => undefined)
          self.creating++
          let id: string
          try {
            id = await self.ensureSession()
            self.shownSession = id
          } finally {
            self.creating--
          }
          self.sync()
          const active = controller.state.activeConversation
          return { data: self.sessionInfo(id, active?.title, active?.updatedAt), error: undefined }
        },
        async prompt(params: { sessionID: string; model?: { providerID: string; modelID: string }; agent?: string; parts: PromptPart[] }) {
          await self.ready
          const conversationId = controller.state.activeConversation?.id
          if (!conversationId || conversationId !== params.sessionID) {
            trace("prompt.rejected", { code: "attachment_changed", sessionMatches: false })
            throw new Error(connectionText("attachment_changed"))
          }
          const binding = controller.view.binding
          const revision = controller.store.conversationRevision
          const storage = controller.state.storagePolicy
          const processing = controller.state.processingPolicy
          const assertCurrent = () => {
            if (controller.state.activeConversation?.id !== conversationId || controller.view.binding !== binding
              || controller.store.conversationRevision !== revision || controller.state.storagePolicy !== storage
              || controller.state.processingPolicy !== processing) throw new Error(connectionText("attachment_changed"))
          }
          if (params.model) await self.selectDestination(params.model.providerID, params.model.modelID)
          assertCurrent()
          if (params.agent === "plan" || params.agent === "build" || params.agent === "autonomous") {
            const autonomy = params.agent === "autonomous"
            controller.setMode(params.agent === "plan" ? "plan" : "build")
            if (controller.view.autonomy !== autonomy) controller.setAutonomy(autonomy)
            self.followedAgent = params.agent
          }
          const prepared = await preparePromptParts(controller, params.parts, {prepareMedia:parts=>controller.prepareMediaInput(parts)}).catch((error) => {
            trace("prompt.rejected", { code: error && typeof error.code === "string" ? error.code : "attachment_read", sessionMatches: controller.state.activeConversation?.id === params.sessionID,
              parts: params.parts.map((part) => ({ type: part.type, synthetic: Boolean(part.synthetic), editor: part.metadata?.kind === "editor_context", ranges: part.metadata?.ranges?.length ?? 0 })) })
            throw error
          })
          assertCurrent()
          const text = prepared.text
          trace("prompt.submit", { busy: controller.busy, turn: controller.state.turn, conversation: controller.state.activeConversation?.id, textLength: text.length, review: Boolean(controller.features.review), steer: controller.view.steer.length })
          const firstRequest = !controller.state.messages.some((message) => message.role === "user")
          // The title is written before the turn starts, never during it: the turn's message appends are CAS-gated on
          // the conversation revision, and a concurrent title write would make them conflict.
          if (firstRequest && conversationId) await self.titleFromFirstRequest(conversationId, text)
          assertCurrent()
          await controller.submit(text, {media:prepared.media})
          trace("prompt.done", { turn: controller.state.turn, messages: controller.state.messages.length, steer: controller.view.steer.length })
          return { data: undefined, error: undefined }
        },
        async command(params: { command: string; arguments?: string }) {
          await self.ready
          trace("session.command", { command: params.command, hasArguments: Boolean(params.arguments) })
          const resolved = resolveSlash(`/${params.command}${params.arguments ? ` ${params.arguments}` : ""}`)
          if (!resolved) return fail("NotFoundError", `command_not_found:${params.command}`)
          await runCommand(resolved.command, { controller, ui: self.ui() }, resolved.arg)
          return { data: undefined, error: undefined }
        },
        async shell(params: { command: string }) {
          await self.ready
          await controller.runShell(params.command)
          return { data: undefined, error: undefined }
        },
        async abort() {
          controller.cancel()
          return { data: true, error: undefined }
        },
        async delete(params: { sessionID: string }) {
          await controller.deleteConversation(params.sessionID)
          return { data: true, error: undefined }
        },
        async fork(params: { sessionID: string; messageID?: string }) {
          await self.ready
          await self.openSession(params.sessionID)
          await controller.fork(params.messageID?.replace(/^msg_/, ""))
          const active = controller.state.activeConversation
          if (!active) return fail("UnknownError", "fork_failed")
          return { data: self.sessionInfo(active.id, active.title, active.updatedAt), error: undefined }
        },
      },
    }
    return withUnsupported(known)
  }
}
