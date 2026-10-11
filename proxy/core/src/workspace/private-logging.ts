/**
 * E2-15-L — private content logging with explicit consent, TTL, scope, and canary scrub.
 * Metrics/analytics opt-in does NOT enable content logging.
 * Default I/O is off; enabling requires scope, destinations, duration, approval.
 */

import { createHash, randomUUID } from "node:crypto";
import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import {
  ObservabilityError,
  QUERY_LIMITS,
  type LoggingMode,
  type PrivateLoggingPlan,
} from "./usage-observability-types.ts";

/** Canary / secret patterns that must never appear in logs or export. */
const CANARY_PATTERNS: readonly RegExp[] = [
  /gsk_[A-Za-z0-9_\-]{8,}/g,
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sig=[A-Za-z0-9%\-_]+/gi,
  /se=\d{4}-\d{2}-\d{2}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /password\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
];

export function scrubCanaries(text: string): { text: string; redacted: number } {
  let out = text;
  let redacted = 0;
  for (const re of CANARY_PATTERNS) {
    out = out.replace(re, () => {
      redacted++;
      return "[REDACTED]";
    });
  }
  return { text: out, redacted };
}

export function containsCanary(text: string): boolean {
  return CANARY_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export function planPrivateLogging(
  store: UsageObservabilityStore,
  input: {
    principalId: string;
    scopeRef: string;
    mode: LoggingMode;
    expiresAt: string;
    retentionDays?: number;
    destinationRefs: readonly string[];
    consentToken: string;
    /** Must be true after explicit UI consent; analytics toggle alone is false. */
    contentConsent: boolean;
    expectedRevision?: number;
    id?: string;
  },
): PrivateLoggingPlan {
  if (!input.principalId) throw new ObservabilityError("unauthorized");
  if (input.mode === "content" && !input.contentConsent) {
    throw new ObservabilityError("unauthorized");
  }
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires)) throw new ObservabilityError("invalid_range");
  const maxExpiry = Date.now() + QUERY_LIMITS.loggingMaxEnableHours * 3600 * 1000;
  if (expires > maxExpiry) throw new ObservabilityError("limit_exceeded");
  if (expires <= Date.now()) throw new ObservabilityError("invalid_range");

  const retentionDays = Math.min(
    Math.max(input.retentionDays ?? QUERY_LIMITS.loggingDefaultRetentionDays, 1),
    QUERY_LIMITS.loggingDefaultRetentionDays,
  );

  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        principalId: input.principalId,
        scopeRef: input.scopeRef,
        mode: input.mode,
        expiresAt: input.expiresAt,
        destinationRefs: input.destinationRefs,
        consentToken: input.consentToken,
        contentConsent: input.contentConsent,
      }),
    )
    .digest("hex");

  const plan: PrivateLoggingPlan = {
    id: input.id ?? `logplan_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    principalId: input.principalId,
    scopeRef: input.scopeRef,
    mode: input.mode,
    expiresAt: input.expiresAt,
    retentionDays,
    maxBytes: QUERY_LIMITS.loggingMaxBytesPerProfile,
    destinationRefs: Object.freeze([...input.destinationRefs]),
    consentDigest: digest,
    applied: input.contentConsent && input.mode === "content",
    paused: false,
    revision: 0,
  };

  return store.putLoggingPlan(plan, input.expectedRevision);
}

/** Idempotent pause/revoke — blocks new captures/sends; does not promise remote deletion. */
export function pauseOrRevokeLogging(
  store: UsageObservabilityStore,
  input: { principalId: string; planId: string; expectedRevision: number; purgeLocal?: boolean },
): { plan: PrivateLoggingPlan; purgedBodies: number; remoteDelete: "not_promised" | "unavailable" } {
  const existing = store.getLoggingPlan(input.planId);
  if (!existing || existing.principalId !== input.principalId) throw new ObservabilityError("unauthorized");
  if (existing.revision !== input.expectedRevision) throw new ObservabilityError("revision_conflict");

  const paused: PrivateLoggingPlan = {
    ...existing,
    paused: true,
    applied: false,
  };
  const plan = store.putLoggingPlan(paused, input.expectedRevision);
  let purged = 0;
  if (input.purgeLocal) purged = store.purgeBodies(plan.id);
  return { plan, purgedBodies: purged, remoteDelete: "not_promised" };
}

/**
 * Attempt to capture I/O for a run under an applied plan.
 * Default-off: without applied content plan, returns zero bodies collected.
 */
export function tryCaptureContent(
  store: UsageObservabilityStore,
  input: {
    principalId: string;
    planId: string | null;
    runId: string;
    attemptId: string;
    role: "input" | "output";
    rawText: string;
    now?: number;
  },
): { captured: boolean; reason: string; scrubbedPreview?: string } {
  if (!input.planId) {
    return { captured: false, reason: "logging_off_default" };
  }
  const plan = store.getLoggingPlan(input.planId);
  if (!plan || plan.principalId !== input.principalId) {
    return { captured: false, reason: "unauthorized" };
  }
  if (!plan.applied || plan.paused || plan.mode !== "content") {
    return { captured: false, reason: "logging_not_enabled" };
  }
  const now = input.now ?? Date.now();
  if (Date.parse(plan.expiresAt) <= now) {
    return { captured: false, reason: "consent_expired" };
  }

  const { text, redacted } = scrubCanaries(input.rawText);
  // Fail closed: if canary still detectable after scrub, refuse capture
  if (containsCanary(text)) {
    return { captured: false, reason: "canary_refuse", scrubbedPreview: "[REDACTED]" };
  }

  const bytes = Buffer.from(text, "utf8");
  const existingBytes = store.listBodies(plan.id).reduce((n, b) => n + b.bytes.byteLength, 0);
  if (existingBytes + bytes.byteLength > plan.maxBytes) {
    return { captured: false, reason: "limit_exceeded" };
  }

  const expiresAt = new Date(now + plan.retentionDays * 86400_000).toISOString();
  store.captureBody({
    planId: plan.id,
    runId: input.runId,
    attemptId: input.attemptId,
    role: input.role,
    bytes: new Uint8Array(bytes),
    capturedAt: new Date(now).toISOString(),
    expiresAt,
  });
  return {
    captured: true,
    reason: redacted > 0 ? "captured_with_redactions" : "captured",
    scrubbedPreview: text.slice(0, 64),
  };
}

/** Expired consent must not auto-renew on restart. */
export function isConsentLive(plan: PrivateLoggingPlan, now = Date.now()): boolean {
  return plan.applied && !plan.paused && Date.parse(plan.expiresAt) > now;
}
