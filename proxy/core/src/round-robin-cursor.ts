/**
 * Atomic round-robin cursor with compare-and-swap increment.
 * Ensures concurrent requests don't all pick the same candidate.
 * The cursor is keyed by combo revision so a policy change resets rotation.
 */

export class RoundRobinCursorRegistry {
  private readonly cursors = new Map<string, number>();
  private readonly persisted: Map<string, number> | undefined;

  constructor(persisted?: Map<string, number>) {
    this.persisted = persisted;
  }

  /**
   * Atomically advance and return the next cursor value for a combo.
   * Uses CAS-style locking via single-threaded JS event loop guarantees.
   * Key includes revision so a policy change resets rotation.
   */
  advance(comboId: string, revision: number, candidateCount: number): number {
    if (candidateCount <= 0) return 0;
    const key = `${comboId}@${revision}`;
    const current = this.cursors.get(key) ?? this.persisted?.get(key) ?? 0;
    const next = ((current + 1) % candidateCount + candidateCount) % candidateCount;
    this.cursors.set(key, next);
    this.persisted?.set(key, next);
    return current % candidateCount;
  }

  /** Read current cursor without advancing; used for projections/UI. */
  peek(comboId: string, revision: number): number {
    const key = `${comboId}@${revision}`;
    return this.cursors.get(key) ?? this.persisted?.get(key) ?? 0;
  }

  /** Export cursors for persistence/reload. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of this.cursors) out[key] = value;
    return out;
  }

  /** Restore cursors from persisted state (reload). */
  restore(snapshot: Record<string, number>): void {
    this.cursors.clear();
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        this.cursors.set(key, Math.floor(value));
      }
    }
  }
}
