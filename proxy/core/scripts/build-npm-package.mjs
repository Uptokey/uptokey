#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { NOTICES_FILE, generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { extractRuntimeSpecifiers } from "./beta-runtime-contract.mjs";

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Refuse builder paths in generated code; never rewrite executable output. */
export function assertPortableBuild(code, roots = [DEFAULT_ROOT, homedir()]) {
  const normalized = code.replaceAll("\\\\", "\\").replaceAll("\\", "/").toLowerCase();
  for (const root of roots) {
    const prefix = root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    if (prefix.length > 3 && [prefix, encodeURI(prefix).toLowerCase()].some(value => normalized.includes(`${value}/`))) {
      throw new Error("build_machine_path_embedded");
    }
  }
}

/**
 * Timestamp for BUILD_INFO.json. Honors SOURCE_DATE_EPOCH (reproducible builds):
 * with a fixed epoch, two builds of the same sources produce the same bytes.
 */
export function buildTimestamp(now = Date.now(), env = process.env) {
  const epoch = Number.parseInt(env.SOURCE_DATE_EPOCH ?? "", 10);
  const ms = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : now;
  return new Date(ms).toISOString();
}

/** Select the existing Debian vault contract at build time, never by runtime env. */
export function nodeBundleProfile(args) {
  const deb = args[0] === "--linux-deb";
  const macos = args[0] === "--macos-native";
  const rest = deb || macos ? args.slice(1) : args;
  if ((deb || macos || rest.length) && (rest.length !== 2 || rest[0] !== "--out-dir" || !rest[1] || rest[1].startsWith("--"))) {
    throw new Error("build_arguments_invalid");
  }
  return {
    args: rest,
    distributionChannel: deb || macos ? "native" : "npm",
    linuxPackageChannel: deb ? "deb" : "development",
  };
}

