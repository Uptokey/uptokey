/**
 * Settings — contrato canônico E2-23 (preferências, idioma, tema, privacidade).
 *
 * schemaVersion=1. Parsers rejeitam propriedades desconhecidas e protótipos
 * especiais. Preferências públicas nunca carregam segredos. Parsing não é
 * autorização: o backend aplica principal/workspace em toda leitura/escrita.
 */

import { isDataRecord } from './plain-data.js';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_CONTRACT_VERSION = 1;

export const SETTINGS_SCOPES = ['device', 'principal', 'workspace'];
export const SETTINGS_THEMES = ['light', 'dark', 'auto'];
export const SETTINGS_LOCALES = ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar'];
export const SETTINGS_PURGE_CLASSES = ['conversation', 'artifact', 'local_receipts', 'export_bundle'];
export const SETTINGS_EXPORT_KINDS = ['conversations', 'receipts', 'preferences'];
export const SETTINGS_JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

export const SETTINGS_ERROR_TYPES = [
  'settings_invalid',
  'settings_not_found',
  'settings_conflict',
  'settings_unauthorized',
  'settings_storage_unavailable',
  'settings_job_conflict',
  'settings_job_not_found',
  'export_invalid',
  'purge_invalid',
  'profile_requires_session',
];

function rejectUnknown(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      const err = new Error('settings_invalid');
      err.code = 'settings_invalid';
      throw err;
    }
  }
}

function asString(value, field, { min = 0, max = 256, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  if (typeof value !== 'string') {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  if (value.length < min || value.length > max) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  return value;
}

function asInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  return value;
}

function asBool(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  if (typeof value !== 'boolean') {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = field;
    throw err;
  }
  return value;
}

export function parseSettingsScope(value) {
  if (!SETTINGS_SCOPES.includes(value)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = 'scope';
    throw err;
  }
  return value;
}

export function parseTheme(value) {
  if (!SETTINGS_THEMES.includes(value)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = 'theme';
    throw err;
  }
  return value;
}

export function parseLocale(value) {
  if (!SETTINGS_LOCALES.includes(value)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    err.field = 'locale';
    throw err;
  }
  return value;
}

export function parseDevicePreferences(input) {
  if (!isDataRecord(input)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['theme', 'panelState', 'accessibility']));
  const out = {};
  if (input.theme !== undefined) out.theme = parseTheme(input.theme);
  if (input.panelState !== undefined) {
    if (!isDataRecord(input.panelState)) {
      const err = new Error('settings_invalid');
      err.code = 'settings_invalid';
      err.field = 'panelState';
      throw err;
    }
    rejectUnknown(input.panelState, new Set(['leftCollapsed', 'rightCollapsed', 'leftWidth', 'rightWidth', 'dividerRatio']));
    out.panelState = {
      leftCollapsed: input.panelState.leftCollapsed === undefined ? undefined : asBool(input.panelState.leftCollapsed, 'leftCollapsed'),
      rightCollapsed: input.panelState.rightCollapsed === undefined ? undefined : asBool(input.panelState.rightCollapsed, 'rightCollapsed'),
      leftWidth: input.panelState.leftWidth === undefined ? undefined : asInt(input.panelState.leftWidth, 'leftWidth', { min: 120, max: 800, optional: true }),
      rightWidth: input.panelState.rightWidth === undefined ? undefined : asInt(input.panelState.rightWidth, 'rightWidth', { min: 120, max: 800, optional: true }),
      dividerRatio: input.panelState.dividerRatio === undefined ? undefined : (typeof input.panelState.dividerRatio === 'number' && input.panelState.dividerRatio >= 0.15 && input.panelState.dividerRatio <= 0.85 ? input.panelState.dividerRatio : (() => { const err = new Error('settings_invalid'); err.code = 'settings_invalid'; err.field = 'dividerRatio'; throw err; })()),
    };
  }
  if (input.accessibility !== undefined) {
    if (!isDataRecord(input.accessibility)) {
      const err = new Error('settings_invalid');
      err.code = 'settings_invalid';
      err.field = 'accessibility';
      throw err;
    }
    rejectUnknown(input.accessibility, new Set(['reducedMotion', 'contrast', 'fontScale']));
    out.accessibility = {
      reducedMotion: input.accessibility.reducedMotion === undefined ? undefined : asBool(input.accessibility.reducedMotion, 'reducedMotion'),
      contrast: input.accessibility.contrast === undefined ? undefined : asString(input.accessibility.contrast, 'contrast', { min: 1, max: 32, optional: true }),
      fontScale: input.accessibility.fontScale === undefined ? undefined : (typeof input.accessibility.fontScale === 'number' && input.accessibility.fontScale >= 0.85 && input.accessibility.fontScale <= 1.5 ? input.accessibility.fontScale : (() => { const err = new Error('settings_invalid'); err.code = 'settings_invalid'; err.field = 'fontScale'; throw err; })()),
    };
  }
  return out;
}

