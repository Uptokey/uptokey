import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, lstatSync, renameSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createNativeReceipt } from "./native-signature-evidence.mjs";
import { UpdateCoordinator } from "../src/update-coordinator.ts";
import { UpdateJournal, updateRecoveryAction, waitForUpdateHealth } from "../src/update-transaction.ts";
import { claimUpdateHelperLock } from "../src/update-helper-lock.ts";
import { updateTransactionPath } from "../src/paths.ts";
import { assertUpdateChildPid } from "../src/update-child-pid.ts";

export class WindowsExecutableInstaller {
  constructor(options) { this.options = options; } options; newPid; candidatePid;
  async install(transaction) {
    assertWindows(); validateOptions(this.options, transaction); await waitForExit(this.options.oldPid, 30_000);
    const installed = resolve(this.options.installedExecutable); const staged = resolve(this.options.stagedExecutable); await assertDigest(staged, transaction.artifactSha256);
    const installedReceipt = createNativeReceipt("windows", installed, { windowsService: "artifact-signing" });
    const candidate = slot(installed, "candidate", transaction.id); const backup = slot(installed, "backup", transaction.id); if (existsSync(candidate) || existsSync(backup)) throw new Error("windows_update_slot_exists");
    copyFileSync(staged, candidate, 1); const candidateReceipt = createNativeReceipt("windows", candidate, { windowsService: "artifact-signing" }); assertWindowsUpdateSignerContinuity(installedReceipt, candidateReceipt);
    await renameWithRetry(installed, backup); try { await renameWithRetry(candidate, installed); } catch (error) { await renameWithRetry(backup, installed); throw error; }
    this.newPid = launch(installed, "update", transaction.id); this.candidatePid = this.newPid;
  }
  async rollback(transaction) {
    assertWindows(); const installed = resolve(this.options.installedExecutable); const backup = slot(installed, "backup", transaction.id); const failed = slot(installed, "failed", transaction.id);
    const runningPid = this.newPid ?? transaction.candidatePid; if (runningPid && runningPid !== this.options.oldPid) { try { process.kill(runningPid); } catch {} await waitForExit(runningPid, 10_000).catch(() => undefined); }
    if (!existsSync(backup) || existsSync(failed)) throw new Error("windows_update_rollback_slot_invalid"); if (existsSync(installed)) await renameWithRetry(installed, failed); await renameWithRetry(backup, installed); launch(installed, "rollback", transaction.id);
  }
}

export function assertWindowsUpdateSignerContinuity(installedReceipt, candidateReceipt) {
  const installedSubject = installedReceipt?.signer?.subject;
  const candidateSubject = candidateReceipt?.signer?.subject;
  if (typeof installedSubject !== "string" || installedSubject.length < 3 || installedSubject.length > 512 || candidateSubject !== installedSubject || installedReceipt?.signer?.service !== "azure-artifact-signing" || candidateReceipt?.signer?.service !== "azure-artifact-signing" || installedReceipt?.checks?.hardwareBackedService !== true || candidateReceipt?.checks?.hardwareBackedService !== true) {
    throw new Error("windows_update_signer_continuity_failed");
  }
}

export async function runWindowsUpdateHelper(options) {
  assertWindows(); assertInvocationScope(options); const release = claimUpdateHelperLock(options.journalPath);
  try {
    const journal = new UpdateJournal(options.journalPath); const transaction = await journal.load(); if (!transaction || transaction.platform !== "windows") throw new Error("windows_update_transaction_invalid");
    const installer = new WindowsExecutableInstaller(options); const action = updateRecoveryAction(transaction);
    if (action === "resume-install") return new UpdateCoordinator(journal, installer, async (version) => { await waitForUpdateHealth(version); assertUpdateChildPid(installer.newPid); }).installStaged();
    if (action === "rollback" || action === "wait-health") { const current = await journal.load(); if (!current || !["installing", "awaiting-health", "rolling-back"].includes(current.state)) throw new Error("windows_update_recovery_state_invalid"); const rolling = current.state === "rolling-back" ? current : await journal.transition(current.state, "rolling-back", new Date(), "helper_recovery"); await installer.rollback(rolling); return journal.transition("rolling-back", "rolled-back", new Date(), "helper_recovery"); }
    return transaction;
  } finally { release(); }
}

function validateOptions(options, transaction) { const staged = resolve(options.stagedExecutable); const installed = resolve(options.installedExecutable); if (!Number.isSafeInteger(options.oldPid) || options.oldPid <= 1 || staged !== transaction.artifactPath || basename(staged) !== transaction.artifactName || basename(installed).toLowerCase() !== "uptokey-windows.exe" || !lstatSync(staged).isFile() || lstatSync(staged).isSymbolicLink()) throw new Error("windows_update_options_invalid"); }
function assertInvocationScope(options) { if (resolve(options.journalPath) !== resolve(updateTransactionPath()) || resolve(options.installedExecutable) !== windowsInstalledTargetForHelper(process.execPath)) throw new Error("windows_update_scope_invalid"); }
export function windowsInstalledTargetForHelper(helperExecutable) { return resolve(dirname(resolve(helperExecutable)), "uptokey-windows.exe"); }
function slot(installed, kind, id) { return resolve(dirname(installed), `.uptokey-${kind}-${id}.exe`); }
function launch(executable, mode, id) { const child = spawn(executable, ["proxy", "start", `--${mode}-child=${id}`], { detached: true, stdio: "ignore", windowsHide: true }); child.unref(); if (!child.pid) throw new Error("windows_update_launch_failed"); return child.pid; }
async function waitForExit(pid, timeout) { const deadline = Date.now() + timeout; while (Date.now() <= deadline) { try { process.kill(pid, 0); await delay(100); } catch { return; } } throw new Error("windows_update_process_timeout"); }
async function renameWithRetry(from, to) { let last; for (let attempt = 0; attempt < 8; attempt += 1) { try { renameSync(from, to); return; } catch (error) { last = error; await delay(50 * (2 ** attempt)); } } throw last; }
async function assertDigest(path, expected) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); if (hash.digest("hex") !== expected) throw new Error("windows_update_staged_digest_mismatch"); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function assertWindows() { if (process.platform !== "win32") throw new Error("windows_update_helper_requires_windows"); }