export function buildNpmPackage(args = process.argv.slice(2), root = DEFAULT_ROOT) {
  // Review builds can be exercised without replacing the installed executable.
  // Only a fresh artifact directory under workspace/output is accepted.
  const profile = nodeBundleProfile(args);
  args = profile.args;
  const dist = args.length ? resolve(args[1]) : resolve(root, "dist");
  if (args.length) {
    const inside = relative(resolve(root, "../../output"), dist);
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || existsSync(dist)) throw new Error("build_review_directory_invalid");
  }
  const outfile = resolve(dist, "cli.js");

  // Preserve the last usable derived output until the new build has completed.
  // Removing dist before spawning Bun made a transient compiler/permission
  // failure destroy the runnable artifact. The release verifier checks the
  // exact generated file set after a successful build, so cleanup is performed
  // only by the successful packaging path.
  mkdirSync(dist, { recursive: true });

  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const buildVersion = process.env.UPTOKEY_BUILD_VERSION || pkg.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildVersion)) {
    process.stderr.write(`compiled_version_invalid:${buildVersion}\n`);
    process.exitCode = 1;
    return;
  }

  // Windows resolves the executable only when the .exe suffix is explicit in
  // child_process.spawnSync; npm's PATH may contain Bun without a shim.
  const bunPlatform = process.platform === "win32" ? "windows" : process.platform;
  const bunArch = process.arch === "arm64" ? "aarch64" : process.arch;
  const copiedBun = resolve(root, "node_modules", "@oven", `bun-${bunPlatform}-${bunArch}`, "bin", process.platform === "win32" ? "bun.exe" : "bun");
  const bun = process.env.BUN_BIN || (existsSync(copiedBun) ? copiedBun : process.platform === "win32" ? "bun.exe" : "bun");
  // Modules the bundler must NOT inline; they are runtime dependencies installed by npm.
  const bundlerExternals = [
      "--external=@lydell/node-pty",
      "--external=@napi-rs/keyring",
      "--external=@hpke/core",
      "--external=@simplewebauthn/server",
      "--external=eventsource-parser",
      // Preserve Undici's own runtime module filename. Bundling its CommonJS
      // entry embeds the build machine path used for fetch stack augmentation.
      "--external=undici",
      "--external=hono",
      "--external=@hono/node-server",
      "--external=zod",
      "--external=@modelcontextprotocol/sdk",
      "--external=@langchain/*",
      "--external=langsmith",
      "--external=langsmith/*",
      "--external=better-sqlite3",
      // js-tiktoken stays external: it must be a runtime dependency of every
      // published profile (see scripts/npm-pack-beta.mjs).
      "--external=js-tiktoken",
      "--external=tree-sitter-wasm"
  ];
  // Bundler metafiles are the source of truth for THIRD-PARTY-NOTICES (exactly what
  // was inlined). They live in a private temp dir, never in dist/.
  const metaDir = resolve(dist, "meta");
  mkdirSync(metaDir, { recursive: true });
  const bundles = [];
  const failBuild = message => {
    rmSync(metaDir, { recursive: true, force: true });
    process.stderr.write(message);
    process.exitCode = 1;
  };
  for (const [entry, output] of [["src/cli.ts", outfile], ["src/workspace/composition-worker.ts", resolve(dist, "composition-worker.js")], ["src/workspace/service-schema-worker.ts", resolve(dist, "service-schema-worker.js")], ["src/workspace-context-helper.ts", resolve(dist, "workspace-context-helper.js")]]) {
  const metafile = join(metaDir, `${bundles.length}.json`);
  bundles.push({ bundle: `dist/${output.slice(dist.length + 1).replaceAll("\\", "/")}`, metafile });
  const result = spawnSync(
    bun,
    [
      "build",
      resolve(root, entry),
      "--outfile",
      output,
      "--target",
      "node",
      "--format",
      "esm",
      "--define",
      `UPTOKEY_BUILD_VERSION=${JSON.stringify(buildVersion)}`,
      "--define",
      `UPTOKEY_DISTRIBUTION_CHANNEL=${JSON.stringify(profile.distributionChannel)}`,
      "--define",
      `UPTOKEY_LINUX_PACKAGE_CHANNEL=${JSON.stringify(profile.linuxPackageChannel)}`,
      "--define",
      'UPTOKEY_REPO_MAP_WORKER_PATH="./tui/repo-map-worker.js"',
      `--metafile=${metafile}`,
      ...bundlerExternals.filter(arg => entry !== "src/workspace-context-helper.ts" || arg !== "--external=eventsource-parser")
    ],
    { cwd: root, encoding: "utf8" }
  );

  if (result.status !== 0 || !existsSync(metafile)) {
    failBuild(result.stderr || result.stdout || `bun_build_failed${result.error?.code ? `:${result.error.code}` : ""}\n`);
    return;
  }
  try {
    assertPortableBuild(readFileSync(output, "utf8"), [root, homedir()]);
  } catch (error) {
    failBuild(`${error instanceof Error ? error.message : "build_portability_failed"}\n`);
    return;
  }
  }

  // B9 Frente D: dist ships the notices for every third-party component inlined above.
  try {
    const notices = generateThirdPartyNotices({
      root,
      bundles,
      externals: bundlerExternals.map(arg => arg.slice("--external=".length)),
    });
    writeFileSync(resolve(dist, NOTICES_FILE), notices.text);
  } catch (error) {
    failBuild(`third_party_notices_failed:${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }
  rmSync(metaDir, { recursive: true, force: true });

  let code = readFileSync(outfile, "utf8");
  if (code.startsWith("#!")) code = code.split("\n").slice(1).join("\n");
  code = "#!/usr/bin/env node\n" + code;
  writeFileSync(outfile, code);

  // Ensure package metadata for pack: no file: deps in the published shape.
  // vendor stays for local installs; published tarball uses files whitelist + bundled dist.
  writeFileSync(resolve(dist, "BUILD_INFO.json"), JSON.stringify({
    builtAt: buildTimestamp(),
    version: buildVersion,
    target: "node",
    distributionChannel: profile.distributionChannel,
    linuxPackageChannel: profile.linuxPackageChannel,
    entry: "src/cli.ts",
    compositionWorker: "composition-worker.js",
    serviceSchemaWorker: "service-schema-worker.js",
    contextHelper: { entry: "workspace-context-helper.js", externalSpecifiers: extractRuntimeSpecifiers(readFileSync(resolve(dist, "workspace-context-helper.js"), "utf8")) },
    thirdPartyNotices: NOTICES_FILE,
    note: "sync-contract is bundled into cli.js; native modules remain external npm deps"
  }, null, 2) + "\n");

  process.stdout.write(`built ${outfile}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNpmPackage();
}
