/**
 * Uptokey TUI — Jev tool-call guard.
 *
 * Verifica semanticamente se um tool call proposto pelo modelo está
 * alinhado com o que o usuário pediu e se apresenta risco não declarado.
 *
 * Por que Jev aqui:
 *  - A aprovação W5 exige julgamento semântico: "o usuário pediu X, o
 *    modelo quer executar Y — isso é coerente?"
 *  - Regras determinísticas (comparação de strings, listas negras) não
 *    capturam equivalências semânticas nem intenções implícitas
 *  - Jev retorna em ~150ms: cabe no fluxo de aprovação antes de exibir
 *    o overlay ao usuário, sem adicionar latência perceptível
 *  - Resultado fica VISÍVEL no overlay — usuário decide, Jev não autoriza
 *
 * Regra PROMPT-AGENTE: "nunca para conceder autorização ou substituir
 * regra determinística" — Jev aqui INFORMA a decisão humana, não a toma.
 */

import { JevClient, jev, type JevQuestion } from "./jev-client.ts";

export interface ToolCallGuardInput {
  /** O que o usuário pediu originalmente neste turno. */
  userRequest: string;
  /** Nome da ferramenta que o modelo quer chamar. */
  toolName: string;
  /** Argumentos JSON serializados. */
  toolArgs: string;
  /** Descrição da ferramenta (se disponível). */
  toolDescription?: string;
}

export interface ToolCallGuardResult {
  /** Probabilidade 0–1 de que o tool call está alinhado com o pedido. */
  alignmentScore: number;
  /** Probabilidade 0–1 de que o tool call tem risco de destruição de dados. */
  destructiveRisk: number;
  /** Probabilidade 0–1 de que o tool call acessa arquivo/recurso fora do escopo. */
  scopeViolationRisk: number;
  /** Sugestão de texto para exibir no overlay de aprovação. */
  riskSummary: string;
  /** true se o fallback determinístico foi usado. */
  fallback: boolean;
}

// ─── Fallback determinístico ────────────────────────────────────────────────

const DESTRUCTIVE_TOOLS = new Set([
  "bash", "shell", "exec", "run_command",
  "delete_file", "remove_file", "write_file",
  "git_reset", "git_clean", "git_push",
  "drop_table", "truncate", "wipe",
]);

const DESTRUCTIVE_ARGS_RE =
  /\b(rm\s+-rf|rimraf|del\s+\/[sqf]|drop\s+table|truncate|format\s+c:|DELETE\s+FROM|reset\s+--hard)\b/i;

function deterministicGuard(input: ToolCallGuardInput): ToolCallGuardResult {
  const toolLower = input.toolName.toLowerCase();
  const isDestructiveTool = DESTRUCTIVE_TOOLS.has(toolLower);
  const hasDestructiveArgs = DESTRUCTIVE_ARGS_RE.test(input.toolArgs);
  const destructiveRisk = isDestructiveTool || hasDestructiveArgs ? 0.8 : 0.1;
  const riskSummary =
    destructiveRisk >= 0.7
      ? `⚠ Ferramenta "${input.toolName}" pode modificar ou excluir dados de forma permanente.`
      : "";
  return {
    alignmentScore: 0.5,
    destructiveRisk,
    scopeViolationRisk: 0.1,
    riskSummary,
    fallback: true,
  };
}

// ─── Jev call ───────────────────────────────────────────────────────────────

/**
 * Avalia o tool call proposto com Jev. Retorna um resultado que o overlay
 * W5 exibe ao usuário para informar a decisão de aprovar/rejeitar.
 *
 * Nunca bloqueia — fallback determinístico se Jev indisponível.
 */
export async function evaluateToolCall(
  input: ToolCallGuardInput,
  opts: { apiKey?: string; timeoutMs?: number; client?: JevClient; externalAllowed?: boolean; signal?: AbortSignal } = {},
): Promise<ToolCallGuardResult> {
  const client = opts.client ?? (opts.apiKey !== undefined ? new JevClient({ apiKey: opts.apiKey }) : jev());

  try {
    const state = {
      user_request: input.userRequest,
      tool: {
        name: input.toolName,
        args: input.toolArgs.slice(0, 500), // limita tamanho do estado
        description: input.toolDescription ?? "",
      },
    };

    const body = {
      state,
      questions: {
        is_aligned: {
          type: "noul",
          instructions: {
            question:
              "Is `tool.name` with `tool.args` a coherent step toward fulfilling `user_request`?",
            focus:
              "Judge whether this specific tool invocation is a plausible sub-task of the request.",
          },
        },
        is_destructive: {
          type: "noul",
          instructions:
            "Could executing `tool.name` with `tool.args` irreversibly delete, overwrite, or destroy data or files?",
        },
        scope_violation: {
          type: "noul",
          instructions: {
            question:
              "Does `tool.args` reference files or resources that `user_request` did not mention or imply?",
            focus:
              "Look for paths, tables, repos, or services outside what the user described.",
          },
        },
      },
    };

    const answers = await client.ask(body.state, body.questions as Record<string, JevQuestion>, {
      externalAllowed: opts.externalAllowed ?? true,
      timeoutMs: opts.timeoutMs ?? 2000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!answers) return deterministicGuard(input);
    const json = { answers } as {
      answers?: {
        is_aligned?: { noul?: number };
        is_destructive?: { noul?: number };
        scope_violation?: { noul?: number };
      };
    };

    const alignmentScore = json.answers?.is_aligned?.noul ?? 0.5;
    const destructiveRisk = json.answers?.is_destructive?.noul ?? 0.1;
    const scopeViolationRisk = json.answers?.scope_violation?.noul ?? 0.1;

    const riskParts: string[] = [];
    if (destructiveRisk >= 0.65)
      riskParts.push(`⚠ Pode excluir/sobrescrever dados (risco: ${Math.round(destructiveRisk * 100)}%)`);
    if (scopeViolationRisk >= 0.6)
      riskParts.push(`⚠ Pode acessar recursos fora do escopo pedido (risco: ${Math.round(scopeViolationRisk * 100)}%)`);
    if (alignmentScore < 0.4)
      riskParts.push(`⚠ Alinhamento baixo com o pedido original (${Math.round(alignmentScore * 100)}%)`);

    return {
      alignmentScore,
      destructiveRisk,
      scopeViolationRisk,
      riskSummary: riskParts.join("\n"),
      fallback: false,
    };
  } catch {
    return deterministicGuard(input);
  }
}

/**
 * Gera uma linha de contexto para o overlay W5 baseada no resultado Jev.
 * Código decide o que exibir — Jev apenas fornece os sinais.
 */
export function formatGuardBadge(result: ToolCallGuardResult): string {
  if (result.fallback) return "";
  const parts: string[] = [];
  if (result.alignmentScore >= 0.8)
    parts.push(`✓ alinhado (${Math.round(result.alignmentScore * 100)}%)`);
  else if (result.alignmentScore >= 0.5)
    parts.push(`~ parcial (${Math.round(result.alignmentScore * 100)}%)`);
  else
    parts.push(`✗ baixo alinhamento (${Math.round(result.alignmentScore * 100)}%)`);
  if (result.destructiveRisk >= 0.65)
    parts.push(`🔴 destrutivo`);
  else if (result.destructiveRisk >= 0.35)
    parts.push(`🟡 risco moderado`);
  return parts.join("  ");
}
