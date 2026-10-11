import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export function claimUpdateHelperLock(journalPath: string, pid = process.pid): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("update_helper_lock_pid_invalid");
  const path = `${resolve(journalPath)}.helper.lock`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = `${path}.${pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      linkSync(temporary, path); unlinkSync(temporary);
      return () => release(path, pid);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("update_helper_lock_unsafe");
      const owner = parsePid(readFileSync(path, "utf8")); if (alive(owner)) throw new Error("update_helper_already_running");
      unlinkSync(path);
    }
  }
  throw new Error("update_helper_lock_unavailable");
}

function release(path: string, pid: number): void {
  try { const metadata = lstatSync(path); if (metadata.isFile() && !metadata.isSymbolicLink() && parsePid(readFileSync(path, "utf8")) === pid) unlinkSync(path); } catch { /* lock ausente ou substituído não pertence mais a esta instância */ }
}
function parsePid(value: string): number { if (!/^[1-9]\d{0,9}\n$/.test(value)) throw new Error("update_helper_lock_invalid"); const pid = Number(value.trim()); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("update_helper_lock_invalid"); return pid; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
