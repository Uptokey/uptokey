import fs from 'node:fs';
import path from 'node:path';
export type WorkspaceCompositionHandle = Awaited<ReturnType<typeof import('./workspace/composition-service.ts').openCompositionService>>;

const openRoots = new Set<string>();
const databaseName = 'composition.sqlite';

function unsafePath(): Error { return new Error('quimera_composition_unsafe_path'); }
function assertUnlinkedAncestors(target: string): void {
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw unsafePath();
    if (path.dirname(cursor) === cursor) return;
  }
}

function assertDatabasePaths(root: string): void {
  assertUnlinkedAncestors(root);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const entry = fs.lstatSync(path.join(root, databaseName + suffix), { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw unsafePath();
  }
}

/** Opt-in only: the caller supplies its isolated state root; importing this module opens no database.
 * One handle owns each canonical root in this process. Filesystem checks are not an OS sandbox.
 */
export async function openWorkspaceComposition(stateRoot: string): Promise<WorkspaceCompositionHandle> {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || stateRoot.includes('\0') ||
    stateRoot.startsWith('//') || stateRoot.startsWith('\\\\') ||
    (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(stateRoot))) throw unsafePath();
  const requested = path.resolve(stateRoot);
  if (requested === path.parse(requested).root) throw unsafePath();
  assertUnlinkedAncestors(requested);
  const existing = fs.lstatSync(requested, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw unsafePath();
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  assertUnlinkedAncestors(requested);
  const root = fs.realpathSync.native(requested);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (openRoots.has(key)) throw new Error('quimera_composition_already_open');
  assertDatabasePaths(root);
  openRoots.add(key);
  let service: WorkspaceCompositionHandle | undefined;
  try {
    const { openCompositionService } = await import('./workspace/composition-service.ts');
    service = await openCompositionService(path.join(root, databaseName));
    assertDatabasePaths(root);
  } catch (error) {
    let closed = !service;
    try { if (service) { await service.close(); closed = true; } } catch { /* Retain the root reservation if close failed. */ }
    if (closed) openRoots.delete(key);
    if (error instanceof Error && error.message === 'quimera_composition_unsafe_path') throw error;
    throw new Error('quimera_composition_unavailable');
  }
  const worker = service;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    createGraph: (options: Parameters<WorkspaceCompositionHandle['createGraph']>[0]) => worker.createGraph(options),
    close(): Promise<void> {
      closing ??= Promise.resolve().then(async () => {
        await worker.close();
        openRoots.delete(key);
      });
      return closing;
    },
  });
}
