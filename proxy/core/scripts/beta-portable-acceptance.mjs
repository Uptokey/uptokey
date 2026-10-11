#!/usr/bin/env node
// The same portable package is installed on each native CI host. No publication or personal state.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(core, "scripts", script), ...args], { cwd: core, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) throw new Error(`portable_acceptance_failed:${script}:${result.status}`);
  return result.stdout;
}
const built = JSON.parse(run("beta-build-candidate.mjs").trim().split("\n").at(-1));
if (!built.buildReproducible) throw new Error("portable_build_not_reproducible");
const out = join(built.runDir, `install-${process.platform}-${process.arch}`);
run("beta-clean-install.mjs", [built.tarball, "--out-dir", out]);
const receipt = JSON.parse(readFileSync(join(out, "clean-install-receipt.json"), "utf8"));
if (receipt.summary?.result !== "approved") throw new Error("portable_install_not_approved");
writeFileSync(join(built.runDir, "PORTABLE-ACCEPTANCE.json"), JSON.stringify({
  schema: "uptokey-portable-acceptance-v1", platform: process.platform, arch: process.arch,
  node: process.version, tarball: built.tarball, sha256: built.sha256,
  reproducible: true, install: receipt.summary, scope: "native package installation, terminal entry points and local service; no external inference or desktop",
}, null, 2) + "\n", { flag: "wx" });
