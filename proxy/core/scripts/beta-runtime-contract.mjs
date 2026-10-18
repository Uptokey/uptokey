import { createHash } from "node:crypto";
import { posix } from "node:path";
import { builtinModules } from "node:module";
import { portableDependencies } from "../src/tui/portable-runtime.mjs";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => name.replace(/^node:/, "")), "bun"]);
const PACKAGE = /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._/-]+)?$/;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Tokenize only the import surface. Quoted prose, comments and regex literals cannot manufacture dependencies.
function tokens(code) {
  const out = []; let i = 0;
  function scan(stopAtBrace = false) {
    let depth = 0;
    while (i < code.length) {
    const ch = code[i];
    if (stopAtBrace && ch === "}" && depth === 0) { i++; return; }
    if (/\s/.test(ch)) { i++; continue; }
    if (code.startsWith("//", i)) { i = code.indexOf("\n", i + 2); if (i < 0) break; continue; }
    if (code.startsWith("/*", i)) { const end = code.indexOf("*/", i + 2); i = end < 0 ? code.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch; let text = "", interpolated = false; i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") { text += code[i + 1] ?? ""; i += 2; continue; }
        if (quote === "`" && code.startsWith("${", i)) {
          interpolated = true; i += 2; out.push({ kind: "symbol", value: "(" }); scan(true); out.push({ kind: "symbol", value: ")" }); continue;
        }
        text += code[i++];
      }
      i++; out.push({ kind: interpolated ? "template" : "string", value: text }); continue;
    }
    if (ch === "/" && (!out.length || /^(?:[({\[=,:;!?~]|return|case|throw|yield|=>|&&|\|\||\?\?)$/.test(out.at(-1).value))) {
      i++; let bracket = false;
      while (i < code.length) { if (code[i] === "\\") { i += 2; continue; } if (code[i] === "[") bracket = true; if (code[i] === "]") bracket = false; if (code[i++] === "/" && !bracket) break; }
      while (/[a-z]/i.test(code[i] ?? "")) i++;
      out.push({ kind: "regex", value: "/" }); continue;
    }
    if (/[A-Za-z_$]/.test(ch)) { const start = i++; while (/[A-Za-z0-9_$]/.test(code[i] ?? "")) i++; out.push({ kind: "word", value: code.slice(start, i) }); continue; }
    if (["=>", "&&", "||", "??"].includes(code.slice(i, i + 2))) { out.push({ kind: "symbol", value: code.slice(i, i + 2) }); i += 2; continue; }
    if (ch === "{") depth++; else if (ch === "}") depth--;
    out.push({ kind: "symbol", value: ch }); i++;
    }
  }
  scan();
  return out;
}

export function extractRuntimeImports(code) {
  const list = tokens(code), found = new Set();
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.kind !== "word") continue;
    if ((token.value === "from" || token.value === "import") && list[i + 1]?.kind === "string") found.add(list[i + 1].value);
    if (/^(?:import|require\d*|__require\d*|importSync\d*)$/.test(token.value) && list[i + 1]?.value === "(" && list[i + 2]?.kind === "string") found.add(list[i + 2].value);
    if (/^createRequire\d*$/.test(token.value)) {
      let end = i + 1, depth = 0;
      for (; end < list.length; end++) { if (list[end].value === "(") depth++; if (list[end].value === ")" && --depth === 0) break; }
      if (list[end + 1]?.value === "(" && list[end + 2]?.kind === "string") found.add(list[end + 2].value);
    }
  }
  return [...found].sort();
}

