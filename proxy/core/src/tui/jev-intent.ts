/**
 * Uptokey TUI — Jev intent classifier.
 *
 * Usa Jev (TypeSafe System One) para julgamento semântico de intenção
 * do input do usuário ANTES de enviar ao LLM principal.
 *
 * Por que Jev aqui:
 *  - Jev retorna em ~150ms, Choice tipado — código controla o fluxo
 *  - Detecta intenções que regras determinísticas não alcançam (ex:
 *    "apaga tudo" escrito de formas variadas vs "/clear" explícito)
 *  - Evita enviar ao modelo caro um input que pode ser tratado localmente
 *  - NUNCA substitui autorização — apenas roteia; decisão final fica no core
 *
 * Regra PROMPT-AGENTE: "Reutilize TypeSafe/Jev somente para julgamento
 * semântico útil; nunca para conceder autorização ou substituir regra
 * determinística."
 *
 * Uso: opcional — sem perfil TypeSafe (cofre) ou TYPESAFE_API_KEY, retorna
 * fallback determinístico sem bloquear o fluxo.
 */

import { JevClient, jev, type JevQuestion } from "./jev-client.ts";

export type IntentCategory =
  | "slash_command"      // o usuário quer executar um /comando explícito
  | "destructive_action" // o texto implica apagar/resetar/destruir algo
  | "code_request"       // pede geração/modificação de código
  | "question"           // pergunta informativa
  | "conversation"       // conversa geral / continuação
  | "steer"              // orientação para um run em andamento (/steer semântico)
  | "unknown";

export interface IntentResult {
  category: IntentCategory;
  /** Probabilidade 0–1 da categoria vencedora (da distribuição Jev). */
  confidence: number;
  /** true se o fallback determinístico foi usado (sem chave API). */
  fallback: boolean;
}

// ─── Fallback determinístico ────────────────────────────────────────────────

const SLASH_RE = /^\s*\/\w/;
const DESTRUCTIVE_RE =
  /\b(apaga|apague|delete|remove|remova|reset|clean|limpa|limpe|destrua|destruir|drop|truncate|wipe)\b/i;
const CODE_RE =
  /\b(cria|crie|implemente|implementa|refatore|refatora|escreva|escreve|adicione|adiciona|corrige|corrija|function|classe|componente|module|import|export|const|let|var|async|await)\b/i;

function deterministicIntent(text: string): IntentResult {
  if (SLASH_RE.test(text))
    return { category: "slash_command", confidence: 1, fallback: true };
  if (DESTRUCTIVE_RE.test(text))
    return { category: "destructive_action", confidence: 0.7, fallback: true };
  if (CODE_RE.test(text))
    return { category: "code_request", confidence: 0.6, fallback: true };
  if (text.endsWith("?"))
    return { category: "question", confidence: 0.6, fallback: true };
  return { category: "conversation", confidence: 0.5, fallback: true };
}

// ─── Jev call ───────────────────────────────────────────────────────────────

/**
 * Classifica a intenção do input usando Jev quando o perfil TypeSafe está
 * disponível. Cai no fallback determinístico se não houver chave ou se
 * a chamada falhar (nunca bloqueia o fluxo principal).
 */
export async function classifyIntent(
  text: string,
  opts: { apiKey?: string; timeoutMs?: number; client?: JevClient; externalAllowed?: boolean; signal?: AbortSignal } = {},
): Promise<IntentResult> {
  const client = opts.client ?? (opts.apiKey !== undefined ? new JevClient({ apiKey: opts.apiKey }) : jev());

  try {
    const body = {
      state: { input: text },
      questions: {
        category: {
          type: "choice",
          instructions: {
            question: "What is the user's primary intent in `input`?",
            focus: "Classify the single most prominent intent.",
          },
          criteria: {
            slash_command: {
              what: "Explicit slash-prefixed command like /compact, /steer, /clear",
              examples: ["/compact", "/steer focus on tests", "/help"],
            },
            destructive_action: {
              what: "Request to delete, reset, wipe, or irreversibly remove something",
              not_for: "Editing or refactoring existing code",
              examples: [
                "delete all migrations",
                "reset the database",
                "wipe the output folder",
              ],
            },
            code_request: {
              what: "Request to generate, modify, refactor, or review code",
              not_for: "General questions about code concepts",
              examples: [
                "implement a binary search function",
                "refactor this component to use hooks",
                "add error handling to the API call",
              ],
            },
            question: {
              what: "Informational question seeking explanation or facts",
              not_for: "Requests that involve changing files or executing commands",
              examples: [
                "what does this function do?",
                "why is the build failing?",
                "how does context compaction work?",
              ],
            },
            steer: {
              what: "Guidance or correction for an ongoing task without starting a new one",
              examples: [
                "focus only on the auth module",
                "stop touching the CSS",
                "also handle the error case",
              ],
            },
            conversation: {
              what: "General conversational input, continuation, or acknowledgment",
              examples: ["ok", "thanks", "let's continue", "sounds good"],
            },
          },
        },
        is_destructive_risk: {
          type: "noul",
          instructions:
            "Does `input` request an action that could irreversibly delete or destroy data or files?",
        },
      },
    };

    const answers = await client.ask(body.state, body.questions as Record<string, JevQuestion>, {
      externalAllowed: opts.externalAllowed ?? true,
      timeoutMs: opts.timeoutMs ?? 2000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!answers) return deterministicIntent(text);
    const json = { answers } as {
      answers?: {
        category?: { choice?: string; confidence?: number };
        is_destructive_risk?: { noul?: number };
      };
    };

    const cat =
      (json.answers?.category?.choice as IntentCategory | undefined) ??
      "unknown";
    const conf = json.answers?.category?.confidence ?? 0.5;

    // Se Jev detectou risco destrutivo com alta probabilidade, promove
    // a categoria (mesmo que a classificação primária tenha sido outra)
    const destructiveRisk = json.answers?.is_destructive_risk?.noul ?? 0;
    const finalCat: IntentCategory =
      destructiveRisk >= 0.75 ? "destructive_action" : cat;

    return { category: finalCat, confidence: conf, fallback: false };
  } catch {
    // Timeout, network error ou qualquer falha — cai no fallback sem ruído
    return deterministicIntent(text);
  }
}

/**
 * Retorna true se o intent é de alto risco e merece confirmação antes de
 * prosseguir. Código decide — Jev apenas fornece o julgamento.
 */
export function isHighRisk(result: IntentResult): boolean {
  return (
    result.category === "destructive_action" && result.confidence >= 0.65
  );
}
