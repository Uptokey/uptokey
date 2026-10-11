/** Startup milestones for the development trace (UPTOKEY_TUI_DEBUG_LOG); a no-op otherwise. */
import { getBackend } from "./backend/registry.ts"

export function traceBoot(event: string, data: Record<string, unknown> = {}) {
  if (!process.env.UPTOKEY_TUI_DEBUG_LOG) return
  try {
    getBackend().trace(event, { sinceStartMs: Math.round(performance.now()), ...data })
  } catch {
    // the backend may not exist yet; tracing never affects startup
  }
}
