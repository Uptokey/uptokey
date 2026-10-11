import { scrubText, telemetryLeakReason } from "../scrub.ts";

/**
 * Stage 10 optional content rules (guardrails delimitados).
 *
 * Bounded input/output checks (block a secret from observability, warn about
 * personal data before sending). Findings feed stage-03 admission metadata via
 * `summarizeForAdmission`; they never replace the central policy: `enforce`
 * consults the central grant decision first, a detector `allow` never wins
 * over a grant denial, and tools stay under the stage-11 boundaries even when
 * a classifier judges the text safe. No detector is labeled complete
 * protection against prompt injection.
 *
 * Findings never carry sensitive snippets: only rule/version/scope/finding
 * type/configured action/stable code. Redaction of a payload changes its
 * digest and must happen BEFORE approval; the conserved original follows the
 * storage policy, never a save-everything default.
 *
 * Disabled by default (`UPTOKEY_CONTENT_RULES=on` opts in); warn-only rules
 * never take down the application and a detector failure cannot release an
 * effect the central policy forbids.
 */

export type ContentFindingKind = "secret" | "personal_data" | "signed_url" | "prompt_injection_suspect";
export type ContentAction = "allow" | "redact" | "warn" | "deny";
export type ContentScope = "observability" | "outbound";

export interface ContentRule {
  readonly id: string;
  readonly version: number;
  readonly scope: ContentScope;
  readonly finding: ContentFindingKind;
  /** Configured action; the application decides through the central grants, not the model. */
  readonly action: Exclude<ContentAction, "allow">;
  readonly description?: string;
}

export interface ContentException {
  readonly ruleId: string;
  readonly principalId?: string;
  /** Bounded purpose, e.g. "observability-debug". Never the content itself. */
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revoked?: boolean;
}

export interface ContentFinding {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly scope: ContentScope;
  readonly finding: ContentFindingKind | "detector_unavailable";
  readonly action: ContentAction;
  readonly code: string;
  readonly excepted: boolean;
}

export interface ContentEvaluation {
  readonly findings: readonly ContentFinding[];
  readonly decision: ContentAction;
  readonly redactedText?: string;
}

export interface ContentRuleMetrics {
  readonly evaluations: number;
  readonly hits: number;
  readonly excepted: number;
  readonly detectorFailures: number;
}

export type CentralDecision = { allowed: true } | { allowed: false; code: string; status: number };

const MAX_RULES = 32;
const MAX_TEXT_BYTES = 256 * 1024;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?|\d{2,4}[\s-])?\d{4,5}[\s-]?\d{4}\b/g;
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const SIGNED_QUERY = /[?&](sig(nature)?|signature|x-amz-signature|token|access_token|se|st|spr|sv)=[^&\s]*/gi;
const INJECTION = /\b(ignore\s+(all\s+)?previous\s+instructions|disregard\s+.*instructions|reveal\s+(your\s+)?system\s+prompt|bypass\s+.*(policy|filter|guardrail)|jailbreak)\b/i;

function validRule(rule: ContentRule): boolean {
  return typeof rule.id === "string" && /^[a-z0-9-]{1,64}$/.test(rule.id) &&
    Number.isSafeInteger(rule.version) && rule.version >= 1 &&
    (rule.scope === "observability" || rule.scope === "outbound") &&
    (["secret", "personal_data", "signed_url", "prompt_injection_suspect"] as const).includes(rule.finding) &&
    (["redact", "warn", "deny"] as const).includes(rule.action);
}

function detect(kind: ContentFindingKind, text: string, knownSecrets: readonly string[]): boolean {
  switch (kind) {
    case "secret": return telemetryLeakReason(text, knownSecrets) !== undefined;
    case "personal_data": return freshTest(EMAIL, text) || freshTest(PHONE, text) || freshTest(CPF, text);
    case "signed_url": return freshTest(SIGNED_QUERY, text);
    case "prompt_injection_suspect": return INJECTION.test(text);
  }
}

/** Stateless use of a shared global regex: always scan the candidate text from zero. */
function freshTest(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  try {
    return pattern.test(text);
  } finally {
    pattern.lastIndex = 0;
  }
}

function redactText(text: string): string {
  const maskedEmails = text.replace(new RegExp(EMAIL.source, "gi"), "[redacted-email]");
  const maskedPhones = maskedEmails.replace(new RegExp(PHONE.source, "g"), "[redacted-phone]");
  const maskedCpf = maskedPhones.replace(new RegExp(CPF.source, "g"), "[redacted-id]");
  const maskedUrls = maskedCpf.replace(new RegExp(SIGNED_QUERY.source, "gi"), "[signed-query-redacted]");
  return scrubText(maskedUrls);
}

function exceptionApplies(exception: ContentException, ruleId: string, principalId: string | undefined, now: number): boolean {
  if (exception.ruleId !== ruleId || exception.revoked === true) return false;
  if (exception.principalId !== undefined && exception.principalId !== principalId) return false;
  if (typeof exception.purpose !== "string" || !exception.purpose || exception.purpose.length > 128) return false;
  const expires = Date.parse(exception.expiresAt);
  return Number.isFinite(expires) && expires > now;
}

export class ContentRuleEngine {
  private readonly rules: readonly ContentRule[];
  private readonly metrics = new Map<string, ContentRuleMetrics>();

