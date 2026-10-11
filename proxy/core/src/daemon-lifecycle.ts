import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { proxyPidPath } from "./paths.ts";

export function claimProxyPid(path = proxyPidPath(), pid = process.pid): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("proxy_pid_invalid");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const temporary = `${path}.${pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      linkSync(temporary, path); unlinkSync(temporary);
      return () => releasePid(path, pid);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readPidIfPresent(path); if (previous === undefined) continue;
      if (isProcessAlive(previous)) throw new Error("proxy_already_running");
      recoverStalePid(path, pid); waitRetry();
    }
  }
  throw new Error("proxy_pid_lock_timeout");
}

export function readLiveProxyPid(path = proxyPidPath()): number {
  const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("proxy_pid_path_unsafe");
  const pid = parsePid(readFileSync(path, "utf8")); if (!isProcessAlive(pid)) throw new Error("proxy_not_running"); return pid;
}

function parsePid(value: string): number { if (!/^[1-9]\d{0,9}\r?\n?$/.test(value)) throw new Error("proxy_pid_invalid"); const pid = Number(value.trim()); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("proxy_pid_invalid"); return pid; }
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

function readPidIfPresent(path: string): number | undefined {
  try { const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("proxy_pid_path_unsafe"); return parsePid(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function recoverStalePid(path: string, pid: number): void {
  const recovery = `${path}.recovery`; const token = `${pid}:${randomUUID()}`; const temporary = `${recovery}.${pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); try { linkSync(temporary, recovery); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; } }
  finally { try { unlinkSync(temporary); } catch {} }
  try { const owner = readPidIfPresent(path); if (owner !== undefined && !isProcessAlive(owner)) unlinkSync(path); }
  finally { try { if (readFileSync(recovery, "utf8") === `${token}\n`) unlinkSync(recovery); } catch {} }
}

function releasePid(path: string, pid: number): void { try { if (readPidIfPresent(path) === pid) unlinkSync(path); } catch {} }
function waitRetry(): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
