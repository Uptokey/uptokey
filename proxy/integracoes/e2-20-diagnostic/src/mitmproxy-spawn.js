/**
 * E2-20 — mitmproxy 12.2.3 optional spawn helper (default OFF).
 * Never installs anything. Never runs unless every gate is satisfied:
 *   1. env UPTOKEY_E2_20_MITMPROXY=1
 *   2. env UPTOKEY_E2_20_MITMPROXY_MODE=explicit|reverse
 *   3. mitmdump binary present AND version matches the pinned profile (12.2.3)
 *   4. listen address is loopback
 * Never passes --ssl-insecure; upstream TLS verification stays on.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const MITMPROXY_PIN = "12.2.3";

export function mitmproxyEnabledByEnv(env = process.env) {
  return env.UPTOKEY_E2_20_MITMPROXY === "1";
}

function readMitmdumpVersion() {
  for (const bin of ["mitmdump", "mitmproxy"]) {
    try {
      const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
      const match = out.match(/(\d+\.\d+\.\d+)/);
      if (match) return { bin, version: match[1] };
    } catch {
      /* not installed — honest absence */
    }
  }
  return null;
}

export function mitmproxyProfileStatus(env = process.env) {
  const found = readMitmdumpVersion();
  return {
    enabledByEnv: mitmproxyEnabledByEnv(env),
    mode: env.UPTOKEY_E2_20_MITMPROXY_MODE === "reverse" ? "reverse" : env.UPTOKEY_E2_20_MITMPROXY_MODE === "explicit" ? "explicit" : null,
    installed: found !== null,
    version: found?.version ?? null,
    pinMatches: found !== null && found.version === MITMPROXY_PIN,
    pin: MITMPROXY_PIN,
  };
}

/**
 * Spawns mitmdump under the pinned profile. Throws typed errors instead of
 * degrading silently; never uses --ssl-insecure; binds loopback only.
 */
export function spawnMitmproxy({ listen = "127.0.0.1:8080", upstreamUrl = null, env = process.env, confDir = null } = {}) {
  if (!mitmproxyEnabledByEnv(env)) {
    const err = new Error("mitmproxy_not_enabled");
    err.code = "mitmproxy_not_enabled";
    throw err;
  }
  const status = mitmproxyProfileStatus(env);
  if (!status.installed) {
    const err = new Error("backend_unavailable");
    err.code = "backend_unavailable";
    throw err;
  }
  if (!status.pinMatches) {
    const err = new Error("mitmproxy_pin_mismatch");
    err.code = "mitmproxy_pin_mismatch";
    throw err;
  }
  if (!status.mode) {
    const err = new Error("mitmproxy_mode_required");
    err.code = "mitmproxy_mode_required";
    throw err;
  }
  const [host, port] = String(listen).split(":");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    const err = new Error("target_not_authorized");
    err.code = "target_not_authorized";
    throw err;
  }
  const dir = confDir ?? mkdtempSync(path.join(tmpdir(), "e2-20-mitm-conf-"));
  const args = [
    "--mode", status.mode,
    "--listen-host", host,
    "--listen-port", port,
    "--set", `confdir=${dir}`,
    // No --ssl-insecure: upstream verification is never disabled by this profile.
  ];
  if (upstreamUrl) args.push("--mode", `reverse:${upstreamUrl}`);
  const child = spawn(status.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  return { child, confDir: dir, version: status.version, mode: status.mode, listen };
}
