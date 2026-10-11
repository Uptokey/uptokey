import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBrowserReadRequest } from "../../../proxy/contratos/browser.js";

/** Resolve only the reviewed repository layouts, never cwd or an inherited environment. */
export function developmentProductRoot(moduleUrl) {
  const directory = dirname(fileURLToPath(moduleUrl));
  const normalized = directory.replaceAll('\\', '/');
  const suffixes = [
    ['/quimera/uptokey/scripts', '..'],
    ['/quimera/uptokey/proxy-local/src', '../..'],
    ['/quimera/uptokey/proxy-local/dist', '../..'],
    ['/proxy/core/src', '../../../quimera/uptokey'],
    ['/proxy/core/dist', '../../../quimera/uptokey'],
  ];
  const match = suffixes.find(([suffix]) => normalized.endsWith(suffix));
  if (!match) throw new Error('uptokey_development_runtime_required');
  return resolve(directory, match[1]);
}

// This script is also bundled into the published CLI. Importing that CLI must not
// require a source checkout; optional repository services resolve lazily below.
export const QUIMERA_ROOT = (() => {
  try { return developmentProductRoot(import.meta.url); }
  catch { return undefined; }
})();
function requiredProductRoot() {
  if (!QUIMERA_ROOT) throw new Error('uptokey_development_runtime_required');
  return QUIMERA_ROOT;
}
const CODE_LOCATIONS = Object.freeze({
  CORE: ['quimera/uptokey/proxy-local', 'proxy/core'],
  INTEGRATIONS: ['quimera/integrations', 'proxy/integracoes'],
});

/** Development code locations only. Data/profile roots never come from this manifest. */
export function declaredCodeRoots(workspaceRoot, manifest) {
  if (manifest?.schema !== 'uptokey-proxy-paths-v1') throw new Error('uptokey_code_layout_invalid');
  const roots = {};
  for (const [alias, allowed] of Object.entries(CODE_LOCATIONS)) {
    const selected = manifest.aliases?.[alias]?.current;
    if (!allowed.includes(selected)) throw new Error('uptokey_code_layout_invalid');
    roots[alias] = confinedPath(resolve(workspaceRoot, selected), workspaceRoot);
  }
  return Object.freeze(roots);
}

export function productCodeRoots(root = requiredProductRoot()) {
  // Existing explicit test/development fixtures retain their isolated geometry.
  if (resolve(root) !== QUIMERA_ROOT) return Object.freeze({
    CORE: confinedPath(resolve(root, 'proxy-local'), root),
    INTEGRATIONS: confinedPath(resolve(root, '../integrations'), dirname(resolve(root))),
  });
  const workspaceRoot = resolve(root, '../..');
  const file = confinedPath(resolve(workspaceRoot, 'proxy/CAMINHOS.json'), workspaceRoot);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 64_000) throw new Error('uptokey_code_layout_invalid');
  return declaredCodeRoots(workspaceRoot, JSON.parse(readFileSync(file, 'utf8')));
}
export const PLAYWRIGHT_MCP_REVISION = "e73d72e01f162054a3d0a6b0fe8d4affffb095ee";
const PLAYWRIGHT_VERSION = "1.64.0-alpha-2026-09-14";
const COMPOSITION_VERSIONS = Object.freeze({
  "@langchain/langgraph": "1.4.15", "@langchain/langgraph-checkpoint-sqlite": "1.0.4",
  "@langchain/langgraph-checkpoint": "1.1.5", "@langchain/langgraph-sdk": "1.11.0",
  "@langchain/protocol": "0.0.19", "@langchain/core": "1.2.11", langsmith: "0.10.3", "better-sqlite3": "12.11.1",
});

/** Composition requires both explicit flags; no environment or persisted configuration enables it. */
export function parseCompositionCliArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("quimera_composition_option_rejected");
  const selected = args.filter(arg => /^--composition/i.test(arg));
  if (!selected.length) return undefined;
  const offset = args[0] === "proxy" && args[1] === "start" ? 2 : args[0] === "start" ? 1 : 0;
  if (!offset || args.slice(offset).some(arg => !arg.startsWith("--")) || selected.length !== 1 || selected[0] !== "--composition=langgraph") {
    throw new Error("quimera_composition_option_rejected");
  }
  try {
    if (!parseBrowserArguments(args.filter(arg => /^--browser/i.test(arg)))) throw new Error();
  } catch { throw new Error("quimera_composition_browser_required"); }
  return "langgraph";
}

