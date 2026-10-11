export const AGENTS_CLI_SCHEMA_VERSION: number;

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

export declare const AGENTS_CLI_ERROR_TYPES: string[];
export declare const MCP_DISCOVERY_LIMITS: { maxTools: number; maxPages: number; maxSchemaBytes: number };
export declare const INSTALL_LIMITS: { maxFiles: number; maxPathLength: number; maxFileBytes: number };

export declare function parseIntegrationProfile(input: unknown): IntegrationProfile;
export declare function parseSkillManifest(input: unknown): SkillManifest;
export declare function parseInstallPlan(input: unknown): InstallPlan;
export declare function parseMcpToolBinding(input: unknown): McpToolBinding;
