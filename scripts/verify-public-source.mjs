import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ".gitleaks.toml",
  "LICENSE",
  "README.md",
  "PUBLIC-SOURCE-MANIFEST.json",
  "proxy/core/package.json",
  "proxy/core/src/cli.ts",
  "proxy/core/src/tui/frontend/UPSTREAM.json",
  "proxy/contratos/package.json",
  "proxy/integracoes/api-instruments/src/index.ts",
  "proxy/integracoes/e2-20-diagnostic/src/w5-diagnostic-adapter.js",
  "proxy/integracoes/conversation-recipes/src/public-contract.ts",
  "quimera/uptokey/scripts/quimera-isolation.mjs",
];
const forbidden = /(^|\/)(?:node_modules|dist|output|coverage|docs\/internal|arquivo|delete|hosted-ai|control-plane|dashboard)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.(?:p12|pfx|db|sqlite3?|exe|dll|node|zip|tgz)$/i;
const absoluteUserPath = /(?:[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)|\/Users\/([A-Za-z0-9._-]+))/g;
const pathPlaceholders = new Set(["me", "user", "username", "<user>", "<username>"]);

function containsPersonalPath(text) {
  return [...text.matchAll(absoluteUserPath)].some(match => !pathPlaceholders.has((match[1] ?? match[2] ?? "").toLowerCase()));
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage", "output"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("public_source_symlink");
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

for (const path of required) {
  const info = lstatSync(join(root, path));
  if (!info.isFile()) throw new Error(`public_source_required:${path}`);
}
const files = walk(root);
const manifest = JSON.parse(readFileSync(join(root, "PUBLIC-SOURCE-MANIFEST.json"), "utf8"));
if (manifest.schema !== "uptokey-public-source-v2" || !Array.isArray(manifest.files)) {
  throw new Error("public_source_manifest_schema");
}
const manifestDestinations = new Set();
for (const item of manifest.files) {
  if (typeof item?.Destination !== "string" || !/^[a-f0-9]{64}$/.test(item?.SourceSha256 ?? "") || !/^[a-f0-9]{64}$/.test(item?.Sha256 ?? "")) {
    throw new Error("public_source_manifest_entry");
  }
  if (manifestDestinations.has(item.Destination)) throw new Error(`public_source_manifest_duplicate:${item.Destination}`);
  manifestDestinations.add(item.Destination);
  const actual = createHash("sha256").update(readFileSync(join(root, item.Destination))).digest("hex");
  if (actual !== item.Sha256) throw new Error(`public_source_manifest_hash:${item.Destination}`);
}
const projectedFiles = files
  .map(path => relative(root, path).replaceAll("\\", "/"))
  .filter(path => path !== "PUBLIC-SOURCE-MANIFEST.json");
for (const path of projectedFiles) {
  if (!manifestDestinations.has(path)) throw new Error(`public_source_unmanifested:${path}`);
}
for (const path of manifestDestinations) {
  if (!projectedFiles.includes(path)) throw new Error(`public_source_missing_manifest_file:${path}`);
}
for (const path of files) {
  const rel = relative(root, path).replaceAll("\\", "/");
  const info = lstatSync(path);
  if (forbidden.test(rel) || info.size > 5 * 1024 * 1024) throw new Error(`public_source_boundary:${rel}`);
  if (/\.(?:m?js|mts|ts|tsx|json|md|ya?ml|toml|txt|css|ps1|sh)$/i.test(rel)) {
    const text = readFileSync(path, "utf8");
    if (containsPersonalPath(text)) throw new Error(`public_source_personal_path:${rel}`);
  }
}
const license = readFileSync(join(root, "LICENSE"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "proxy/core/package.json"), "utf8"));
if (!/GNU AFFERO GENERAL PUBLIC LICENSE/.test(license) || pkg.license !== "AGPL-3.0-or-later") throw new Error("public_source_license");
process.stdout.write(`public_source_valid files=${files.length} version=${pkg.version}\n`);
