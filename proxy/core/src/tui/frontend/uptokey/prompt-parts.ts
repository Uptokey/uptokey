/** Composer parts enter the canonical context set. No frontend file reads, second journal or implicit remote fetch. */
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { TuiController } from "../../controller.ts"
import { connectionText } from "./integration-connections.ts"
import { MediaInputError, type PreparedMediaInput } from "../../media-input.ts"
import { contextRanges, type ContextRange } from "../../context-ranges.ts"

export interface PromptPart {
  type: string
  text?: string
  synthetic?: boolean
  mime?: string
  filename?: string
  url?: string
  source?: { type?: string; path?: string; text?: { value?: string } }
  metadata?: { kind?: string; filePath?: string; ranges?: unknown[] }
}

/** A shared core media adapter must admit the selected destination and import bytes to real artifacts. */
export type PreparedPromptMedia = PreparedMediaInput

export class PromptPartsError extends Error {
  readonly code: string
  constructor(code: "attachment_unavailable" | "attachment_project" | "attachment_read" | "attachment_changed" | "attachment_busy" | "attachment_size" | "attachment_temporary") {
    super(connectionText(code))
    this.name = "PromptPartsError"
    this.code = code
  }
}

/** Resolve using the real bound root; URLs cannot replace the authority with another folder or host. */
export function promptFilePath(part: PromptPart, rootPath: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(rootPath)
  const paths = windows ? path.win32 : path.posix
  let target: string
  if (part.url !== undefined) {
    try {
      const url = new URL(part.url)
      if (url.protocol !== "file:" || url.search || url.hash) throw new Error("unsupported")
      target = fileURLToPath(url, { windows })
    } catch { throw new PromptPartsError("attachment_unavailable") }
  } else {
    target = part.source?.path ?? ""
  }
  if (!target || /[\x00-\x1f]/.test(target)) throw new PromptPartsError("attachment_read")
  const relative = paths.relative(rootPath, paths.resolve(rootPath, target))
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new PromptPartsError("attachment_project")
  return relative.split(paths.sep).join("/")
}

export async function preparePromptParts(controller: Pick<TuiController, "state" | "view" | "context" | "store" | "busy">, parts: readonly PromptPart[], options: {
  /** Supplied by the canonical controller after model capabilities, retention policy and artifacts are handled. */
  prepareMedia?: (parts: readonly PromptPart[]) => Promise<PreparedPromptMedia>
} = {}): Promise<{ text: string; media?: PreparedPromptMedia }> {
  const text = parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text ?? "").join("\n")
  const binding = controller.view.binding
  const conversationRevision = controller.store.conversationRevision
  const storagePolicy = controller.state.storagePolicy
  const processingPolicy = controller.state.processingPolicy
  const assertCurrent = () => {
    if (controller.view.binding !== binding || controller.store.conversationRevision !== conversationRevision
      || controller.state.storagePolicy !== storagePolicy || controller.state.processingPolicy !== processingPolicy) throw new PromptPartsError("attachment_changed")
  }
  const files = new Map<string, ContextRange[] | undefined>()
  const mediaParts: PromptPart[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.synthetic) continue
      // Editor context carries path metadata: reread it through the verified project root, never trust injected text.
      if (part.metadata?.kind !== "editor_context" || !part.metadata.filePath) throw new PromptPartsError("attachment_unavailable")
      if (!binding) throw new PromptPartsError("attachment_project")
      const ranges = part.metadata.ranges?.length ? contextRanges(part.metadata.ranges) : undefined
      if (ranges === null) throw new PromptPartsError("attachment_read")
      files.set(promptFilePath({ type: "file", source: { path: part.metadata.filePath } }, binding.rootPath), ranges)
      continue
    }
    if (part.type !== "file" || part.source?.type === "resource" || part.mime === "application/x-directory") throw new PromptPartsError("attachment_unavailable")
    if (part.mime?.startsWith("image/") || part.mime?.startsWith("audio/") || part.mime === "application/pdf") {
      if (!options.prepareMedia) throw new PromptPartsError("attachment_unavailable")
      if (part.url?.startsWith("data:")) {
        if (!new RegExp(`^data:${part.mime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};base64,`).test(part.url)) throw new PromptPartsError("attachment_unavailable")
      } else {
        if (!binding) throw new PromptPartsError("attachment_project")
        // Local binary parts are read by the shared core adapter, but first stay inside this verified root.
        promptFilePath(part, binding.rootPath)
      }
      mediaParts.push(part)
      continue
    }
    if (part.mime && part.mime !== "text/plain" && !part.mime.startsWith("text/")) throw new PromptPartsError("attachment_unavailable")
    if (!binding) throw new PromptPartsError("attachment_project")
    files.set(promptFilePath(part, binding.rootPath), undefined)
  }
  // Queued text steering has no per-intention attachment snapshot; do not attach files to an earlier turn.
  if ((files.size || mediaParts.length) && controller.busy) throw new PromptPartsError("attachment_busy")
  const created: string[] = []
  try {
    assertCurrent()
    for (const [file, ranges] of files) {
      const existed = controller.context.has(file)
      const entry = await controller.context.add(file, undefined, ranges)
      if (!existed) created.push(entry.id)
      assertCurrent()
      if (entry.state !== "ready") throw new PromptPartsError("attachment_read")
    }
    const media = mediaParts.length ? await options.prepareMedia!(mediaParts) : undefined
    assertCurrent()
    return { text, ...(media ? { media } : {}) }
  } catch (error) {
    // Only undo newly added entries while still in the captured context; never remove another project's context.
    if (controller.view.binding === binding) {
      for (const id of created) controller.context.remove(id)
    }
    if (error instanceof PromptPartsError) throw error
    if (error instanceof MediaInputError) throw new PromptPartsError(error.code as ConstructorParameters<typeof PromptPartsError>[0])
    throw new PromptPartsError("attachment_read")
  }
}
