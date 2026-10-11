/**
 * Uptokey TUI — Jev compaction quality verifier.
 *
 * Após a compactação de contexto, verifica se o resumo gerado preservou
 * os 6 invariantes obrigatórios definidos em 02-ARQUITETURA.md:
 *  1. Objetivo da conversa
 *  2. Decisões tomadas
 *  3. Alterações pendentes
 *  4. Aprovações e consentimentos
 *  5. Erros abertos
 *  6. Próximos passos
 *
 * Por que Jev aqui:
 *  - Verificar "o resumo contém X?" é julgamento semântico — não se faz
 *    com regex nem presença de palavras-chave
 *  - Se o resumo falhar, o TUI pode rejeitar a compactação ou avisar o
 *    usuário antes de descartar o contexto original
 *  - Alternativa seria enviar ao mesmo LLM para auto-avaliar: caro e
 *    propenso a concordância espúria (o modelo que gerou vai dizer "sim")
 *  - Jev é independente, rápido (~150ms) e retorna Noul tipado por invariante
 *
 * Regra PROMPT-AGENTE: uso semântico útil e configurado; nunca bloqueia
 * o fluxo se indisponível.
 */

import type { Message } from "./state.ts";

import { JevClient, jev, type JevQuestion } from "./jev-client.ts";

export interface CompactionQualityResult {
  /** Scores 0–1 para cada invariante (probabilidade de estar presente no resumo). */
  scores: {
    goal: number;
    decisions: number;
    pending_changes: number;
    approvals: number;
    open_errors: number;
    next_steps: number;
  };
  /** Invariantes com score abaixo do threshold (possivelmente ausentes). */
  missing: string[];
  /** Score médio geral (0–1). */
  overallScore: number;
  /** true se o resumo passa no critério mínimo para ser aceito. */
  acceptable: boolean;
  /** true se o fallback determinístico foi usado. */
  fallback: boolean;
}

/** Threshold mínimo por invariante para considerar presente. */
const INVARIANT_THRESHOLD = 0.55;

/** Score médio mínimo para aceitar a compactação. */
const OVERALL_THRESHOLD = 0.60;

// ─── Fallback determinístico ────────────────────────────────────────────────

const KEYWORD_PATTERNS: Record<keyof CompactionQualityResult["scores"], RegExp> = {
  goal: /\b(objetivo|goal|propósito|purpose|tarefa|task)\b/i,
  decisions: /\b(decisão|decisões|decision|decidiu|decided|escolha|chosen)\b/i,
  pending_changes: /\b(pendente|pending|alteração|change|arquivo|file|modificação|modification)\b/i,
  approvals: /\b(aprovação|approval|consentimento|consent|autorizado|authorized)\b/i,
  open_errors: /\b(erro|error|falha|failure|problema|issue|bug|aberto|open)\b/i,
  next_steps: /\b(próximo|next|passo|step|continuar|continue|seguir|follow)\b/i,
};

function deterministicQuality(summary: string): CompactionQualityResult {
  const scores: CompactionQualityResult["scores"] = {
    goal: 0, decisions: 0, pending_changes: 0,
    approvals: 0, open_errors: 0, next_steps: 0,
  };
  for (const [key, re] of Object.entries(KEYWORD_PATTERNS) as [keyof typeof scores, RegExp][]) {
    scores[key] = re.test(summary) ? 0.6 : 0.2;
  }
  const missing = (Object.keys(scores) as (keyof typeof scores)[])
    .filter((k) => scores[k] < INVARIANT_THRESHOLD);
  const overallScore =
    Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
  return {
    scores,
    missing,
    overallScore,
    acceptable: overallScore >= OVERALL_THRESHOLD,
    fallback: true,
  };
}

// ─── Jev call ───────────────────────────────────────────────────────────────

/**
 * Verifica se o resumo de compactação preserva os 6 invariantes.
 * Sem Jev disponível (perfil TypeSafe ausente, processamento externo desligado ou falha), usa fallback de keywords.
 */
export async function verifyCompactionQuality(
  summary: string,
  originalMessages: Message[],
  opts: { apiKey?: string; timeoutMs?: number; client?: JevClient; externalAllowed?: boolean; signal?: AbortSignal } = {},
): Promise<CompactionQualityResult> {
  const client = opts.client ?? (opts.apiKey !== undefined ? new JevClient({ apiKey: opts.apiKey }) : jev());

  // Fornece apenas o início do transcript como referência (máx 1k chars)
  const transcriptSample = originalMessages
    .slice(0, 6)
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n")
    .slice(0, 1000);

  try {
    const state = {
      summary,
      original_transcript_sample: transcriptSample,
    };

    const body = {
      state,
      questions: {
        has_goal: {
          type: "noul",
          instructions:
            "Does `summary` clearly state the main goal or objective of the conversation?",
        },
        has_decisions: {
          type: "noul",
          instructions:
            "Does `summary` mention specific decisions that were made during the conversation?",
        },
        has_pending_changes: {
          type: "noul",
          instructions:
            "Does `summary` describe files, operations, or changes that are pending or not yet completed?",
        },
        has_approvals: {
          type: "noul",
          instructions:
            "Does `summary` record any approvals, consents, or authorizations that were granted?",
        },
        has_open_errors: {
          type: "noul",
          instructions:
            "Does `summary` note any errors, failures, or unresolved issues that remain open?",
        },
        has_next_steps: {
          type: "noul",
          instructions:
            "Does `summary` specify the next steps or actions to be taken?",
        },
      },
    };

    const answers = await client.ask(body.state, body.questions as Record<string, JevQuestion>, {
      externalAllowed: opts.externalAllowed ?? true,
      timeoutMs: opts.timeoutMs ?? 3000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!answers) return deterministicQuality(summary);
    const json = { answers } as {
      answers?: {
        has_goal?: { noul?: number };
        has_decisions?: { noul?: number };
        has_pending_changes?: { noul?: number };
        has_approvals?: { noul?: number };
        has_open_errors?: { noul?: number };
        has_next_steps?: { noul?: number };
      };
    };

    const a = json.answers ?? {};
    const scores: CompactionQualityResult["scores"] = {
      goal: a.has_goal?.noul ?? 0.5,
      decisions: a.has_decisions?.noul ?? 0.5,
      pending_changes: a.has_pending_changes?.noul ?? 0.5,
      approvals: a.has_approvals?.noul ?? 0.5,
      open_errors: a.has_open_errors?.noul ?? 0.5,
      next_steps: a.has_next_steps?.noul ?? 0.5,
    };

    const LABELS: Record<keyof typeof scores, string> = {
      goal: "objetivo",
      decisions: "decisões",
      pending_changes: "alterações pendentes",
      approvals: "aprovações",
      open_errors: "erros abertos",
      next_steps: "próximos passos",
    };

    const missing = (Object.keys(scores) as (keyof typeof scores)[])
      .filter((k) => scores[k] < INVARIANT_THRESHOLD)
      .map((k) => LABELS[k]);

    const overallScore =
      Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;

    return {
      scores,
      missing,
      overallScore,
      acceptable: overallScore >= OVERALL_THRESHOLD,
      fallback: false,
    };
  } catch {
    return deterministicQuality(summary);
  }
}

/**
 * Formata aviso para o banner de compactação quando há invariantes ausentes.
 * Retorna null se a qualidade é aceitável.
 */
export function formatCompactionWarning(
  result: CompactionQualityResult,
): string | null {
  if (result.acceptable) return null;
  if (result.missing.length === 0) return null;
  return `⚠ Resumo pode estar incompleto — ausentes: ${result.missing.join(", ")}`;
}
