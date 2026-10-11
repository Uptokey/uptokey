import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createNativeReceipt } from "./native-signature-evidence.mjs";
import { UpdateCoordinator } from "../src/update-coordinator.ts";
import { UpdateJournal, updateRecoveryAction, waitForUpdateHealth } from "../src/update-transaction.ts";
import { claimUpdateHelperLock } from "../src/update-helper-lock.ts";
import { updateTransactionPath } from "../src/paths.ts";
import { assertUpdateChildPid } from "../src/update-child-pid.ts";

export class MacosBundleInstaller {
  constructor(options) { this.options = options; }
  options; newPid; candidatePid;
  async install(transaction) {
    assertMacos(); validateOptions(this.options, transaction); await waitForExit(this.options.oldPid, 30_000);
    const installed = resolve(this.options.installedApp); const parent = dirname(installed); const work = resolve(parent, `.uptokey-update-${transaction.id}`); const candidate = resolve(work, "Uptokey.app");
    const installedReceipt = createNativeReceipt("macos", installed);
    const stagedArchive = resolve(this.options.stagedArchive); await assertArchiveDigest(stagedArchive, transaction.artifactSha256); inspectMacosUpdateArchive(stagedArchive);
    if (existsSync(work)) throw new Error("macos_update_work_exists"); mkdirSync(work, { mode: 0o700 });
    run("ditto", ["-x", "-k", resolve(this.options.stagedArchive), work]);
    if (!existsSync(candidate)) throw new Error("macos_update_bundle_missing"); rejectUnsafeTree(candidate); const candidateReceipt = createNativeReceipt("macos", candidate); assertMacosUpdateSignerContinuity(installedReceipt, candidateReceipt);
    const plist = resolve(candidate, "Contents", "Info.plist"); const bundleId = run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist]).trim(); const version = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]).trim();
    if (bundleId !== "com.uptokey.proxy" || `v${version}` !== transaction.toVersion) throw new Error("macos_update_identity_or_version_mismatch");
    const backup = backupPath(installed, transaction.id); if (existsSync(backup)) throw new Error("macos_update_backup_exists"); renameSync(installed, backup);
    try { renameSync(candidate, installed); } catch (error) { renameSync(backup, installed); throw error; }
    this.newPid = launch(installed, "update", transaction.id); this.candidatePid = this.newPid;
  }
  async rollback(transaction) {
    assertMacos(); const installed = resolve(this.options.installedApp); const backup = backupPath(installed, transaction.id);
    const runningPid = this.newPid ?? transaction.candidatePid; if (runningPid && runningPid !== this.options.oldPid) { try { process.kill(runningPid, "SIGTERM"); } catch {} await waitForExit(runningPid, 10_000).catch(() => undefined); }
    if (!existsSync(backup)) throw new Error("macos_update_backup_missing"); const failed = resolve(dirname(installed), `.Uptokey.app.failed-${transaction.id}`); if (existsSync(failed)) throw new Error("macos_update_failed_slot_exists");
    if (existsSync(installed)) renameSync(installed, failed); renameSync(backup, installed); launch(installed, "rollback", transaction.id);
  }
}

export function assertMacosUpdateSignerContinuity(installedReceipt, candidateReceipt) {
  const installedTeam = installedReceipt?.signer?.teamId;
  const candidateTeam = candidateReceipt?.signer?.teamId;
  if (!/^[A-Z0-9]{10}$/.test(installedTeam ?? "") || candidateTeam !== installedTeam || installedReceipt?.checks?.applicationBoundKeychain !== true || candidateReceipt?.checks?.applicationBoundKeychain !== true) {
    throw new Error("macos_update_signer_continuity_failed");
  }
}

export async function runMacosUpdateHelper(options) {
  assertMacos(); assertInvocationScope(options); const release = claimUpdateHelperLock(options.journalPath);
  try {
    const journal = new UpdateJournal(options.journalPath); const transaction = await journal.load(); if (!transaction || transaction.platform !== "macos") throw new Error("macos_update_transaction_invalid");
    const installer = new MacosBundleInstaller(options); const action = updateRecoveryAction(transaction);
    if (action === "resume-install") return new UpdateCoordinator(journal, installer, async (version) => { await waitForUpdateHealth(version); assertUpdateChildPid(installer.newPid); }).installStaged();
    if (action === "rollback" || action === "wait-health") {
      const current = await journal.load(); if (!current || !["installing", "awaiting-health", "rolling-back"].includes(current.state)) throw new Error("macos_update_recovery_state_invalid");
      const rolling = current.state === "rolling-back" ? current : await journal.transition(current.state, "rolling-back", new Date(), "helper_recovery"); await installer.rollback(rolling); return journal.transition("rolling-back", "rolled-back", new Date(), "helper_recovery");
    }
    return transaction;
  } finally { release(); }
}

