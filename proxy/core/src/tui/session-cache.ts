/**
 * Uptokey TUI — Persistent session metadata cache.
 *
 * This module stores ONLY lightweight metadata (IDs, titles, timestamps)
 * for fast local listing and search. The canonical transcript lives in
 * the proxy core (ConversationStore). This cache never stores message
 * content, avoiding uncontrolled transcript duplication.
 *
 * Storage policy enforcement:
 * - "local": metadata cache is written (IDs, titles, timestamps only)
 * - "temporary": no disk writes; metadata stays in memory
 * - "ephemeral": nothing persists; cleared on exit
 *
 * Search delegates to the authenticated core endpoint
 * GET /v1/workspace/conversations/search when available.
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CachedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model?: string;
  projectRoot?: string;
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  preview: string;
  score: number;
  timestamp: number;
}

const CACHE_DIR = join(homedir(), ".uptokey", "tui", "cache");

/**
 * Lightweight metadata cache. No message content is persisted here.
 */
export class ConversationCache {
  private dir: string;
  private index: Map<string, CachedConversation> = new Map();
  private initialized = false;

  constructor(cacheDir?: string) {
    this.dir = cacheDir ?? CACHE_DIR;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.storagePolicy === "local") {
      await mkdir(join(this.dir, "conversations"), { recursive: true });
    }
    await this.loadIndex();
    this.initialized = true;
  }

  private async loadIndex(): Promise<void> {
    if (this.storagePolicy !== "local") return;
    try {
      const data = await readFile(join(this.dir, "index.json"), "utf-8");
      const parsed = JSON.parse(data) as CachedConversation[];
      for (const conv of parsed) {
        this.index.set(conv.id, conv);
      }
    } catch {
      // No index yet
    }
  }

  private async saveIndex(): Promise<void> {
    if (this.storagePolicy !== "local") return;
    const data = JSON.stringify([...this.index.values()], null, 2);
    await writeFile(join(this.dir, "index.json"), data);
  }

  /** Storage policy: only cache if local is allowed. */
  private storagePolicy: "local" | "temporary" | "ephemeral" = "local";
  setStoragePolicy(policy: "local" | "temporary" | "ephemeral"): void { this.storagePolicy = policy; }

  setPrincipal(principalId?: string): void {
    if (principalId) {
      const sanitized = principalId.replace(/[^a-zA-Z0-9_-]/g, "_");
      this.dir = join(homedir(), ".uptokey", "tui", "cache", sanitized);
      this.initialized = false;
      this.index.clear();
    }
  }

  /**
   * Cache ONLY conversation metadata (no message content).
   */
  async cacheConversation(conv: CachedConversation): Promise<void> {
    if (this.storagePolicy !== "local") return;
    await this.init();
    this.index.set(conv.id, conv);
    await this.saveIndex();
  }

  /**
   * No longer writes message content to disk. The proxy ConversationStore
   * is the single source of truth for transcript data.
   */
  async cacheMessages(_conversationId: string, _messages: unknown[]): Promise<void> {
    // Intentional no-op: transcript lives in the proxy core only.
    // Update metadata index without persisting content.
    if (this.storagePolicy !== "local") return;
    // Metadata updates happen through cacheConversation.
  }

  /**
   * Returns empty — messages are loaded from the proxy, not this cache.
   */
  async getMessages(_conversationId: string): Promise<never[]> {
    return [];
  }

  async listConversations(): Promise<CachedConversation[]> {
    await this.init();
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Local metadata search: only matches against cached titles and IDs.
   * Full-text search should route to the authenticated core endpoint.
   */
  async search(query: string, limit: number = 20): Promise<SearchHit[]> {
    await this.init();
    const normalizedQuery = query.toLowerCase();
    const hits: SearchHit[] = [];

    for (const [convId, meta] of this.index) {
      if (meta.title.toLowerCase().includes(normalizedQuery)) {
        hits.push({
          messageId: convId,
          conversationId: convId,
          preview: meta.title,
          score: meta.title.toLowerCase().startsWith(normalizedQuery) ? 1.0 : 0.5,
          timestamp: meta.updatedAt,
        });
      }
    }

    return hits
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Clear all cached data. Called on ephemeral session cleanup.
   */
  async clear(): Promise<void> {
    this.index.clear();
    if (this.storagePolicy === "ephemeral") {
      // Remove cached files for ephemeral sessions
      try {
        const indexPath = join(this.dir, "index.json");
        await rm(indexPath, { force: true });
        const convDir = join(this.dir, "conversations");
        await rm(convDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      this.initialized = false;
    }
  }
}
