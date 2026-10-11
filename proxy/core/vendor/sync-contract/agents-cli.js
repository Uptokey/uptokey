/**
 * E2-14 Agents/CLI/MCP/Skills — contrato canônico compartilhado.
 *
 * Tipos promovidos de proxy-local/src para sync-contract como fonte canônica.
 * schemaVersion=1. Parsers rejeitam propriedades desconhecidas.
 * Nenhum parser recebe ou devolve segredos.
 */

export const AGENTS_CLI_SCHEMA_VERSION = 1;

export type IntegrationSupport = "verified" | "format_documented" | "unsupported" | "mitm_only";

export interface IntegrationProfile {
  schemaVersion: 1;
  id: string;
  version: number;
  displayName: string;
  officialDocs: string | null;
  clientVersionRange: string | null;
  authKind: "local_client_token" | "none";
  configFormat: "manual-ui" | "yaml" | "environment-and-argv" | "json" | "docs_only";
  support: IntegrationSupport;
  copyGeneratesInstall: false;
  notes: string;
}

export type SkillInstallState = "available" | "installed" | "update_available" | "revoked";

export interface SkillManifest {
  schemaVersion: 1;
  id: string;
  sourceUrl: string;
  revision: string;
  license: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  entrypoint: string;
  dependencies: string[];
  allowedCapabilities: string[];
  state: SkillInstallState;
  grantsExecution: false;
  instructionsTrusted: false;
}

export interface InstallPlan {
  schemaVersion: 1;
  id: string;
  packageOrigin: string;
  exactVersion: string;
  integrity: string;
  targetRootRef: string;
  managerProfile: "npm" | "npx" | "pip" | "fixture";
  lifecyclePolicy: "no_scripts" | "scripts_denied";
  expectedFiles: Array<{ path: string; sha256: string }>;
}

export interface InstallManifest {
  schemaVersion: 1;
  planId: string;
  origin: string;
  revision: string;
  integrity: string;
  written: string[];
  receiptId: string;
}

export type McpEffectClass = "read" | "write" | "network" | "exec" | "unknown";

export interface McpToolDescriptor {
  name: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  readOnlyHint?: boolean;
}

export interface McpToolBinding {
  schemaVersion: 1;
  serverProfileRevision: number;
  transportVersion: string;
  name: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string | null;
  effectClass: McpEffectClass;
  approvedSchemaDigest: string | null;
}

export interface ToolResultView {
  structuredContent: unknown;
  text: string | null;
  mediaRefs: string[];
  isError: boolean;
  provenance: { serverProfileRevision: number; toolName: string; attemptId: string };
}

export const AGENTS_CLI_ERROR_TYPES = [
  "integration_profile_unsupported",
  "client_config_invalid",
  "package_integrity_failed",
  "install_target_denied",
  "install_conflict",
  "mcp_schema_changed",
  "mcp_tool_unavailable",
  "mcp_output_invalid",
  "session_revoked",
  "tool_outcome_unknown",
];

export const MCP_DISCOVERY_LIMITS = {
  maxTools: 100,
  maxPages: 20,
  maxSchemaBytes: 256 * 1024,
};

export const INSTALL_LIMITS = {
  maxFiles: 1024,
  maxPathLength: 512,
  maxFileBytes: 10 * 1024 * 1024,
};

export function parseIntegrationProfile(input: unknown): IntegrationProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("integration_profile_invalid");
  const v = input as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new Error("integration_profile_invalid");
  if (typeof v.id !== "string" || typeof v.version !== "number" || typeof v.displayName !== "string") throw new Error("integration_profile_invalid");
  if (typeof v.copyGeneratesInstall !== "boolean" || v.copyGeneratesInstall !== false) throw new Error("integration_profile_invalid");
  if (!["verified", "format_documented", "unsupported", "mitm_only"].includes(v.support as string)) throw new Error("integration_profile_invalid");
  if (!["local_client_token", "none"].includes(v.authKind as string)) throw new Error("integration_profile_invalid");
  if (!["manual-ui", "yaml", "environment-and-argv", "json", "docs_only"].includes(v.configFormat as string)) throw new Error("integration_profile_invalid");
  return v as unknown as IntegrationProfile;
}

export function parseSkillManifest(input: unknown): SkillManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill_manifest_invalid");
  const v = input as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new Error("skill_manifest_invalid");
  if (typeof v.id !== "string" || typeof v.sourceUrl !== "string" || typeof v.revision !== "string") throw new Error("skill_manifest_invalid");
  if (typeof v.license !== "string" || typeof v.entrypoint !== "string") throw new Error("skill_manifest_invalid");
  if (v.grantsExecution !== false || v.instructionsTrusted !== false) throw new Error("skill_manifest_invalid");
  if (!Array.isArray(v.files) || !Array.isArray(v.dependencies) || !Array.isArray(v.allowedCapabilities)) throw new Error("skill_manifest_invalid");
  if (!["available", "installed", "update_available", "revoked"].includes(v.state as string)) throw new Error("skill_manifest_invalid");
  return v as unknown as SkillManifest;
}

export function parseInstallPlan(input: unknown): InstallPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("install_plan_invalid");
  const v = input as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new Error("install_plan_invalid");
  if (typeof v.id !== "string" || typeof v.packageOrigin !== "string" || typeof v.exactVersion !== "string") throw new Error("install_plan_invalid");
  if (typeof v.integrity !== "string" || typeof v.targetRootRef !== "string") throw new Error("install_plan_invalid");
  if (!["npm", "npx", "pip", "fixture"].includes(v.managerProfile as string)) throw new Error("install_plan_invalid");
  if (v.lifecyclePolicy !== "scripts_denied" && v.lifecyclePolicy !== "no_scripts") throw new Error("install_plan_invalid");
  if (!Array.isArray(v.expectedFiles)) throw new Error("install_plan_invalid");
  return v as unknown as InstallPlan;
}

export function parseMcpToolBinding(input: unknown): McpToolBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("mcp_tool_binding_invalid");
  const v = input as Record<string, unknown>;
  if (v.schemaVersion !== 1) throw new Error("mcp_tool_binding_invalid");
  if (typeof v.serverProfileRevision !== "number" || typeof v.transportVersion !== "string") throw new Error("mcp_tool_binding_invalid");
  if (typeof v.name !== "string" || typeof v.inputSchemaDigest !== "string") throw new Error("mcp_tool_binding_invalid");
  if (!["read", "write", "network", "exec", "unknown"].includes(v.effectClass as string)) throw new Error("mcp_tool_binding_invalid");
  return v as unknown as McpToolBinding;
}
