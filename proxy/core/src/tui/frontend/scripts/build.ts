/**
 * Builds the terminal frontend for distribution.
 *   bun run scripts/build.ts [--outdir <dir>] [--entry <file>] [--compile]
 *
 * Default (bundle): `main.js` + chunks + the OpenTUI parser worker, next to a copy of the Bun runtime
 * (`runtime/bun[.exe]`). The runtime is the vendor-signed Bun binary, so Windows application-control policies that
 * block freshly compiled unsigned executables still allow it to run; the bundle is data for that runtime.
 * `--compile` produces a single executable instead (for hosts whose policy allows it, or once it is signed).
 * The Node core never loads this runtime; the CLI starts it as a child process.
 */
import { copyFile, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)

const flag = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const outdir = path.resolve(flag("--outdir") ?? path.join(root, "../../../dist/tui"))
const entry = flag("--entry") ?? "./uptokey/main.tsx"
const compile = process.argv.includes("--compile")
const metafilePath = flag("--metafile") ? path.resolve(flag("--metafile")!) : undefined
const version = (await Bun.file(path.join(root, "../../../package.json")).json()).version as string
const distributionDefine = {
  UPTOKEY_REPO_MAP_WORKER_PATH: JSON.stringify("./repo-map-worker.js"),
  UPTOKEY_DISTRIBUTION_CHANNEL: JSON.stringify(process.argv.includes("--portable") ? "npm" : "native"),
  UPTOKEY_BUILD_VERSION: JSON.stringify(version),
}
// Packages with native code, data files or module-relative runtime behavior stay external; they resolve from installed node_modules,
// exactly as they do for the Node core (see scripts/build-npm-package.mjs).
const RUNTIME_PACKAGES = ["@napi-rs/keyring", "tree-sitter-wasm", "web-tree-sitter", "js-tiktoken", "js-tiktoken/*", "undici"]
// OpenTUI's worker embeds web-tree-sitter 0.25; its matching WASM must travel with that worker.
// The canonical core independently uses the published JavaScript API, so keep that module external.
const parserWasm = path.join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm")
const parserRuntimePlugin: import("bun").BunPlugin = {
  name: "uptokey-parser-runtime",
  setup(build) {
    build.onResolve({ filter: /^web-tree-sitter(?:\/|$)/ }, args => args.path === "web-tree-sitter/tree-sitter.wasm"
      ? { path: parserWasm }
      : { path: args.path, external: true })
    build.onLoad({ filter: /[/\\]web-tree-sitter[/\\]tree-sitter\.wasm$/ }, async () => ({ contents: new Uint8Array(await Bun.file(parserWasm).arrayBuffer()), loader: "file" }))
  },
}
async function writeMetafile(metafile: { inputs: Record<string, unknown>; outputs: unknown } | undefined) {
  if (!metafilePath || !metafile) return
  const coreRoot = path.resolve(root, "../../..")
  const inputs = Object.fromEntries(Object.entries(metafile.inputs).map(([input, value]) => [path.relative(coreRoot, path.resolve(root, input)).replaceAll("\\", "/"), value]))
  await Bun.write(metafilePath, JSON.stringify({ inputs, outputs: metafile.outputs }))
}

// Accessible mode uses the host Node readline implementation. It loads the same backend and controller,
// without loading the native renderer, Bun runtime or terminal worker into that process.
if (process.argv.includes("--linear")) {
  if (compile) throw new Error("linear_bundle_requires_node_host")
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    define: distributionDefine,
    conditions: ["node"],
    tsconfig: "./tsconfig.json",
    external: ["node-gyp", ...RUNTIME_PACKAGES],
    target: "node",
    format: "esm",
    splitting: false,
    outdir,
    minify: process.argv.includes("--minify"),
    metafile: metafilePath !== undefined,
    naming: { entry: "[name].js" },
    entrypoints: [flag("--entry") ? entry : "./uptokey/linear-entry.ts", "../repo-map-worker.ts"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  await writeMetafile(result.metafile)
  console.log(`accessible bundle: ${result.outputs.length} files in ${outdir}`)
  process.exit(0)
}

const workerName = "opentui-tree-sitter-worker.js"
const worker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

await mkdir(outdir, { recursive: true })
const define = { UPTOKEY_TUI_VERSION: JSON.stringify(version), ...distributionDefine }

if (compile) {
  const exe = process.platform === "win32" ? "uptokey-tui.exe" : "uptokey-tui"
  const bunfsRoot = process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin()],
    external: ["node-gyp"],
    format: "esm",
    splitting: true,
    compile: { autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: true, autoloadPackageJson: true, outfile: path.join(outdir, exe) },
    files: { [workerName]: worker },
    entrypoints: [entry, workerName, "../repo-map-worker.ts"],
    define: { ...define, OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + workerName), UPTOKEY_REPO_MAP_WORKER_PATH: JSON.stringify(bunfsRoot + "repo-map-worker.ts") },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`built ${path.join(outdir, exe)}`)
} else {
  const result = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin(), parserRuntimePlugin],
    // Native libraries stay outside the bundle: only the package for this platform is shipped next to it.
    external: ["node-gyp", "@opentui/core-*", ...RUNTIME_PACKAGES.filter(name => name !== "web-tree-sitter")],
    target: "bun",
    format: "esm",
    splitting: true,
    outdir,
    minify: process.argv.includes("--minify"),
    // Precompiled bytecode next to each chunk: the shipped runtime is the same Bun that built it, so startup skips
    // parsing. A runtime of another version ignores the cache and parses the source as usual.
    bytecode: process.argv.includes("--bytecode"),
    metafile: metafilePath !== undefined,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
    entrypoints: [entry, "../repo-map-worker.ts"],
    define,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  await Bun.write(path.join(outdir, workerName), worker)
  await writeMetafile(result.metafile)
  if (process.argv.includes("--portable")) {
    const runtimeDir = path.join(outdir, "runtime")
    await mkdir(runtimeDir, { recursive: true })
    await copyFile(path.join(root, "vendor", "bun-runtime", "LICENSE-Bun.md"), path.join(runtimeDir, "LICENSE-Bun.md"))
    console.log(`portable bundle: ${result.outputs.length} files in ${outdir}`)
    process.exit(0)
  }
  const nativePackage = `@opentui/core-${process.platform}-${process.arch}`
  await cp(path.join(root, "node_modules", nativePackage), path.join(outdir, "node_modules", nativePackage), { recursive: true })
  const runtimeDir = path.join(outdir, "runtime")
  await mkdir(runtimeDir, { recursive: true })
  const runtime = path.join(runtimeDir, process.platform === "win32" ? "bun.exe" : "bun")
  await copyFile(process.execPath, runtime)
  // The runtime statically links LGPL components (JavaScriptCore): its license and relink notes travel with it.
  const runtimeLicense = path.join(root, "vendor", "bun-runtime", "LICENSE-Bun.md")
  if (await Bun.file(runtimeLicense).exists()) await copyFile(runtimeLicense, path.join(runtimeDir, "LICENSE-Bun.md"))
  console.log(`bundle: ${result.outputs.length} files in ${outdir}; runtime ${runtime}`)
}
