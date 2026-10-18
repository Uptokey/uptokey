/**
 * Projection of Uptokey conversation state into the OpenCode message/part model that
 * the vendored terminal frontend renders. Pure functions: no I/O, no clocks except the
 * injected time assigner, so the same transcript always yields the same ids.
 */
import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import type { TranscriptItem } from "../../../transcript.ts"
import type { MessageUsage } from "../../../state.ts"
import { chromeText } from "../../../ui-chrome.ts"

/**
 * What the projected assistant message knows about its measurement. The OpenCode schema has only numbers;
 * this marker keeps "not reported" distinct from a real zero for every Uptokey display.
 */
export interface UptokeyUsageMarker {
  /** `none`: no round of this answer recorded any measurement. `partial`: some rounds did not. */
  usage: "reported" | "estimated" | "partial" | "unavailable" | "none"
  cost: "known" | "partial" | "unknown"
  costBasis?: "charged" | "estimate" | "local" | "free" | "mixed"
  /** Input tokens of the last measured request: the context actually sent. */
  contextTokens: number | null
}

export function usageMarkerOf(message: Message): UptokeyUsageMarker | undefined {
  return (message as { uptokey?: UptokeyUsageMarker }).uptokey
}

/** Folds the measured rounds of one visual answer; never fills a missing value with zero. */
export function foldUsage(rounds: readonly MessageUsage[]): { tokens: AssistantMessage["tokens"]; cost: number; marker: UptokeyUsageMarker } {
  const measured = rounds.filter((round) => round.state !== "unavailable" && (round.input !== undefined || round.output !== undefined))
  const last = measured.at(-1)
  const costed = rounds.filter((round) => round.costMicros !== undefined)
  const bases = [...new Set(costed.map((round) => round.costBasis))]
  const usage = !rounds.length ? "none" : !measured.length ? "unavailable" : measured.length < rounds.length ? "partial"
    : measured.some((round) => round.state === "estimated") ? "estimated" : "reported"
  return {
    tokens: { input: last?.input ?? 0, output: last?.output ?? 0, reasoning: last?.reasoning ?? 0, cache: { read: last?.cached ?? 0, write: 0 } },
    cost: costed.reduce((sum, round) => sum + (round.costMicros ?? 0), 0) / 1_000_000,
    marker: {
      usage,
      cost: !costed.length ? "unknown" : costed.length < rounds.length ? "partial" : "known",
      ...(bases.length === 1 && bases[0] ? { costBasis: bases[0] } : bases.length > 1 ? { costBasis: "mixed" as const } : {}),
      contextTokens: last?.input ?? null,
    },
  }
}

export interface ProjectionContext {
  sessionID: string
  providerID: string
  modelID: string
  agent: string
  cwd: string
  /** Stable creation time per message id, monotonic in projection order. */
  time: (messageID: string, hint?: number) => number
  /** Time hint (epoch ms) for a transcript item id, when the canonical message carries one. */
  hint: (itemID: string) => number | undefined
  now: () => number
}

export interface ProjectedMessage {
  info: Message
  parts: Part[]
}

const TOOL_ALIASES: Record<string, string> = {
  read_file: "read",
  find_files: "glob",
  search_in_files: "grep",
  execute_command: "bash",
  web_fetch: "webfetch",
  web_search: "websearch",
}

export function messageIdOf(first: TranscriptItem) {
  return `msg_${first.id}`
}

export function partIdOf(item: TranscriptItem) {
  return `prt_${item.id}`
}

/** Tool arguments arrive as a (possibly truncated) JSON string; keep what parses, never invent fields. */
function parseArguments(summary: string): Record<string, unknown> {
  try {
    const value = JSON.parse(summary)
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // truncated summaries stay textual
  }
  return summary ? { summary } : {}
}

function toolInput(name: string, summary: string): Record<string, unknown> {
  const args = parseArguments(summary)
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined)
  const number = (key: string) => (typeof args[key] === "number" ? (args[key] as number) : undefined)
  switch (name) {
    case "read_file": {
      const start = number("startLine")
      const end = number("endLine")
      return {
        filePath: text("path") ?? text("summary") ?? "",
        ...(start !== undefined ? { offset: start } : {}),
        ...(start !== undefined && end !== undefined ? { limit: end - start + 1 } : {}),
      }
    }
    case "find_files":
      return { pattern: text("query") ?? text("pattern") ?? text("summary") ?? "", ...(text("path") ? { path: text("path") } : {}) }
    case "search_in_files":
      return { pattern: text("query") ?? text("pattern") ?? text("summary") ?? "", ...(text("path") ? { path: text("path") } : {}) }
    case "execute_command": {
      const argv = Array.isArray(args.argv) ? (args.argv as unknown[]).filter((part): part is string => typeof part === "string") : []
      return { command: text("command") ?? (argv.length ? argv.join(" ") : (text("summary") ?? "")), description: text("description") ?? "" }
    }
    case "web_fetch":
      return { url: text("url") ?? text("summary") ?? "" }
    case "web_search":
      return { query: text("query") ?? text("summary") ?? "" }
    default:
      return args
  }
}

