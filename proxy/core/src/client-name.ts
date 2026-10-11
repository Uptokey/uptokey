const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function normalizeClientName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().normalize("NFC");
  return normalized.length >= 1 && normalized.length <= 80 && !UNSAFE_DISPLAY_CHARACTER.test(normalized) ? normalized : undefined;
}
