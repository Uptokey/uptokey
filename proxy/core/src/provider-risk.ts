import { isNamedExperimentalProvider, type NamedExperimentalProviderName } from "./provider-registry.ts";
import type { ProviderConfig } from "./types.ts";

export const NAMED_PROVIDER_RISK_NOTICES: Record<NamedExperimentalProviderName, {
  version: string;
  summary: string;
  sourceUrl: string;
  reviewedAt: string;
}> = {
  deepseek: {
    version: "deepseek-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. A solicitação é enviada à API DeepSeek. Os termos da Open Platform permitem integrações downstream e atribuem ao desenvolvedor responsabilidades perante seus usuários. Não presuma retenção zero; consulte a política aplicável à sua conta antes de enviar dados sensíveis.",
    sourceUrl: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
    reviewedAt: "2026-09-23"
  },
  mistral: {
    version: "mistral-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. A política da API descreve retenção padrão de entradas e saídas por até 30 dias para monitoramento de abuso, salvo ativação de ZDR. APIs específicas, incluindo Agents e Fine-Tuning, têm regras próprias; confirme a configuração e o endpoint usados.",
    sourceUrl: "https://legal.mistral.ai/terms/privacy-policy/",
    reviewedAt: "2026-09-23"
  },
  cerebras: {
    version: "cerebras-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. A política consultada diz que entradas e saídas associadas aos serviços de inferência não são retidas; dados pessoais e logs operacionais seguem os prazos e exceções da própria política. Confirme os termos aplicáveis à sua API e conta.",
    sourceUrl: "https://www.cerebras.ai/privacy-policy",
    reviewedAt: "2026-09-23"
  },
  together: {
    version: "together-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. Os termos dizem que ZDR só vale a partir da ativação na conta. Também restringem o uso do serviço para desenvolver produto ou serviço competitivo; avalie se isso se aplica ao seu uso antes de ativar.",
    sourceUrl: "https://www.together.ai/terms-of-service",
    reviewedAt: "2026-09-23"
  },
  anthropic: {
    version: "anthropic-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. Na API comercial, a retenção padrão de entradas e saídas é de até 30 dias, com exceções; ZDR depende de aprovação e acordo aplicável. Confira quais produtos e recursos estão cobertos pela configuração da sua organização.",
    sourceUrl: "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organizations-data",
    reviewedAt: "2026-09-23"
  },
  openrouter: {
    version: "openrouter-risk-2026-09-23-v2",
    summary: "Tier 3 user-managed. A entrada segue para a OpenRouter e para o provedor do modelo selecionado. As práticas de retenção e treinamento variam entre provedores; a OpenRouter declara que não usa entradas e saídas para treinamento próprio. Esta conexão usa sua conta OpenRouter, não um gateway hospedado pela Uptokey.",
    sourceUrl: "https://openrouter.ai/privacy/",
    reviewedAt: "2026-09-23"
  }
};

export function namedProviderRiskAccepted(provider: unknown, config: Pick<ProviderConfig, "riskAcceptedAt" | "riskNoticeVersion">): boolean {
  if (!isNamedExperimentalProvider(provider)) return true;
  const acceptedAt = config.riskAcceptedAt;
  return typeof acceptedAt === "string"
    && Number.isFinite(Date.parse(acceptedAt))
    && config.riskNoticeVersion === NAMED_PROVIDER_RISK_NOTICES[provider].version;
}

export function acceptNamedProviderRisk(config: ProviderConfig, provider: NamedExperimentalProviderName, acceptedAt = new Date()): void {
  config.riskAcceptedAt = acceptedAt.toISOString();
  config.riskNoticeVersion = NAMED_PROVIDER_RISK_NOTICES[provider].version;
}
