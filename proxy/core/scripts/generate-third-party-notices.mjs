#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.md for the JavaScript bundles shipped in dist/.
//
// Source of truth: the bundler metafile (Bun `--metafile`), i.e. the exact list of
// input files inlined into each bundle. Only code that is physically embedded is
// listed as redistributed; modules kept `--external` are listed separately as NOT
// embedded. License identifiers come from each package's package.json and license
// texts are copied verbatim from files shipped inside the package. Nothing is
// inferred: a missing license file or undeclared license is stated as such.
// Output is deterministic (code-unit sorting, LF, no timestamps or absolute paths).
// This is an engineering inventory, not a legal opinion.
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
export const NOTICES_HEADER = "# Third-party notices";

// Bundler inputs outside node_modules that are Uptokey repository sources
// (paths relative to proxy/core, the bundler working directory).
export const FIRST_PARTY_SOURCE_ROOTS = Object.freeze([
  "src/", "scripts/", "vendor/sync-contract/",
  "../contratos/", "../integracoes/api-instruments/src/", "../integracoes/conversation-recipes/src/",
  "../integracoes/e2-20-diagnostic/src/", "../integracoes/e2-20-diagnostic/contracts/",
  "../../quimera/uptokey/scripts/",
]);
// Third-party source trees copied into the repository (not installed by npm) that
// the bundler may inline. `manifest` records the pinned upstream origin/commit.
export const VENDORED_SOURCE_ROOTS = Object.freeze([
  Object.freeze({ root: "../integracoes/9router/app/", manifest: "../integracoes/9router/source-manifest.json" }),
  // OpenTUI frontend: pinned OpenCode snapshot (MIT) with Uptokey modifications listed in src/tui/frontend/UPSTREAM.json.
  Object.freeze({ root: "src/tui/frontend/vendor/opencode-tui/", manifest: "src/tui/frontend/vendor/source-manifest.json" }),
  Object.freeze({ root: "src/tui/frontend/vendor/opencode-sdk/", manifest: "src/tui/frontend/vendor/source-manifest.json" }),
  Object.freeze({ root: "src/tui/frontend/vendor/opencode-plugin/", manifest: "src/tui/frontend/vendor/source-manifest.json" }),
]);

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.\-_][^/\\]*)?$/i;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = value => value.replaceAll("\\", "/").replace(/^\.\//, "");

function readJson(path, error) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`${error}:${path}`); }
}