function backupPath(installed, id) { return resolve(dirname(installed), `.Uptokey.app.backup-${id}`); }
function launch(app, mode, id) { const child = spawn(resolve(app, "Contents", "MacOS", "uptokey"), ["proxy", "start", `--${mode}-child=${id}`], { detached: true, stdio: "ignore" }); child.unref(); if (!child.pid) throw new Error("macos_update_launch_failed"); return child.pid; }
async function waitForExit(pid, timeout) { const deadline = Date.now() + timeout; while (Date.now() <= deadline) { try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { return; } } throw new Error("macos_update_old_process_timeout"); }
function assertMacos() { if (process.platform !== "darwin") throw new Error("macos_update_helper_requires_macos"); }
function validateOptions(options, transaction) { if (!Number.isSafeInteger(options.oldPid) || options.oldPid <= 1 || resolve(options.stagedArchive) !== transaction.artifactPath || basename(options.installedApp) !== "Uptokey.app" || basename(options.stagedArchive) !== transaction.artifactName) throw new Error("macos_update_options_invalid"); }
function assertInvocationScope(options) { if (resolve(options.journalPath) !== resolve(updateTransactionPath()) || resolve(options.installedApp) !== macosInstalledTargetForHelper(process.execPath)) throw new Error("macos_update_scope_invalid"); }
export function macosInstalledTargetForHelper(helperExecutable) { return resolve(dirname(resolve(helperExecutable)), "..", ".."); }
function rejectUnsafeTree(root) { for (const name of readdirSync(root)) { const path = resolve(root, name); const metadata = lstatSync(path); if (metadata.isSymbolicLink()) throw new Error("macos_update_symlink_forbidden"); if (metadata.isDirectory()) rejectUnsafeTree(path); else if (!metadata.isFile()) throw new Error("macos_update_special_file_forbidden"); } }
function run(command, args) { const result = spawnSync(command, args, { encoding: "utf8" }); if (result.status !== 0) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 240)}`); return result.stdout; }

const ZIP_LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024, centralDirectoryBytes: 16 * 1024 * 1024, entries: 20_000, uncompressedBytes: 2 * 1024 * 1024 * 1024, expansionRatio: 100 });

export function inspectMacosUpdateArchive(archivePath, limits = ZIP_LIMITS) {
  const handle = openSync(archivePath, "r");
  try {
    const archiveSize = fstatSync(handle).size;
    if (archiveSize < 22 || archiveSize > limits.archiveBytes) throw new Error("macos_update_zip_size_invalid");
    const tailLength = Math.min(archiveSize, 65_557); const tail = Buffer.allocUnsafe(tailLength); readExact(handle, tail, archiveSize - tailLength);
    const eocd = findSignatureBackwards(tail, 0x06054b50); if (eocd < 0 || eocd + 22 + tail.readUInt16LE(eocd + 20) !== tail.length) throw new Error("macos_update_zip_eocd_invalid");
    const disk = tail.readUInt16LE(eocd + 4); const centralDisk = tail.readUInt16LE(eocd + 6); const diskEntries = tail.readUInt16LE(eocd + 8); const entries = tail.readUInt16LE(eocd + 10); const centralSize = tail.readUInt32LE(eocd + 12); const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries === 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("macos_update_zip_multidisk_or_zip64_forbidden");
    if (entries > limits.entries || centralSize > limits.centralDirectoryBytes || centralOffset + centralSize !== archiveSize - tailLength + eocd) throw new Error("macos_update_zip_central_invalid");
    const central = Buffer.allocUnsafe(centralSize); readExact(handle, central, centralOffset); const decoder = new TextDecoder("utf-8", { fatal: true }); const names = new Set(); const localRanges = []; let cursor = 0; let compressed = 0; let uncompressed = 0;
    for (let index = 0; index < entries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("macos_update_zip_entry_invalid");
      const madeBy = central.readUInt16LE(cursor + 4); const flags = central.readUInt16LE(cursor + 8); const method = central.readUInt16LE(cursor + 10); const compressedSize = central.readUInt32LE(cursor + 20); const uncompressedSize = central.readUInt32LE(cursor + 24); const nameLength = central.readUInt16LE(cursor + 28); const extraLength = central.readUInt16LE(cursor + 30); const commentLength = central.readUInt16LE(cursor + 32); const externalAttributes = central.readUInt32LE(cursor + 38); const localOffset = central.readUInt32LE(cursor + 42); const end = cursor + 46 + nameLength + extraLength + commentLength;
      if ((flags & 1) !== 0 || ![0, 8].includes(method) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || localOffset >= centralOffset || nameLength === 0 || end > central.length) throw new Error("macos_update_zip_entry_unsupported");
      const centralName = central.subarray(cursor + 46, cursor + 46 + nameLength); let name; try { name = decoder.decode(centralName); } catch { throw new Error("macos_update_zip_name_encoding_invalid"); }
      validateArchiveEntryName(name); const canonical = name.normalize("NFC"); if (names.has(canonical)) throw new Error("macos_update_zip_duplicate_entry"); names.add(canonical);
      const localHeader = Buffer.allocUnsafe(30); readExact(handle, localHeader, localOffset); if (localHeader.readUInt32LE(0) !== 0x04034b50 || localHeader.readUInt16LE(6) !== flags || localHeader.readUInt16LE(8) !== method) throw new Error("macos_update_zip_local_header_mismatch");
      const localNameLength = localHeader.readUInt16LE(26); const localExtraLength = localHeader.readUInt16LE(28); const localName = Buffer.allocUnsafe(localNameLength); readExact(handle, localName, localOffset + 30); if (localNameLength !== nameLength || !localName.equals(centralName)) throw new Error("macos_update_zip_local_name_mismatch");
      const localDataStart = localOffset + 30 + localNameLength + localExtraLength; const localDataEnd = localDataStart + compressedSize; if (localDataEnd > centralOffset) throw new Error("macos_update_zip_local_range_invalid"); localRanges.push([localOffset, localDataEnd]);
      if ((madeBy >> 8) === 3) { const kind = (externalAttributes >>> 16) & 0o170000; const directory = name.endsWith("/"); if (kind === 0o120000 || (kind !== 0 && kind !== 0o100000 && !(directory && kind === 0o040000))) throw new Error("macos_update_zip_special_entry_forbidden"); }
      compressed += compressedSize; uncompressed += uncompressedSize; if (uncompressed > limits.uncompressedBytes) throw new Error("macos_update_zip_uncompressed_limit"); cursor = end;
    }
    localRanges.sort((left, right) => left[0] - right[0]); if (localRanges.some((range, index) => index > 0 && range[0] < localRanges[index - 1][1])) throw new Error("macos_update_zip_local_overlap");
    if (cursor !== central.length || !names.has("Uptokey.app/Contents/Info.plist") || compressed === 0 || uncompressed / compressed > limits.expansionRatio) throw new Error("macos_update_zip_layout_or_ratio_invalid");
    return Object.freeze({ entries, compressedBytes: compressed, uncompressedBytes: uncompressed });
  } finally { closeSync(handle); }
}

function validateArchiveEntryName(name) { if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || !name.startsWith("Uptokey.app/")) throw new Error("macos_update_zip_path_invalid"); const body = name.endsWith("/") ? name.slice(0, -1) : name; const parts = body.split("/"); if (parts.some((part) => part === "" || part === "." || part === "..") || /^[A-Za-z]:/.test(name)) throw new Error("macos_update_zip_path_invalid"); }
function findSignatureBackwards(buffer, signature) { for (let offset = buffer.length - 22; offset >= 0; offset -= 1) if (buffer.readUInt32LE(offset) === signature) return offset; return -1; }
function readExact(handle, buffer, position) { let offset = 0; while (offset < buffer.length) { const count = readSync(handle, buffer, offset, buffer.length - offset, position + offset); if (count === 0) throw new Error("macos_update_zip_truncated"); offset += count; } }
async function assertArchiveDigest(path, expected) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); if (hash.digest("hex") !== expected) throw new Error("macos_update_staged_digest_mismatch"); }
