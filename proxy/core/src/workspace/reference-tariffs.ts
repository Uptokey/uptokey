import {parseReferenceTariff,type ReferenceTariff} from '@uptokey/sync-contract/workflow';

// Immutable observation, not the provider's historical price-effective date.
// Keep old revisions for persisted receipts; append new observations instead of editing.
// Evidence and refresh policy: docs/handoffs/workflow-tariff-evidence.md.
const checkedAt='2026-09-17T02:23:03.000Z';
export const VERIFIED_REFERENCE_TARIFFS:readonly ReferenceTariff[]=[
  ['20b','75000','300000','37500'],
  ['120b','150000','600000','75000'],
].map(([size,input,output,cached])=>parseReferenceTariff({
  schemaVersion:1,id:`groq_gpt_oss_${size}_20260917`,createdAt:checkedAt,version:1,
  provider:'groq',model:`openai/gpt-oss-${size}`,accessMode:'byok',currency:'USD',unit:'million_tokens',
  inputMicrosPerMillion:input,outputMicrosPerMillion:output,cachedInputMicrosPerMillion:cached,priceMicrosPerUnit:null,
  sourceUrl:'https://console.groq.com/docs/models',checkedAt,validFrom:checkedAt,
  validUntil:'2026-10-17T02:23:03.000Z',comparisonBasis:'same_service',
}));

// Etapa 06: Ampliação de tarifas com fontes primárias atuais (revisão/validade e fixtures verificadas)
const checkedAt20260918 = '2026-09-18T20:00:00.000Z';
export const EXPANDED_PRIMARY_SOURCE_TARIFFS: readonly ReferenceTariff[] = [
  ...VERIFIED_REFERENCE_TARIFFS,
  parseReferenceTariff({
    schemaVersion: 1, id: 'groq_llama_3_3_70b_versatile_20260918', createdAt: checkedAt20260918, version: 1,
    provider: 'groq', model: 'llama-3.3-70b-versatile', accessMode: 'byok', currency: 'USD', unit: 'million_tokens',
    inputMicrosPerMillion: '590000', outputMicrosPerMillion: '790000', cachedInputMicrosPerMillion: '295000', priceMicrosPerUnit: null,
    sourceUrl: 'https://console.groq.com/docs/models', checkedAt: checkedAt20260918, validFrom: checkedAt20260918,
    validUntil: '2026-12-31T23:59:59.000Z', comparisonBasis: 'same_service',
  }),
  parseReferenceTariff({
    schemaVersion: 1, id: 'groq_llama_3_1_8b_instant_20260918', createdAt: checkedAt20260918, version: 1,
    provider: 'groq', model: 'llama-3.1-8b-instant', accessMode: 'byok', currency: 'USD', unit: 'million_tokens',
    inputMicrosPerMillion: '50000', outputMicrosPerMillion: '80000', cachedInputMicrosPerMillion: '25000', priceMicrosPerUnit: null,
    sourceUrl: 'https://console.groq.com/docs/models', checkedAt: checkedAt20260918, validFrom: checkedAt20260918,
    validUntil: '2026-12-31T23:59:59.000Z', comparisonBasis: 'same_service',
  }),
  parseReferenceTariff({
    schemaVersion: 1, id: 'moonshot_kimi_k3_20260918', createdAt: checkedAt20260918, version: 1,
    provider: 'moonshot', model: 'kimi-k3', accessMode: 'byok', currency: 'USD', unit: 'million_tokens',
    inputMicrosPerMillion: '3000000', outputMicrosPerMillion: '15000000', cachedInputMicrosPerMillion: null, priceMicrosPerUnit: null,
    sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3.md', checkedAt: checkedAt20260918, validFrom: checkedAt20260918,
    validUntil: '2026-12-31T23:59:59.000Z', comparisonBasis: 'same_service',
  }),
  parseReferenceTariff({
    schemaVersion: 1, id: 'deepseek_chat_20260918', createdAt: checkedAt20260918, version: 1,
    provider: 'deepseek', model: 'deepseek-chat', accessMode: 'byok', currency: 'USD', unit: 'million_tokens',
    inputMicrosPerMillion: '280000', outputMicrosPerMillion: '280000', cachedInputMicrosPerMillion: '140000', priceMicrosPerUnit: null,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', checkedAt: checkedAt20260918, validFrom: checkedAt20260918,
    validUntil: '2026-12-31T23:59:59.000Z', comparisonBasis: 'same_service',
  }),
];

// Media prices are not reference data here: an operator records them in the configured tariff
// snapshot with source and validity (per image/second/character), where account admission reads them.
