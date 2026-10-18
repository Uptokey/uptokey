#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTICES_FILE, NOTICES_HEADER } from "./generate-third-party-notices.mjs";
import { extractRuntimeAssets, frontendPackageFiles, verifyFrontendEntries, verifyRuntimeDependencies } from "./beta-runtime-contract.mjs";
import { portableDependencies } from "../src/tui/portable-runtime.mjs";

export const QUIMERA_DEV_DEPENDENCIES = Object.freeze([
  "@hpke/core", "@napi-rs/keyring", "@simplewebauthn/server", "eventsource-parser", "hono", "@hono/node-server",
  "@modelcontextprotocol/sdk", "zod", "@langchain/core", "@langchain/langgraph", "@langchain/langgraph-checkpoint",
  "@langchain/langgraph-checkpoint-sqlite", "@langchain/langgraph-sdk", "@langchain/protocol", "langsmith", "better-sqlite3", "js-tiktoken",
  "undici",
]);
export const QUIMERA_DEV_PROFILE = Object.freeze({
  schemaVersion: 1, profile: "win32-x64-node24-abi137", nodeAbi: "137", completeApplication: false,
  externalApplications: ["9router", "playwright-mcp"], nativeAddon: {
    package: "better-sqlite3", version: "12.11.1", path: "build/Release/better_sqlite3.node",
    sha256: "e75b8c024a85179d8e0e51203a8b8867916e9a51327ce3953db5f8483cc9a91e", included: false,
  },
});
const baseFiles = ["FIRST-RUN-BETA.md", "LICENSE", "README.md", "SPEC-MCP-V1.md", "dist/BUILD_INFO.json", `dist/${NOTICES_FILE}`, "dist/cli.js", "dist/service-schema-worker.js", "dist/workspace-context-helper.js", "package.json"];
export function packageFiles(profile = "beta", frontendInfo) {
  if (!["beta", "quimera-dev"].includes(profile)) throw new Error("package_profile_invalid");
  return [...baseFiles, ...(profile === "quimera-dev" ? ["dist/composition-worker.js"] : frontendInfo ? frontendPackageFiles(frontendInfo) : ["dist/tui/BUILD_INFO.json"])].sort();
}
/**
 * The shipped notices must be the generated file and must cover every npm package
 * the bundler annotated as inlined (`// node_modules/<pkg>/...` module comments).
 */
