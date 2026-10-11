import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseUpdateManifest } from "../src/update-manifest.ts";
import { verifyUpdateSignatureContent } from "./update-signature-evidence.mjs";

export function buildUpdateSite(rootInput: string, originInput: string) {
  const requestedRoot = resolve(rootInput); const metadata = lstatSync(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("update_site_root_directory_required");
  const root = realpathSync(requestedRoot); const origin = validatedOrigin(originInput);
  const manifestPath = regular(root, "update-manifest.json", 128 * 1024); const signaturePath = regular(root, "update-manifest.sig", 1024); const publicKeyPath = regular(root, "update-public.pem", 8 * 1024);
  const manifestBytes = readFileSync(manifestPath); const manifest = parseUpdateManifest(manifestBytes, origin);
  verifyUpdateSignatureContent(manifestBytes, readFileSync(signaturePath, "utf8").trim(), readFileSync(publicKeyPath));
  const sources = manifest.artifacts.map((artifact) => {
    const source = regular(root, artifact.path, 2_147_483_648); assertArtifact(source, artifact.size, artifact.sha256);
    if (artifact.url !== `${origin}/${manifest.version}/${artifact.path}`) throw new Error("update_site_artifact_url_layout_mismatch");
    return { artifact, source };
  });
  const output = resolve(root, "update-site"); if (existsSync(output)) throw new Error("update_site_output_exists");
  const temporary = resolve(root, `.update-site.${process.pid}.${randomUUID()}.tmp`); mkdirSync(temporary, { mode: 0o700 });
  try {
    copyFileSync(manifestPath, resolve(temporary, "update-manifest.json"), constants.COPYFILE_EXCL);
    copyFileSync(signaturePath, resolve(temporary, "update-manifest.sig"), constants.COPYFILE_EXCL);
    const versionDirectory = resolve(temporary, manifest.version); mkdirSync(versionDirectory, { mode: 0o700 });
    for (const { artifact, source } of sources) { const target = resolve(versionDirectory, artifact.path); copyFileSync(source, target, constants.COPYFILE_EXCL); assertArtifact(target, artifact.size, artifact.sha256); }
    renameSync(temporary, output); return { output, version: manifest.version, files: ["update-manifest.json", "update-manifest.sig", ...manifest.artifacts.map((item) => `${manifest.version}/${item.path}`)] };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}

function validatedOrigin(value: string) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) throw new Error("update_site_origin_invalid"); return url.origin; }
function regular(root: string, name: string, maximum: number) { const path = resolve(root, name); const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) throw new Error(`update_site_input_invalid:${name}`); const canonical = realpathSync(path); if (!canonical.startsWith(`${root}\\`) && !canonical.startsWith(`${root}/`)) throw new Error(`update_site_input_outside_root:${name}`); return canonical; }
function assertArtifact(path: string, expectedSize: number, expectedDigest: string) { const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedSize || sha256File(path) !== expectedDigest) throw new Error("update_site_artifact_binding_mismatch"); }
function sha256File(path: string) { const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { closeSync(handle); } return hash.digest("hex"); }
function parseArgs(argv: string[]) { const parsed: Record<string, string> = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("build_update_site_arguments_invalid"); parsed[key.slice(2)] = value; } return parsed; }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { const args = parseArgs(process.argv.slice(2)); if (!args.root || !args.origin) throw new Error("uso: --root <release-dir> --origin <https-origin>"); const result = buildUpdateSite(args.root, args.origin); process.stdout.write(`Site de update ${result.version} criado em ${result.output}.\n`); }
  catch { process.stderr.write("Site de update recusado: build_failed\n"); process.exitCode = 1; }
}
