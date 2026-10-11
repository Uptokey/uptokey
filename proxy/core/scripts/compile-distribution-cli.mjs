import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { compiledVersionDefineArgs, updateOriginDefineArgs, updateTrustDefineArgs } from "./build-update-trust.mjs";

export function defaultDistributionOutput(platform = process.platform) { return resolve("dist", platform === "win32" ? "uptokey-windows.exe" : platform === "darwin" ? "uptokey-macos" : "uptokey-linux"); }
export function resolveBunCompiler() { try { return createRequire(import.meta.url).resolve("bun/bin/bun.exe"); } catch { return "bun"; } }
export function compileDistributionCli(outputPath = defaultDistributionOutput()) { const output = resolve(outputPath); mkdirSync(dirname(output), { recursive: true }); const result = spawnSync(resolveBunCompiler(), ["build", "--compile", ...updateTrustDefineArgs(), ...updateOriginDefineArgs(), ...compiledVersionDefineArgs(), "src/cli.ts", "--outfile", output], { encoding: "utf8", windowsHide: true }); if (result.status !== 0) throw new Error(`distribution_cli_compile_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 240)}`); return output; }
export function publicDistributionCompileError(error) { const value = error instanceof Error ? error.message : ""; return /^(?:update_public_key_path_required_for_distribution_build|update_origin_required_for_distribution_build|update_origin_invalid|compiled_version_required_for_distribution_build|compiled_version_invalid)$/.test(value) ? value : "distribution_cli_compile_failed"; }
export function shouldRetryDistributionExecution(platform, retries, result) { const emptyDiagnostic = Buffer.isBuffer(result?.stderr) ? result.stderr.length === 0 : result?.stderr == null && Boolean(result?.error); const opaqueExit = result?.status === 1 && !result.error; const opaqueSpawn = result?.error && ["EBUSY", "UNKNOWN"].includes(result.error.code); return platform === "win32" && retries === 0 && !result?.signal && emptyDiagnostic && Boolean(opaqueExit || opaqueSpawn); }
export function shouldRecompileDistributionExecution(result) { return Boolean(result?.error && ["EBUSY", "UNKNOWN"].includes(result.error.code)); }
export function isWindowsDeviceGuardExecutionBlock(platform, retries, result) { return platform === "win32" && retries === 1 && result?.status === null && result?.signal === null && result?.error?.code === "UNKNOWN" && result.error.errno === -4094 && result?.stderr == null; }
export const DISTRIBUTION_EXECUTION_RETRY_DELAY_MS = 250;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { process.stdout.write(`${compileDistributionCli(process.argv[2])}\n`); } catch (error) { process.stderr.write(`${publicDistributionCompileError(error)}\n`); process.exitCode = 1; } }
