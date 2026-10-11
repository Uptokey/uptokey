import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const RETRY_MS = 20;
const WAIT_LIMIT_MS = 5_000;

export async function withConfigFileLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(configPath)}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = performance.now();
  while (true) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await link(temporary, lockPath); await unlink(temporary);
      break;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner(lockPath).catch((failure) => {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw failure;
      });
      if (!owner) continue;
      if (!alive(owner.pid)) { await recoverStaleLock(lockPath); continue; }
      if (performance.now() - started >= WAIT_LIMIT_MS) throw new Error("proxy_config_lock_timeout");
      await waitRetry();
    }
  }
  try { return await operation(); }
  finally {
    try { const owner = await readOwner(lockPath); if (owner.token === token) await unlink(lockPath); }
    catch { /* lock ausente, inseguro ou substituído não pertence mais a esta operação */ }
  }
}

async function recoverStaleLock(lockPath: string): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryToken = `${process.pid}:${randomUUID()}`;
  const temporary = `${recoveryPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${recoveryToken}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { await link(temporary, recoveryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { await waitRetry(); return; }
      throw error;
    }
  } finally { await unlink(temporary).catch(() => undefined); }
  try {
    const owner = await readOwner(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (owner && !alive(owner.pid)) await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  } finally {
    try { const owner = await readOwner(recoveryPath); if (owner.token === recoveryToken) await unlink(recoveryPath); }
    catch { /* recovery ausente ou substituída não pertence mais a esta operação */ }
  }
}

function waitRetry(): Promise<void> { return new Promise((resolveWait) => setTimeout(resolveWait, RETRY_MS)); }

async function readOwner(path: string): Promise<{ pid: number; token: string }> {
  const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("proxy_config_lock_unsafe");
  const value = await readFile(path, "utf8");
  const match = /^([1-9]\d{0,9}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\n$/i.exec(value);
  if (!match) throw new Error("proxy_config_lock_invalid");
  const pid = Number(match[1]); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("proxy_config_lock_invalid");
  return { pid, token: `${pid}:${match[2]}` };
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
