import { readBoundedJson } from '@uptokey/sync-contract/limits';
import { approveLocalPairing } from './local-admin-client.ts';
import type { BrowserApprovalOffer } from './pairing.ts';
import { assertSecretStoreBoundary, createOfficialSecretStore, type SecretStore } from './secret-store.ts';
import { NATIVE_CLIENT_APPROVAL_ACCEPT, isPairedBrowserOrigin, isPublicPwaOrigin } from './workspace/browser-enrollment.ts';

export const BROWSER_PAIRING_OPERATIONS = ['browser-pairing-review', 'browser-pairing-approve'] as const;
type Operation = typeof BROWSER_PAIRING_OPERATIONS[number];
type Approval = { id: string; userCode: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function approval(value: unknown): Approval {
  if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
      typeof value.userCode !== 'string' || !/^[A-F0-9]{8}$/.test(value.userCode)) {
    throw new Error('browser_pairing_invalid');
  }
  return { id: value.id, userCode: value.userCode };
}

function choice(value: unknown, keys: number) {
  if (!object(value)) throw new Error('browser_pairing_invalid');
  if (Object.keys(value).length === keys && isPublicPwaOrigin(value.origin)) return { ...approval(value), origin: value.origin };
  if (Object.keys(value).length === keys + 1 && value.audience === 'browser-extension' &&
      isPairedBrowserOrigin(value.origin) && !isPublicPwaOrigin(value.origin)) {
    return { ...approval(value), origin: value.origin, audience: 'browser-extension' as const };
  }
  if (Object.keys(value).length === keys + 1 && value.audience === 'vscode' && value.origin === 'local-vscode') {
    return { ...approval(value), origin: value.origin, audience: 'vscode' as const };
  }
  throw new Error('browser_pairing_invalid');
}

export async function browserPairingOwnerOperation(operation: Operation, input: unknown,
  dependencies: { secrets?: SecretStore; fetch?: typeof fetch } = {}): Promise<BrowserApprovalOffer | { approved: true }> {
  const request = operation === 'browser-pairing-approve' ? approval(input) : undefined;
  let audience: 'pwa' | 'browser-extension' | 'vscode' = 'pwa';
  if (request) {
    if (!object(input)) throw new Error('browser_pairing_invalid');
    const keys = Object.keys(input).length;
    if (keys === 3 && (input.audience === 'browser-extension' || input.audience === 'vscode')) audience = input.audience;
    else if (keys !== 2) throw new Error('browser_pairing_invalid');
  }
  const official = dependencies.secrets ? undefined : createOfficialSecretStore();
  if (official) assertSecretStoreBoundary(official.securityBoundary());
  const token = await (dependencies.secrets ?? official!).get('local:api-token');
  if (!token || !/^utk_local_[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('browser_pairing_owner_unavailable');
  const fetcher = dependencies.fetch ?? fetch;
  if (request) {
    await approveLocalPairing('/local/pair/approve', token, { ...request, audience }, fetcher);
    return { approved: true };
  }
  const response = await fetcher('http://127.0.0.1:21435/local/pair/browser-offer', {
    headers: { authorization: 'Bearer ' + token, accept: NATIVE_CLIENT_APPROVAL_ACCEPT },
    signal: AbortSignal.timeout(5_000), redirect: 'error',
  });
  const result = await readBoundedJson(response, 4_096);
  const value = result.ok ? result.value : undefined;
  if (!response.ok || !object(value)) throw new Error('browser_pairing_owner_unavailable');
  if ((value.status === 'none' || value.status === 'multiple') && Object.keys(value).length === 1) return { status: value.status };
  if (value.status === 'pending') return { status: 'pending', ...choice(value, 4) };
  if (value.status === 'choices' && Object.keys(value).length === 2 &&
      Array.isArray(value.choices) && value.choices.length >= 2 && value.choices.length <= 20) {
    const choices = value.choices.map(item => choice(item, 3));
    if (new Set(choices.map(item => item.id)).size === choices.length &&
        new Set(choices.map(item => item.userCode)).size === choices.length) return { status: 'choices', choices };
  }
  throw new Error('browser_pairing_invalid');
}

export async function runBrowserPairingOwner(args: string[]): Promise<void> {
  try {
    const operation = BROWSER_PAIRING_OPERATIONS.find(option => args.length === 1 && option === args[0]);
    if (!operation) throw new Error('browser_pairing_invalid');
    let input: unknown;
    if (operation === 'browser-pairing-approve') {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 512) throw new Error('browser_pairing_invalid');
        chunks.push(bytes);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const result = await browserPairingOwnerOperation(operation, input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write('{"error":{"code":"browser_pairing_owner_unavailable"}}\n');
    process.exitCode = 1;
  }
}
