/**
 * E2-20 thin W5-style adapter wrapping DiagnosticSession.
 * Lab-only: validates W0-shaped contract inputs, then delegates to session.
 * Does not touch OS CA/DNS, shared sync-contract, or product PWA.
 */
import crypto from "node:crypto";
import { DiagnosticSession } from "./diagnostic-session.js";
import {
  parseDiscoverInput,
  parseDiscoverOutput,
  parsePlanInput,
  parsePlanOutput,
  parseStartInput,
  parseCertificateInspectInput,
  parseCertificateInspectOutput,
  parseRoutePlanInput,
  parseObserveExportInput,
  parseObserveExportOutput,
  parseStopInput,
  DIAGNOSTIC_ERROR_CODES,
  DIAGNOSTIC_LIMITS,
} from "../contracts/diagnostic.js";

function fail(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  throw err;
}

/**
 * @typedef {object} W5DiagnosticAdapterOptions
 * @property {(opts: object) => import('./diagnostic-session.js').DiagnosticSession} [sessionFactory]
 * @property {object} [sessionDefaults] defaults passed to DiagnosticSession
 */

export class W5DiagnosticAdapter {
  /**
   * @param {W5DiagnosticAdapterOptions} [opts]
   */
  constructor(opts = {}) {
    this.sessionFactory =
      opts.sessionFactory || ((sessionOpts) => new DiagnosticSession(sessionOpts));
    this.sessionDefaults = { ...(opts.sessionDefaults || {}) };
    /** @type {import('./diagnostic-session.js').DiagnosticSession | null} */
    this.session = null;
    /** @type {ReturnType<typeof parsePlanOutput> | null} */
    this.approvedPlan = null;
    this._startedRequestIds = new Map(); // requestId -> receipt
    /** requestId -> uncertainty record (crash-before-receipt; no auto-retry) */
    this._uncertainByRequestId = new Map();
  }

  /** E2-20-D */
  async discover(rawInput = {}) {
    parseDiscoverInput(rawInput);
    const session = this.session || this.sessionFactory({ ...this.sessionDefaults });
    const raw = session.discover();
    return parseDiscoverOutput(raw);
  }

  /** E2-20-P — materialize revisable plan; no listen/CA yet. */
  async plan(rawInput) {
    const input = parsePlanInput(rawInput);
    const planRef = `plan_${crypto.randomBytes(6).toString("hex")}`;
    const effectsExplicit = [
      "bind_loopback_proxy_on_start",
      "session_ca_ephemeral_on_start",
      "no_os_ca",
      "no_dns_mutation",
      `collectPolicy=${input.collectPolicy}`,
    ];
    const output = parsePlanOutput({
      planRef,
      revision: 1,
      origins: input.origins,
      mode: input.mode,
      collectPolicy: input.collectPolicy,
      confidence: 1,
      effectsExplicit,
      destinations: [...input.origins],
      expiresAt: input.expiresAt,
      limits: input.limits,
      osCaMutation: false,
      dnsMutation: false,
    });
    this.approvedPlan = {
      ...output,
      appRef: input.appRef,
      ownershipEvidenceRef: input.ownershipEvidenceRef,
    };
    return output;
  }

  /** E2-20-S */
  async start(rawInput) {
    const input = parseStartInput(rawInput);
    if (this.session && this.session.state === "needs_attention") {
      fail(DIAGNOSTIC_ERROR_CODES.uncertain_state, "needs_attention_no_auto_retry");
    }
    if (this._startedRequestIds.has(input.requestId)) {
      // Idempotent return of prior receipt only — never re-apply mutating effect
      return this._startedRequestIds.get(input.requestId);
    }
    // Pending crash-before-receipt marker: refuse silent mutating retry
    if (this._uncertainByRequestId.has(input.requestId)) {
      fail(DIAGNOSTIC_ERROR_CODES.uncertain_state, "crash_before_receipt_no_auto_retry");
    }
    if (this.session && this.session.state === "active") {
      const receipt = await this.session.start({
        approvedPlanRef: input.approvedPlanRef,
        requestId: input.requestId,
      });
      this._startedRequestIds.set(input.requestId, receipt);
      return receipt;
    }
    if (
      this.approvedPlan &&
      this.approvedPlan.planRef !== input.approvedPlanRef &&
      input.approvedPlanRef !== "lab-plan"
    ) {
      // Allow lab-plan shortcut for harness; otherwise require matching planRef
      fail(DIAGNOSTIC_ERROR_CODES.plan_invalid, "approvedPlanRef_mismatch");
    }
    const plan = this.approvedPlan;
    const sessionOpts = {
      ...this.sessionDefaults,
      origins: plan?.origins || this.sessionDefaults.origins || ["127.0.0.1"],
      collectPolicy: plan?.collectPolicy || this.sessionDefaults.collectPolicy || "off",
      ttlMs: plan?.limits?.ttlMs || this.sessionDefaults.ttlMs || DIAGNOSTIC_LIMITS.maxSessionTtlMs,
    };
    if (!sessionOpts.stateDir) {
      fail(DIAGNOSTIC_ERROR_CODES.plan_invalid, "stateDir_required");
    }
    this.session = this.sessionFactory(sessionOpts);
    const receipt = await this.session.start({
      approvedPlanRef: input.approvedPlanRef,
      requestId: input.requestId,
    });
    this._startedRequestIds.set(input.requestId, receipt);
    return receipt;
  }

