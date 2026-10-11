/**
 * Uptokey TUI — C8 watch mode (edit by comment, Aider `--watch` style).
 *
 * Watches the project for saved files carrying a fresh AI instruction comment:
 *
 *   // AI:  refactor to use map   → notify only (default; the user decides)
 *   // AI?  add tests             → notify, plan-only intent
 *   // AI!  rename this fn        → auto-apply, ONLY under an explicit watch grant
 *
 * Security: the default is notify-only. `AI!` never runs anything by itself —
 * auto-apply requires `options.autoApply === true` AND a `WatchGrant` scoped to
 * the exact file with a 15-minute window minted from an explicit user gesture
 * (the W5 of the authorized write flow). Without the grant the event is
 * reported as blocked and nothing is submitted.
 *
 * Zero new dependencies: the watcher is Node's `fs.watch` (recursive), with an
 * injectable factory so tests use a FakeFS observer. Detection is line-based
 * on comment prefixes only — prose, URLs and strings containing "AI:" never
 * match. The comment itself is never modified by this module; removal happens
 * through the governed write flow after the instruction is processed.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";

export type AiMarker = "AI:" | "AI!" | "AI?";
export type AiMode = "notify" | "plan" | "auto";

export interface AiComment {
  path: string;
  line: number;
  marker: AiMarker;
  mode: AiMode;
  text: string;
}

/**
 * Line-based detection: a comment prefix (// /* # -- ;) followed by the AI
 * marker, whitespace, and a non-empty instruction. Anchored to the line start
 * so `const x = "AI: y"`, `// NOT AI: z` and URLs are false-positive-free.
 */
const AI_COMMENT = /^[ \t]*(?:\/\/+|#+|\/\*+|\*+|--|;+)[ \t]*AI([!?:])[ \t]+(\S.*\S|\S)[ \t]*$/;

export function detectAiComment(source: string, path: string): AiComment | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = AI_COMMENT.exec(lines[i]!);
    if (!match) continue;
    const punctuation = match[1] as "!" | "?" | ":";
    const marker: AiMarker = punctuation === "!" ? "AI!" : punctuation === "?" ? "AI?" : "AI:";
    const mode: AiMode = punctuation === "!" ? "auto" : punctuation === "?" ? "plan" : "notify";
    const text = match[2]!.replace(/\*\/[ \t]*$/, "").trim();
    if (!text) continue;
    return { path, line: i + 1, marker, mode, text };
  }
  return null;
}

/** Grant for `AI!` auto-apply: one file, 15 minutes, minted from an explicit gesture. */
export interface WatchGrant {
  consentRef: string;
  /** Repo-relative path this grant covers. */
  scopePath: string;
  issuedAt: string;
  expiresAt: string;
}

export const WATCH_GRANT_TTL_MS = 15 * 60_000;

export function createWatchGrant(input: { consentRef: string; scopePath: string; issuedAt: string }): WatchGrant {
  if (typeof input.consentRef !== "string" || input.consentRef.length < 8) throw new Error("watch_grant_invalid");
  if (typeof input.scopePath !== "string" || !input.scopePath.trim() || input.scopePath.includes("..")) throw new Error("watch_grant_invalid");
  const issued = Date.parse(input.issuedAt);
  if (!Number.isFinite(issued)) throw new Error("watch_grant_invalid");
  return {
    consentRef: input.consentRef,
    scopePath: normalizePath(input.scopePath),
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + WATCH_GRANT_TTL_MS).toISOString(),
  };
}

