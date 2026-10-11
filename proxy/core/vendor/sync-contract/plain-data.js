export function isDataRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value"));
}

export function asDataRecord(value) { return isDataRecord(value) ? value : undefined; }

export function projectDataArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(maximum) || maximum < 0 || value.length > maximum) return undefined;
  const keys = Reflect.ownKeys(value); if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value); const result = [];
  for (let index = 0; index < value.length; index += 1) { const key = String(index); const descriptor = descriptors[key]; if (keys[index] !== key || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined; result.push(descriptor.value); }
  return result;
}

export function projectStringArray(value, maximum) {
  const projected = projectDataArray(value, maximum);
  return projected && projected.every((item) => typeof item === "string") ? projected : undefined;
}
