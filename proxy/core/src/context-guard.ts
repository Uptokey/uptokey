import type { ChatCompletionRequest, ProviderName } from "./types.ts";
import { conservativeTokenEstimate, planAttemptAccounting, type AttemptAccounting } from "./token-estimate.ts";

/**
 * Tabela de limites de janela de contexto padrão por modelo/provedor (em tokens).
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Gemini
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,

  // Groq
  "llama-3.3-70b-versatile": 128_000,
  "llama-3.3-70b-specdec": 8_192,
  "llama-3.1-8b-instant": 128_000,
  "llama-3.1-70b-versatile": 128_000,
  "llama3-70b-8192": 8_192,
  "llama3-8b-8192": 8_192,
  "openai/gpt-oss-20b": 128_000,
  "openai/gpt-oss-120b": 128_000,
  "qwen-2.5-coder-32b": 128_000,
  "qwen/qwen-2.5-coder-32b": 128_000,
  "deepseek-r1-distill-llama-70b": 128_000,
  "mixtral-8x7b-32768": 32_768,
  "gemma2-9b-it": 8_192,

  // Modelos virtuais Uptokey
  "auto": 128_000,
  "uptokey-auto": 128_000,
  "uptokey-fast": 128_000,
  "uptokey-coder": 128_000,

  // Presets remotos tier 3 user-managed — somente providers realmente wired.
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "mistral-small-latest": 128_000,
  "mistral-large-latest": 128_000,
  "llama3.1-8b": 128_000,
  "llama3.3-70b": 128_000,
  "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": 128_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,

  // Ollama
  "llama3.2": 128_000,
  "llama3.1": 128_000,
  "qwen2.5-coder": 128_000,

  // OpenAI / Padrões
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 128_000,
  "o3-mini": 128_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-7-sonnet": 200_000
};

export const DEFAULT_FALLBACK_CONTEXT_LIMIT = 128_000;

export interface SessionContextState {
  lastProvider: ProviderName | string;
  lastModel: string;
  totalRequests: number;
  switches: number;
  lastActivity: number;
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
}

export interface ContextRoutingDecision {
  canFit: boolean;
  estimatedTokens: number;
  modelLimit: number;
  needsCompaction: boolean;
  /**
   * Audit of the coherent accounting that produced `estimatedTokens`. `null` only when the
   * request is not countable at all (no declared output, unserializable), in which case the
   * conservative fallback keeps the previous behavior.
   */
  accounting: {
    coverage: "complete" | "partial";
    state: string | null;
    reason: string | null;
    tokenizerId: string | null;
    catalogVersion: string | null;
    basis: string | null;
  } | null;
}

export class ContextGuard {
  private readonly sessions = new Map<string, SessionContextState>();
  private readonly sessionTtlMs: number;
  private totalFallbacksWithPreservation = 0;
  private totalFallbacksAttempted = 0;

  constructor(sessionTtlMs = 30 * 60 * 1000) {
    this.sessionTtlMs = sessionTtlMs;
  }

  /**
   * Obtém ou inicializa a sessão ativa para manter afinidade (Sticky Session)
   */
  getOrCreateSession(sessionId: string, initialProvider: ProviderName | string, initialModel: string): SessionContextState {
    this.cleanupExpiredSessions();
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        lastProvider: initialProvider,
        lastModel: initialModel,
        totalRequests: 0,
        switches: 0,
        lastActivity: Date.now(),
        accumulatedInputTokens: 0,
        accumulatedOutputTokens: 0
      };
      this.sessions.set(sessionId, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  /**
   * Registra uma troca de provedor dentro de uma sessão existente
   */
  recordSwitch(sessionId: string, newProvider: ProviderName | string, newModel: string, preservedContext = true): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.lastProvider !== newProvider) {
        session.switches += 1;
        session.lastProvider = newProvider;
        session.lastModel = newModel;
      }
      session.totalRequests += 1;
      session.lastActivity = Date.now();
    }
    this.totalFallbacksAttempted += 1;
    if (preservedContext) {
      this.totalFallbacksWithPreservation += 1;
    }
  }

  /**
   * Avalia se a requisição cabe na janela do modelo sem estourar o limite. Consome a mesma
   * fonte coerente de medição usada pela reserva (catálogo por modelo escolhido, com o
   * envelope conservador como piso): para famílias com tokenizador verificado, CJK e afins
   * deixam de ser aceitos por subcontagem de chars/4. `accounting` permite reutilizar a
   * medição já feita pelo roteador na mesma tentativa.
   */
  evaluateFit(request: ChatCompletionRequest, modelName: string, accounting?: AttemptAccounting): ContextRoutingDecision {
    const coherent = accounting ?? (() => {
      const conservative = conservativeTokenEstimate(request);
      return conservative ? planAttemptAccounting(request, conservative) : undefined;
    })();
    const fallback = conservativeTokenEstimate(request);
    const totalTokens = coherent?.reservation.total ?? (fallback ? fallback.input + fallback.output : 1000);
    const limit = MODEL_CONTEXT_LIMITS[modelName] ?? DEFAULT_FALLBACK_CONTEXT_LIMIT;

    return {
      canFit: totalTokens <= limit,
      estimatedTokens: totalTokens,
      modelLimit: limit,
      needsCompaction: totalTokens > limit,
      accounting: coherent ? {
        coverage: coherent.coverage,
        state: coherent.reservation.state,
        reason: coherent.reason,
        tokenizerId: coherent.tokenizerId,
        catalogVersion: coherent.catalogVersion,
        basis: coherent.reservation.basis,
      } : null
    };
  }

  /**
   * Calcula o Context Preservation Index (CPI) global do sistema
   */
  getContextPreservationMetrics(): {
    cpiPercent: number;
    totalSwitches: number;
    activeSessions: number;
  } {
    this.cleanupExpiredSessions();
    const cpiPercent = this.totalFallbacksAttempted === 0
      ? 100
      : Math.round((this.totalFallbacksWithPreservation / this.totalFallbacksAttempted) * 1000) / 10;

    let totalSwitches = 0;
    for (const session of this.sessions.values()) {
      totalSwitches += session.switches;
    }

    return {
      cpiPercent,
      totalSwitches,
      activeSessions: this.sessions.size
    };
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
