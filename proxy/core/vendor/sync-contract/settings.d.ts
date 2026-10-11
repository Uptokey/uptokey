export const SETTINGS_SCHEMA_VERSION: 1;
export const SETTINGS_CONTRACT_VERSION: 1;
export const SETTINGS_SCOPES: readonly ['device', 'principal', 'workspace'];
export const SETTINGS_THEMES: readonly ['light', 'dark', 'auto'];
export const SETTINGS_LOCALES: readonly ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar'];
export const SETTINGS_PURGE_CLASSES: readonly ['conversation', 'artifact', 'local_receipts', 'export_bundle'];
export const SETTINGS_EXPORT_KINDS: readonly ['conversations', 'receipts', 'preferences'];
export const SETTINGS_JOB_STATES: readonly ['queued', 'running', 'completed', 'failed', 'cancelled'];
export const SETTINGS_ERROR_TYPES: readonly string[];

export type SettingsScope = (typeof SETTINGS_SCOPES)[number];
export type SettingsTheme = (typeof SETTINGS_THEMES)[number];
export type SettingsLocale = (typeof SETTINGS_LOCALES)[number];

export interface DevicePreferences {
  theme?: SettingsTheme;
  panelState?: {
    leftCollapsed?: boolean;
    rightCollapsed?: boolean;
    leftWidth?: number | null;
    rightWidth?: number | null;
    dividerRatio?: number;
  };
  accessibility?: {
    reducedMotion?: boolean;
    contrast?: string | null;
    fontScale?: number;
  };
}

export interface PrincipalPreferences {
  locale?: SettingsLocale;
  region?: string | null;
  timezone?: string | null;
  localeAuto?: boolean;
  loggingIncludeContent?: boolean;
  notificationSettings?: {
    browserOptIn?: boolean;
    channels?: string[];
    quietHours?: { startMinute: number; endMinute: number; timezone: string } | null;
  };
}

export interface WorkspaceDataPolicy {
  retentionDaysByClass?: Record<string, number>;
  exportAllowed?: boolean;
  effectivePolicyRef?: string | null;
}

export function parseSettingsScope(value: unknown): SettingsScope;
export function parseTheme(value: unknown): SettingsTheme;
export function parseLocale(value: unknown): SettingsLocale;
export function parseDevicePreferences(input: unknown): DevicePreferences;
export function parsePrincipalPreferences(input: unknown): PrincipalPreferences;
export function parseWorkspaceDataPolicy(input: unknown): WorkspaceDataPolicy;
export function parseSettingsPatch(input: unknown): {
  schemaVersion: number;
  scope: SettingsScope;
  expectedRevision: number;
  device?: DevicePreferences;
  principal?: PrincipalPreferences;
  workspace?: WorkspaceDataPolicy;
};
export function parseExportRequest(input: unknown): {
  kind: string;
  idempotencyKey: string;
  conversationId: string | null;
  includeContent?: boolean;
};
export function parsePurgeRequest(input: unknown): {
  targetClass: string;
  targetId: string;
  scope: string;
  idempotencyKey: string;
};
export function clampPanelState<T>(panelState: T, viewportWidth?: number): T;
