import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(core, "package-lock.json"), "utf8"));

export function betaPackageFixture(t, platform = "win32-x64") {
  const directory = mkdtempSync(join(tmpdir(), "uptokey-package-fixture-"));
  t.after(() => {
    const checked = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(checked && checked !== ".." && !checked.startsWith(`..${sep}`) && !resolve(directory).endsWith(sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const source = join(directory, "project", "proxy", "core"), stage = join(directory, "stage");
  const distDir = join(source, "dist"), frontendDir = join(distDir, "tui");
  mkdirSync(frontendDir, { recursive: true }); mkdirSync(stage);
  const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  write(join(source, "package.json"), JSON.stringify(pkg));
  write(join(source, "package-lock.json"), JSON.stringify(lock));
  write(join(source, "LICENSE"), "fixture license\n"); write(join(source, "README.md"), "fixture README\n");
  // Exercise the canonical documentation sources after the workspace reorganization.
  write(join(source, "../../docs/beta/FIRST-RUN-BETA.md"), "fixture first run\n");
  write(join(source, "../../packaging/npm-uptokey/SPEC-MCP-V1.md"), "fixture specification\n");
  write(join(distDir, "cli.js"), 'import "node:fs"; import "hono"; const repositoryWorker = new URL("./tui/repo-map-worker.js", import.meta.url);\n');
  write(join(distDir, "workspace-context-helper.js"), 'import "node:fs"; import "@napi-rs/keyring";\n');
  write(join(distDir, "BUILD_INFO.json"), JSON.stringify({ version: pkg.version, target: "node", compositionWorker: "composition-worker.js", serviceSchemaWorker: "service-schema-worker.js" }));
  write(join(distDir, "THIRD-PARTY-NOTICES.md"), "# Third-party notices\n\nFixture inventory.\n");
  write(join(distDir, "composition-worker.js"), "export {};\n");
  write(join(distDir, "service-schema-worker.js"), "export {};\n");
  const native = `@opentui/core-${platform}`;
  const info = { builtAt: "2026-10-01T00:00:00.000Z", version: pkg.version, bun: "1.4.0", entry: "main.js", accessibleEntry: "linear-entry.js", accessibleRuntime: "node",
    runtime: `runtime/${platform.startsWith("win32-") ? "bun.exe" : "bun"}`, nativePackage: `${native}@0.4.5`, parserPackage: "web-tree-sitter@0.25.10", parserRuntime: "tree-sitter-abc123.wasm", platform, notices: "THIRD-PARTY-NOTICES.md", files: [] };
  const fixture = { directory, source, stage, distDir, frontendDir, info, pkg, lock,
    writeInfo() { write(join(frontendDir, "BUILD_INFO.json"), JSON.stringify(info, null, 2) + "\n"); },
    writeFrontend(path, content) {
      const bytes = Buffer.from(content); write(join(frontendDir, path), bytes);
      const entry = { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const index = info.files.findIndex(file => file.path === path);
      if (index < 0) info.files.push(entry); else info.files[index] = entry;
      this.writeInfo();
    } };
  for (const [path, content] of [
    ["main.js", `import "${native}"; import "./chunk.js"; import "@napi-rs/keyring"; const repositoryWorker = new URL("./repo-map-worker.js", import.meta.url);\n`],
    ["linear-entry.js", 'import "web-tree-sitter"; import "./chunk.js";\n'],
    ["chunk.js", 'export const png = () => import("pngjs");\n'],
    ["opentui-tree-sitter-worker.js", "export {};\n"],
    ["repo-map-worker.js", "export {};\n"],
    ["parser.wasm", "fixture parser"], ["syntax.scm", "fixture query"],
    [info.parserRuntime, "fixture base parser"],
    [info.runtime, "fixture vendor runtime"], ["runtime/LICENSE-Bun.md", "fixture Bun license\n"],
    [`node_modules/${native}/package.json`, JSON.stringify({ name: native, version: "0.4.5", type: "module" })],
    [`node_modules/${native}/LICENSE`, "fixture native MIT license\n"],
    [`node_modules/${native}/libopentui.${platform.startsWith("win32-") ? "dll" : platform.startsWith("darwin-") ? "dylib" : "so"}`, "fixture native library"],
    ["THIRD-PARTY-NOTICES.md", "# Third-party notices\n\n### @opencode-ai/tui@1.18.32\nMIT\n### @opentui/core@0.4.5\nMIT\n### @opentui/solid@0.4.5\nMIT\n### solid-js@1.9.10\nMIT\n### Bun runtime 1.4.0\nMIT\n"],
  ]) fixture.writeFrontend(path, content);
  return fixture;
}

export function stagedEntries(stage) {
  const entries = new Map();
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.set(`package/${relative(stage, path).replaceAll("\\", "/")}`, readFileSync(path));
    }
  };
  walk(stage); return entries;
}
