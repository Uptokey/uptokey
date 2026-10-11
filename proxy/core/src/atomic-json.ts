import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function readJson<T>(path: string, fallback: T, maximum = 2 * 1024 * 1024): Promise<T> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("json_state_limit_invalid");
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  let directory;
  try {
    directory = await openObservedDirectory(dirname(path));
    const [pathInfo, observed] = await Promise.all([lstat(path), handle.stat()]);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || !observed.isFile() || pathInfo.dev !== observed.dev || pathInfo.ino !== observed.ino) throw new Error("json_state_path_invalid");
    if (observed.size > maximum) throw new Error("json_state_size_invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readObserved(handle, maximum))) as T;
  } finally { await directory?.close(); await handle.close(); }
}

async function readObserved(handle: Awaited<ReturnType<typeof open>>, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  while (true) { const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - size + 1)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; size += bytesRead; if (size > maximum) throw new Error("json_state_size_invalid"); chunks.push(buffer.subarray(0, bytesRead)); }
  return Buffer.concat(chunks, size);
}

/** Directories validated by this process, keyed by path. Each write still re-checks
 * the current inode and symlink state; a replaced directory forces full validation. */
const observedDirectoryIdentities = new Map<string, { dev: number; ino: number }>();

async function directoryIdentityUnchanged(path: string): Promise<boolean> {
  const cached = observedDirectoryIdentities.get(path);
  if (cached === undefined) return false;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== cached.dev || info.ino !== cached.ino) {
      observedDirectoryIdentities.delete(path);
      return false;
    }
    return true;
  } catch {
    observedDirectoryIdentities.delete(path);
    return false;
  }
}

async function observeDirectoryIdentity(path: string): Promise<{ dev: number; ino: number }> {
  const handle = await open(path, "r");
  try {
    const [pathInfo, observed] = await Promise.all([lstat(path), handle.stat()]);
    if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory() || !observed.isDirectory() || pathInfo.dev !== observed.dev || pathInfo.ino !== observed.ino) throw new Error("json_state_directory_invalid");
    return { dev: observed.dev, ino: observed.ino };
  } finally { await handle.close(); }
}

export async function writeJsonAtomic(path: string, value: unknown, options: { rename?: typeof rename; maximum?: number; beforeCommit?:()=>Promise<void> } = {}): Promise<void> {
  const maximum = options.maximum ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("json_state_limit_invalid");
  const encoded = JSON.stringify(value, null, 2); if (typeof encoded !== "string") throw new Error("json_state_invalid");
  const content = `${encoded}\n`; if (Buffer.byteLength(content) > maximum) throw new Error("json_state_size_invalid");
  const directoryPath = dirname(path);
  if (!(await directoryIdentityUnchanged(directoryPath))) {
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    observedDirectoryIdentities.set(directoryPath, await observeDirectoryIdentity(directoryPath));
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    const renameFn = options.rename ?? rename;
    let renamed = false;
    for (let attempt = 0; attempt < (process.platform === "win32" ? 15 : 1); attempt++) {
      try {
        await options.beforeCommit?.();
        await renameFn(temporary, path);
        renamed = true;
        break;
      } catch (err: any) {
        if (attempt < (process.platform === "win32" ? 14 : 0) && (err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES")) {
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    await syncParentDirectory(directoryPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function openObservedDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    const [pathInfo, observed] = await Promise.all([lstat(path), handle.stat()]);
    if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory() || !observed.isDirectory() || pathInfo.dev !== observed.dev || pathInfo.ino !== observed.ino) throw new Error("json_state_directory_invalid");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
