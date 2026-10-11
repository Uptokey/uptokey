/**
 * Finds folders the person names in ordinary request text ("trabalhe nesta pasta: C:\\projetos\\app").
 * Detection is deterministic and local: a candidate must exist on disk as a directory (or be a file whose directory
 * is used) and must lie outside the folder already bound. Acting on it always goes through a confirmation, so a
 * path quoted in passing never widens access by itself.
 */
import { stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CANDIDATE = [
  /(?:^|[\s"'`(\[])([A-Za-z]:[\\/][^\s"'`<>|?*)\]]*)/g,
  /(?:^|[\s"'`(\[])(~[\\/][^\s"'`<>|?*)\]]*)/g,
  /(?:^|[\s"'`(\[])((?:\/[^\s"'`<>|?*)\]/]+){2,}\/?)/g,
]

function clean(raw: string) {
  const trimmed = raw.replace(/[.,;:!?]+$/, "")
  return trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed
}

function inside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Folders named in `text` that exist and are not within `boundRoot`, in order of appearance, without duplicates. */
export async function mentionedFolders(text: string, boundRoot: string | undefined): Promise<string[]> {
  const found: string[] = []
  const seen = new Set<string>()
  for (const pattern of CANDIDATE) {
    for (const match of text.matchAll(pattern)) {
      const raw = clean(match[1] ?? "")
      if (raw.length < 3 || raw.length > 2048 || seen.has(raw)) continue
      seen.add(raw)
      try {
        const info = await stat(raw)
        const folder = info.isDirectory() ? raw : path.dirname(raw)
        const normalized = path.resolve(folder)
        if (boundRoot && inside(boundRoot, normalized)) continue
        if (!found.includes(normalized)) found.push(normalized)
      } catch {
        // not a path on this machine: ordinary text
      }
    }
  }
  return found
}
