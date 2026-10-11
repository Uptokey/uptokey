import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compileDistributionCli, DISTRIBUTION_EXECUTION_RETRY_DELAY_MS, isWindowsDeviceGuardExecutionBlock, shouldRecompileDistributionExecution, shouldRetryDistributionExecution } from "./compile-distribution-cli.mjs";

const temporary = await mkdtemp(join(tmpdir(), "uptokey-distribution-smoke-"));
const publicKey = join(temporary, "ephemeral-public.pem");
const executableName = process.platform === "win32" ? "uptokey-windows.exe" : process.platform === "darwin" ? "uptokey-macos" : "uptokey-linux";
let executable = join(temporary, executableName);
const previous = Object.fromEntries(["UPTOKEY_UPDATE_PUBLIC_KEY_PATH", "UPTOKEY_UPDATE_ORIGIN", "UPTOKEY_BUILD_VERSION"].map((name) => [name, process.env[name]]));
const executionTimeoutMs = process.platform === "win32" ? 30_000 : 10_000;
let stage = "generate";

try {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(publicKey, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  process.env.UPTOKEY_UPDATE_PUBLIC_KEY_PATH = publicKey;
  process.env.UPTOKEY_UPDATE_ORIGIN = "https://updates.uptokey.test";
  process.env.UPTOKEY_BUILD_VERSION = "0.1.0-smoke";
  stage = "compile";
  compileDistributionCli(executable);
  stage = "execute";
  let result;
  let executionRetries = 0;
  for (;;) {
    result = spawnSync(executable, ["license"], { encoding: "buffer", windowsHide: true, timeout: executionTimeoutMs });
    if (!shouldRetryDistributionExecution(process.platform, executionRetries, result)) break;
    executionRetries += 1;
    if (shouldRecompileDistributionExecution(result)) {
      executable = join(temporary, "retry", executableName);
      compileDistributionCli(executable);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, DISTRIBUTION_EXECUTION_RETRY_DELAY_MS));
  }
  if (isWindowsDeviceGuardExecutionBlock(process.platform, executionRetries, result)) {
    process.stdout.write(`distribution_build_smoke_skipped:device_guard:node_${process.versions.node.split(".")[0]}\n`);
    process.exitCode = 0;
    stage = "skipped";
  } else {
  if (result.error) {
    const code = ["EACCES", "EINVAL", "ENOENT", "ENOMEM", "ETIMEDOUT"].includes(result.error.code) ? result.error.code.toLowerCase() : "unknown";
    stage = `execute_spawn_${code}`;
    throw new Error("distribution_smoke_execute_invalid");
  }
  if (result.signal) { stage = "execute_signal"; throw new Error("distribution_smoke_execute_invalid"); }
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const diagnostic = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
    stage = /keyring|napi|\.node\b|module not found|cannot find module/i.test(diagnostic) ? "execute_native_dependency"
      : /bun|runtime|entrypoint/i.test(diagnostic) ? "execute_runtime"
      : /unexpected_error/.test(diagnostic) ? "execute_cli_unexpected_error"
      : `execute_exit_${Number.isInteger(result.status) ? result.status : "unknown"}`;
    throw new Error("distribution_smoke_execute_invalid");
  }
  stage = "compare";
  const expected = await readFile(new URL("../LICENSE", import.meta.url));
  if (!result.stdout.equals(expected)) throw new Error("distribution_smoke_compare_invalid");
  process.stdout.write(`distribution_build_smoke_valid retries=${executionRetries}\n`);
  }
} catch {
  process.stderr.write(`distribution_build_smoke_invalid:${stage}\n`);
  process.exitCode = 1;
} finally {
  for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await rm(temporary, { recursive: true, force: true });
}