export function parsePrincipalPreferences(input) {
  if (!isDataRecord(input)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['locale', 'region', 'timezone', 'localeAuto', 'notificationSettings', 'loggingIncludeContent']));
  const out = {};
  if (input.locale !== undefined) out.locale = parseLocale(input.locale);
  if (input.region !== undefined) out.region = asString(input.region, 'region', { min: 0, max: 32, optional: true });
  if (input.timezone !== undefined) out.timezone = asString(input.timezone, 'timezone', { min: 1, max: 64, optional: true });
  if (input.localeAuto !== undefined) out.localeAuto = asBool(input.localeAuto, 'localeAuto');
  if (input.loggingIncludeContent !== undefined) out.loggingIncludeContent = asBool(input.loggingIncludeContent, 'loggingIncludeContent');
  if (input.notificationSettings !== undefined) {
    if (!isDataRecord(input.notificationSettings)) {
      const err = new Error('settings_invalid');
      err.code = 'settings_invalid';
      err.field = 'notificationSettings';
      throw err;
    }
    rejectUnknown(input.notificationSettings, new Set(['browserOptIn', 'channels', 'quietHours']));
    out.notificationSettings = {
      browserOptIn: input.notificationSettings.browserOptIn === undefined ? undefined : asBool(input.notificationSettings.browserOptIn, 'browserOptIn'),
      channels: input.notificationSettings.channels === undefined ? undefined : (Array.isArray(input.notificationSettings.channels) && input.notificationSettings.channels.every((c) => typeof c === 'string' && c.length <= 32) ? input.notificationSettings.channels.slice(0, 16) : (() => { const err = new Error('settings_invalid'); err.code = 'settings_invalid'; err.field = 'channels'; throw err; })()),
      quietHours: input.notificationSettings.quietHours === undefined ? undefined : (() => {
        const q = input.notificationSettings.quietHours;
        if (q === null) return null;
        if (!isDataRecord(q)) {
          const err = new Error('settings_invalid');
          err.code = 'settings_invalid';
          err.field = 'quietHours';
          throw err;
        }
        rejectUnknown(q, new Set(['startMinute', 'endMinute', 'timezone']));
        return {
          startMinute: asInt(q.startMinute, 'startMinute', { min: 0, max: 1439 }),
          endMinute: asInt(q.endMinute, 'endMinute', { min: 0, max: 1439 }),
          timezone: asString(q.timezone, 'timezone', { min: 1, max: 64 }),
        };
      })(),
    };
  }
  return out;
}

export function parseWorkspaceDataPolicy(input) {
  if (!isDataRecord(input)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['retentionDaysByClass', 'exportAllowed', 'effectivePolicyRef']));
  const out = {};
  if (input.exportAllowed !== undefined) out.exportAllowed = asBool(input.exportAllowed, 'exportAllowed');
  if (input.effectivePolicyRef !== undefined) out.effectivePolicyRef = asString(input.effectivePolicyRef, 'effectivePolicyRef', { min: 1, max: 128, optional: true });
  if (input.retentionDaysByClass !== undefined) {
    if (!isDataRecord(input.retentionDaysByClass)) {
      const err = new Error('settings_invalid');
      err.code = 'settings_invalid';
      err.field = 'retentionDaysByClass';
      throw err;
    }
    const retention = {};
    for (const [key, value] of Object.entries(input.retentionDaysByClass)) {
      if (!SETTINGS_PURGE_CLASSES.includes(key)) {
        const err = new Error('settings_invalid');
        err.code = 'settings_invalid';
        err.field = 'retentionDaysByClass';
        throw err;
      }
      retention[key] = asInt(value, key, { min: 0, max: 3650 });
    }
    out.retentionDaysByClass = retention;
  }
  return out;
}