function toolPart(item: Extract<TranscriptItem, { kind: "tool" }>, ctx: ProjectionContext, messageID: string, started: number): ToolPart {
  const tool = TOOL_ALIASES[item.name] ?? item.name
  const base = { id: partIdOf(item), sessionID: ctx.sessionID, messageID, type: "tool" as const, callID: item.id, tool }
  const input = toolInput(item.name, item.summary)
  const metadata = { uptokeyTool: item.name, ...(item.status === "rejected" ? { uptokeyOutcome: "not_executed" } : {}), ...(item.receipt ? { receiptId: item.receipt } : {}) }
  // SDK "completed" means terminal. The metadata retains neutral non-execution for the renderer.
  if (item.status === "done" || item.status === "rejected") {
    return { ...base, metadata, state: { status: "completed", input, output: item.detail ?? "", title: item.name, metadata, time: { start: started, end: started } } }
  }
  if (item.status === "error") {
    return { ...base, metadata, state: { status: "error", input, error: item.detail ?? item.status, metadata, time: { start: started, end: started } } }
  }
  return { ...base, metadata, state: { status: "running", input, title: item.name, metadata, time: { start: started } } }
}

/** Non-conversational items (notices, proposals, runs, tasks) travel as typed tool parts rendered by Uptokey views. */
function auxiliaryPart(item: TranscriptItem, ctx: ProjectionContext, messageID: string, started: number): Part {
  const base = { id: partIdOf(item), sessionID: ctx.sessionID, messageID, type: "tool" as const, callID: item.id }
  const done = (tool: string, input: Record<string, unknown>, title: string, output = ""): Part => ({
    ...base,
    tool,
    state: { status: "completed", input, output, title, metadata: { uptokeyKind: item.kind }, time: { start: started, end: started } },
  })
  switch (item.kind) {
    case "notice":
      return done("uptokey_notice", { level: item.level, text: item.text, hint: item.hint ?? "" }, item.text, item.text)
    case "change":
      return done("uptokey_change", { title: item.title, files: item.files, state: item.state, receipt: item.receipt ?? null, hint: item.hint ?? "" }, item.title)
    case "run":
      return done("uptokey_run", { title: item.title, state: item.state, detail: item.detail ?? "", receipt: item.receipt ?? null }, item.title, item.detail ?? "")
    case "task":
      return done("uptokey_task", { title: item.title, state: item.state, children: item.children, detail: item.detail ?? "" }, item.title, item.detail ?? "")
    case "intro":
      return done("uptokey_notice", { level: "info", text: item.lines.join("\n"), hint: "" }, item.title, item.lines.join("\n"))
    default:
      return done("uptokey_notice", { level: "info", text: "", hint: "" }, "")
  }
}

/** The frontend store keeps parts sorted by id, so ids carry the position: the display order is the projection order. */
function orderedParts(parts: Part[]): Part[] {
  return parts.map((part, index) => ({ ...part, id: `prt_${String(index).padStart(4, "0")}_${part.id.replace(/^prt_/, "")}` }) as Part)
}

/**
 * A canonical assistant message that carries both an answer and tool calls with results is stored without part order;
 * its answer is produced after the results, so the calls are shown first. Calls without a result keep their position.
 */
function toolsBeforeAnswer(items: readonly TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (item.kind !== "assistant" || item.streaming) {
      out.push(item)
      continue
    }
    const tools: TranscriptItem[] = []
    let next = index + 1
    while (next < items.length) {
      const candidate = items[next]!
      if (candidate.kind !== "tool" || !candidate.id.startsWith(`${item.id}:`) || candidate.status === "pending" || candidate.status === "running") break
      tools.push(candidate)
      next++
    }
    out.push(...tools, item)
    index = next - 1
  }
  return out
}

/**
 * Groups transcript items into OpenCode messages: every user item opens a user message; everything
 * that follows until the next user item belongs to one assistant message, in transcript order.
 */
