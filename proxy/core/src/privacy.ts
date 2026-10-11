export const GEMINI_FREE_PRIVACY_NOTICE = [
  "Gemini free tier: o Google pode usar prompts e respostas para melhorar produtos,",
  "incluindo revisão humana. No Brasil, esta utilização não está na exceção regional.",
  "Não envie dados pessoais sensíveis, segredos, dados clínicos ou conteúdo confidencial."
].join(" ");

export const GEMINI_FREE_PRIVACY_NOTICE_VERSION = "gemini-free-2026-08-20-v1";
const NOTICE_EFFECTIVE_AT_MS = Date.parse("2026-08-20T00:00:00.000Z");
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export function geminiPrivacyAccepted(acceptedAt?: string, noticeVersion?: string, now = new Date()): boolean {
  if (!acceptedAt || noticeVersion !== GEMINI_FREE_PRIVACY_NOTICE_VERSION) return false;
  const acceptedAtMs = Date.parse(acceptedAt);
  return Number.isFinite(acceptedAtMs) && acceptedAtMs >= NOTICE_EFFECTIVE_AT_MS && acceptedAtMs <= now.getTime() + MAX_FUTURE_SKEW_MS;
}
