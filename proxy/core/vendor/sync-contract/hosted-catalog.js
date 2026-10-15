import {isDataRecord, projectDataArray} from "./plain-data.js";

function integer(value, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
/** Project remote data; never relay unrecognized fields or upstream error bodies. */
export function projectHostedCatalog(value) {
  if (!isDataRecord(value) || value.transport !== "json" || value.admissionRequired !== true || !isDataRecord(value.billing) ||
    value.billing.currency !== "USD" || value.billing.unit !== "micro_usd" || value.billing.rateBasisTokens !== 1_000_000 ||
    value.billing.settlement !== "provider_reported_usage") {
    throw new Error("hosted_catalog_invalid");
  }
  const projectedModels = projectDataArray(value.models, 100);
  if (!projectedModels) throw new Error("hosted_catalog_invalid");
  const ids = new Set();
  const models = projectedModels.map((rawModel) => {
    if (!isDataRecord(rawModel) || typeof rawModel.id !== "string" || !isDataRecord(rawModel.price) || !isDataRecord(rawModel.limits)) {
      throw new Error("hosted_catalog_invalid");
    }
    const id = rawModel.id;
    const price = rawModel.price;
    const limits = rawModel.limits;
    const cached = price.cachedInputMicrosPerMillion;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id) || ids.has(id) || price.model !== id || price.currency !== "USD" ||
      typeof price.version !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(price.version) ||
      !integer(price.inputMicrosPerMillion, 1e12) || !integer(price.outputMicrosPerMillion, 1e12) ||
      (cached !== undefined && !integer(cached, price.inputMicrosPerMillion)) ||
      !integer(limits.inputTokens, 1e6) || !integer(limits.outputTokens, 1e6) || !integer(limits.contextTokens, 2e6) ||
      !limits.inputTokens || !limits.outputTokens ||
      (rawModel.inputReservation === "full_context"
        ? limits.inputTokens !== limits.contextTokens || limits.outputTokens >= limits.contextTokens || rawModel.contextValidation !== "provider"
        : rawModel.inputReservation !== undefined || rawModel.contextValidation !== undefined || limits.inputTokens + limits.outputTokens > limits.contextTokens)) {
      throw new Error("hosted_catalog_invalid");
    }
    ids.add(id);
    return {
      id,
      price: {model: id, version: price.version, currency: "USD", inputMicrosPerMillion: price.inputMicrosPerMillion,
        outputMicrosPerMillion: price.outputMicrosPerMillion, ...(cached !== undefined ? {cachedInputMicrosPerMillion: cached} : {})},
      limits: {inputTokens: limits.inputTokens, outputTokens: limits.outputTokens, contextTokens: limits.contextTokens},
      ...(rawModel.inputReservation === "full_context" ? {inputReservation: "full_context", contextValidation: "provider"} : {}),
    };
  });
  return {models, transport: "json", admissionRequired: true,
    billing: {currency: "USD", unit: "micro_usd", rateBasisTokens: 1_000_000, settlement: "provider_reported_usage"}};
}
