import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const RECEIPT_SCHEMA_ID = "uptokey-windows-clean-acceptance-v1";
export const ACCEPTANCE_ARTIFACT_NAMES = Object.freeze(["uptokey-windows.exe", "uptokey-update-helper.exe"]);

// Espelho dos padrões de src/scrub.ts (scripts .mjs de evidência não importam src/*.ts por decisão do repo).
const LEAK_PATTERNS = Object.freeze([
  { name: "groq_key", pattern: /gsk_[A-Za-z0-9_-]{8,}/ },
  { name: "gemini_key", pattern: /AIza[A-Za-z0-9_-]{8,}/ },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9_-]{8,}/ },
  { name: "zai_key", pattern: /\bz-[A-Za-z0-9_-]{8,}/ },
  { name: "zai_account_key", pattern: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/ },
  { name: "uptokey_token", pattern: /utk_(?:local|device|bootstrap|control|live)_[A-Za-z0-9._-]{8,}/ },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/ },
  { name: "personal_path", pattern: /[A-Za-z]:\\+Users\\+(?!WDAGUtilityAccount\b)[^\\"]+/ }
]);

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function receiptLeakReason(serialized) {
  for (const { name, pattern } of LEAK_PATTERNS) if (pattern.test(serialized)) return name;
  return null;
}

export function expectedArtifacts(distDir) {
  return ACCEPTANCE_ARTIFACT_NAMES.map((name) => ({ name, path: join(distDir, name) }));
}

export function buildSandboxConfiguration(hostInDir, hostOutDir) {
  return [
    "<Configuration>",
    "  <Networking>Disable</Networking>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${hostInDir}</HostFolder>`,
    "      <SandboxFolder>C:\\UptokeyAcceptance\\in</SandboxFolder>",
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    `      <HostFolder>${hostOutDir}</HostFolder>`,
    "      <SandboxFolder>C:\\UptokeyAcceptance\\out</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    "    <Command>powershell.exe -ExecutionPolicy Bypass -NoProfile -File C:\\UptokeyAcceptance\\in\\clean-acceptance-inner.ps1</Command>",
    "  </LogonCommand>",
    "</Configuration>",
    ""
  ].join("\n");
}

export function buildAcceptanceManifest(distDir, licensePath) {
  const artifacts = expectedArtifacts(distDir).map(({ name, path }) => {
    if (!existsSync(path)) throw new Error(`clean_acceptance_artifact_missing:${name}`);
    return { name, sha256: sha256File(path) };
  });
  return Object.freeze({
    schema: "uptokey-windows-clean-acceptance-manifest-v1",
    expected: Object.freeze({ artifacts: Object.freeze(artifacts), license_sha256: sha256File(licensePath) })
  });
}

export function validateReceipt(receipt) {
  const errors = [];
  if (typeof receipt !== "object" || receipt === null) return ["receipt_not_object"];
  if (receipt.schema !== RECEIPT_SCHEMA_ID) errors.push("schema_mismatch");
  const serialized = JSON.stringify(receipt);
  const leak = receiptLeakReason(serialized);
  if (leak !== null) errors.push(`receipt_leak:${leak}`);
  if (receipt.result !== "valid") { errors.push(`result_not_valid:${String(receipt.result)}`); return errors; }
  if (receipt.runtime_absence?.node !== true) errors.push("node_present_on_machine");
  if (receipt.runtime_absence?.bun !== true) errors.push("bun_present_on_machine");
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== ACCEPTANCE_ARTIFACT_NAMES.length) errors.push("artifacts_incomplete");
  else for (const artifact of receipt.artifacts) {
    if (artifact.matches_expected !== true) errors.push(`artifact_mismatch:${String(artifact.name)}`);
    if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256))) errors.push(`artifact_sha256_invalid:${String(artifact.name)}`);
  }
  if (receipt.license?.exit_code !== 0 || receipt.license?.matches_expected !== true) errors.push("license_invalid");
  if (receipt.daemon?.loopback_only !== true) errors.push("listener_not_loopback");
  if (receipt.daemon?.health_status !== 200) errors.push("health_invalid");
  if (receipt.daemon?.ui_status !== 200 || receipt.daemon?.ui_leak_scan !== "clean") errors.push("ui_invalid");
  if (receipt.token_flow?.issued !== true) errors.push("token_not_issued");
  if (receipt.token_flow?.inference_status === 401 || !Number.isInteger(receipt.token_flow?.inference_status) || receipt.token_flow.inference_status === 0) errors.push("authenticated_call_invalid");
  if (receipt.token_flow?.inference_leak_scan !== "clean") errors.push("inference_leak");
  if (receipt.token_flow?.revoked !== true) errors.push("token_not_revoked");
  if (receipt.token_flow?.post_revoke_status !== 401 || receipt.token_flow?.post_revoke_shape_exact !== true) errors.push("revocation_not_enforced");
  if (receipt.cleanup?.daemon_stopped !== true || receipt.cleanup?.profile_removed !== true) errors.push("cleanup_incomplete");
  return errors;
}

