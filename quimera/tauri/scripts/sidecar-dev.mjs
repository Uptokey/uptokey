#!/usr/bin/env node
// Development loop: prepare + verify the sidecar, then `cargo build` (debug).

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
console.log("--- Building Tauri (debug) ---");
run("cargo", ["build"], { cwd: resolve(here, "..") });
console.log("Dev loop completed");
