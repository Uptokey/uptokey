/**
 * Uptokey TUI — verification through the canonical project runner.
 *
 * The TUI never spawns test processes. It chooses a runtime profile declared
 * by the core (node-app / python-app in rootless OCI, static-web inspection),
 * binds the exact manifest into a W5 run plan and reads the verification
 * report artifact. When the isolated runtime is not installed, the report is
 * `blocked` with the core diagnostic and the canonical setup path; there is no
 * fallback to the host.
 */
import { randomUUID } from "node:crypto";
import type { ProjectManifestEntry, ProjectRunRequestInput, RuntimeProfile } from "./workspace.ts";
import { t } from "./i18n.ts";

export interface VerificationChoice {
  profileId: string;
  actionId: string;
  reason: string;
}

export interface VerificationOutcome {
  state: "passed" | "failed" | "blocked";
  summary: string;
  detail: string;
  /** Bounded failure output suitable for a correction turn. */
  failureText: string;
}

export const RUNNER_SETUP_HINT = "Instale o executor isolado (WSL/Podman) com proxy/core/scripts/setup-project-runner-windows.ps1 (Windows) ou setup-project-runner.mjs; nada roda no host sem isolamento.";

/** Picks a runtime profile from the project manifest; null when nothing fits. */
export function chooseVerification(entries: readonly ProjectManifestEntry[], profiles: readonly RuntimeProfile[], preferredAction = "test"): VerificationChoice | null {
  const files = new Set(entries.filter((e) => e.kind === "file").map((e) => e.relativePath));
  const has = (path: string) => files.has(path);
  const anyUnder = (prefix: string) => [...files].some((f) => f.startsWith(prefix));
  const declared = (id: string) => profiles.find((p) => p.id === id);
  if (has("package.json") && declared("node-app")) return { profileId: "node-app", actionId: preferredAction, reason: "package.json encontrado" };
  if ((has("pyproject.toml") || has("setup.py") || has("requirements.txt") || anyUnder("tests/")) && [...files].some((f) => f.endsWith(".py")) && declared("python-app")) {
    return { profileId: "python-app", actionId: preferredAction, reason: "projeto Python" };
  }
  if (has("web/index.html") && declared("static-web")) return { profileId: "static-web", actionId: "check_html", reason: "web/index.html" };
  return null;
}

export function buildRunRequest(choice: VerificationChoice, manifestDigest: string): ProjectRunRequestInput {
  return {
    taskId: `tui-verify-${randomUUID()}`,
    manifestDigest,
    runtimeProfileId: choice.profileId,
    actionId: choice.actionId,
    relativeWorkingDirectory: ".",
    artifactInputRefs: [],
    timeoutMs: 180_000,
    outputLimitBytes: 262_144,
  };
}

interface ReportCheck { id?: string; status?: string; observed?: string; expected?: string; command?: string; exitCode?: number }

/** Interprets the durable report artifact produced by the runner. */
export function interpretReport(content: string): VerificationOutcome {
  let report: { checks?: ReportCheck[]; runtimeFingerprint?: string };
  try { report = JSON.parse(content) as typeof report; }
  catch { return { state: "blocked", summary: t("verif_unreadable"), detail: content.slice(0, 2000), failureText: "" }; }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (!checks.length) return { state: "blocked", summary: t("verif_no_checks"), detail: "", failureText: "" };
  const detailLines: string[] = [];
  let failureText = "";
  for (const check of checks) {
    let observed = check.observed ?? "";
    try {
      const parsed = JSON.parse(observed) as { output?: string; elapsedMs?: number };
      if (typeof parsed.output === "string") observed = `${parsed.output}${typeof parsed.elapsedMs === "number" ? `\n(${parsed.elapsedMs} ms)` : ""}`;
    } catch { /* plain observation */ }
    detailLines.push(`${check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "⊘"} ${check.id ?? "check"}${check.command ? ` — ${check.command}` : ""}${check.exitCode !== undefined ? ` (${t("verif_exit", { code: check.exitCode })})` : ""}`);
    if (observed) detailLines.push(observed.slice(-6000));
    if (check.status !== "pass" && observed) failureText += `${check.id ?? "check"}: ${observed.slice(-4000)}\n`;
  }
  const failed = checks.some((c) => c.status === "fail");
  const blocked = !failed && checks.some((c) => c.status === "blocked");
  const state = failed ? "failed" : blocked ? "blocked" : "passed";
  const blockedCode = blocked ? checks.find((c) => c.status === "blocked")?.observed ?? "" : "";
  const summary = state === "passed" ? t(checks.length === 1 ? "verif_passed_one" : "verif_passed", { count: checks.length })
    : state === "failed" ? t("verif_failed")
    : /runtime|unavailable|podman|oci/i.test(blockedCode) ? t("verif_runner_unavailable", { reason: blockedCode.slice(0, 80) }) : t("verif_blocked");
  return { state, summary, detail: detailLines.join("\n"), failureText: failureText.trim() };
}
