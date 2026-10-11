const secretPatterns = [
  ["groq_key", /gsk_[A-Za-z0-9_-]+/g], ["gemini_key", /AIza[A-Za-z0-9_-]+/g],
  ["gemini_auth_key", /\bAQ\.[A-Za-z0-9_-]{20,}/g], ["cerebras_key", /csk-[A-Za-z0-9_-]{20,}/g],
  ["meta_key", /\bLLM\|[0-9]{1,32}\|[A-Za-z0-9._-]{8,}/g],
  ["openai_key", /sk-[A-Za-z0-9_-]+/g], ["zai_key", /z-[A-Za-z0-9_-]+/g],
  // Formato real de chave de conta Zhipu/Z.AI (32 hex + "." + 16 alfanum) — sem prefixo,
  // cabe no shape de um request_id válido e escaparia da detecção por prefixo acima.
  ["zai_account_key", /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g],
  ["uptokey_token", /utk_(?:local|device|bootstrap|control|live)_[A-Za-z0-9._-]{8,}/gi], ["bearer", /Bearer\s+\S+/gi],
  ["windows_user_path", /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/"\s]+/gi],
  ["macos_user_path", /\/Users\/[^/"\s]+/g], ["linux_user_path", /\/home\/[^/"\s]+/g]
] as const;

export interface SafeEvent {
  timestamp: string;
  provider: string;
  status_code: number;
  latency_ms: number;
  request_id: string;
}

export function scrubText(value: string, knownSecrets: readonly string[] = []): string {
  let result = secretPatterns.reduce((text, [, pattern]) => text.replace(pattern, "[REDACTED]"), value);
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}

export function telemetryLeakReason(serialized: string, knownSecrets: readonly string[] = []): string | undefined {
  if (knownSecrets.some((secret) => secret.length >= 8 && serialized.includes(secret))) return "known_secret";
  for (const [name, pattern] of secretPatterns) { pattern.lastIndex = 0; if (pattern.test(serialized)) return name; }
  return undefined;
}

export function safeEvent(event: SafeEvent, knownSecrets: readonly string[] = []): SafeEvent {
  if (!validSafeEvent(event)) throw new Error("telemetry_event_invalid");
  const serialized = JSON.stringify(event);
  if (telemetryLeakReason(serialized, knownSecrets)) {
    throw new Error("telemetry_leak_blocked");
  }
  return event;
}

function validSafeEvent(event: SafeEvent): boolean {
  return Object.keys(event).sort().join(",") === "latency_ms,provider,request_id,status_code,timestamp"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(event.timestamp) && Number.isFinite(Date.parse(event.timestamp))
    && (event.provider === "groq" || event.provider === "gemini")
    && Number.isInteger(event.status_code) && event.status_code >= 0 && event.status_code <= 599
    && Number.isFinite(event.latency_ms) && event.latency_ms >= 0 && event.latency_ms <= 86_400_000
    && /^[A-Za-z0-9._:-]{1,128}$/.test(event.request_id);
}