export function parseSettingsPatch(input) {
  if (!isDataRecord(input)) {
    const err = new Error('settings_invalid');
    err.code = 'settings_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['schemaVersion', 'scope', 'expectedRevision', 'device', 'principal', 'workspace']));
  const schemaVersion = asInt(input.schemaVersion ?? SETTINGS_SCHEMA_VERSION, 'schemaVersion', { min: 1, max: 1 });
  const scope = parseSettingsScope(input.scope);
  const expectedRevision = asInt(input.expectedRevision, 'expectedRevision', { min: 0 });
  const patch = { schemaVersion, scope, expectedRevision };
  if (scope === 'device') patch.device = parseDevicePreferences(input.device ?? {});
  if (scope === 'principal') patch.principal = parsePrincipalPreferences(input.principal ?? {});
  if (scope === 'workspace') patch.workspace = parseWorkspaceDataPolicy(input.workspace ?? {});
  return patch;
}

export function parseExportRequest(input) {
  if (!isDataRecord(input)) {
    const err = new Error('export_invalid');
    err.code = 'export_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['kind', 'idempotencyKey', 'conversationId', 'includeContent']));
  const kind = asString(input.kind, 'kind', { min: 1, max: 32 });
  if (!SETTINGS_EXPORT_KINDS.includes(kind)) {
    const err = new Error('export_invalid');
    err.code = 'export_invalid';
    throw err;
  }
  return {
    kind,
    idempotencyKey: asString(input.idempotencyKey, 'idempotencyKey', { min: 8, max: 128 }),
    conversationId: input.conversationId === undefined ? null : asString(input.conversationId, 'conversationId', { min: 8, max: 64, optional: true }),
    includeContent: input.includeContent === undefined ? undefined : asBool(input.includeContent, 'includeContent'),
  };
}

export function parsePurgeRequest(input) {
  if (!isDataRecord(input)) {
    const err = new Error('purge_invalid');
    err.code = 'purge_invalid';
    throw err;
  }
  rejectUnknown(input, new Set(['targetClass', 'targetId', 'scope', 'idempotencyKey']));
  const targetClass = asString(input.targetClass, 'targetClass', { min: 1, max: 32 });
  if (!SETTINGS_PURGE_CLASSES.includes(targetClass)) {
    const err = new Error('purge_invalid');
    err.code = 'purge_invalid';
    throw err;
  }
  return {
    targetClass,
    targetId: asString(input.targetId, 'targetId', { min: 1, max: 128 }),
    scope: asString(input.scope ?? 'principal', 'scope', { min: 1, max: 32 }),
    idempotencyKey: asString(input.idempotencyKey, 'idempotencyKey', { min: 8, max: 128 }),
  };
}

export function clampPanelState(panelState, viewportWidth = 1280) {
  if (!panelState || typeof panelState !== 'object') return panelState;
  const width = Math.max(320, Number(viewportWidth) || 1280);
  const maxCol = Math.max(120, Math.floor(width * 0.45));
  const next = { ...panelState };
  if (typeof next.leftWidth === 'number') next.leftWidth = Math.min(maxCol, Math.max(120, next.leftWidth));
  if (typeof next.rightWidth === 'number') next.rightWidth = Math.min(maxCol, Math.max(120, next.rightWidth));
  if (typeof next.dividerRatio === 'number') next.dividerRatio = Math.min(0.85, Math.max(0.15, next.dividerRatio));
  return next;
}
