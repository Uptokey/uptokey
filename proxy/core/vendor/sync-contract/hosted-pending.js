/** Public projection shared by the account API and dashboard. Never forwards raw ledger entries. */
export function projectHostedPending(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error("hosted_pending_invalid");
  const date = text => typeof text === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text));
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(item.requestId) ||
      !Number.isSafeInteger(item.reservedMicros) || item.reservedMicros < 0 || item.reservedMicros > 1e12 ||
      !date(item.createdAt) || (item.dispatchStartedAt !== null && !date(item.dispatchStartedAt))) throw new Error("hosted_pending_invalid");
    return {requestId:item.requestId,reservedMicros:item.reservedMicros,createdAt:item.createdAt,dispatchStartedAt:item.dispatchStartedAt};
  });
}
