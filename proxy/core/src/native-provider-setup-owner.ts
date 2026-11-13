import { readBoundedJson } from '@uptokey/sync-contract/limits';
import {
  ProviderSetupClientError, parsePreparedProviderSetup, parseProviderDestination,
} from '../../contratos/provider-setup.js';
import { assertSecretStoreBoundary, createOfficialSecretStore, type SecretStore } from './secret-store.ts';

export const NATIVE_PROVIDER_SETUP_OPERATION = 'provider-setup';
const providers = new Set(['custom-openai', 'anthropic', 'deepseek', 'gemini', 'groq']);
const setupId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const modelId = /^[A-Za-z0-9._:/-]{1,200}$/;
const publicErrors = new Set([
  'provider_key_invalid', 'provider_key_rejected', 'provider_access_denied', 'provider_key_restricted',
  'provider_region_or_key_rejected', 'provider_discovery_timeout', 'provider_discovery_rate_limited',
  'provider_setup_rate_limited', 'provider_setup_expired', 'provider_setup_busy',
  'provider_billing_required', 'provider_service_disabled', 'provider_models_empty',
]);

function inputForOperation(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('provider_setup_invalid_request');
  const value = input as Record<string, unknown>;
  const fields = Object.keys(value).length;
  if (value.operation === 'prepare' && fields === 3 && typeof value.providerId === 'string' && providers.has(value.providerId) &&
      typeof value.apiKey === 'string') {
    const apiKey = value.apiKey.trim();
    if (!/^[!-~]{20,512}$/.test(apiKey)) throw new Error('provider_key_invalid');
    return { path: '/prepare', body: { providerId: value.providerId, apiKey } } as const;
  }
  if (typeof value.id === 'string' && setupId.test(value.id)) {
    if (value.operation === 'commit' && fields === 3 && typeof value.modelId === 'string' && modelId.test(value.modelId)) {
      return { path: '/commit', body: { id: value.id, modelId: value.modelId, acceptNotice: true } } as const;
    }
    if (value.operation === 'dispose' && fields === 2) return { path: '/dispose', body: { id: value.id } } as const;
  }
  throw new Error('provider_setup_invalid_request');
}

export async function nativeProviderSetupOwner(input: unknown,
  dependencies: { secrets?: SecretStore; fetch?: typeof fetch } = {}) {
  const operation = inputForOperation(input);
  const official = dependencies.secrets ? undefined : createOfficialSecretStore();
  if (official) assertSecretStoreBoundary(official.securityBoundary());
  const token = await (dependencies.secrets ?? official!).get('local:api-token');
  if (!token || !/^utk_local_[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('provider_setup_unavailable');
  const fetcher = dependencies.fetch ?? fetch;
  const call = async (path: '/prepare' | '/commit' | '/dispose', body: object) => {
    const response = await fetcher('http://127.0.0.1:21435/local/provider/setup' + path, {
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(25_000),
      headers: { authorization: 'Bearer ' + token, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (path === '/dispose' && response.ok) {
      await response.body?.cancel();
      return { disposed: true };
    }
    const parsed = await readBoundedJson(response, 256 * 1024);
    if (!parsed.ok) throw new Error('provider_setup_unavailable');
    if (!response.ok) {
      const type = (parsed.value as {error?: {type?: unknown}} | null)?.error?.type;
      throw new ProviderSetupClientError(typeof type === 'string' && publicErrors.has(type) ? type : 'provider_setup_unavailable', response.status);
    }
    return parsed.value;
  };
  const value = await call(operation.path, operation.body);
  if (operation.path === '/prepare') {
    const prepared = parsePreparedProviderSetup(value);
    const result = { id: prepared.id, models: prepared.models.map(model => model.id),
      notice: prepared.notice, noticeByLocale: prepared.noticeByLocale };
    const visible = JSON.stringify(result);
    if (prepared.providerId !== operation.body.providerId || prepared.reusingStoredCredential ||
        visible.includes(operation.body.apiKey) || visible.includes(token) || Buffer.byteLength(visible) > 60 * 1024) {
      await call('/dispose', { id: prepared.id }).catch(() => {});
      throw new Error('provider_setup_unavailable');
    }
    return result;
  }
  if (operation.path === '/commit') {
    const result = parseProviderDestination(value);
    if (!providers.has(result.providerId) || result.modelId !== operation.body.modelId || JSON.stringify(result).includes(token)) {
      throw new Error('provider_setup_unavailable');
    }
    return { saved: true };
  }
  return { disposed: true };
}

export async function runNativeProviderSetupOwner(args: string[]): Promise<void> {
  try {
    if (args.length !== 1 || args[0] !== NATIVE_PROVIDER_SETUP_OPERATION) throw new Error('provider_setup_invalid_request');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 2_048) throw new Error('provider_setup_invalid_request');
      chunks.push(bytes);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(await nativeProviderSetupOwner(input)) + '\n');
  } catch (error) {
    const code = error instanceof Error && publicErrors.has(error.message) ? error.message : 'provider_setup_unavailable';
    process.stdout.write(JSON.stringify({ error: { code } }) + '\n');
    process.exitCode = 1;
  }
}
