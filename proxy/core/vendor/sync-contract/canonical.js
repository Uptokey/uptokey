export function canonicalJson(value) {
  return canonicalValue(value, 0, new Set(), { remaining: 1_048_576 });
}

export function envelopeChallengePayload(tenantId, envelope) {
  if (typeof tenantId !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(tenantId)) throw new Error("sync_invalid_challenge");
  const serializedEnvelope = canonicalJson(envelope);
  if (new TextEncoder().encode(serializedEnvelope).byteLength > 131_072) throw new Error("sync_invalid_challenge");
  return new TextEncoder().encode(canonicalJson({ tenant_id: tenantId, envelope }));
}

function canonicalValue(value, depth, seen, budget) {
  if (depth > 32 || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("sync_non_json_value");
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("sync_non_json_value");
    if (typeof value === "string" && value.length + 2 > budget.remaining) throw new Error("sync_non_json_value");
    return charge(JSON.stringify(value), budget);
  }
  if (seen.has(value)) throw new Error("sync_non_json_value"); seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("sync_non_json_value");
      if (value.length > 1_024) throw new Error("sync_non_json_value");
      const ownKeys = Reflect.ownKeys(value); const keys = Object.keys(value);
      if (ownKeys.length !== value.length + 1 || ownKeys[ownKeys.length - 1] !== "length" || keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error("sync_non_json_value");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw new Error("sync_non_json_value");
      const parts = [charge("[", budget)];
      keys.forEach((key, index) => { if (index) parts.push(charge(",", budget)); parts.push(canonicalValue(descriptors[key].value, depth + 1, seen, budget)); });
      parts.push(charge("]", budget)); return parts.join("");
    }
    const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) throw new Error("sync_non_json_value");
    const keys = Reflect.ownKeys(value); if (keys.length > 256 || keys.some((key) => typeof key !== "string")) throw new Error("sync_non_json_value");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw new Error("sync_non_json_value");
    const parts = [charge("{", budget)];
    keys.sort().forEach((key, index) => { if (key.length + 2 > budget.remaining) throw new Error("sync_non_json_value"); if (index) parts.push(charge(",", budget)); parts.push(charge(JSON.stringify(key), budget), charge(":", budget), canonicalValue(descriptors[key].value, depth + 1, seen, budget)); });
    parts.push(charge("}", budget)); return parts.join("");
  } finally { seen.delete(value); }
}

function charge(fragment, budget) { if (fragment.length > budget.remaining) throw new Error("sync_non_json_value"); const size = new TextEncoder().encode(fragment).byteLength; if (size > budget.remaining) throw new Error("sync_non_json_value"); budget.remaining -= size; return fragment; }
