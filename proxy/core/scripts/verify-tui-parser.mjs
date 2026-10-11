#!/usr/bin/env node
/** Real parser acceptance: the shipped Bun runs the shipped Worker and shipped default queries/grammars. */
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { frontendPackageFiles, extractRuntimeAssets } from "./beta-runtime-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultDir = resolve(dirname(scriptPath), "../dist/tui");
const SAMPLES = {
  javascript: 'const answer = 42;\nfunction greet(name) { return "hello " + name; }\n',
  typescript: 'interface Person { name: string }\nconst person: Person = { name: "Ada" };\n',
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve the bundle's actual default asset loaders, rather than supply substitute highlight queries. */
export function parserProbePlan(info, sourceFor, artifact) {
  frontendPackageFiles(info);
  if (!/^web-tree-sitter@\d+\.\d+\.\d+$/.test(info.parserPackage ?? "") || !/^tree-sitter-[\w-]+\.wasm$/.test(info.parserRuntime ?? "")) throw new Error("tui_parser_manifest_invalid");
  const listed = new Set(info.files.map(file => file.path));
  if (!listed.has(info.parserRuntime)) throw new Error("tui_parser_runtime_missing");
  const main = sourceFor(info.entry);
  function bundledAsset(key, extension) {
    const pattern = new RegExp(`["']${escapeRegex(key)}["']\\s*:\\s*\\(\\s*\\)\\s*=>\\s*import\\(\\s*["'](\\./[^"']+\\.js)["']`, "g");
    const mappings = [...main.matchAll(pattern)];
    if (mappings.length !== 1) throw new Error(`tui_parser_asset_loader_invalid:${key}`);
    const chunk = posix.normalize(posix.join(posix.dirname(info.entry), mappings[0][1]));
    if (!listed.has(chunk)) throw new Error(`tui_parser_asset_chunk_missing:${key}`);
    const assets = extractRuntimeAssets(sourceFor(chunk)).filter(path => path.endsWith(extension));
    if (assets.length !== 1) throw new Error(`tui_parser_asset_chunk_invalid:${key}`);
    const target = posix.normalize(posix.join(posix.dirname(chunk), assets[0]));
    if (!listed.has(target)) throw new Error(`tui_parser_asset_missing:${key}`);
    return target;
  }
  const languages = ["javascript", "typescript"].map(filetype => {
    const grammar = bundledAsset(`assets/${filetype}/tree-sitter-${filetype}.wasm`, ".wasm");
    const query = bundledAsset(`assets/${filetype}/highlights.scm`, ".scm");
    if (!new RegExp(`^tree-sitter-${filetype}-[\\w-]+\\.wasm$`).test(grammar) || !/^highlights-[\w-]+\.scm$/.test(query)) throw new Error(`tui_parser_language_asset_invalid:${filetype}`);
    return { filetype, grammar, query, content: SAMPLES[filetype] };
  });
  return { artifact: resolve(artifact), runtime: join(artifact, info.runtime), worker: join(artifact, "opentui-tree-sitter-worker.js"),
    parserRuntime: join(artifact, info.parserRuntime), parserPackage: info.parserPackage, languages };
}

/** A parser must return visible token captures from the supplied code, not only an empty success response. */
export function verifyVisibleHighlights(response, content, filetype) {
  if (response?.type !== "ONESHOT_HIGHLIGHT_RESPONSE" || response.hasParser !== true || response.error || response.warning || !Array.isArray(response.highlights) || !response.highlights.length) throw new Error(`tui_parser_highlight_failed:${filetype}`);
  const visible = response.highlights.map(highlight => {
    if (!Array.isArray(highlight) || !Number.isSafeInteger(highlight[0]) || !Number.isSafeInteger(highlight[1])
      || highlight[0] < 0 || highlight[1] <= highlight[0] || highlight[1] > content.length || typeof highlight[2] !== "string" || !highlight[2]) throw new Error(`tui_parser_highlight_invalid:${filetype}`);
    return { start: highlight[0], end: highlight[1], group: highlight[2], text: content.slice(highlight[0], highlight[1]) };
  });
  const keyword = filetype === "typescript" ? "interface" : "const";
  const string = filetype === "typescript" ? '"Ada"' : '"hello "';
  if (!visible.some(token => token.text === keyword && token.group.startsWith("keyword"))
    || !visible.some(token => token.text.includes(string) && token.group.startsWith("string"))) throw new Error(`tui_parser_visible_tokens_missing:${filetype}`);
  return { highlightCount: visible.length, groups: [...new Set(visible.map(token => token.group))].sort(),
    visibleTokens: visible.filter(token => /^(?:keyword|string|number|type|function)/.test(token.group)).slice(0, 12) };
}

function readVerifiedPlan(artifact) {
  const info = JSON.parse(readFileSync(join(artifact, "BUILD_INFO.json"), "utf8"));
  frontendPackageFiles(info);
  const files = new Map(info.files.map(file => [file.path, file]));
  const cache = new Map();
  function bytesFor(path) {
    if (cache.has(path)) return cache.get(path);
    const file = files.get(path), absolute = join(artifact, path);
    if (!file || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`tui_parser_file_missing:${path}`);
    const bytes = readFileSync(absolute);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`tui_parser_file_mismatch:${path}`);
    cache.set(path, bytes);
    return bytes;
  }
  const plan = parserProbePlan(info, path => bytesFor(path).toString("utf8"), artifact);
  for (const path of [info.runtime, "opentui-tree-sitter-worker.js", info.parserRuntime, ...plan.languages.flatMap(language => [language.grammar, language.query])]) bytesFor(path);
  return { plan, info };
}

