export type HostedCatalogModel = {
  id: string;
  price: {model: string; version: string; currency: "USD"; inputMicrosPerMillion: number;
    outputMicrosPerMillion: number; cachedInputMicrosPerMillion?: number};
  limits: {inputTokens: number; outputTokens: number; contextTokens: number};
  inputReservation?: "full_context";
  contextValidation?: "provider";
};
export type HostedCatalog = {
  models: HostedCatalogModel[];
  transport: "json";
  admissionRequired: true;
  billing: {currency: "USD"; unit: "micro_usd"; rateBasisTokens: number; settlement: "provider_reported_usage"};
};
export function projectHostedCatalog(value: unknown): HostedCatalog;