/** Declared license exactly as written in package.json (SPDX string, legacy object or array). */
export function declaredLicense(pkg) {
  if (typeof pkg?.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg?.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") return `${pkg.license.type} (legacy "license" object)`;
  if (Array.isArray(pkg?.licenses)) {
    const types = pkg.licenses.map(entry => (typeof entry === "string" ? entry : entry?.type)).filter(value => typeof value === "string" && value);
    if (types.length) return `${types.join(", ")} (legacy "licenses" field)`;
  }
  return null;
}

function licenseFiles(directory) {
  return readdirSync(directory)
    .filter(name => LICENSE_FILE.test(name) && lstatSync(join(directory, name)).isFile())
    .sort(byCodeUnit)
    .map(name => ({ name, text: readFileSync(join(directory, name), "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd() }));
}

/** Classifies one metafile input path (relative to the bundler cwd). Fails closed on unknown code. */
export function classifyInput(input) {
  const path = posix(input);
  const marker = path.lastIndexOf("node_modules/");
  if (marker >= 0) {
    const segments = path.slice(marker + "node_modules/".length).split("/");
    const name = segments[0]?.startsWith("@") ? `${segments[0]}/${segments[1] ?? ""}` : segments[0];
    if (!name || name.endsWith("/") || segments.length < (name.includes("/") ? 3 : 2)) throw new Error(`third_party_notices_package_path_invalid:${path}`);
    return { kind: "npm", name, directory: `${path.slice(0, marker)}node_modules/${name}` };
  }
  const vendored = VENDORED_SOURCE_ROOTS.find(entry => path.startsWith(entry.root));
  if (vendored) return { kind: "vendored", directory: vendored.root.slice(0, -1), manifest: vendored.manifest };
  const firstParty = FIRST_PARTY_SOURCE_ROOTS.find(root => path.startsWith(root));
  if (firstParty) return { kind: "first-party", root: firstParty };
  throw new Error(`third_party_notices_unclassified_input:${path}`);
}

/**
 * @param {{ root: string, bundles: { bundle: string, metafile: string }[], externals?: string[] }} options
 * @returns {{ text: string, components: { name: string, version: string, license: string | null, source: string, licenseFiles: string[], bundles: string[] }[] }}
 */
export function generateThirdPartyNotices({ root, bundles, externals = [] }) {
  if (!Array.isArray(bundles) || bundles.length === 0) throw new Error("third_party_notices_bundles_required");
  const components = new Map();
  const firstParty = new Set();
  for (const { bundle, metafile } of [...bundles].sort((a, b) => byCodeUnit(a.bundle, b.bundle))) {
    const meta = readJson(metafile, "third_party_notices_metafile_invalid");
    if (!meta || typeof meta.inputs !== "object" || meta.inputs === null) throw new Error(`third_party_notices_metafile_invalid:${metafile}`);
    for (const input of Object.keys(meta.inputs).sort(byCodeUnit)) {
      const entry = classifyInput(input);
      if (entry.kind === "first-party") { firstParty.add(entry.root); continue; }
      const pkg = readJson(join(root, entry.directory, "package.json"), "third_party_notices_package_json_missing");
      if (entry.kind === "npm" && pkg.name !== entry.name) throw new Error(`third_party_notices_package_name_mismatch:${entry.directory}`);
      if (typeof pkg.version !== "string" || !pkg.version) throw new Error(`third_party_notices_package_version_missing:${entry.directory}`);
      const name = entry.kind === "npm" ? entry.name : (typeof pkg.name === "string" && pkg.name ? pkg.name : entry.directory.split("/").at(-1));
      const key = `${name}@${pkg.version}`;
      let component = components.get(key);
      if (!component) {
        let source = "npm package (inlined by the bundler)";
        if (entry.kind === "vendored") {
          const manifest = readJson(join(root, entry.manifest), "third_party_notices_vendored_manifest_invalid");
          if (typeof manifest.origin !== "string" || !/^[a-f0-9]{40}$/.test(manifest.commit ?? "")) throw new Error(`third_party_notices_vendored_manifest_invalid:${entry.manifest}`);
          source = `vendored source copy of ${manifest.origin} at commit ${manifest.commit} (inlined by the bundler)`;
        }
        component = { name, version: pkg.version, license: declaredLicense(pkg), source, directories: new Set(), bundles: new Set() };
        components.set(key, component);
      }
      component.directories.add(entry.directory);
      component.bundles.add(bundle);
    }
  }
  const list = [...components.values()].sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version)).map(component => {
    // Same name@version installed in several places: read the first location in code-unit order.
    const directory = [...component.directories].sort(byCodeUnit)[0];
    return { ...component, files: licenseFiles(join(root, directory)), bundles: [...component.bundles].sort(byCodeUnit) };
  });
  const rootPkg = readJson(join(root, "package.json"), "third_party_notices_package_json_missing");
  const cell = value => String(value).replaceAll("|", "\\|");
  const bundleNames = bundles.map(entry => entry.bundle).sort(byCodeUnit);
  const lines = [
    NOTICES_HEADER, "",
    `This file lists third-party software embedded (inlined by the bundler) in the JavaScript bundles shipped in this package: ${bundleNames.map(name => `\`${name}\``).join(", ")}.`,
    "It is generated by `scripts/generate-third-party-notices.mjs` from the bundler metafile; license identifiers are copied from each component's package.json and license texts are copied verbatim from the files shipped with each component. It is an engineering inventory, not a legal opinion.",
    "",
    `Uptokey's own code is distributed under the terms in this package's \`LICENSE\` file (declared license: ${declaredLicense(rootPkg) ?? "not declared in package.json"}).`,
    "",
    `## Embedded third-party components (${list.length})`, "",
    "| Component | Version | Declared license (package.json) | License file(s) | Embedded in |",
    "| --- | --- | --- | --- | --- |",
    ...list.map(c => `| ${cell(c.name)} | ${cell(c.version)} | ${cell(c.license ?? "not declared")} | ${cell(c.files.length ? c.files.map(f => f.name).join(", ") : "not present")} | ${cell(c.bundles.join(", "))} |`),
    "",
  ];
  // Reconstructed after the 2026-09-28 loss: the original first 130 lines are
  // preserved verbatim. This tail follows the preserved generated notice format.
  lines.push(
    "## Runtime dependencies NOT embedded", "",
    "The following module specifiers are kept external by the bundler. Their code is NOT redistributed in this package; when used, they are installed separately by the package manager under their own license terms and are therefore not reproduced here.", "",
    ...[...new Set(externals)].sort(byCodeUnit).map(name => `- \`${name}\``), "",
    "## First-party repository sources (not third-party)", "",
    "The bundles also inline Uptokey repository sources from these paths (relative to the core package root); they are not third-party components and are not listed above.", "",
    ...[...firstParty].sort(byCodeUnit).map(path => `- \`${path}\``), "",
    "## Component notices", "",
  );
  for (const component of list) {
    lines.push(
      `### ${component.name}@${component.version}`, "",
      `- Declared license (package.json): ${component.license ?? "not declared in package.json"}`,
      `- Source: ${component.source}`,
      `- Embedded in: ${component.bundles.join(", ")}`, "",
    );
    if (component.files.length === 0) {
      lines.push(`License file not present in package; declared license: ${component.license ?? "not declared in package.json"}.`, "");
      continue;
    }
    for (const file of component.files) {
      // Keep the copied text intact even if a license contains Markdown fences.
      const runs = [...file.text.matchAll(/`+/g)].map(match => match[0].length);
      const fence = "`".repeat(Math.max(3, ...runs.map(length => length + 1)));
      lines.push(`#### ${file.name}`, "", `${fence}text`, file.text, fence, "");
    }
  }
  return {
    text: lines.join("\n").trimEnd() + "\n",
    components: list.map(component => ({
      name: component.name,
      version: component.version,
      license: component.license,
      source: component.source,
      licenseFiles: component.files.map(file => file.name),
      bundles: component.bundles,
    })),
  };
}
