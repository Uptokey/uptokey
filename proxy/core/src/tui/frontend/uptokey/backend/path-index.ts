/**
 * Path index of the bound project for @-mentions and file search. It is built with the same paginated listing the
 * controller already uses (no recursive hash, no content read), so protected paths stay excluded by the core, and it
 * is bounded: a very large tree is searched by what was crawled so far, never by touching the whole disk.
 */
import fuzzysort from "fuzzysort"
import type { WorkspaceService } from "../../../workspace.ts"

export interface IndexedPath {
  path: string
  type: "file" | "directory"
}

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".venv", "__pycache__", ".cache", "coverage"])

export class PathIndex {
  private entries: IndexedPath[] = []
  private crawling: Promise<void> | null = null
  private complete = false
  private generation = 0

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly maxEntries = 20_000,
  ) {}

  reset() {
    this.generation++
    this.entries = []
    this.crawling = null
    this.complete = false
  }

  get size() {
    return this.entries.length
  }

  /** Starts (or joins) the background crawl of the given binding. */
  ensure(binding: { projectId: string; rootBindingId: string }) {
    if (this.crawling || this.complete) return this.crawling ?? Promise.resolve()
    const generation = this.generation
    this.crawling = this.crawl(binding, generation).finally(() => {
      if (generation === this.generation) {
        this.complete = true
        this.crawling = null
      }
    })
    return this.crawling
  }

  private async crawl(binding: { projectId: string; rootBindingId: string }, generation: number) {
    const queue: Array<{ path: string; offset: number }> = [{ path: "", offset: 0 }]
    while (queue.length && this.entries.length < this.maxEntries) {
      if (generation !== this.generation) return
      const folder = queue.shift()!
      let page
      try {
        page = await this.workspace.listProjectDirectory(binding.projectId, binding.rootBindingId, folder.path, folder.offset)
      } catch {
        continue
      }
      if (generation !== this.generation) return
      if (page.nextOffset !== null) queue.unshift({ path: folder.path, offset: page.nextOffset })
      for (const entry of page.entries) {
        const name = entry.relativePath.split("/").at(-1) ?? ""
        if (entry.kind === "directory") {
          if (SKIP_DIRECTORIES.has(name)) continue
          this.entries.push({ path: `${entry.relativePath}/`, type: "directory" })
          queue.push({ path: entry.relativePath, offset: 0 })
        } else {
          this.entries.push({ path: entry.relativePath, type: "file" })
        }
      }
    }
  }

  find(query: string, limit: number): IndexedPath[] {
    if (!query) return this.entries.slice(0, limit)
    return fuzzysort.go(query, this.entries, { key: "path", limit }).map((result) => result.obj)
  }
}