/** Installed metadata and native-addon existence only; never import an SDK or open SQLite. */
export function inspectCompositionRuntime(root = requiredProductRoot()) {
  try {
    const coreRoot = productCodeRoots(root).CORE;
    assertNoEnvFiles(root, [".", "proxy-local"]);
    if (process.platform !== "win32" || process.arch !== "x64" || process.versions.modules !== "137") throw new Error();
    const file = target => {
      const checked = confinedPath(target, coreRoot), stat = lstatSync(checked);
      if (!stat.isFile() || stat.size === 0) throw new Error();
      return checked;
    };
    const dependencies = confinedPath(join(coreRoot, "node_modules"), coreRoot);
    for (const [name, version] of Object.entries(COMPOSITION_VERSIONS)) {
      const metadata = file(join(dependencies, name, "package.json"));
      if (lstatSync(metadata).size > 2_000_000) throw new Error();
      const pkg = JSON.parse(readFileSync(metadata, "utf8"));
      if (pkg.name !== name || pkg.version !== version) throw new Error();
    }
    const graphEntry = file(join(dependencies, "@langchain", "langgraph", "dist", "index.js"));
    const saverEntry = file(join(dependencies, "@langchain", "langgraph-checkpoint-sqlite", "dist", "index.js"));
    const traceableEntry = file(join(dependencies, "langsmith", "traceable.js"));
    const nativeAddon = file(join(dependencies, "better-sqlite3", "build", "Release", "better_sqlite3.node"));
    const workerEntry = file(join(coreRoot, "dist", "composition-worker.js"));
    const stateRoot = confinedPath(join(root, "output", "quimera-runtime", "composition"), root);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) confinedPath(join(stateRoot, "composition.sqlite" + suffix), root);
    return Object.freeze({ stateRoot, graphEntry, saverEntry, traceableEntry, nativeAddon, workerEntry, versions: COMPOSITION_VERSIONS });
  } catch { throw new Error("quimera_composition_runtime_required"); }
}

/** Exact local Langfuse ingest URL; never credentials, aliases, redirects or environment defaults. */
export function parseLangfuseEndpoint(value) {
  try {
    if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/public\/otel\/v1\/traces$/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.href !== value || !url.port) throw new Error();
    return value;
  } catch { throw new Error("quimera_telemetry_endpoint_rejected"); }
}

/** Public argv only. Setup keys are accepted exclusively by the existing hidden terminal prompt. */
export function parseTelemetryCliArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("quimera_telemetry_option_rejected");
  if (args[0] === "telemetry") {
    if (args.length !== 4 || args[1] !== "configure" || args[2] !== "langfuse") throw new Error("quimera_telemetry_option_rejected");
    return Object.freeze({ kind: "configure", endpoint: parseLangfuseEndpoint(args[3]) });
  }
  const selected = args.filter(arg => /^--telemetry/i.test(arg));
  if (!selected.length) return undefined;
  const offset = args[0] === "proxy" && args[1] === "start" ? 2 : args[0] === "start" ? 1 : 0;
  if(offset&&selected.includes('--telemetry=collector-local')){
    const endpoints=selected.filter(arg=>arg.startsWith('--telemetry-endpoint='));
    if(selected.length!==2||endpoints.length!==1||args.slice(offset).some(arg=>!arg.startsWith('--')))throw new Error('quimera_telemetry_option_rejected');
    return Object.freeze({kind:'start',driver:'collector-local',endpoint:parseCollectorEndpoint(endpoints[0].slice('--telemetry-endpoint='.length))});
  }
  if (!offset || args.slice(offset).some(arg => !arg.startsWith("--")) || selected.length !== 1 || selected[0] !== "--telemetry=langfuse") {
    throw new Error("quimera_telemetry_option_rejected");
  }
  return Object.freeze({ kind: "start", driver: "langfuse" });
}

export function parseCollectorEndpoint(value){
  try{if(typeof value!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/traces$/.test(value))throw new Error();
    if(new URL(value).href!==value)throw new Error();return value;
  }catch{throw new Error('quimera_telemetry_endpoint_rejected');}
}

/** Shared by CLI and launcher. Public metadata only; parsing starts no worker. */
export function parseBrowserArguments(args) {
  if (!Array.isArray(args)) throw new Error("quimera_browser_option_rejected");
  if (!args.length) return undefined;
  const values = {};
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("quimera_browser_option_rejected");
    const match = arg.match(/^--(browser|browser-origin|browser-executable)=(.+)$/);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("quimera_browser_option_rejected");
    values[match[1]] = match[2];
  }
  const origin = values["browser-origin"], executablePath = values["browser-executable"];
  if (values.browser !== "playwright-mcp" || typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) {
    throw new Error("quimera_browser_option_rejected");
  }
  try { parseBrowserReadRequest({ schemaVersion: 1, url: `${origin}/` }); } catch { throw new Error("quimera_browser_option_rejected"); }
  if (executablePath !== undefined && (executablePath.length > 4096 || /[\x00-\x1f]/.test(executablePath) || !isAbsolute(executablePath))) {
    throw new Error("quimera_browser_option_rejected");
  }
  return Object.freeze({ driver: "playwright-mcp", allowedOrigin: origin, ...(executablePath ? { executablePath } : {}) });
}

export function browserArguments(options) {
  if (!options || Object.keys(options).some(key => !["driver", "allowedOrigin", "executablePath"].includes(key))) throw new Error("quimera_browser_option_rejected");
  const args = [`--browser=${options.driver}`, `--browser-origin=${options.allowedOrigin}`,
    ...(options.executablePath === undefined ? [] : [`--browser-executable=${options.executablePath}`])];
  parseBrowserArguments(args);
  return args;
}

