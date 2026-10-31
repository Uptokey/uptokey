#!/usr/bin/env node
// Test gate: `cargo test --locked` (never mutates Cargo.lock) for unit +
// integration tests. The prepared sidecar is NOT required: tests use tempdirs
// and loopback fixtures only.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const result = spawnSync("cargo", ["test", "--locked"], {
  stdio: "inherit",
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
});
if (result.error) {
  console.error(`Cannot launch cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
