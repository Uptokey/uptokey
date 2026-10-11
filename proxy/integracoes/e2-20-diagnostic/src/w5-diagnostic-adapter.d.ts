/** E2-20 W5DiagnosticAdapter — type surface for product import (proxy-local). */
export interface DiagnosticReceipt {
  kind: string;
  sessionRef: string;
  boundEndpoint: string | null;
  state: string;
  revision: number;
  collectPolicy: string;
  expiresAt: string | null;
  protocol: string;
  destinationPolicy: string;
  [key: string]: unknown;
}

export interface W5DiagnosticAdapterOptions {
  sessionFactory?: (sessionOpts: Record<string, unknown>) => unknown;
  sessionDefaults?: Record<string, unknown>;
}

export declare class W5DiagnosticAdapter {
  session: unknown;
  constructor(opts?: W5DiagnosticAdapterOptions);
  discover(rawInput?: unknown): Promise<Record<string, unknown>>;
  plan(rawInput: unknown): Promise<Record<string, unknown>>;
  start(rawInput: { approvedPlanRef: string; requestId: string }): Promise<DiagnosticReceipt>;
  certificateInspect(rawInput: { sessionRef: string }): Promise<Record<string, unknown>>;
  routePlan(rawInput: unknown): Promise<Record<string, unknown>>;
  observe(rawInput: { sessionRef: string; cursor: number }): Promise<Record<string, unknown>>;
  export(rawInput: { sessionRef: string; cursor: number; format: string; manifesto: boolean }): Promise<Record<string, unknown>>;
  stop(rawInput: { sessionRef: string; expectedRevision?: number | null; reason?: string }): Promise<DiagnosticReceipt>;
  simulateCrashBeforeReceipt(opts?: { effectKind?: string; requestId?: string; reason?: string }): Record<string, unknown>;
  getUncertainty(): Record<string, unknown> | null;
  attachSession(session: unknown): W5DiagnosticAdapter;
  getSessionRef(): string | null;
  getRevision(): number | null;
}
