import { searchPublicSource, type SourceRecord } from "../../public-sources.ts";
import type { AdapterExecutionResult } from "../types.ts";

export interface OpenLibrarySearchArgs {
  readonly query: string;
}

export const OPEN_LIBRARY_CAPABILITY_ID = "sources.open-library.search";
export const OPEN_LIBRARY_CAPABILITY_VERSION = 1;
export const OPEN_LIBRARY_DESTINATION = "openlibrary.org";

export function parseOpenLibraryArgs(input: unknown): OpenLibrarySearchArgs | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.query !== "string") return undefined;
  const trimmed = raw.query.trim();
  if (trimmed.length < 2 || trimmed.length > 300 || /[\u0000-\u001f]/.test(trimmed)) {
    return undefined;
  }
  return { query: trimmed };
}

export async function executeOpenLibrarySearch(
  args: OpenLibrarySearchArgs,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<AdapterExecutionResult<SourceRecord[]>> {
  const started = performance.now();
  try {
    const result = await searchPublicSource({ source: "open-library", query: args.query }, signal, fetcher);
    return {
      success: true,
      capabilityId: OPEN_LIBRARY_CAPABILITY_ID,
      capabilityVersion: OPEN_LIBRARY_CAPABILITY_VERSION,
      destination: OPEN_LIBRARY_DESTINATION,
      records: result.records,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: result.checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_source_error";
    return {
      success: false,
      capabilityId: OPEN_LIBRARY_CAPABILITY_ID,
      capabilityVersion: OPEN_LIBRARY_CAPABILITY_VERSION,
      destination: OPEN_LIBRARY_DESTINATION,
      latencyMs: Math.round(performance.now() - started),
      error: message,
      checkedAt: new Date().toISOString(),
    };
  }
}
