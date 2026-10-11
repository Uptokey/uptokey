import { createPublicKey } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { updateKeyFingerprint } from "./update-signature-evidence.mjs";

export function updateTrustDefineArgs(publicKeyPath = process.env.UPTOKEY_UPDATE_PUBLIC_KEY_PATH) {
  if (!publicKeyPath) throw new Error("update_public_key_path_required_for_distribution_build");
  const primary = publicTrust(publicKeyPath); const args = ["--define", `UPTOKEY_UPDATE_PUBLIC_KEY_SPKI_BASE64=${JSON.stringify(primary.spki)}`, "--define", `UPTOKEY_UPDATE_KEY_FINGERPRINT=${JSON.stringify(primary.fingerprint)}`]; const nextPath = process.env.UPTOKEY_UPDATE_NEXT_PUBLIC_KEY_PATH;
  if (nextPath) { const next = publicTrust(nextPath); if (next.fingerprint === primary.fingerprint) throw new Error("update_rotation_key_must_be_distinct"); args.push("--define", `UPTOKEY_UPDATE_NEXT_PUBLIC_KEY_SPKI_BASE64=${JSON.stringify(next.spki)}`, "--define", `UPTOKEY_UPDATE_NEXT_KEY_FINGERPRINT=${JSON.stringify(next.fingerprint)}`); }
  return args;
}

export function compiledVersionDefineArgs(version = process.env.UPTOKEY_BUILD_VERSION) {
  const compiled = requiredCompiledVersion(version); return ["--define", `UPTOKEY_BUILD_VERSION=${JSON.stringify(compiled)}`];
}

export function requiredCompiledVersion(version = process.env.UPTOKEY_BUILD_VERSION) {
  if (!version) throw new Error("compiled_version_required_for_distribution_build");
  const compiled = version.startsWith("v") ? version.slice(1) : version;
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(compiled);
  if (!match || (match[1] && match[1].split(".").some((part) => /^\d+$/.test(part) && !/^(?:0|[1-9]\d*)$/.test(part)))) throw new Error("compiled_version_invalid");
  return compiled;
}

export function updateOriginDefineArgs(origin = process.env.UPTOKEY_UPDATE_ORIGIN) { if (!origin) throw new Error("update_origin_required_for_distribution_build"); let parsed; try { parsed = new URL(origin); } catch { throw new Error("update_origin_invalid"); } if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== origin) throw new Error("update_origin_invalid"); return ["--define", `UPTOKEY_UPDATE_ORIGIN=${JSON.stringify(origin)}`]; }
export function publicUpdateKeyFingerprint(path) { return publicTrust(path).fingerprint; }
function publicTrust(path) { const key = createPublicKey(readFileSync(realpathSync(path))); const spki = key.export({ type: "spki", format: "der" }); return { spki: spki.toString("base64"), fingerprint: updateKeyFingerprint(key) }; }
