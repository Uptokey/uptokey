#!/usr/bin/env node
/**
 * Builds the terminal frontend artifact: dist/tui/{main.js, chunks, runtime/bun, node_modules/@opentui/core-<platform>,
 * THIRD-PARTY-NOTICES.md, BUILD_INFO.json}. The Node core and its release verifier are untouched; the launcher
 * (src/tui/frontend-launcher.ts) resolves this canonical artifact or the same frontend's development sources.
 *
 *   node scripts/build-tui-frontend.mjs [--out-dir <dir>]    (default: dist/tui)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateThirdPartyNotices, NOTICES_FILE } from "./generate-third-party-notices.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontend = join(root, "src", "tui", "frontend");
const flagIndex = process.argv.indexOf("--out-dir");
const outDir = resolve(flagIndex >= 0 ? process.argv[flagIndex + 1] : join(root, "dist", "tui"));
const bun = process.env.BUN_BIN || (process.platform === "win32" ? "bun.exe" : "bun");
const portable = process.argv.includes("--portable");
const portableArgs = portable ? ["--portable"] : [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${command}_failed\n`);
    process.exit(1);
  }
  return result.stdout.trim();
}

const bunVersion = run(bun, ["--version"]);
if (!existsSync(join(frontend, "node_modules"))) run(bun, ["install", "--frozen-lockfile"], { cwd: frontend });

const meta = mkdtempSync(join(tmpdir(), "uptokey-tui-meta-"));
const metafile = join(meta, "main.json");
run(bun, ["run", "scripts/build.ts", "--outdir", outDir, "--metafile", metafile, "--minify", ...portableArgs], { cwd: frontend });
const linearMetafile = join(meta, "linear.json");
run(bun, ["run", "scripts/build.ts", "--linear", "--outdir", outDir, "--metafile", linearMetafile, "--minify", ...portableArgs], { cwd: frontend });
if (process.argv.includes("--with-fixtures")) {
  run(bun, ["run", "scripts/build.ts", "--outdir", outDir, "--entry", "./uptokey/fixture-entry.tsx", "--minify"], { cwd: frontend });
  run(bun, ["run", "scripts/build.ts", "--linear", "--outdir", outDir, "--entry", "./uptokey/fixture-linear-entry.ts", "--minify"], { cwd: frontend });
}

// Notices: exactly what the bundler inlined, plus what ships beside it (runtime and native library).
const externals = ["@napi-rs/keyring", "tree-sitter-wasm", "web-tree-sitter", "@repomix/tree-sitter-wasms", "js-tiktoken", "@opentui/core-*"];
const generated = generateThirdPartyNotices({ root, bundles: [{ bundle: "dist/tui/main.js", metafile }, { bundle: "dist/tui/linear-entry.js", metafile: linearMetafile }], externals });
const nativePackage = portable ? "@opentui/core" : `@opentui/core-${process.platform}-${process.arch}`;
const nativeDir = join(frontend, "node_modules", nativePackage);
const nativeLicense = readFileSync(join(nativeDir, "LICENSE"), "utf8").replace(/\r\n?/g, "\n").trimEnd();
const nativeVersion = JSON.parse(readFileSync(join(nativeDir, "package.json"), "utf8")).version;
// The parser WASM is copied from this package even when its JavaScript stays external.
const parserDir = join(frontend, "node_modules", "web-tree-sitter");
const parserPackage = JSON.parse(readFileSync(join(parserDir, "package.json"), "utf8"));
const parserLicense = readFileSync(join(parserDir, "LICENSE"), "utf8").replace(/\r\n?/g, "\n").trimEnd();
const shipped = [
  "",
  "## Shipped next to the bundle (not inlined)",
  "",
  `### web-tree-sitter@${parserPackage.version}`,
  `License: ${parserPackage.license}. Parser WebAssembly copied from web-tree-sitter; its JavaScript module remains a runtime dependency.`,
  "",
  "```text",
  parserLicense,
  "```",
  "",
  `### ${nativePackage}@${nativeVersion}`,
  "License: MIT. Prebuilt native renderer library loaded by OpenTUI.",
  "",
  "```text",
  nativeLicense,
  "```",
  "",
  `### Bun runtime ${bunVersion}`,
  "License: MIT (Oven, https://github.com/oven-sh/bun), with the third-party components listed at https://bun.sh/docs/project/licensing.",
  portable ? "The pinned official bun npm dependency installs the runtime for the user's platform. OpenTUI native dependencies are selected by npm for that platform." : "The vendor-signed executable is shipped unmodified in `runtime/` so the bundle runs under hosts that block freshly compiled unsigned executables.",
  "The full Bun license text must accompany the runtime in a release: see runtime/LICENSE-Bun.md when it is present; its absence is reported by verify-tui-frontend.",
  "",
].join("\n");
writeFileSync(join(outDir, NOTICES_FILE), generated.text.replace(/\n$/, "\n") + shipped);
rmSync(meta, { recursive: true, force: true });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(outDir).filter((file) => !file.endsWith("BUILD_INFO.json")).sort().map((file) => ({
  path: relative(outDir, file).replaceAll("\\", "/"),
  bytes: statSync(file).size,
  sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
}));
const parserRuntime = files.find(file => /^tree-sitter-[A-Za-z0-9_]+\.wasm$/.test(file.path))?.path;
if (!parserRuntime) throw new Error("tui_parser_runtime_missing");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "BUILD_INFO.json"), JSON.stringify({
  builtAt: new Date(Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH)) && Number(process.env.SOURCE_DATE_EPOCH)>0 ? Number(process.env.SOURCE_DATE_EPOCH)*1000 : Date.now()).toISOString(),
  version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  bun: bunVersion,
  entry: "main.js",
  accessibleEntry: "linear-entry.js",
  accessibleRuntime: "node",
  runtime: portable ? "npm:bun" : `runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`,
  nativePackage: `${nativePackage}@${nativeVersion}`,
  parserPackage: `web-tree-sitter@${parserPackage.version}`,
  parserRuntime,
  platform: portable ? "portable" : `${process.platform}-${process.arch}`,
  upstream: JSON.parse(readFileSync(join(frontend, "UPSTREAM.json"), "utf8")).revision,
  notices: NOTICES_FILE,
  files,
}, null, 2) + "\n");
process.stdout.write(`built ${outDir} (${files.length} files)\n`);
