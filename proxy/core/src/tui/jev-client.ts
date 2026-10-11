/**
 * Uptokey TUI — single transport to Jev (TypeSafe System One) for the TUI's semantic judgments
 * (intent of a request, tool-call alignment/risk, compaction summary quality).
 *
 * Contract (docs.typesafe.ai/api): POST https://api.typesafe.ai/v1/systemone, Bearer key,
 * body { model, state, questions } → { model, answers: { id: { type, noul | choice+probabilities | score, confidence } }, usage }.
 *
 * Credential: the TypeSafe profile of this terminal's identity, kept by the core (vault, typesafe-profile.ts).
 * The terminal asks through the core (POST /v1/workspace/classification/judge), so the key never reaches this
 * process; TYPESAFE_API_KEY (development) calls System One directly. Text is sent only when the conversation
 * allows external processing. Jev informs; it never authorizes anything — callers keep deterministic rules and the
 * core keeps W5.
 */
import { TYPESAFE_ENDPOINT } from "../typesafe-profile.ts";

/** The authenticated core transport the terminal already uses (TuiClient.fetchRaw). */
export interface JevCoreTransport {
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
}

export type JevQuestion = { type: "noul" | "choice" | "score"; instructions: unknown; criteria?: unknown };
export interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  confidence?: number;
}
export type JevInactiveReason = "no_profile" | "profile_disabled" | "external_processing_off" | "core_unavailable" | "request_failed" | "invalid_response";
export interface JevStatus {
  active: boolean;
  reason: JevInactiveReason | null;
  source: "core" | "environment" | "explicit" | null;
  model: string;
  calls: number;
  failures: number;
  lastLatencyMs: number | null;
  lastUsage: { inputTokens: number; outputTokens: number } | null;
  lastError: string | null;
}
export interface JevAskOptions {
  /** The conversation's processing policy: text leaves the device only when it is external_allowed. */
  externalAllowed: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const CACHE_MS = 60_000;

/** Test seam: a loopback endpoint only (a scripted System One server); anything else keeps the official URL. */
function endpointFrom(env: NodeJS.ProcessEnv): string {
  const override = env.UPTOKEY_TYPESAFE_ENDPOINT;
  if (!override) return TYPESAFE_ENDPOINT;
  try {
    const url = new URL(override);
    if ((url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.toString();
  } catch {
    // invalid override: ignored
  }
  return TYPESAFE_ENDPOINT;
}

function validAnswer(value: unknown, question: JevQuestion): value is JevAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Record<string, unknown>;
  if (answer.type !== question.type) return false;
  const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (question.type === "noul") return unit(answer.noul);
  if (question.type === "choice") return typeof answer.choice === "string" && (answer.confidence === undefined || unit(answer.confidence));
  return typeof answer.score === "number" && Number.isFinite(answer.score);
}

export class JevClient {
  private readonly core?: JevCoreTransport;
  private readonly explicitKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly endpoint: string;
  private cached: { key: string; model: string; source: JevStatus["source"]; at: number } | null = null;
  private readonly state: JevStatus = { active: false, reason: "no_profile", source: null, model: "jev-latest", calls: 0, failures: 0, lastLatencyMs: null, lastUsage: null, lastError: null };

  constructor(options: { core?: JevCoreTransport; apiKey?: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
    this.core = options.core;
    this.explicitKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.endpoint = endpointFrom(this.env);
  }

  /** Resolves (and caches briefly) the credential without calling Jev. */
  private async credential(): Promise<{ key: string; model: string; source: JevStatus["source"]; at: number } | { reason: JevInactiveReason }> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached;
    if (this.explicitKey !== undefined) {
      if (!this.explicitKey.trim()) return { reason: 'no_profile' };
      return (this.cached = { key: this.explicitKey, model: "jev-latest", source: "explicit", at: Date.now() });
    }
    // A paired terminal always uses its core identity's profile. An ambient
    // developer key cannot supersede that identity or bypass its policy.
    if (!this.core) {
      const fromEnv = this.env.TYPESAFE_API_KEY;
      if (fromEnv) return (this.cached = { key: fromEnv, model: this.env.TYPESAFE_MODEL || "jev-latest", source: "environment", at: Date.now() });
      return { reason: "no_profile" };
    }
    try {
      const response = await this.core.fetchRaw("/v1/workspace/classification/config")
      if (!response.ok) return { reason: "core_unavailable" };
      const info = (await response.json()) as { keyPresent?: boolean; configured?: boolean; enabled?: boolean; model?: string };
      if (!info.keyPresent) return { reason: "no_profile" };
      if (!info.configured || !info.enabled) return { reason: "profile_disabled" };
      // The key stays in the core; "key" here only marks that the core can judge with this identity's profile.
      return (this.cached = { key: "", model: info.model || "jev-latest", source: "core", at: Date.now() });
    } catch {
      return { reason: "core_unavailable" };
    }
  }

  /** Forget the cached profile state (after the person changes the TypeSafe profile). */
  reset() {
    this.cached = null
    Object.assign(this.state, { reason: "no_profile", active: false, lastError: null })
  }

  /** Current availability (no network call). */
  async status(externalAllowed = true): Promise<JevStatus> {
    const credential = await this.credential();
    if ("reason" in credential) Object.assign(this.state, { active: false, reason: credential.reason, source: null });
    else {
      // A failing service stays reported as inactive until a call succeeds again.
      const failing = this.state.reason === "request_failed" || this.state.reason === "invalid_response"
      Object.assign(this.state, {
        active: externalAllowed && !failing,
        reason: !externalAllowed ? "external_processing_off" : failing ? this.state.reason : null,
        source: credential.source,
        model: credential.model,
      });
    }
    return { ...this.state };
  }

  /**
   * Asks independent questions over one state in a single request. Returns null when Jev is not usable
   * (no credential, external processing off, timeout, service error or a response outside the contract);
   * callers then use their deterministic fallback and must say so.
   */
  async ask(state: unknown, questions: Record<string, JevQuestion>, options: JevAskOptions): Promise<Record<string, JevAnswer> | null> {
    if (options.signal?.aborted) return null;
    if (!options.externalAllowed) {
      Object.assign(this.state, { active: false, reason: "external_processing_off" });
      return null;
    }
    const credential = await this.credential();
    if (options.signal?.aborted) return null;
    if ("reason" in credential) {
      Object.assign(this.state, { active: false, reason: credential.reason });
      return null;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 2000);
    const onAbort = () => abort.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const started = performance.now();
    this.state.calls++;
    try {
      const response =
        credential.source === "core"
          ? await this.core!.fetchRaw("/v1/workspace/classification/judge", {
              method: "POST",
              body: JSON.stringify({ state, questions, processingPolicy: "external_allowed", purpose: "tui" }),
              signal: abort.signal,
            })
          : await this.fetchImpl(this.endpoint, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${credential.key}` },
              body: JSON.stringify({ model: credential.model, state, questions }),
              signal: abort.signal,
              redirect: "error",
            });
      if (!response.ok) {
        if (response.status === 401 || response.status === 503) this.cached = null;
        throw new Error(`jev_http_${response.status}`);
      }
      const raw = (await response.json()) as { answers?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number } | null };
      const body = { answers: raw.answers, usage: raw.usage ? { input_tokens: raw.usage.input_tokens ?? raw.usage.inputTokens, output_tokens: raw.usage.output_tokens ?? raw.usage.outputTokens } : undefined };
      const answers: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = body.answers?.[id];
        if (!validAnswer(answer, question)) throw new Error("jev_response_invalid");
        answers[id] = answer;
      }
      Object.assign(this.state, {
        active: true,
        reason: null,
        source: credential.source,
        model: credential.model,
        lastLatencyMs: Math.round(performance.now() - started),
        lastUsage: body.usage ? { inputTokens: Number(body.usage.input_tokens ?? 0), outputTokens: Number(body.usage.output_tokens ?? 0) } : null,
        lastError: null,
      });
      return answers;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(this.state, {
        active: false,
        failures: this.state.failures + 1,
        reason: message === "jev_response_invalid" ? "invalid_response" : "request_failed",
        lastError: abort.signal.aborted && !options.signal?.aborted ? "timeout" : message.slice(0, 80),
      });
      return null;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

let shared: JevClient | undefined;

/** The process-wide client (the TUI entry configures it with the vault; tests may replace it). */
export function jev(): JevClient {
  shared ??= new JevClient();
  return shared;
}

export function setJev(client: JevClient) {
  shared = client;
}