export function watchGrantCovers(grant: WatchGrant, path: string, now: string): boolean {
  const t = Date.parse(now);
  return Number.isFinite(t) && t >= Date.parse(grant.issuedAt) && t < Date.parse(grant.expiresAt)
    && normalizePath(path) === grant.scopePath;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface WatchEvent {
  kind: "instruction" | "blocked";
  path: string;
  line: number;
  marker: AiMarker;
  mode: AiMode;
  text: string;
  /** Why auto-apply did not run (blocked events only). */
  reason?: "watch_auto_apply_disabled" | "watch_grant_missing" | "watch_grant_expired" | "watch_grant_scope";
}

export interface WatchHost {
  /** TUI notification surface; the user turns `notify` events into turns. */
  notify(event: WatchEvent): unknown;
  /** Only invoked for `AI!` under a valid grant — never by `AI:`/`AI?`. */
  submit(text: string, context: { path: string; grant: WatchGrant }): unknown | Promise<unknown>;
}

export interface WatcherFactory {
  (root: string, onChange: (path: string) => void): { close(): void };
}

export interface WatchOptions {
  /** Restrict detection to one repo-relative path (the `/watch scope <path>`). */
  scope?: string;
  /** Master switch for `AI!`; still requires a grant per event. Default false. */
  autoApply?: boolean;
  /** Injectable clock (ISO); defaults to now. */
  now?: () => string;
  /** Injectable file reader (tests use FakeFS). */
  readFile?: (path: string) => Promise<string>;
  /** Injectable fs watcher factory (tests use an observer). */
  watcherFactory?: WatcherFactory;
  /** Debounce per path in ms (default 250). */
  debounceMs?: number;
  /** Injectable grant for auto-apply; without it `AI!` is blocked. */
  grant?: WatchGrant;
}

export interface Watcher {
  readonly active: boolean;
  readonly scope: string | null;
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function startWatcher(root: string, host: WatchHost, options: WatchOptions = {}): Watcher {
  const readFileFn = options.readFile ?? ((path: string) => readFile(path, "utf-8"));
  const now = options.now ?? (() => new Date().toISOString());
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const factory: WatcherFactory = options.watcherFactory ?? ((dir, onChange) => {
    const handle: FSWatcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) onChange(filename.toString());
    });
    return { close: (): void => handle.close() };
  });

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let active = true;
  const handle = factory(root, (relative) => {
    if (!active) return;
    const path = normalizePath(relative);
    if (options.scope && normalizePath(options.scope) !== path) return;
    const existing = pending.get(path);
    if (existing) clearTimeout(existing);
    pending.set(path, setTimeout(() => {
      pending.delete(path);
      void process(path).catch(() => { /* unreadable or deleted: not an instruction source */ });
    }, debounceMs));
  });

  async function process(path: string): Promise<void> {
    if (!active) return;
    let content: string;
    try {
      content = await readFileFn(path);
    } catch {
      return;
    }
    const comment = detectAiComment(content, path);
    if (!comment) return;
    if (comment.mode !== "auto" || options.autoApply !== true) {
      const blocked: WatchEvent = comment.mode === "auto"
        ? { kind: "blocked", ...comment, reason: options.autoApply !== true ? "watch_auto_apply_disabled" : "watch_grant_missing" }
        : { kind: "instruction", ...comment };
      host.notify(blocked);
      return;
    }
    const grant = options.grant;
    if (!grant) {
      host.notify({ kind: "blocked", ...comment, reason: "watch_grant_missing" });
      return;
    }
    if (!watchGrantCovers(grant, path, now())) {
      const expired = Date.parse(now()) >= Date.parse(grant.expiresAt);
      host.notify({ kind: "blocked", ...comment, reason: expired ? "watch_grant_expired" : "watch_grant_scope" });
      return;
    }
    await host.submit(`Em @${path}: ${comment.text}`, { path, grant });
  }

  return {
    get active(): boolean { return active; },
    get scope(): string | null { return options.scope ?? null; },
    stop(): void {
      active = false;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      handle.close();
    },
  };
}

/**
 * Session-level toggle backing `/watch on|off` and `/watch scope <path>`.
 * The TUI command registers here; only one watcher is active per session.
 */
let sessionWatcher: Watcher | null = null;

export function toggleWatch(action: "on" | "off", root: string, host: WatchHost, options: WatchOptions = {}): { active: boolean } {
  if (action === "off") {
    sessionWatcher?.stop();
    sessionWatcher = null;
    return { active: false };
  }
  sessionWatcher?.stop();
  sessionWatcher = startWatcher(root, host, options);
  return { active: sessionWatcher.active };
}

/** Test/inspection accessor for the current session watcher. */
export function currentWatchSession(): Watcher | null {
  return sessionWatcher;
}