export function extractRuntimeSpecifiers(code) {
  const names = new Set();
  for (const specifier of extractRuntimeImports(code)) {
    if (specifier.startsWith("node:") || specifier.startsWith("bun:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0])) continue;
    if (!PACKAGE.test(specifier) || specifier.startsWith(".")) continue;
    names.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
  }
  return [...names].sort();
}

export function extractRuntimeAssets(code) {
  return [...new Set(tokens(code).filter(token => token.kind === "string" && token.value.startsWith("./")
    && /(?:\.(?:wasm|scm)|\/audio-[\w-]+\.ts|\/repo-map-worker\.js)$/.test(token.value)).map(token => token.value))].sort();
}

function safePath(path) {
  return typeof path === "string" && path.length <= 220 && !/[\\:\x00-\x1f\x7f]/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith("."))
    && !/(?:^|\/)(?:fixtures?|tests?|__tests__|output|cache|meta)(?:[-./]|$)/i.test(path);
}

export function frontendPackageFiles(info) {
  const portable = info?.platform === "portable";
  if (portable) portableDependencies(info);
  if (!record(info) || info.entry !== "main.js" || info.accessibleEntry !== "linear-entry.js" || info.accessibleRuntime !== "node"
    || (!portable && (!/^(?:win32|linux|darwin)-(?:x64|arm64)$/.test(info.platform ?? "") || info.runtime !== `runtime/${info.platform.startsWith("win32-") ? "bun.exe" : "bun"}`))
    || info.notices !== "THIRD-PARTY-NOTICES.md" || (!portable && !/^@opentui\/core-(?:win32|linux|darwin)-(?:x64|arm64)@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.nativePackage ?? ""))
    || !/^web-tree-sitter@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.parserPackage ?? "") || !/^tree-sitter-[A-Za-z0-9_]+\.wasm$/.test(info.parserRuntime ?? "")
    || !Array.isArray(info.files) || !info.files.length) throw new Error("beta_frontend_manifest_invalid");
  const nativeName = info.nativePackage.slice(0, info.nativePackage.lastIndexOf("@"));
  if (!portable && nativeName !== `@opentui/core-${info.platform}`) throw new Error("beta_frontend_native_platform_invalid");
  const paths = new Set();
  for (const file of info.files) {
    if (!record(file) || !safePath(file.path) || file.path === "BUILD_INFO.json" || paths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[0-9a-f]{64}$/.test(file.sha256 ?? "")) throw new Error("beta_frontend_file_invalid");
    const product = /^(?:[^/]+\.(?:js|jsc|wasm|scm)|audio-[\w-]+\.ts|THIRD-PARTY-NOTICES\.md)$/.test(file.path);
    const runtime = (!portable && file.path === info.runtime) || file.path === "runtime/LICENSE-Bun.md";
    const native = !portable && file.path.startsWith(`node_modules/${nativeName}/`) && /(?:\.(?:dll|dylib|so|node|js|json|md|d\.ts)|\/LICENSE)$/.test(file.path);
    if (!product && !runtime && !native) throw new Error(`beta_frontend_file_forbidden:${file.path}`);
    paths.add(file.path);
  }
  // Versions through beta.17 did not run repository analysis in a worker. Keep
  // their exact artifacts verifiable for rollback, while every new release must
  // ship the worker even if a malformed build removed its runtime reference.
  const legacyWithoutRepoMapWorker = /^0\.1\.0-beta\.(?:[0-9]|1[0-7])$/.test(info.version ?? "");
  for (const required of [info.entry, info.accessibleEntry, "opentui-tree-sitter-worker.js", info.parserRuntime, "runtime/LICENSE-Bun.md", info.notices,
    ...(!legacyWithoutRepoMapWorker ? ["repo-map-worker.js"] : []),
    ...(!portable ? [info.runtime, `node_modules/${nativeName}/package.json`, `node_modules/${nativeName}/LICENSE`] : [])]) if (!paths.has(required)) throw new Error(`beta_frontend_required_missing:${required}`);
  if (!portable && ![...paths].some(path => path.startsWith(`node_modules/${nativeName}/`) && /\.(?:dll|dylib|so|node)$/.test(path))) throw new Error("beta_frontend_native_library_missing");
  return ["dist/tui/BUILD_INFO.json", ...[...paths].map(path => `dist/tui/${path}`)].sort();
}

export function verifyFrontendEntries(entries, info, version) {
  frontendPackageFiles(info);
  if (info.version !== version) throw new Error("beta_frontend_version_mismatch");
  const listed = new Set(info.files.map(file => file.path));
  const nativeName = info.nativePackage.slice(0, info.nativePackage.lastIndexOf("@"));
  for (const file of info.files) {
    const bytes = entries.get(`package/dist/tui/${file.path}`);
    if (!bytes || bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`beta_frontend_file_mismatch:${file.path}`);
    if (!file.path.endsWith(".js")) continue;
    const source = bytes.toString("utf8");
    for (const imported of [...extractRuntimeImports(source), ...extractRuntimeAssets(source)]) if (imported.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file.path), imported));
      if (!safePath(target) || !listed.has(target)) throw new Error(`beta_frontend_import_missing:${file.path}:${imported}`);
    }
  }
  if (info.platform !== "portable") {
    const native = JSON.parse(entries.get(`package/dist/tui/node_modules/${nativeName}/package.json`).toString("utf8"));
    if (native.name !== nativeName || `${native.name}@${native.version}` !== info.nativePackage) throw new Error("beta_frontend_native_manifest_invalid");
  }
  const notices = entries.get("package/dist/tui/THIRD-PARTY-NOTICES.md").toString("utf8");
  if (!notices.startsWith("# Third-party notices\n") || notices.includes("\r") || !notices.endsWith("\n")
    || ["@opencode-ai/tui", "@opentui/core", "@opentui/solid", "solid-js", "Bun runtime", "MIT"].some(name => !notices.includes(name))) throw new Error("beta_frontend_notices_invalid");
  const components = new Set([...notices.matchAll(/^### (.+)@[^@\s]+$/gm)].map(match => match[1]));
  const missing = new Set();
  for (const file of info.files.filter(file => file.path.endsWith(".js"))) {
    for (const match of entries.get(`package/dist/tui/${file.path}`).toString("utf8").matchAll(/^\/\/ (?:\S*\/)?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\/\S+$/gm)) {
      if (!components.has(match[1])) missing.add(match[1]);
    }
  }
  if (missing.size) throw new Error(`beta_frontend_notices_incomplete:${[...missing].sort().join(",")}`);
}

export function verifyRuntimeDependencies(entries, manifest) {
  const dependencies = manifest.dependencies ?? {};
  const missing = new Set();
  for (const [path, bytes] of entries) {
    if (!/^package\/dist\/.*\.js$/.test(path)) continue;
    for (const name of extractRuntimeSpecifiers(bytes.toString("utf8"))) {
      if (name.startsWith("@opentui/core-")) continue; // The verified platform library is physically shipped.
      if (!Object.hasOwn(dependencies, name) || typeof dependencies[name] !== "string" || /^(?:file:|link:|workspace:)/.test(dependencies[name])) missing.add(name);
    }
  }
  if (missing.size) throw new Error(`beta_artifact_runtime_dependencies_missing:${[...missing].sort().join(",")}`);
}
