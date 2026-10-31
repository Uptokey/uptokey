/**
 * Canonical provider setup client contract shared by the Uptokey Tauri UI and
 * embedded shells. It contains no transport, credential store, or browser
 * policy: callers supply the authenticated request boundary they already own.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;
const LOCALES = ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar'];

export class ProviderSetupClientError extends Error {
  constructor(code, status, retryAfterSeconds) {
    super(code);
    this.name = 'ProviderSetupClientError';
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

const bad = () => { throw new ProviderSetupClientError('provider_setup_invalid_response', 502); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : bad();
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);

export function parseProviderPresets(input) {
  const value = record(input);
  if (!Array.isArray(value.presets) || value.presets.length > 64) return bad();
  const result = value.presets.map(raw => {
    const p = record(raw);
    if (!text(p.id, 64) || !PROVIDER.test(p.id) || !text(p.label, 160) || !['openai', 'anthropic', 'gemini'].includes(String(p.protocol)) || typeof p.local !== 'boolean' || !(((p.id === 'custom' || p.endpointRequired === true) && p.endpointUrl === '') || text(p.endpointUrl, 2048)) || p.discovery !== undefined && !['models', 'manual', 'catalog'].includes(String(p.discovery))) return bad();
    if (p.endpointRequired !== undefined && typeof p.endpointRequired !== 'boolean' || p.endpointPlaceholder !== undefined && !text(p.endpointPlaceholder, 2048) || p.endpointHostSuffix !== undefined && (!text(p.endpointHostSuffix, 253) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(p.endpointHostSuffix))) return bad();
    let documentationUrl;
    if (p.documentationUrl !== undefined) { if (!text(p.documentationUrl, 2048)) return bad(); let url; try { url = new URL(p.documentationUrl); } catch { return bad(); } if (url.protocol !== 'https:' || url.username || url.password || url.search) return bad(); documentationUrl = p.documentationUrl; }
    let getKeyUrl;
    if (p.getKeyUrl !== undefined) { if (!text(p.getKeyUrl, 2048)) return bad(); let url; try { url = new URL(p.getKeyUrl); } catch { return bad(); } if (url.protocol !== 'https:' || url.username || url.password) return bad(); getKeyUrl = p.getKeyUrl; }
    if (p.endpointUrl !== '') { let url; try { url = new URL(p.endpointUrl); } catch { return bad(); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return bad(); }
    return { id: p.id, label: p.label, protocol: p.protocol, local: p.local, endpointUrl: p.endpointUrl, ...(p.discovery ? { discovery: p.discovery } : {}), ...(documentationUrl ? { documentationUrl } : {}), ...(getKeyUrl ? { getKeyUrl } : {}), ...(p.endpointRequired ? { endpointRequired: true } : {}), ...(p.endpointPlaceholder ? { endpointPlaceholder: p.endpointPlaceholder } : {}), ...(p.endpointHostSuffix ? { endpointHostSuffix: p.endpointHostSuffix } : {}) };
  });
  if (new Set(result.map(p => p.id)).size !== result.length) return bad();
  return result;
}

export function parsePreparedProviderSetup(input) {
  const p = record(input);
  if (typeof p.id !== 'string' || !UUID.test(p.id) || !text(p.providerId, 64) || !PROVIDER.test(p.providerId) || !text(p.label, 160) || !Array.isArray(p.models) || !p.models.length || p.models.length > 2000 || !['discovered', 'declared'].includes(String(p.source)) || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt)) || p.notice !== null && !text(p.notice, 4096)) return bad();
  const models = p.models.map(raw => { const model = record(raw); if (typeof model.id !== 'string' || !MODEL.test(model.id) || model.name !== undefined && !text(model.name, 160)) return bad(); return { id: model.id, ...(typeof model.name === 'string' ? { name: model.name } : {}) }; });
  if (new Set(models.map(model => model.id)).size !== models.length) return bad();
  let noticeByLocale = null;
  if (p.noticeByLocale !== null) { const row = record(p.noticeByLocale); if (LOCALES.some(locale => !text(row[locale], 4096))) return bad(); noticeByLocale = Object.fromEntries(LOCALES.map(locale => [locale, row[locale]])); }
  const existing = p.connectionId !== undefined || p.expectedRevision !== undefined || p.reusingStoredCredential !== undefined;
  if (existing && (typeof p.connectionId !== 'string' || !UUID.test(p.connectionId) || !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 1 || p.reusingStoredCredential !== true)) return bad();
  return { id: p.id, providerId: p.providerId, label: p.label, models, source: p.source, notice: p.notice, noticeByLocale, expiresAt: p.expiresAt, ...(existing ? { connectionId: p.connectionId, expectedRevision: p.expectedRevision, reusingStoredCredential: true } : {}) };
}

export function parseProviderDestination(input) {
  const p = record(input);
  if (!text(p.providerId, 64) || !PROVIDER.test(p.providerId) || typeof p.connectionId !== 'string' || !UUID.test(p.connectionId) || typeof p.modelId !== 'string' || !MODEL.test(p.modelId) || !text(p.accountLabel, 80) || p.reloaded !== true) return bad();
  return { providerId: p.providerId, connectionId: p.connectionId, modelId: p.modelId, accountLabel: p.accountLabel };
}

export function createProviderSetupProtocolClient(request) {
  if (typeof request !== 'function') throw new TypeError('provider_setup_transport_required');
  return {
    presets: async signal => parseProviderPresets(await request('/presets', undefined, signal)),
    prepare: async (input, signal) => parsePreparedProviderSetup(await request('/prepare', input, signal)),
    commit: async (id, modelId, signal) => {
      if (!UUID.test(id) || !MODEL.test(modelId)) throw new ProviderSetupClientError('provider_setup_invalid_request', 400);
      return parseProviderDestination(await request('/commit', { id, modelId, acceptNotice: true }, signal));
    },
    dispose: async id => { if (UUID.test(id)) await request('/dispose', { id }); },
  };
}

/** Refresh one existing account while its credential remains behind the core boundary. */
export async function refreshProviderConnection(client, input, signal) {
  if (!client || typeof client.prepare !== 'function' || typeof client.commit !== 'function' || typeof client.dispose !== 'function' || !input || !PROVIDER.test(input.providerId ?? '') || !UUID.test(input.connectionId ?? '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !Array.isArray(input.currentModels) || input.currentModels.length > 256 || input.currentModels.some(model => typeof model !== 'string' || !MODEL.test(model))) throw new ProviderSetupClientError('provider_setup_invalid_request', 400);
  let prepared;
  try {
    prepared = await client.prepare({ providerId: input.providerId, connectionId: input.connectionId, expectedRevision: input.expectedRevision }, signal);
    if (prepared.connectionId !== input.connectionId || prepared.expectedRevision !== input.expectedRevision || prepared.reusingStoredCredential !== true) return bad();
    const discovered = prepared.models.map(model => model.id);
    const modelId = input.currentModels.find(model => discovered.includes(model)) ?? discovered.find(model => model === `${input.providerId}-chat`) ?? discovered[0];
    const destination = await client.commit(prepared.id, modelId, signal);
    if (destination.providerId !== input.providerId || destination.connectionId !== input.connectionId || destination.modelId !== modelId) return bad();
    return { ...destination, models: discovered, changed: !input.currentModels.includes(modelId) };
  } finally {
    if (prepared) await client.dispose(prepared.id).catch(() => undefined);
  }
}