function browserExecutable(explicit) {
  const candidates = explicit ? [explicit] : process.platform === "win32" ? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ] : [];
  for (const candidate of candidates) {
    try {
      if (!["chrome.exe", "msedge.exe", "chrome", "google-chrome", "google-chrome-stable", "microsoft-edge", "msedge"].includes(basename(candidate).toLowerCase())) continue;
      const executable = confinedPath(candidate, dirname(candidate));
      const info = lstatSync(executable);
      if (info.isFile() && info.size > 0) return executable;
    } catch { /* Try only the next fixed application location, never PATH or user profiles. */ }
  }
  throw new Error("quimera_browser_executable_required");
}

/** Inspect installed files only: no imports of third-party code, downloads, writes or vault access. */
export function inspectBrowserRuntime(options, root = requiredProductRoot()) {
  const selected = parseBrowserArguments(browserArguments(options));
  const executablePath = browserExecutable(selected.executablePath);
  try {
    const integrations = productCodeRoots(root).INTEGRATIONS;
    const appRoot = confinedPath(resolve(integrations, "playwright-mcp", "app"), integrations);
    assertNoEnvFiles(root, [".", "proxy-local"]);
    assertNoEnvFiles(appRoot, ["."]);
    const file = path => {
      const checked = confinedPath(path, dirname(appRoot));
      if (!lstatSync(checked).isFile()) throw new Error();
      return checked;
    };
    const json = path => {
      const checked = file(path);
      if (lstatSync(checked).size > 2_000_000) throw new Error();
      return JSON.parse(readFileSync(checked, "utf8"));
    };
    const manifest = json(join(appRoot, "..", "source-manifest.json"));
    if (manifest.commit !== PLAYWRIGHT_MCP_REVISION || manifest.origin !== "https://github.com/microsoft/playwright-mcp.git") throw new Error();
    const entry = file(join(appRoot, "cli.js"));
    const entryHash = manifest.files?.find(item => item.path === "cli.js")?.sha256;
    if (!/^[a-f0-9]{64}$/.test(entryHash ?? "") || lstatSync(entry).size > 1_000_000 ||
      createHash("sha256").update(readFileSync(entry)).digest("hex") !== entryHash) throw new Error();
    const pkg = json(join(appRoot, "package.json"));
    const core = json(join(appRoot, "node_modules", "playwright-core", "package.json"));
    if (pkg.name !== "@playwright/mcp" || pkg.version !== "0.0.81" || pkg.dependencies?.["playwright-core"] !== PLAYWRIGHT_VERSION ||
      core.name !== "playwright-core" || core.version !== PLAYWRIGHT_VERSION) throw new Error();
    const coreEntry = file(join(appRoot, "node_modules", "playwright-core", "lib", "coreBundle.js"));
    const initPage = file(join(appRoot, "..", "init-page.cjs"));
    const stateRoot = confinedPath(resolve(root, "output", "quimera-runtime", "browser"), root);
    return Object.freeze({ allowedOrigin: selected.allowedOrigin, appRoot, stateRoot,
      browsersPath: confinedPath(join(stateRoot, "browsers"), root), executablePath, entry, coreEntry, initPage });
  } catch { throw new Error("quimera_browser_runtime_required"); }
}

/** Reject both lexical escapes and existing junctions/symlinks, including ancestors. */
export function confinedPath(path, root = requiredProductRoot()) {
  const base = resolve(root);
  const target = resolve(path);
  const suffix = relative(base, target);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("quimera_path_outside_copy");
  for (let current = target; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("quimera_linked_path_rejected");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
  return target;
}

/** Inspect names only: no dotenv values or inherited profiles are read.
 * A dotenv file is rejected even when Git ignores it: ignore rules protect
 * commits, but they do not make a local runtime safe to launch from.
 */
export function assertNoEnvFiles(root = requiredProductRoot(), directories = [".", "proxy-local", "uptokey-pwa", "control-plane"]) {
  for (const directory of directories) {
    const path = directory === 'proxy-local' ? productCodeRoots(root).CORE : confinedPath(resolve(root, directory), root);
    try {
      if (readdirSync(path).some((name) =>
        name === ".env" || name.startsWith(".env."))) {
        throw new Error("quimera_dotenv_rejected");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function isolatedChildEnv(inherited = process.env, root = requiredProductRoot()) {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP"]) {
    if (inherited[name]) env[name] = inherited[name];
  }
  const home = confinedPath(resolve(root, "output", "quimera-runtime", "home"), root);
  Object.assign(env, {
    NODE_ENV: "development", HOME: home, USERPROFILE: home,
    APPDATA: resolve(home, "AppData", "Roaming"), LOCALAPPDATA: resolve(home, "AppData", "Local"),
    XDG_CONFIG_HOME: resolve(home, ".config"), XDG_DATA_HOME: resolve(home, ".local", "share"),
    UPTOKEY_QUIMERA_DATA_DIR: confinedPath(resolve(root, "output", "quimera-runtime", "proxy"), root),
    UPTOKEY_QUIMERA_CONTROL_DATA_DIR: confinedPath(resolve(root, "output", "quimera-runtime", "control-plane"), root),
  });
  return env;
}
