export interface DetectedClient { installed: boolean; version: string | null }
export interface DetectedClients {
  cline: DetectedClient;
  aider: DetectedClient;
  continue: DetectedClient;
  "vscode-uptokey": DetectedClient;
}
export interface ClientSmokeResult {
  client: "cline" | "aider" | "continue" | "vscode-uptokey" | "antigravity-mcp";
  client_version: string | null;
  external_app: "installed" | "missing";
  fresh_profile: true;
  config_contract_valid: true;
  config_copied_without_provider_key: true;
  request_reached_loopback_proxy: boolean;
  pre_revoke_http_status: number | null;
  revoked_token_returned_401: boolean;
  native_app_smoke: string;
  native_error_or_warning: string;
}
export interface ClientSmokeEvidence {
  schema: "uptokey-client-integration-smoke-v1";
  tested_at_utc: string;
  host_os: "windows" | "macos" | "linux" | "other";
  uptokey_version: string;
  endpoint: string;
  model: string;
  temporary_profiles_cleaned: boolean;
  results: ClientSmokeResult[];
}
export interface ClientSmokeOptions {
  fetchImpl?: typeof fetch;
  detectClients?: () => Promise<DetectedClients>;
  extensionHostRunner?: () => Promise<{ valid: boolean; humanConfirmationBypassed: boolean }>;
  antigravityRunner?: () => Promise<{ valid: boolean; version: string | null; warning: string | null }>;
  now?: () => Date;
  evidencePath?: string | false;
  tempBase?: string;
}
export function runClientIntegrationSmoke(options?: ClientSmokeOptions): Promise<ClientSmokeEvidence>;
export function detectLocalClients(options?: { userProfile?: string; localAppData?: string }): Promise<DetectedClients>;
export function normalizedSmokeHostOs(platform?: NodeJS.Platform | string): "windows" | "macos" | "linux" | "other";
export function validateEvidence(value: unknown): value is ClientSmokeEvidence;
