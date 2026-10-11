import {
  CLIENT_INFERENCE_BASE_URL,
  CLIENT_INFERENCE_MODEL,
  CLIENT_TOKEN_PLACEHOLDER,
  buildClientIntegrationContract,
  type ClientIntegrationId,
} from "./client-integrations.ts";
import type { IntegrationProfile as W0IntegrationProfile, IntegrationSupport as W0IntegrationSupport } from "@uptokey/sync-contract/agents-cli";

/** Re-export canonical W0 types for backward compatibility. */
export type IntegrationSupport = W0IntegrationSupport;
export type IntegrationProfile = Omit<W0IntegrationProfile, "schemaVersion">;

const VERIFIED: Array<{ id: ClientIntegrationId; displayName: string; docs: string; format: IntegrationProfile["configFormat"] }> = [
  { id: "cline", displayName: "Cline", docs: "https://docs.cline.bot/", format: "manual-ui" },
  { id: "continue", displayName: "Continue", docs: "https://docs.continue.dev/", format: "yaml" },
  { id: "aider", displayName: "Aider", docs: "https://aider.chat/docs/", format: "environment-and-argv" },
];

/** Profiles discussed in E2-14; unsupported stay honest. */
const DOCUMENTED: Array<Omit<IntegrationProfile, "version" | "copyGeneratesInstall" | "authKind">> = [
  { id: "cursor", displayName: "Cursor", officialDocs: "https://docs.cursor.com/", clientVersionRange: null, configFormat: "docs_only", support: "format_documented", notes: "OpenAI-compatible baseURL possible; not verified in this slice." },
  { id: "codex-cli", displayName: "Codex CLI/App", officialDocs: "https://github.com/openai/codex", clientVersionRange: null, configFormat: "docs_only", support: "format_documented", notes: "Official docs only; no invented config." },
  { id: "github-copilot", displayName: "GitHub Copilot", officialDocs: "https://docs.github.com/copilot", clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "No verified Uptokey profile." },
  { id: "opencode", displayName: "OpenCode", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending official format revision." },
  { id: "claude-code", displayName: "Claude Code", officialDocs: "https://docs.anthropic.com/", clientVersionRange: null, configFormat: "docs_only", support: "format_documented", notes: "Anthropic CLI; not claiming OpenAI-compatible install." },
  { id: "openclaw", displayName: "OpenClaw", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "No verified profile." },
  { id: "claude-cowork", displayName: "Claude Cowork", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "hermes-agent", displayName: "Hermes Agent", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "factory-droid", displayName: "Factory Droid", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "kilo-code", displayName: "Kilo Code", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "roo", displayName: "Roo", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "amp-cli", displayName: "Amp CLI", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "qwen-code", displayName: "Qwen Code", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "deepseek-tui", displayName: "DeepSeek TUI", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "jcode", displayName: "jcode", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "grok-build", displayName: "Grok Build", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "devin-cli", displayName: "Devin CLI", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "opendesign", displayName: "OpenDesign", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "unsupported", notes: "Pending." },
  { id: "antigravity", displayName: "Antigravity", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "mitm_only", notes: "Intercept compatibility belongs to E2-20; no signature/token extraction." },
  { id: "kiro", displayName: "Kiro", officialDocs: null, clientVersionRange: null, configFormat: "docs_only", support: "mitm_only", notes: "E2-20 when supported; not integrated here." },
];

export function listIntegrationProfiles(): IntegrationProfile[] {
  const verified: IntegrationProfile[] = VERIFIED.map((item) => ({
    id: item.id,
    version: 1,
    displayName: item.displayName,
    officialDocs: item.docs,
    clientVersionRange: null,
    authKind: "local_client_token",
    configFormat: item.format,
    support: "verified",
    copyGeneratesInstall: false,
    notes: "Copy config only; does not install packages or grant execution.",
  }));
  const rest: IntegrationProfile[] = DOCUMENTED.map((item) => ({
    ...item,
    version: 1,
    authKind: "none",
    copyGeneratesInstall: false as const,
  }));
  return [...verified, ...rest];
}

export function integrationProfilesForUi(): IntegrationProfile[] {
  // 14-08: unsupported without verified support must not appear as integrated.
  return listIntegrationProfiles().filter((p) => p.support === "verified" || p.support === "format_documented");
}

export function previewIntegrationCopy(profileId: string, baseUrl = CLIENT_INFERENCE_BASE_URL, model = CLIENT_INFERENCE_MODEL, token = CLIENT_TOKEN_PLACEHOLDER): {
  profile: IntegrationProfile;
  contract: unknown;
  display: string;
} {
  const profile = listIntegrationProfiles().find((p) => p.id === profileId);
  if (!profile) throw Object.assign(new Error("integration_profile_unsupported"), { code: "integration_profile_unsupported" });
  if (profile.support !== "verified") {
    throw Object.assign(new Error("integration_profile_unsupported"), { code: "integration_profile_unsupported" });
  }
  // Port/baseURL change must flow into all verified formats.
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new Error("client_config_invalid");
  const contract = buildClientIntegrationContract(profileId as ClientIntegrationId, token);
  // Rebuild display with effective base when custom (14-01 port update).
  if (baseUrl !== CLIENT_INFERENCE_BASE_URL || model !== CLIENT_INFERENCE_MODEL) {
    const text = JSON.stringify(contract);
    const rewritten = text.split(CLIENT_INFERENCE_BASE_URL).join(baseUrl).split(CLIENT_INFERENCE_MODEL).join(model);
    const parsed = JSON.parse(rewritten);
    return { profile, contract: parsed, display: typeof parsed.display === "string" ? parsed.display : rewritten };
  }
  return { profile, contract, display: (contract as { display: string }).display };
}

export function doctorIntegrationSummary(baseUrl = CLIENT_INFERENCE_BASE_URL): {
  baseUrl: string;
  model: string;
  verifiedProfiles: string[];
  tokenPlaceholder: string;
  npmPublicPackage: "not_claimed";
} {
  return {
    baseUrl,
    model: CLIENT_INFERENCE_MODEL,
    verifiedProfiles: listIntegrationProfiles().filter((p) => p.support === "verified").map((p) => p.id),
    tokenPlaceholder: CLIENT_TOKEN_PLACEHOLDER,
    npmPublicPackage: "not_claimed",
  };
}
