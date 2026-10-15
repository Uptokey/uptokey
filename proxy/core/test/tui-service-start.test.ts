import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { frontendCoreLaunchEnv } from "../src/tui/frontend-launcher.ts";
import { adoptTuiServiceProfile, tuiServicePlan } from "../src/tui/service-start.ts";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "uptokey-service-start-"));
  const entry = join(cwd, "cli.js");
  writeFileSync(entry, "console.log(JSON.stringify({ runtime: process.execPath, args: process.argv.slice(2), profile: process.env.UPTOKEY_QUIMERA_DATA_DIR }))");
  const env = {
    ...frontendCoreLaunchEnv({ executable: process.execPath, entry, execArgv: [] }),
    UPTOKEY_QUIMERA_DATA_DIR: join(cwd, "profile"),
  };
  return { cwd, entry, env };
}

test("frontend startup invokes the transported core runtime and CLI with the explicit profile", async () => {
  const { cwd, entry, env } = fixture();
  const selected = await adoptTuiServiceProfile(cwd, { env });
  assert.equal(selected.source, "explicit");
  const plan = await tuiServicePlan(cwd, env);
  assert.equal(plan.executable, process.execPath);
  assert.deepEqual(plan.args, [entry, "start", "--no-tailnet"]);
  assert.equal(plan.env, env);
  const child = spawnSync(plan.executable!, plan.args, { cwd: plan.cwd, env: plan.env, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { runtime: process.execPath, args: ["start", "--no-tailnet"], profile: env.UPTOKEY_QUIMERA_DATA_DIR });
});

test("the core command preserves Node source flags and supports standalone executable cores", async () => {
  const { cwd, entry, env } = fixture();
  const flags = ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];
  Object.assign(env, frontendCoreLaunchEnv({ executable: process.execPath, entry, execArgv: flags }));
  assert.deepEqual((await tuiServicePlan(cwd, env)).args, [...flags, entry, "start", "--no-tailnet"]);
  Object.assign(env, frontendCoreLaunchEnv({ executable: process.execPath, execArgv: flags }));
  assert.deepEqual((await tuiServicePlan(cwd, env)).args, ["start", "--no-tailnet"]);
});

test("missing or malformed transported core commands fail without searching another installation", async () => {
  const { cwd, env } = fixture();
  for (const change of [
    { UPTOKEY_TUI_CORE_EXECUTABLE: join(cwd, "missing-node") },
    { UPTOKEY_TUI_CORE_ENTRY: join(cwd, "missing-cli.js") },
    { UPTOKEY_TUI_CORE_ENTRY: "cli.js" },
    { UPTOKEY_TUI_CORE_EXEC_ARGV: "invalid" },
    { UPTOKEY_TUI_CORE_EXEC_ARGV: '[42]' },
    { UPTOKEY_TUI_CORE_EXEC_ARGV: undefined },
  ]) await assert.rejects(tuiServicePlan(cwd, { ...env, ...change }), /tui_service_plan_unavailable/);
});

test("development startup retains its launcher profile and arguments with the original core runtime", async () => {
  const { cwd, entry, env } = fixture();
  const developmentEnv: NodeJS.ProcessEnv = { ...env };
  delete developmentEnv.UPTOKEY_QUIMERA_DATA_DIR;
  const plan = await tuiServicePlan(cwd, developmentEnv, (selected, root) => {
    assert.equal(selected, developmentEnv);
    assert.ok(root.endsWith("uptokey"));
    return [{ cwd, args: [entry, "start", "--no-tailnet"], env: { ...selected, UPTOKEY_QUIMERA_DATA_DIR: join(cwd, "profile") } }];
  });
  assert.equal(plan.executable, process.execPath);
  assert.ok(plan.args[0]?.endsWith("cli.js"));
  assert.deepEqual(plan.args.slice(1), ["start", "--no-tailnet"]);
  assert.ok(plan.env.UPTOKEY_QUIMERA_DATA_DIR);
});

test("an inherited frontend command cannot override the launching core command", () => {
  const { entry } = fixture();
  const env = { UPTOKEY_TUI_CORE_EXECUTABLE: "stale-runtime", UPTOKEY_TUI_CORE_ENTRY: "stale-entry", UPTOKEY_TUI_CORE_EXEC_ARGV: "invalid", ...frontendCoreLaunchEnv({ executable: process.execPath, entry, execArgv: [] }) };
  assert.equal(env.UPTOKEY_TUI_CORE_EXECUTABLE, process.execPath);
  assert.equal(env.UPTOKEY_TUI_CORE_ENTRY, entry);
  assert.equal(env.UPTOKEY_TUI_CORE_EXEC_ARGV, "[]");
});
