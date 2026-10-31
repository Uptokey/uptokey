#!/usr/bin/env node
// Release build: prepare + verify the sidecar, then compile its production app.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseBuildArgs, releaseBuildEnvironment } from "./release-cargo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cargoArgs = releaseBuildArgs();
if (process.argv.includes('--print-plan')) {
  console.log(JSON.stringify({command: 'cargo', args: cargoArgs}));
  process.exit(0);
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(`Cannot launch ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

console.log("--- Preparing sidecar ---");
run(process.execPath, ["scripts/prepare-sidecar.mjs"], { cwd: resolve(here, "..") });
console.log("--- Verifying sidecar ---");
run(process.execPath, ["scripts/verify-sidecar.mjs"], { cwd: resolve(here, "..") });
console.log("--- Building Tauri (release) ---");
run("cargo", cargoArgs, { cwd: resolve(here, ".."), env: releaseBuildEnvironment() });
console.log("Release build completed");