  constructor(rules: readonly ContentRule[]) {
    if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error("content_rules_invalid");
    const ids = new Set<string>();
    for (const rule of rules) {
      if (!validRule(rule) || ids.has(rule.id)) throw new Error("content_rules_invalid");
      ids.add(rule.id);
      this.metrics.set(rule.id, { evaluations: 0, hits: 0, excepted: 0, detectorFailures: 0 });
    }
    this.rules = Object.freeze([...rules]);
  }

  metricsSnapshot(): Readonly<Record<string, ContentRuleMetrics>> {
    return Object.freeze(Object.fromEntries(this.metrics));
  }

  evaluate(
    text: string,
    options: { scope: ContentScope; principalId?: string; exceptions?: readonly ContentException[]; knownSecrets?: readonly string[]; now?: number } = { scope: "outbound" },
  ): ContentEvaluation {
    const now = options.now ?? Date.now();
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES || !Number.isFinite(now)) {
      throw new Error("content_evaluation_invalid");
    }
    const findings: ContentFinding[] = [];
    // Severity rank: allow 0 < warn 1 < redact 2 < deny 3. Keeps the decision
    // mutable for the compiler without losing the closed action set.
    let severity = 0;
    let redacted: string | undefined;
    const escalate = (action: ContentAction): void => {
      severity = Math.max(severity, action === "deny" ? 3 : action === "redact" ? 2 : action === "warn" ? 1 : 0);
    };
    for (const rule of this.rules) {
      if (rule.scope !== options.scope) continue;
      const counters = this.metrics.get(rule.id)!;
      this.metrics.set(rule.id, { ...counters, evaluations: saturating(counters.evaluations) });
      let hit: boolean;
      try {
        hit = detect(rule.finding, text, options.knownSecrets ?? []);
      } catch {
        this.metrics.set(rule.id, { ...this.metrics.get(rule.id)!, detectorFailures: saturating(this.metrics.get(rule.id)!.detectorFailures) });
        // Fail-closed inside deny scope, warn elsewhere; never an allow, never a throw into the app.
        const fallback: ContentAction = rule.action === "deny" ? "deny" : "warn";
        findings.push({ ruleId: rule.id, ruleVersion: rule.version, scope: rule.scope, finding: "detector_unavailable", action: fallback, code: `${rule.id}.detector_unavailable`, excepted: false });
        escalate(fallback);
        continue;
      }
      if (!hit) continue;
      this.metrics.set(rule.id, { ...this.metrics.get(rule.id)!, hits: saturating(this.metrics.get(rule.id)!.hits) });
      const excepted = (options.exceptions ?? []).some((exception) => exceptionApplies(exception, rule.id, options.principalId, now));
      if (excepted) {
        this.metrics.set(rule.id, { ...this.metrics.get(rule.id)!, excepted: saturating(this.metrics.get(rule.id)!.excepted) });
        findings.push({ ruleId: rule.id, ruleVersion: rule.version, scope: rule.scope, finding: rule.finding, action: "allow", code: `${rule.id}.excepted`, excepted: true });
        continue;
      }
      findings.push({ ruleId: rule.id, ruleVersion: rule.version, scope: rule.scope, finding: rule.finding, action: rule.action, code: `${rule.id}.${rule.finding}`, excepted: false });
      escalate(rule.action);
    }
    const decision: ContentAction = severity >= 3 ? "deny" : severity === 2 ? "redact" : severity === 1 ? "warn" : "allow";
    if (decision === "redact") redacted = redactText(text);
    return Object.freeze({ findings: Object.freeze([...findings]), decision, ...(redacted === undefined ? {} : { redactedText: redacted }) });
  }

  /**
   * Central grants decide. A detector `allow` never overrides a central denial;
   * deny/redact/warn apply only inside the rule's configured scope after the
   * central check passes. Findings carry no sensitive snippet.
   */
  enforce(
    text: string,
    central: CentralDecision,
    options: { scope: ContentScope; principalId?: string; exceptions?: readonly ContentException[]; knownSecrets?: readonly string[]; now?: number } = { scope: "outbound" },
  ): { central: CentralDecision; findings: readonly ContentFinding[]; decision: ContentAction; redactedText?: string } {
    if (!central.allowed) return { central, findings: Object.freeze([]), decision: "allow" };
    try {
      const evaluation = this.evaluate(text, options);
      if (evaluation.decision === "deny") {
        const code = evaluation.findings.find((finding) => finding.action === "deny")?.code ?? "content.denied";
        return { central: { allowed: false, code, status: 403 }, findings: evaluation.findings, decision: "deny" };
      }
      return { central, findings: evaluation.findings, decision: evaluation.decision, ...(evaluation.redactedText === undefined ? {} : { redactedText: evaluation.redactedText }) };
    } catch {
      // A warn-only optional policy must never take down the application.
      return { central, findings: Object.freeze([]), decision: "allow" };
    }
  }
}

/** Admission feed for stage 03: rule/version/action/code only, never the flagged content. */
export function summarizeForAdmission(findings: readonly ContentFinding[]): ReadonlyArray<{ rule: string; version: number; action: ContentAction; code: string }> {
  return Object.freeze(findings.map((finding) => Object.freeze({
    rule: finding.ruleId, version: finding.ruleVersion, action: finding.action, code: finding.code,
  })));
}

/** Rollback flag for stage 10: default off; "on" enables the opt-in rule set. */
export function contentRulesEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.UPTOKEY_CONTENT_RULES?.trim().toLowerCase() === "on";
}

function saturating(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? value : value + 1;
}
