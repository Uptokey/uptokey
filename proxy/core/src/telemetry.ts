import { safeEvent, telemetryLeakReason } from "./scrub.ts";
import type { ProviderName } from "./types.ts";

export interface ProviderFailureEvent { provider: ProviderName; statusCode: number; latencyMs: number; requestId: string; sensitiveValues?: readonly string[]; }
export interface TelemetrySink { providerFailed(event: ProviderFailureEvent): void; }

export class AllowlistTelemetry implements TelemetrySink {
  private dropped = 0;
  private readonly write: (line: string) => void;
  constructor(write: (line: string) => void = (line) => { process.stderr.write(line); }) { this.write = write; }
  providerFailed(event: ProviderFailureEvent): void {
    try {
      const candidate = {
        timestamp: new Date().toISOString(), provider: event.provider,
        status_code: event.statusCode, latency_ms: event.latencyMs, request_id: event.requestId
      };
      const reason = telemetryLeakReason(JSON.stringify(candidate), event.sensitiveValues);
      if (reason) { this.dropped += 1; this.emitBlocked(reason); return; }
      const payload = safeEvent(candidate, event.sensitiveValues);
      if (!this.safeWrite(`${JSON.stringify(payload)}\n`)) this.dropped += 1;
    } catch { this.dropped += 1; this.emitBlocked("detector_error"); }
  }

  private emitBlocked(patternId: string): void {
    const signal = JSON.stringify({ event: "telemetry_leak_blocked", timestamp: new Date().toISOString(), pattern_id: patternId, drop_count: this.dropped });
    if (!telemetryLeakReason(signal)) this.safeWrite(`${signal}\n`);
  }

  private safeWrite(line: string): boolean { try { this.write(line); return true; } catch { return false; } }
}
