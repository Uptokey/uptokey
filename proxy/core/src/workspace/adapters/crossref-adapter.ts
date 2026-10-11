import { searchPublicSource, type SourceRecord } from "../../public-sources.ts";
import type { AdapterExecutionResult } from "../types.ts";

export interface CrossrefSearchArgs {
  readonly query: string;
  /** Contato educado (polite pool); opcional, nunca vira credencial. */
  readonly email?: string;
}

export const CROSSREF_CAPABILITY_ID = "sources.crossref.search";
export const CROSSREF_CAPABILITY_VERSION = 1;
export const CROSSREF_DESTINATION = "api.crossref.org";

export function parseCrossrefArgs(input: unknown): CrossrefSearchArgs | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (!["query", "email,query"].includes(keys)) return undefined;
  if (typeof raw.query !== "string") return undefined;
  const trimmed = raw.query.trim();
  if (trimmed.length < 2 || trimmed.length > 300 || /[\u0000-\u001f]/.test(trimmed)) {
    return undefined;
  }
  let email: string | undefined;
  if (raw.email !== undefined) {
    if (typeof raw.email !== "string" || raw.email.length > 200 || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/.test(raw.email)) return undefined;
    email = raw.email;
  }
  return { query: trimmed, ...(email ? { email } : {}) };
}

export async function executeCrossrefSearch(
  args: CrossrefSearchArgs,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<AdapterExecutionResult<SourceRecord[]>> {
  const started = performance.now();
  try {
    const result = await searchPublicSource({ source: "crossref", query: args.query, ...(args.email ? { email: args.email } : {}) }, signal, fetcher);
    return {
      success: true,
      capabilityId: CROSSREF_CAPABILITY_ID,
      capabilityVersion: CROSSREF_CAPABILITY_VERSION,
      destination: CROSSREF_DESTINATION,
      records: result.records,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: result.checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_source_error";
    return {
      success: false,
      capabilityId: CROSSREF_CAPABILITY_ID,
      capabilityVersion: CROSSREF_CAPABILITY_VERSION,
      destination: CROSSREF_DESTINATION,
      latencyMs: Math.round(performance.now() - started),
      error: message,
      checkedAt: new Date().toISOString(),
    };
  }
}