export function windowsSandboxExecutable() {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe");
  return existsSync(candidate) ? candidate : null;
}

async function main() {
  const contractOnly = process.argv.includes("--contract");
  const packageRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
  const distDir = join(packageRoot, "dist");
  const licensePath = join(packageRoot, "LICENSE");
  const innerScript = join(packageRoot, "packaging", "windows", "clean-acceptance-inner.ps1");

  if (contractOnly) {
    if (!existsSync(innerScript)) { process.stderr.write("windows_clean_acceptance_invalid:inner_script_missing\n"); process.exitCode = 1; return; }
    const configuration = buildSandboxConfiguration("C:\\host\\in", "C:\\host\\out");
    if (!configuration.includes("<Networking>Disable</Networking>") || !configuration.includes("<ReadOnly>true</ReadOnly>")) {
      process.stderr.write("windows_clean_acceptance_invalid:sandbox_configuration\n"); process.exitCode = 1; return;
    }
    process.stdout.write("windows_clean_acceptance_contract_valid\n");
    return;
  }

  let stage = "manifest";
  try {
    const manifest = buildAcceptanceManifest(distDir, licensePath);
    const sandbox = windowsSandboxExecutable();
    if (sandbox === null) {
      // Ensaio físico impossível neste host (ex.: Windows Home sem o recurso). Registrar SKIP honesto, nunca promover.
      process.stdout.write("windows_clean_acceptance_skipped:sandbox_unavailable\n");
      return;
    }
    stage = "stage_folders";
    const staging = mkdtempSync(join(tmpdir(), "uptokey-clean-acceptance-"));
    const inDir = join(staging, "in");
    const outDir = join(staging, "out");
    mkdirSync(inDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    for (const { name, path } of expectedArtifacts(distDir)) copyFileSync(path, join(inDir, name));
    copyFileSync(innerScript, join(inDir, "clean-acceptance-inner.ps1"));
    writeFileSync(join(inDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const wsbPath = join(staging, "clean-acceptance.wsb");
    writeFileSync(wsbPath, buildSandboxConfiguration(inDir, outDir), { mode: 0o600 });

    stage = "launch_sandbox";
    const launch = spawnSync(sandbox, [wsbPath], { windowsHide: true });
    if (launch.error) throw new Error("sandbox_launch_failed");

    stage = "await_receipt";
    const receiptPath = join(outDir, "clean-acceptance-receipt.json");
    const deadline = Date.now() + 10 * 60_000;
    while (!existsSync(receiptPath)) {
      if (Date.now() > deadline) throw new Error("receipt_timeout");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));

    stage = "validate_receipt";
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const errors = validateReceipt(receipt);
    if (errors.length > 0) throw new Error(`receipt_invalid:${errors.join(",")}`);

    stage = "publish_receipt";
    const published = join(distDir, "windows-clean-acceptance-receipt.json");
    writeFileSync(published, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    rmSync(staging, { recursive: true, force: true });
    process.stdout.write("windows_clean_acceptance_valid\n");
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_:,.-]+$/i.test(error.message) ? error.message : "unexpected";
    process.stderr.write(`windows_clean_acceptance_invalid:${stage}:${reason}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
