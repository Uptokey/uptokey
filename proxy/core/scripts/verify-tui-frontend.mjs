#!/usr/bin/env node
/**
 * Verifies a built terminal frontend artifact (default dist/tui): file list and hashes against BUILD_INFO.json,
 * runtime presence (and, on Windows, a valid Authenticode signature), notices coverage, the Bun license beside the
 * runtime, the native renderer package, and a smoke run of the bundle that must print its help and exit 0.
 *   node scripts/verify-tui-frontend.mjs [--dir <artifact>]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = process.argv.indexOf("--dir");
const dir = resolve(index >= 0 ? process.argv[index + 1] : join(root, "dist", "tui"));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const infoPath = join(dir, "BUILD_INFO.json");
check(existsSync(infoPath), "BUILD_INFO.json is missing");
const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf8")) : { files: [] };

for (const file of info.files) {
  const path = join(dir, file.path);
  if (!existsSync(path)) { failures.push(`listed file is missing: ${file.path}`); continue; }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  check(digest === file.sha256, `hash differs: ${file.path}`);
}

const runtime = join(dir, info.runtime ?? "runtime/bun");
check(existsSync(runtime), "the runtime is missing");
check(existsSync(join(dir, "runtime", "LICENSE-Bun.md")), "the Bun license (LICENSE-Bun.md) is not shipped beside the runtime");
check(existsSync(join(dir, "main.js")), "main.js is missing");
check(info.accessibleRuntime === "node" && info.accessibleEntry === "linear-entry.js", "the accessible Node entry is not declared");
check(existsSync(join(dir, "linear-entry.js")), "linear-entry.js is missing");
check(existsSync(join(dir, "opentui-tree-sitter-worker.js")), "the OpenTUI parser worker is missing");
check(existsSync(join(dir, "node_modules", ...String(info.nativePackage ?? "").replace(/@[^@/]+$/, "").split("/"))), "the native renderer package is missing");

const notices = existsSync(join(dir, "THIRD-PARTY-NOTICES.md")) ? readFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), "utf8") : "";
for (const required of ["@opencode-ai/tui", "@opentui/core", "@opentui/solid", "solid-js", "Bun runtime"]) check(notices.includes(required), `notices do not mention ${required}`);
check(notices.includes("MIT"), "notices carry no license text");

if (process.platform === "win32" && existsSync(runtime)) {
  // Windows PowerShell can expose the cmdlet but fail to load its security
  // module in a constrained host.  Try the explicitly selected shell first,
  // then the bundled PowerShell 7 fallback; a fallback is accepted only when
  // the signature command itself returns `Valid`.
  const shells = [...new Set([process.env.UPTOKEY_POWERSHELL, "pwsh.exe", "powershell.exe"].filter(Boolean))];
  let signatureStatus = "";
  const diagnostics = [];
  for (const shell of shells) {
    const signature = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${runtime.replaceAll("'", "''")}').Status`], { encoding: "utf8" });
    signatureStatus = signature.stdout.trim();
    if (signatureStatus === "Valid") break;
    diagnostics.push(`${shell}: ${signatureStatus || signature.stderr.trim() || `exit ${signature.status}`}`);
  }
  check(signatureStatus === "Valid", `the runtime signature is not valid (${diagnostics.join("; ")})`);
}

if (existsSync(runtime) && existsSync(join(dir, "main.js"))) {
  const smoke = spawnSync(runtime, [join(dir, "main.js"), "--help"], { encoding: "utf8", env: { ...process.env, OTUI_TREE_SITTER_WORKER_PATH: join(dir, "opentui-tree-sitter-worker.js") }, timeout: 60000 });
  check(smoke.status === 0 && /uptokey/i.test(smoke.stdout), `the bundle did not print its help and exit 0 (status ${smoke.status}) ${smoke.stderr.slice(0, 300)}`);
}

if (existsSync(join(dir, "linear-entry.js"))) {
  const smoke = spawnSync(process.execPath, [join(dir, "linear-entry.js"), "--help"], { encoding: "utf8", env: { ...process.env, UPTOKEY_LANG: "en" }, timeout: 60000 });
  check(smoke.status === 0 && /Usage: uptokey \[folder\] \[options\]/.test(smoke.stdout), `the accessible bundle did not print English help and exit 0 (status ${smoke.status}) ${smoke.stderr.slice(0, 300)}`);
}

if (failures.length) {
  process.stderr.write(`verify-tui-frontend: ${failures.length} problem(s)\n${failures.map((entry) => `  - ${entry}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`verify-tui-frontend: ok (${info.files.length} files, runtime ${info.bun}, ${info.nativePackage})\n`);
