import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compiledVersionDefineArgs, updateOriginDefineArgs, updateTrustDefineArgs } from "./build-update-trust.mjs";
import { resolveBunCompiler } from "./compile-distribution-cli.mjs";

export function windowsPackageLayout(root = resolve("dist")) { return Object.freeze({ executable: resolve(root, "uptokey-windows.exe"), updateHelper: resolve(root, "uptokey-update-helper.exe") }); }
export function buildWindowsPackage(root = resolve("dist")) { if (process.platform !== "win32") throw new Error("windows_package_build_requires_windows"); mkdirSync(root, { recursive: true }); const layout = windowsPackageLayout(root); const defines = [...updateTrustDefineArgs(), ...updateOriginDefineArgs(), ...compiledVersionDefineArgs()]; compile("src/cli.ts", layout.executable, defines); compile("scripts/windows-update-helper-cli.mjs", layout.updateHelper, defines); return layout; }
function compile(source, output, defines) { const result = spawnSync(resolveBunCompiler(), ["build", "--compile", ...defines, source, "--outfile", output], { encoding: "utf8", windowsHide: true }); if (result.status !== 0) throw new Error(`windows_package_compile_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 240)}`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { buildWindowsPackage(); } catch { process.stderr.write("windows_package_build_failed\n"); process.exitCode = 1; } }