export function projectTranscript(rawItems: readonly TranscriptItem[], ctx: ProjectionContext): ProjectedMessage[] {
  const items = toolsBeforeAnswer(rawItems)
  const out: ProjectedMessage[] = []
  let assistant: { message: AssistantMessage; parts: Part[]; rounds: MessageUsage[] } | undefined
  let lastUser: string | undefined

  const closeAssistant = (completed: boolean) => {
    if (!assistant) return
    const folded = foldUsage(assistant.rounds)
    assistant.message.tokens = folded.tokens
    assistant.message.cost = folded.cost
    ;(assistant.message as AssistantMessage & { uptokey?: UptokeyUsageMarker }).uptokey = folded.marker
    const lastPart = assistant.parts.at(-1)
    const streaming = lastPart?.type === "text" && lastPart.time?.end === undefined && assistant.message.time.completed === undefined && !completed
    if (completed && !streaming) assistant.message.time.completed = assistant.message.time.completed ?? ctx.time(assistant.message.id)
    out.push({ info: assistant.message, parts: orderedParts(assistant.parts) })
    assistant = undefined
  }

  const ensureAssistant = (first: TranscriptItem) => {
    if (assistant) return assistant
    const id = messageIdOf(first)
    const created = ctx.time(id, ctx.hint(first.id))
    assistant = {
      message: {
        id,
        sessionID: ctx.sessionID,
        role: "assistant",
        time: { created },
        parentID: lastUser ?? "",
        modelID: ctx.modelID,
        providerID: ctx.providerID,
        mode: ctx.agent,
        agent: ctx.agent,
        path: { cwd: ctx.cwd, root: ctx.cwd },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
      rounds: [],
    }
    return assistant
  }

  for (const item of items) {
    if (item.kind === "user") {
      closeAssistant(true)
      const id = messageIdOf(item)
      const created = ctx.time(id, ctx.hint(item.id) ?? (item.time ? Date.parse(item.time) : undefined))
      const info: UserMessage = {
        id,
        sessionID: ctx.sessionID,
        role: "user",
        time: { created },
        agent: ctx.agent,
        model: { providerID: ctx.providerID, modelID: ctx.modelID },
      }
      const parts: Part[] = [{ id: partIdOf(item), sessionID: ctx.sessionID, messageID: id, type: "text", text: item.text, time: { start: created, end: created } }]
      for (const [index, attachment] of (item.attachments ?? []).entries()) {
        parts.push({ id: `${partIdOf(item)}:file:${index}`, sessionID: ctx.sessionID, messageID: id, type: "file", mime: "text/plain", filename: attachment, url: attachment })
      }
      for (const [index, attachment] of (item.mediaAttachments ?? []).entries()) {
        parts.push({ id: `${partIdOf(item)}:media:${index}`, sessionID: ctx.sessionID, messageID: id, type: "file", mime: "application/octet-stream", filename: attachment.name ?? attachment.artifactId, url: `uptokey-artifact:${attachment.artifactId}` })
      }
      out.push({ info, parts: orderedParts(parts) })
      lastUser = id
      continue
    }

    const current = ensureAssistant(item)
    if ((item.kind === "assistant" || item.kind === "tool") && item.usage) current.rounds.push(item.usage)
    const started = ctx.time(current.message.id)
    const messageID = current.message.id
    if (item.kind === "assistant") {
      const text = item.interrupted ? `${item.text}${item.text ? "\n\n" : ""}[${chromeText(item.interrupted === "cancelled" ? "interrupted" : "incomplete")}]` : item.text
      current.parts.push({
        id: partIdOf(item),
        sessionID: ctx.sessionID,
        messageID,
        type: "text",
        text,
        time: item.streaming ? { start: started } : { start: started, end: started },
      })
      if (item.interrupted) {
        current.message.error = { name: "MessageAbortedError", data: { message: item.interrupted === "cancelled" ? "cancelled" : "interrupted" } } as AssistantMessage["error"]
      }
      if (item.streaming) current.message.time.completed = undefined
      continue
    }
    if (item.kind === "tool") {
      current.parts.push(toolPart(item, ctx, messageID, started))
      continue
    }
    if (item.kind === "reasoning") {
      // Live reasoning of the turn in progress: open until the answer or a tool call follows.
      const start = item.startedAt ?? started
      current.parts.push({ id: partIdOf(item), sessionID: ctx.sessionID, messageID, type: "reasoning", text: item.text, time: item.done ? { start, end: item.endedAt ?? start } : { start } })
      continue
    }
    if (item.kind === "compaction") {
      current.parts.push({ id: partIdOf(item), sessionID: ctx.sessionID, messageID, type: "compaction", auto: false } as Part)
      current.parts.push({ id: `${partIdOf(item)}:summary`, sessionID: ctx.sessionID, messageID, type: "text", text: item.summary, time: { start: started, end: started } })
      continue
    }
    current.parts.push(auxiliaryPart(item, ctx, messageID, started))
  }
  const streaming = assistant && (assistant as { parts: Part[] }).parts.some((part) => part.type === "text" && part.time?.end === undefined)
  closeAssistant(!streaming)
  return out
}

/** Stable creation times: assigned on first sight, strictly increasing. Reset to renumber after a structural change. */
export function createTimeAssigner(now: () => number = Date.now) {
  const assigned = new Map<string, number>()
  let last = 0
  return {
    assign(id: string, hint?: number) {
      const known = assigned.get(id)
      if (known !== undefined) return known
      const candidate = Math.max(hint ?? now(), last + 1)
      assigned.set(id, candidate)
      last = candidate
      return candidate
    },
    has: (id: string) => assigned.has(id),
    reset() {
      assigned.clear()
      last = 0
    },
  }
}
