/** Media uses the existing authorized workspace/artifact services and declared connection capabilities. */
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_INFERENCE_REQUEST_BYTES } from "@uptokey/sync-contract/limits"
import type { ConnectionView } from "@uptokey/sync-contract/connections"
import { extractPdfSafe } from "../workspace/artifact-transforms.ts"
import type { TuiClient, TuiInferenceDestination } from "./client.ts"
import type { ProjectBinding } from "./project-binding.ts"
import type { WorkspaceService } from "./workspace.ts"
import { fileReferencePart } from "./conversations.ts"

export type MediaDispatchPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } } | { type: "input_audio"; input_audio: { data: string; format: string } }
export interface MediaInputPart { mime?: string; filename?: string; url?: string; source?: { path?: string } }
export interface PreparedMediaInput {
  projectId: string
  rootBindingId: string
  model: string
  destination: TuiInferenceDestination
  dispatchParts: MediaDispatchPart[]
  persistedParts: Array<Record<string, unknown>>
}
export class MediaInputError extends Error {
  readonly code: string
  constructor(code: "attachment_unavailable" | "attachment_project" | "attachment_read" | "attachment_changed" | "attachment_size" | "attachment_temporary") { super(code); this.code = code; this.name = "MediaInputError" }
}
const SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const MEDIA_INPUT_MAX_BYTES = 512 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function scopedAttachmentPath(part: MediaInputPart, rootPath: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(rootPath)
  const paths = windows ? path.win32 : path.posix
  let target = part.source?.path ?? ""
  if (part.url?.startsWith("file:")) {
    try {
      const url = new URL(part.url)
      if (url.search || url.hash) throw new Error()
      target = fileURLToPath(url, { windows })
    } catch { throw new MediaInputError("attachment_unavailable") }
  }
  if (!target || /[\x00-\x1f]/.test(target)) throw new MediaInputError("attachment_read")
  const relative = paths.relative(rootPath, paths.resolve(rootPath, target))
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new MediaInputError("attachment_project")
  return relative.split(paths.sep).join("/")
}

/** Mirrors the router's priority rule, then pins its exact account so a later picker change cannot retarget bytes. */
export function declaredMediaConnection(connections: readonly ConnectionView[], destination: TuiInferenceDestination, model: string, kinds: readonly ("image" | "audio")[]): ConnectionView {
  const explicit = destination.connectionId && UUID.test(destination.connectionId) ? destination.connectionId : null
  const eligible = connections.filter((profile) => profile.providerId === destination.providerId && profile.enabled && (!explicit || profile.id === explicit))
  const profile = explicit ? eligible[0] : eligible.reduce<ConnectionView | undefined>((best, candidate) => !best || candidate.priority > best.priority ? candidate : best, undefined)
  if (!profile || !profile.id || !profile.credentialPresent && profile.accessMode !== "local" || !profile.modelIds.includes(model)
    || kinds.some((kind) => !(kind === "image" ? profile.imageInputModels : profile.audioInputModels)?.includes(model))) throw new MediaInputError("attachment_unavailable")
  return profile
}

export async function assertMediaDestination(client: Pick<TuiClient, "fetchAuth">, destination: TuiInferenceDestination, model: string, kinds: readonly ("image" | "audio")[], signal?: AbortSignal): Promise<TuiInferenceDestination> {
  if (!kinds.length) return destination
  const response = await client.fetchAuth("/local/connections", { signal })
  if (!response.ok) throw new MediaInputError("attachment_unavailable")
  const value = await response.json() as { connections?: ConnectionView[] }
  if (!Array.isArray(value.connections)) throw new MediaInputError("attachment_unavailable")
  const profile = declaredMediaConnection(value.connections, destination, model, kinds)
  return Object.freeze({ ...destination, connectionId: profile.id, modelId: model })
}

