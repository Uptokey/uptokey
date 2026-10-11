/**
 * Local retention gate for the vendored prompt helpers (history, stash): while the active conversation is temporary,
 * what the person types stays in memory only and never reaches the files under the TUI state directory.
 */
import { getBackend } from "./backend/registry.ts"

const ephemeral = new WeakSet<object>()

/** True when text typed now may be written to local prompt files. */
export function mayPersistPrompt(): boolean {
  try {
    return !getBackend().temporary
  } catch {
    return true
  }
}

/** Marks an in-memory entry that must never be written (it was typed in a temporary conversation). */
export function markEphemeral(entry: object) {
  ephemeral.add(entry)
}

export function isEphemeral(entry: object) {
  return ephemeral.has(entry)
}