  /** E2-20-C */
  async certificateInspect(rawInput) {
    const input = parseCertificateInspectInput(rawInput);
    if (!this.session || this.session.id !== input.sessionRef) {
      return parseCertificateInspectOutput({ error: DIAGNOSTIC_ERROR_CODES.diagnostic_disabled });
    }
    return parseCertificateInspectOutput(this.session.certificateInspect());
  }

  /** E2-20-R — propose alias/route diff; never widens authority. */
  async routePlan(rawInput) {
    const input = parseRoutePlanInput(rawInput);
    if (!this.session || this.session.id !== input.sessionRef) {
      fail(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
    }
    if (input.expectedRevision !== this.session.revision) {
      fail(DIAGNOSTIC_ERROR_CODES.revision_mismatch);
    }
    const granted =
      input.grantedDestinations ||
      this.approvedPlan?.destinations ||
      [...(this.session.origins || [])];
    const added = [];
    const rejected = [];
    for (const [alias, dest] of Object.entries(input.aliasMap)) {
      const destHost = dest.split(":")[0];
      const ok = granted.some((g) => g === dest || String(g).split(":")[0] === destHost);
      if (ok) added.push({ alias, dest });
      else rejected.push({ alias, dest, reason: DIAGNOSTIC_ERROR_CODES.target_not_authorized });
    }
    return {
      sessionRef: input.sessionRef,
      expectedRevision: input.expectedRevision,
      currentRevision: this.session.revision,
      authorityWidened: false,
      diff: { added, rejected },
      plan: {
        aliasesAccepted: added,
        note: "route.plan proposes only; apply requires separate approved effect",
      },
    };
  }

  /** E2-20-O observe */
  async observe(rawInput) {
    const input = parseObserveExportInput(rawInput);
    if (!this.session || this.session.id !== input.sessionRef) {
      fail(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
    }
    return parseObserveExportOutput(this.session.observeExport({ cursor: input.cursor }));
  }

  /** E2-20-O export (same session export; artifactRef remains null in lab). */
  async export(rawInput) {
    const input = parseObserveExportInput(rawInput);
    if (!this.session || this.session.id !== input.sessionRef) {
      fail(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
    }
    const out = parseObserveExportOutput(this.session.observeExport({ cursor: input.cursor }));
    return {
      ...out,
      format: input.format,
      manifesto: input.manifesto
        ? {
            packageId: "E2-20",
            sessionRef: input.sessionRef,
            collectionState: out.collectionState,
            recordCount: out.records.length,
            privateKeys: false,
            artifactRef: out.artifactRef,
          }
        : null,
    };
  }

  /** E2-20-X */
  async stop(rawInput) {
    const input = parseStopInput(rawInput);
    if (!this.session || this.session.id !== input.sessionRef) {
      fail(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
    }
    if (
      input.expectedRevision != null &&
      input.expectedRevision !== this.session.revision
    ) {
      fail(DIAGNOSTIC_ERROR_CODES.revision_mismatch);
    }
    if (
      this.session.state === "needs_attention" &&
      input.reason !== "operator_reconcile"
    ) {
      fail(DIAGNOSTIC_ERROR_CODES.uncertain_state, "needs_attention_use_reconcile");
    }
    if (input.reason === "operator_reconcile") {
      const receipt = await this.session.reconcileAttention({
        requestId: `reconcile_${input.sessionRef}`,
      });
      this._uncertainByRequestId.clear();
      return receipt;
    }
    const receipt = await this.session.stop({ reason: input.reason });
    return receipt;
  }

  /**
   * Lab/test: simulate crash after mutating effect, before durable receipt.
   * Leaves session in needs_attention; blocks automatic mutating retry.
   */
  simulateCrashBeforeReceipt({ effectKind = "start", requestId, reason } = {}) {
    if (!this.session) {
      fail(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled, "no_session");
    }
    const rid = requestId || `crash_${Date.now()}`;
    // Drop any cached start receipt so a later same-requestId cannot look "done"
    this._startedRequestIds.delete(rid);
    const u = this.session.markCrashBeforeReceipt({
      effectKind,
      requestId: rid,
      reason: reason || "crash_before_receipt",
      resourcesHint: this.session.boundEndpoint ? [this.session.boundEndpoint] : [],
    });
    this._uncertainByRequestId.set(rid, u);
    return u;
  }

  getUncertainty() {
    return this.session?.getUncertainty?.() ?? null;
  }

  /** Convenience: bind an already-constructed session (tests). */
  attachSession(session) {
    this.session = session;
    return this;
  }

  getSessionRef() {
    return this.session?.id ?? null;
  }

  getRevision() {
    return this.session?.revision ?? null;
  }
}

export default W5DiagnosticAdapter;
