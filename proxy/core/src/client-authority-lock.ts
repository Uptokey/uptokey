import type { SecretStore } from './secret-store.ts';

// One existing process-local queue, shared by credential and enrollment policy
// writers. This is not a transaction across native-vault accounts or processes.
const queuesByStore = new WeakMap<SecretStore, Map<string, Promise<unknown>>>();
export async function serialClientAuthority<T>(secrets: SecretStore, key: string, work: () => Promise<T>): Promise<T> {
  let queues = queuesByStore.get(secrets);
  if (!queues) { queues = new Map(); queuesByStore.set(secrets, queues); }
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(key, pending);
  try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}