export function verifyThirdPartyNotices(entries) {
  const notices = entries.get(`package/dist/${NOTICES_FILE}`)?.toString("utf8") ?? "";
  if (!notices.startsWith(`${NOTICES_HEADER}\n`) || notices.includes("\r") || !notices.endsWith("\n")) throw new Error("beta_artifact_notices_invalid");
  const listed = new Set([...notices.matchAll(/^### (.+)@[^@\s]+$/gm)].map(match => match[1]));
  const missing = new Set();
  for (const [name, content] of entries) {
    if (!/^package\/dist\/[^/]+\.js$/.test(name)) continue;
    for (const match of content.toString("utf8").matchAll(/^\/\/ (?:\S*\/)?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\/\S+$/gm)) {
      if (!listed.has(match[1])) missing.add(match[1]);
    }
  }
  if (missing.size) throw new Error(`beta_artifact_notices_incomplete:${[...missing].sort().join(",")}`);
  return { components: listed.size };
}
export function verifyPackageEntries(entries, profile = "beta") {
  const listing = [...entries.keys()].sort();
  const required = packageFiles(profile).map(name => `package/${name}`);
  const absent = required.filter(name => !entries.has(name));
  if (absent.length) throw new Error(`beta_artifact_contents_invalid:missing:${absent.sort().join(",")}`);
  const frontendInfo = profile === "beta" ? JSON.parse(entries.get("package/dist/tui/BUILD_INFO.json").toString("utf8")) : undefined;
  const expected = packageFiles(profile, frontendInfo).map(name => `package/${name}`).sort();
  const missing = expected.filter(name => !listing.includes(name));
  const extra = listing.filter(name => !expected.includes(name));
  if (missing.length || extra.length) throw new Error(`beta_artifact_contents_invalid${missing.length ? `:missing:${missing.join(",")}` : ""}${extra.length ? `:extra:${extra.join(",")}` : ""}`);
  if (listing.some(name => /(?:^|\/)(?:\.env(?:\.|$)|secrets?(?:\.|\/|$)|tokens?(?:\.|\/|$)|logs?(?:\.|\/|$)|pwa(?:\/|$)|dashboard(?:\/|$))/i.test(name))) throw new Error("beta_artifact_forbidden_path");
  verifyThirdPartyNotices(entries);
  const schemaBuild = JSON.parse(entries.get("package/dist/BUILD_INFO.json").toString("utf8"));
  if (schemaBuild.serviceSchemaWorker !== "service-schema-worker.js" || !entries.get("package/dist/service-schema-worker.js").length) throw new Error("service_schema_worker_invalid");
  if (profile === "beta") {
    const pkg = JSON.parse(entries.get("package/package.json").toString("utf8"));
    if (JSON.stringify(pkg.uptokeyTui) !== JSON.stringify({ manifest: "dist/tui/BUILD_INFO.json", entry: "dist/tui/main.js", accessibleEntry: "dist/tui/linear-entry.js", accessibleRuntime: "node", platform: frontendInfo.platform })) throw new Error("beta_frontend_package_metadata_invalid");
    verifyFrontendEntries(entries, frontendInfo, pkg.version);
    // Pipe mode constructs the same controller inside the Node CLI bundle.
    // Its worker path is relative to dist/cli.js, not to the frontend chunk.
    if (!/^0\.1\.0-beta\.(?:[0-9]|1[0-7])$/.test(pkg.version)
      && !extractRuntimeAssets(entries.get("package/dist/cli.js").toString("utf8")).includes("./tui/repo-map-worker.js")) {
      throw new Error("beta_core_repo_map_worker_invalid");
    }
    if (frontendInfo.platform === "portable") {
      const expected = portableDependencies(frontendInfo);
      if (pkg.dependencies?.bun !== undefined || JSON.stringify(pkg.optionalDependencies) !== JSON.stringify(expected.optionalDependencies)
        || JSON.stringify(pkg.os) !== '["win32","darwin","linux"]' || JSON.stringify(pkg.cpu) !== '["x64","arm64"]') throw new Error("beta_portable_dependencies_invalid");
    }
    verifyRuntimeDependencies(entries, pkg);
  }
  if (profile === "quimera-dev") {
    const pkg = JSON.parse(entries.get("package/package.json").toString("utf8"));
    const exact = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
    if (pkg.name !== "@uptokey/quimera-proxy-dev" || pkg.private !== true || pkg.publishConfig !== undefined ||
        pkg.scripts !== undefined || pkg.engines?.node !== ">=24.0.0 <25.0.0" || JSON.stringify(pkg.os) !== '["win32"]' ||
        JSON.stringify(pkg.cpu) !== '["x64"]' || JSON.stringify(pkg.bin) !== '{"uptokey-quimera":"dist/cli.js"}' ||
        JSON.stringify(pkg.quimeraDev) !== JSON.stringify(QUIMERA_DEV_PROFILE) ||
        JSON.stringify(Object.keys(pkg.dependencies ?? {}).sort()) !== JSON.stringify([...QUIMERA_DEV_DEPENDENCIES].sort()) ||
        !Object.values(pkg.dependencies).every(exact) || pkg.dependencies["better-sqlite3"] !== QUIMERA_DEV_PROFILE.nativeAddon.version) {
      throw new Error("quimera_dev_manifest_invalid");
    }
    const build = JSON.parse(entries.get("package/dist/BUILD_INFO.json").toString("utf8"));
    if (build.compositionWorker !== "composition-worker.js" || build.target !== "node" || build.version !== pkg.version ||
        !entries.get("package/dist/composition-worker.js").length) throw new Error("quimera_dev_worker_invalid");
  }
  return { files: listing.length, forbiddenPaths: 0, profile, completeApplication: false };
}
/** Dry-run verification uses the same exact file/manifest checks as the archive verifier. */
export function verifyStagedPackage(stage, profile = "beta") {
  const entries = new Map();
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("package_link_forbidden");
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) entries.set(`package/${relative(stage, path).replaceAll("\\", "/")}`, readFileSync(path));
      else throw new Error("package_file_invalid");
    }
  };
  walk(stage);
  return verifyPackageEntries(entries, profile);
}
// Parse the gzip/tar container in-process. This keeps verification portable and
// works on Windows hosts where spawning the system `tar` may be blocked by policy.
function tarEntries(path) {
  const bytes = gunzipSync(readFileSync(path));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => Buffer.from(header.subarray(start, start + length)).toString("utf8").replace(/\0.*$/, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const sizeText = text(124, 12).trim().replace(/\0/g, "");
    if (!name || !/^[0-7]+$/.test(sizeText)) throw new Error("beta_artifact_tar_invalid");
    const size = Number.parseInt(sizeText || "0", 8);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length || entries.has(fullName) ||
        ![0, 48].includes(header[156])) throw new Error("beta_artifact_tar_invalid");
    entries.set(fullName, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
export function verifyArtifact(artifact, profile = "beta") {
  if (!existsSync(artifact)) throw new Error(`beta_artifact_missing:${artifact}`);
  const result = verifyPackageEntries(tarEntries(artifact), profile);
  return { artifact, files: result.files, sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"), forbiddenPaths: result.forbiddenPaths,
    ...(profile === "quimera-dev" ? { profile, completeApplication: false } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dev = args[0] === "--quimera-dev";
  if (dev) args.shift();
  if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("package_arguments_invalid");
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const filename = dev ? `uptokey-quimera-proxy-dev-${pkg.version}.tgz` : `uptokey-${pkg.version}.tgz`;
  console.log(JSON.stringify(verifyArtifact(resolve(args[0] ?? filename), dev ? "quimera-dev" : "beta")));
}
