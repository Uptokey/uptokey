/**
 * Estimates conversation size and prepares summary requests that preserve
 * goals, decisions, pending edits, approvals and unresolved errors.
 * Compacted history retains the recent message tail.
 */

import type { Message } from "./state.ts";

/** Chars acima dos quais a compactação é sugerida (≈ 50k tokens a 4 chars/tok). */
export const COMPACT_SUGGEST_CHARS = 200_000;

/** Chars acima dos quais a compactação é forçada antes do envio. */
export const COMPACT_FORCE_CHARS = 800_000;

/** Estima tokens com base em contagem de chars (proxy simples). */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
  );
}

/** Retorna true se o contexto atual deve ser compactado. */
export function shouldSuggestCompact(messages: Message[]): boolean {
  return messages.reduce((sum, m) => sum + m.content.length, 0) >= COMPACT_SUGGEST_CHARS;
}

/** Retorna true se o contexto deve ser compactado antes do próximo envio. */
export function mustCompact(messages: Message[]): boolean {
  return messages.reduce((sum, m) => sum + m.content.length, 0) >= COMPACT_FORCE_CHARS;
}

/**
 * Prompt enviado ao modelo para gerar o resumo de compactação.
 * Preserva os invariantes exigidos pelo doc 02: objetivo, decisões,
 * alterações pendentes, aprovações e erros abertos.
 */
export function buildCompactPrompt(messages: Message[]): string {
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  return `Você está compactando o histórico desta conversa. Produza um resumo estruturado que preserve obrigatoriamente:

1. **Objetivo** da conversa/tarefa atual
2. **Decisões** tomadas e razões
3. **Alterações pendentes** (arquivos, operações não concluídas)
4. **Aprovações** e consentimentos dados
5. **Erros abertos** e problemas não resolvidos
6. **Próximos passos** identificados

Seja conciso mas completo. Não omita nenhum item das 6 categorias acima.

=== HISTÓRICO A COMPACTAR ===

${transcript}

=== FIM DO HISTÓRICO ===

Resumo compactado:`;
}

/**
 * Aplica um resumo de compactação: descarta mensagens anteriores e insere
 * uma mensagem de sistema com o resumo no início.
 * Retorna o novo array de mensagens compactado.
 */
export function applyCompaction(
  messages: Message[],
  summary: string,
  keepLastN = 4,
): Message[] {
  const summaryMsg: Message = {
    id: `compact-${Date.now()}`,
    role: "system",
    content: `[Contexto compactado]\n\n${summary}`,
    timestamp: new Date().toISOString(),
  };

  // Mantém as últimas N mensagens para continuidade imediata
  const tail = messages.slice(-keepLastN);
  return [summaryMsg, ...tail];
}

/** Formata um banner de status de compactação para exibir no chat. */
export function formatCompactStatus(
  originalCount: number,
  newCount: number,
  originalChars: number,
  newChars: number,
): string {
  const pct = Math.round((1 - newChars / originalChars) * 100);
  return `Contexto compactado: ${originalCount} → ${newCount} mensagens, ${pct}% de redução`;
}