export async function prepareMediaInput(input: {
  client: Pick<TuiClient, "fetchAuth">
  workspace: Pick<WorkspaceService, "readFile" | "getProject" | "importMediaArtifact">
  binding: ProjectBinding | null
  destination: TuiInferenceDestination
  model: string
  storagePolicy: "local" | "temporary"
  processingPolicy: "local_only" | "external_allowed"
  parts: readonly MediaInputPart[]
  assertCurrent(): void
  signal?: AbortSignal
}): Promise<PreparedMediaInput> {
  if (!input.binding) throw new MediaInputError("attachment_project")
  if (input.storagePolicy === "temporary") throw new MediaInputError("attachment_temporary")
  if (!input.parts.length || input.parts.length > 8) throw new MediaInputError("attachment_size")
  const kinds = [...new Set(input.parts.flatMap((part) => part.mime?.startsWith("image/") ? ["image" as const] : part.mime?.startsWith("audio/") ? ["audio" as const] : []))]
  let destination = await assertMediaDestination(input.client, input.destination, input.model, kinds, input.signal)
  input.assertCurrent()
  // Local-only policy is also enforced by the router. Do not import a file for an already prohibited dispatch.
  if (input.processingPolicy === "local_only" && kinds.length) {
    const response = await input.client.fetchAuth("/local/connections", { signal: input.signal })
    const value = await response.json() as { connections?: ConnectionView[] }
    if (value.connections?.find((item) => item.id === destination.connectionId)?.accessMode !== "local") throw new MediaInputError("attachment_unavailable")
    input.assertCurrent()
  }
  const prepared: PreparedMediaInput = { projectId: input.binding.projectId, rootBindingId: input.binding.rootBindingId, model: input.model, destination, dispatchParts: [], persistedParts: [] }
  let total = 0
  // Validate and read all inputs before the first artifact write.
  const files: Array<{ mime: string; bytes: Uint8Array; relativePath?: string; filename?: string }> = []
  for (const part of input.parts) {
    const mime = part.mime ?? ""
    if (!["image/png", "image/jpeg", "image/webp", "audio/mpeg", "application/pdf"].includes(mime)) throw new MediaInputError("attachment_unavailable")
    let bytes: Uint8Array
    let relativePath: string | undefined
    const hasFilePath = part.url?.startsWith("file:") || part.source?.path && part.source.path !== "clipboard"
    if (hasFilePath || !part.url?.startsWith("data:")) {
      relativePath = scopedAttachmentPath(part, input.binding.rootPath)
      bytes = await input.workspace.readFile(input.binding.projectId, input.binding.rootBindingId, relativePath, input.signal)
      input.assertCurrent()
    } else {
      const prefix = `data:${mime};base64,`
      if (!part.url.startsWith(prefix)) throw new MediaInputError("attachment_unavailable")
      const base64 = part.url.slice(prefix.length)
      if (!base64.length || base64.length > Math.ceil(MEDIA_INPUT_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new MediaInputError("attachment_size")
      bytes = new Uint8Array(Buffer.from(base64, "base64"))
    }
    total += bytes.byteLength
    if (!bytes.byteLength || total > MEDIA_INPUT_MAX_BYTES) throw new MediaInputError("attachment_size")
    if (mime === "application/pdf" && !relativePath) throw new MediaInputError("attachment_unavailable")
    files.push({ mime, bytes, ...(relativePath ? { relativePath } : {}), filename: part.filename })
  }
  for (const file of files) {
    input.assertCurrent()
    if (file.mime === "application/pdf") {
      const extracted = extractPdfSafe(file.bytes)
      if (extracted.status !== "succeeded" || !extracted.text?.trim()) throw new MediaInputError("attachment_unavailable")
      prepared.dispatchParts.push({ type: "text", text: `[PDF ${file.relativePath}; sha256 ${SHA(file.bytes)}]\n${extracted.text}` })
      prepared.persistedParts.push(fileReferencePart({ rootBindingId: input.binding.rootBindingId, relativePath: file.relativePath!, sha256: SHA(file.bytes), byteLength: file.bytes.byteLength }))
      continue
    }
    const project = await input.workspace.getProject(input.binding.projectId)
    input.assertCurrent()
    if (!project || project.id !== input.binding.projectId || !Number.isSafeInteger(project.revision)) throw new MediaInputError("attachment_changed")
    const saved = await input.workspace.importMediaArtifact(input.binding.projectId, project.revision!, file.mime, file.bytes, input.signal)
    input.assertCurrent()
    const kind = file.mime.startsWith("image/") ? "image" : "audio"
    const name = file.filename?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200)
    prepared.persistedParts.push({ type: kind, artifactRef: saved.artifactId, ...(name ? { name } : {}) })
    prepared.dispatchParts.push(kind === "image" ? { type: "image_url", image_url: { url: `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}` } } : { type: "input_audio", input_audio: { data: Buffer.from(file.bytes).toString("base64"), format: "mp3" } })
  }
  if (Buffer.byteLength(JSON.stringify(prepared.dispatchParts)) > MAX_INFERENCE_REQUEST_BYTES - 4096) throw new MediaInputError("attachment_size")
  destination = await assertMediaDestination(input.client, destination, input.model, kinds, input.signal)
  input.assertCurrent()
  return { ...prepared, destination }
}

export async function resolveMediaArtifact(input: {
  client: Pick<TuiClient, "fetchAuth">
  workspace: Pick<WorkspaceService, "readArtifactMedia">
  projectId: string
  artifactId: string
  kind: "image" | "audio"
  destination: TuiInferenceDestination
  model: string
  signal?: AbortSignal
}): Promise<{ part: MediaDispatchPart; destination: TuiInferenceDestination }> {
  const destination = await assertMediaDestination(input.client, input.destination, input.model, [input.kind], input.signal)
  const artifact = await input.workspace.readArtifactMedia(input.projectId, input.artifactId, input.signal)
  if (artifact.bytes.byteLength > MEDIA_INPUT_MAX_BYTES || input.kind === "image" && !["image/png", "image/jpeg", "image/webp"].includes(artifact.mediaType)
    || input.kind === "audio" && artifact.mediaType !== "audio/mpeg") throw new MediaInputError("attachment_unavailable")
  return { destination, part: input.kind === "image" ? { type: "image_url", image_url: { url: `data:${artifact.mediaType};base64,${Buffer.from(artifact.bytes).toString("base64")}` } }
    : { type: "input_audio", input_audio: { data: Buffer.from(artifact.bytes).toString("base64"), format: "mp3" } } }
}
