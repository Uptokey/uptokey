import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {EncryptedWorkspaceStore} from './encrypted-workspace.mjs';

const [workspace, store, keyPath] = process.argv.slice(2);
const encrypted = await new EncryptedWorkspaceStore({
  workspace, store, keyPath, seed: undefined, requireTmpfs: process.env.UPTOKEY_REQUIRE_TMPFS === '1',
  // A former caller-supplied delay must not reintroduce delayed durability.
  debounceMs: 60_000,
}).initialize();
const before = encrypted.sequence;
const startedAt = Date.now();
for (let revision = 0; revision < 24; revision++) {
  await writeFile(join(workspace, 'latest.txt'), `durable-before-abrupt-stop:${revision}\n`, {mode: 0o600});
  await new Promise(resolve => setTimeout(resolve, 1));
}
while (encrypted.sequence === before || encrypted.flushPromise || encrypted.persistedRevision < encrypted.dirtyRevision) {
  if (Date.now() - startedAt > 4_000) throw Error('workspace_immediate_flush_timeout');
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.send?.({sequence: encrypted.sequence, elapsedMs: Date.now() - startedAt});
await new Promise(() => {});