async function probeWorker(plan, info) {
  if (typeof Bun === "undefined" || typeof Worker === "undefined") throw new Error("tui_parser_shipped_bun_required");
  // A signed Bun copied under this workspace can be blocked from %TEMP% by the host policy.
  // Keep its disposable parser cache beside the candidate, outside the artifact's own file list.
  const tempRoot = dirname(plan.artifact);
  const work = mkdtempSync(join(tempRoot, "uptokey-parser-probe-"));
  const worker = new Worker(pathToFileURL(plan.worker).href, { type: "module" });
  const pending = new Map();
  let failure;
  worker.onmessage = event => {
    const message = event.data;
    if (message?.type === "ERROR") {
      failure = new Error("tui_parser_worker_error");
      for (const waiter of pending.values()) waiter.reject(failure);
      pending.clear();
      return;
    }
    const key = message?.type === "INIT_RESPONSE" ? "INIT_RESPONSE" : message?.messageId;
    const waiter = pending.get(key);
    if (waiter) { pending.delete(key); waiter.resolve(message); }
  };
  worker.onerror = () => {
    failure = new Error("tui_parser_worker_start_failed");
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  function request(message, key) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`tui_parser_worker_timeout:${key}`)); }, 10_000);
      pending.set(key, { resolve: value => { clearTimeout(timeout); resolveResponse(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      worker.postMessage(message);
    });
  }
  try {
    const initialization = await request({ type: "INIT", dataPath: join(work, "data"), treeSitterWasmPath: plan.parserRuntime }, "INIT_RESPONSE");
    if (initialization.error) throw new Error("tui_parser_init_failed");
    const languages = [];
    for (const language of plan.languages) {
      worker.postMessage({ type: "ADD_FILETYPE_PARSER", filetypeParser: { filetype: language.filetype,
        wasm: join(plan.artifact, language.grammar), queries: { highlights: [join(plan.artifact, language.query)] } } });
      const messageId = `verify_${language.filetype}`;
      const response = await request({ type: "ONESHOT_HIGHLIGHT", content: language.content, filetype: language.filetype, messageId }, messageId);
      languages.push({ filetype: language.filetype, grammar: language.grammar, query: language.query,
        ...verifyVisibleHighlights(response, language.content, language.filetype) });
    }
    return { schema: "uptokey-tui-parser-verification-v1", directory: plan.artifact, bun: Bun.version,
      parserPackage: plan.parserPackage, parserRuntime: info.parserRuntime, initialized: true, languages };
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error("tui_parser_probe_closed"));
    await worker.terminate();
    // work is the exact mkdtemp directory, bounded to the resolved temporary root.
    if (dirname(work) !== tempRoot) throw new Error("tui_parser_temporary_directory_invalid");
    rmSync(work, { recursive: true, force: true });
  }
}

export async function verifyTuiParser(artifact, workerProbe = false) {
  const { plan, info } = readVerifiedPlan(resolve(artifact));
  if (workerProbe) return probeWorker(plan, info);
  const child = spawnSync(plan.runtime, [scriptPath, "--worker-probe", "--dir", plan.artifact], { encoding: "utf8", windowsHide: true, timeout: 45_000 });
  if (child.status !== 0) throw new Error(`tui_parser_probe_failed:${(child.stderr || "").trim().split("\n").find(line => /^tui_parser_[a-z0-9_:-]+$/.test(line)) ?? "runtime"}`);
  const receipt = JSON.parse(child.stdout.trim());
  if (receipt.initialized !== true || receipt.languages?.length !== 2) throw new Error("tui_parser_receipt_invalid");
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const args = process.argv.slice(2), workerProbe = args[0] === "--worker-probe";
    if (workerProbe) args.shift();
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--dir" || !args[1] || args[1].startsWith("--"))) throw new Error("tui_parser_arguments_invalid");
    process.stdout.write(JSON.stringify(await verifyTuiParser(args.length ? resolve(args[1]) : defaultDir, workerProbe)) + "\n");
  } catch (error) {
    const publicCode = error instanceof Error && /^[a-z0-9_:@/.-]+$/i.test(error.message) ? error.message : "tui_parser_verification_failed";
    process.stderr.write(`${publicCode}\n`);
    process.exitCode = 1;
  }
}
