import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Entry } from "@napi-rs/keyring";

const service = "com.uptokey.proxy";

export function runMacosKeychainAcceptance(appPath, outputPath) {
  if (process.platform !== "darwin") throw new Error("macos_keychain_e2e_requires_macos");
  const app = realpathSync(appPath); const executable = resolve(app, "Contents", "MacOS", "uptokey");
  if (!existsSync(executable)) throw new Error("macos_app_executable_missing");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  let account;
  try {
    const prepared = JSON.parse(lastLine(run(executable, ["security", "acceptance", "prepare"])));
    account = prepared.account;
    if (!/^acceptance:[0-9a-f-]{36}$/i.test(account ?? "")) throw new Error("acceptance_prepare_response_invalid");
    const leaked = readLegacyEntry(account);
    if (leaked !== null && leaked !== undefined) throw new Error("legacy_keychain_cross_process_read_succeeded");
    const evidence = { schema: "uptokey-macos-keychain-isolation-v1", verifiedAt: new Date().toISOString(), accountFingerprint: createHash("sha256").update(account).digest("hex"), protectedWrite: true, legacyCrossProcessRead: false, cleanup: "pending" };
    run(executable, ["security", "acceptance", "cleanup", account]); account = undefined; evidence.cleanup = "complete";
    if (outputPath) writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return evidence;
  } finally {
    if (account) run(executable, ["security", "acceptance", "cleanup", account]);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
  return result.stdout;
}
function lastLine(value) { return value.trim().split(/\r?\n/).at(-1) ?? ""; }

function readLegacyEntry(account) {
  try {
    return new Entry(service, account).getPassword();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|no entry|item.*not found|could not be found/i.test(message)) return undefined;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const evidence = runMacosKeychainAcceptance(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch { process.stderr.write("E2E Keychain recusado: verification_failed\n"); process.exitCode = 1; }
}
