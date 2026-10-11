export * from "./crossref-adapter.ts";
export * from "./open-library-adapter.ts";

import {
  CROSSREF_CAPABILITY_ID,
  CROSSREF_CAPABILITY_VERSION,
  executeCrossrefSearch,
  parseCrossrefArgs,
} from "./crossref-adapter.ts";
import {
  OPEN_LIBRARY_CAPABILITY_ID,
  OPEN_LIBRARY_CAPABILITY_VERSION,
  executeOpenLibrarySearch,
  parseOpenLibraryArgs,
} from "./open-library-adapter.ts";
import type { AdapterExecutionResult } from "../types.ts";

export type AdapterExecutor = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  fetcher?: typeof fetch
) => Promise<AdapterExecutionResult>;

export const BUILTIN_ADAPTERS: ReadonlyMap<string, AdapterExecutor> = new Map([
  [
    `${CROSSREF_CAPABILITY_ID}@${CROSSREF_CAPABILITY_VERSION}`,
    async (args, signal, fetcher) => {
      const parsed = parseCrossrefArgs(args);
      if (!parsed) {
        return {
          success: false,
          capabilityId: CROSSREF_CAPABILITY_ID,
          capabilityVersion: CROSSREF_CAPABILITY_VERSION,
          destination: "api.crossref.org",
          latencyMs: 0,
          error: "invalid_arguments",
          checkedAt: new Date().toISOString(),
        };
      }
      return executeCrossrefSearch(parsed, signal, fetcher);
    },
  ],
  [
    `${OPEN_LIBRARY_CAPABILITY_ID}@${OPEN_LIBRARY_CAPABILITY_VERSION}`,
    async (args, signal, fetcher) => {
      const parsed = parseOpenLibraryArgs(args);
      if (!parsed) {
        return {
          success: false,
          capabilityId: OPEN_LIBRARY_CAPABILITY_ID,
          capabilityVersion: OPEN_LIBRARY_CAPABILITY_VERSION,
          destination: "openlibrary.org",
          latencyMs: 0,
          error: "invalid_arguments",
          checkedAt: new Date().toISOString(),
        };
      }
      return executeOpenLibrarySearch(parsed, signal, fetcher);
    },
  ],
]);
