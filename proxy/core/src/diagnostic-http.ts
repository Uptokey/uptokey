import type { Context, Hono } from "hono";
import { W5DiagnosticAdapter } from "../../integracoes/e2-20-diagnostic/src/w5-diagnostic-adapter.js";
import { dataDir } from "./paths.ts";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { join } from "node:path";

/**
 * E2-20 — MITM de diagnóstico controlado (rotas locais).
 * Default OFF: descobrir é sempre inócuo (zero captura); plan/start exigem
 * UPTOKEY_E2_20_DIAGNOSTIC=1. Loopback apenas; CA efêmera por sessão; sem
 * mutação de CA/DNS do SO; sem insecureSkipVerify; sem wildcard.
 */

export const DIAGNOSTIC_LOCAL_ROUTES = [
  { path: "/local/diagnostic/discover", method: "POST" as const },
  { path: "/local/diagnostic/plan", method: "POST" as const },
  { path: "/local/diagnostic/start", method: "POST" as const },
  { path: "/local/diagnostic/certificate", method: "POST" as const },
  { path: "/local/diagnostic/route", method: "POST" as const },
  { path: "/local/diagnostic/observe", method: "POST" as const },
  { path: "/local/diagnostic/export", method: "POST" as const },
  { path: "/local/diagnostic/stop", method: "POST" as const },
] as const;

const MAX_BODY_BYTES = 262_144;
const DIAGNOSTIC_ENABLED_ENV = "UPTOKEY_E2_20_DIAGNOSTIC";
const MAX_JOURNALED_RECEIPTS = 256;

/** Journal durável de recibos de diagnóstico — metadados apenas, sem segredos/PEM. */
export class DiagnosticReceiptJournal {
  private readonly path: string;
  private entries: Array<Record<string, unknown>> = [];
  private loaded = false;

  constructor(root = dataDir()) {
    this.path = join(root, "diagnostic", "receipts-journal.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const value = await readJson<Record<string, unknown>>(this.path, { schemaVersion: 1, receipts: [] });
      const receipts = value.receipts;
      this.entries = Array.isArray(receipts) ? (receipts as Array<Record<string, unknown>>).slice(-MAX_JOURNALED_RECEIPTS) : [];
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.entries];
  }

  /** Persiste o recibo com fsync atômico; campos grandes/corpos nunca entram. */
  async append(receipt: Record<string, unknown>): Promise<void> {
    await this.load();
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(receipt)) {
      if (typeof value === "string" && /BEGIN .*PRIVATE KEY/.test(value)) continue;
      if (key === "records" || key === "body") continue;
      sanitized[key] = value;
    }
    this.entries = [...this.entries, { journaledAt: new Date().toISOString(), ...sanitized }].slice(-MAX_JOURNALED_RECEIPTS);
    await writeJsonAtomic(this.path, { schemaVersion: 1, receipts: this.entries });
  }
}

export function diagnosticFeatureEnabled(): boolean {
  return process.env[DIAGNOSTIC_ENABLED_ENV] === "1";
}

type AuthCheck = (authorizationHeader: string | undefined) => Promise<boolean>;

export interface DiagnosticHttpOptions {
  authorize: AuthCheck;
  adapter?: W5DiagnosticAdapter;
  journal?: DiagnosticReceiptJournal;
}

function statusForCode(code: string): 400 | 403 | 409 | 502 {
  switch (code) {
    case "diagnostic_disabled":
    case "ownership_scope_unverified":
    case "target_not_authorized":
    case "collection_not_authorized":
    case "pinned_client_unsupported":
    case "certificate_untrusted":
      return 403;
    case "revision_mismatch":
    case "port_conflict":
    case "uncertain_state":
      return 409;
    case "backend_unavailable":
      return 502;
    default:
      return 400;
  }
}

function jsonError(c: Context, type: string, status: 400 | 401 | 403 | 409 | 502) {
  return c.json({ error: { type } }, status);
}

async function readBoundedBody(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function registerDiagnosticRoutes(app: Hono, options: DiagnosticHttpOptions): void {
  const adapter = options.adapter ?? new W5DiagnosticAdapter({
    sessionDefaults: { stateDir: join(dataDir(), "diagnostic") },
  });
  const journal = options.journal ?? new DiagnosticReceiptJournal();

  const requireAuth = async (c: Context): Promise<boolean> => options.authorize(c.req.header("authorization"));

  const handle = (route: (typeof DIAGNOSTIC_LOCAL_ROUTES)[number]["path"], op: (body: Record<string, unknown>) => Promise<unknown>, journalKind = false) =>
    app.post(route, async (c) => {
      if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
      const body = await readBoundedBody(c);
      if (body === null) return jsonError(c, "invalid_request", 400);
      // Discover is always safe (zero capture); every other op requires the opt-in flag.
      if (!diagnosticFeatureEnabled() && route !== "/local/diagnostic/discover") {
        return jsonError(c, "diagnostic_disabled", 403);
      }
      try {
        const result = await op(body);
        if (journalKind && result && typeof result === "object" && "kind" in (result as Record<string, unknown>)) {
          await journal.append(result as Record<string, unknown>).catch(() => undefined);
        }
        return c.json(result);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!code) throw error;
        return jsonError(c, code, statusForCode(code));
      }
    });

  handle("/local/diagnostic/discover", async (body) => {
    const disc = (await adapter.discover(body)) as Record<string, unknown>;
    return { ...disc, enabled: diagnosticFeatureEnabled() };
  });
  handle("/local/diagnostic/plan", (body) => adapter.plan(body));
  handle("/local/diagnostic/start", (body) => adapter.start(body as { approvedPlanRef: string; requestId: string }), true);
  handle("/local/diagnostic/certificate", (body) => adapter.certificateInspect(body as { sessionRef: string }));
  handle("/local/diagnostic/route", (body) => adapter.routePlan(body));
  handle("/local/diagnostic/observe", (body) => adapter.observe(body as { sessionRef: string; cursor: number }));
  handle("/local/diagnostic/export", (body) => adapter.export(body as { sessionRef: string; cursor: number; format: string; manifesto: boolean }));
  handle("/local/diagnostic/stop", (body) => adapter.stop(body as { sessionRef: string; expectedRevision?: number | null; reason?: string }), true);
}
