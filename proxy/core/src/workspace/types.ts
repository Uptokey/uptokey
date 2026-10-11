/**
 * Workspace contracts directly consuming W0 shared canonical contracts.
 * Source: @uptokey/sync-contract/workflow.
 */

export * from "@uptokey/sync-contract/workflow";

import type { SourceRecord } from "../public-sources.ts";

export interface AdapterExecutionResult<T = SourceRecord[]> {
  readonly success: boolean;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly destination: string;
  readonly records?: T;
  readonly latencyMs: number;
  readonly error?: string;
  readonly checkedAt: string;
}
