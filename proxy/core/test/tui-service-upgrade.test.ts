import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { olderTuiService, startSharedService, type TuiServiceStartupDependencies } from "../src/tui/service-start.ts";
import { SERVICE_UPDATE_STRINGS, serviceUpdateAccepted, serviceUpdateText } from "../src/tui/service-update-ui.ts";
import { setLang } from "../src/tui/i18n.ts";

const URL = "http://127.0.0.1:21435";
const token = `utk_local_${"x".repeat(32)}`;

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "uptokey-service-upgrade-"));
  const env: NodeJS.ProcessEnv = { UPTOKEY_QUIMERA_DATA_DIR: dataDir };
  const calls: string[] = [], notices: string[] = [], pidPaths: string[] = [];
  const state = { version: "v0.1.0-beta.11", status: "ok" as "ok" | "error", pid: 41001, record: true };
  const deps: TuiServiceStartupDependencies = {
    env, currentVersion: "0.1.0-beta.15", interactive: true,
    health: async () => { calls.push("health"); return { status: state.status, version: state.version }; },
    readPid: name => { calls.push("pid"); pidPaths.push(name); return state.pid; },
    pidRecordExists: name => { pidPaths.push(name); return state.record; },
    confirmUpdate: async () => { calls.push("confirm"); return true; },
    readAdminToken: async () => { calls.push("token"); return token; },
    plan: async (cwd, selected) => { calls.push("plan"); return { cwd, executable: process.execPath, args: ["fixture-cli.js", "start", "--no-tailnet"], env: selected }; },
    authorizeStop: async (pid, secret) => {
      calls.push("stop"); assert.equal(pid, 41001); assert.equal(secret, token);
      state.record = false; state.status = "error"; return 204;
    },
    launch: plan => {
      calls.push("launch"); assert.equal(plan.env, env); assert.equal(plan.env.UPTOKEY_QUIMERA_DATA_DIR, dataDir);
      assert.deepEqual(plan.args, ["fixture-cli.js", "start", "--no-tailnet"]);
      state.status = "ok"; state.version = "v0.1.0-beta.15"; state.pid = 41002; state.record = true;
      return {};
    },
    notice: text => notices.push(text), wait: async () => { calls.push("wait"); }, stopAttempts: 3, readyAttempts: 3,
  };
  return { dataDir, env, deps, calls, notices, state, pidPaths, run: () => startSharedService(URL, dataDir, deps) };
}

const effects = (calls: string[]) => calls.filter(name => ["confirm", "token", "stop", "launch"].includes(name));

test("release comparison handles numeric beta versions and never treats invalid versions as an upgrade", () => {
  assert.equal(olderTuiService("v0.1.0-beta.9", "0.1.0-beta.15"), true);
  assert.equal(olderTuiService("0.1.0-beta.15", "0.1.0-beta.15"), false);
  assert.equal(olderTuiService("v0.1.0-beta.16", "0.1.0-beta.15"), false);
  assert.equal(olderTuiService("v0.1.0", "0.1.0-beta.15"), false);
  for (const value of [undefined, "", "dev", "v0.1.0-beta.01", "v99999999999999999.0.0"]) assert.equal(olderTuiService(value, "0.1.0-beta.15"), false);
});

test("current and newer services stay untouched without vault access or an update prompt", async () => {
  for (const version of ["v0.1.0-beta.15", "v0.1.0-beta.16", "v0.1.0"]) {
    const h = fixture(); h.state.version = version; await h.run();
    assert.deepEqual(h.calls, ["health"]); assert.deepEqual(h.notices, []);
  }
});

test("the uncompiled development version cannot replace or downgrade an installed release", async () => {
  const h = fixture(); delete h.deps.currentVersion; await h.run();
  assert.deepEqual(h.calls, ["health"]); assert.deepEqual(h.notices, []);
});

test("an unversioned service remains available with an honest notice and no administrative effects", async () => {
  const h = fixture(); h.state.version = "dev-build".repeat(2000);
  await h.run(); await h.run();
  assert.deepEqual(effects(h.calls), []);
  assert.deepEqual(h.notices, [serviceUpdateText("unknown")]);
  assert.ok((h.env.UPTOKEY_TUI_SERVICE_CHECK?.length ?? 0) < 1024, "untrusted health text cannot inflate the inherited environment");
});

test("declining keeps BYOK/local service intact and avoids a second prompt in the inherited frontend", async () => {
  const h = fixture(); h.deps.confirmUpdate = async () => { h.calls.push("confirm"); return false; };
  await h.run();
  // Simulate the child process: its environment is copied, not the same object.
  const frontendEnv = { ...h.env };
  await startSharedService(URL, h.dataDir, { ...h.deps, env: frontendEnv });
  assert.deepEqual(effects(h.calls), ["confirm"]);
  assert.deepEqual(h.notices, [serviceUpdateText("needed")]);
  assert.equal(h.state.version, "v0.1.0-beta.11"); assert.equal(h.state.record, true);
  h.state.pid = 41003; await h.run();
  assert.equal(h.calls.filter(name => name === "confirm").length, 2, "a different daemon needs a fresh decision");
  assert.equal(frontendEnv.UPTOKEY_QUIMERA_DATA_DIR, h.dataDir);
});

test("noninteractive launches never update, and a noncanonical port cannot authorize a shared service restart", async () => {
  const h = fixture(); h.deps.interactive = false; await h.run();
  assert.deepEqual(effects(h.calls), []); assert.equal(h.notices.length, 1);
  const other = fixture(); await startSharedService("http://127.0.0.1:21436", other.dataDir, other.deps);
  assert.deepEqual(effects(other.calls), []); assert.equal(other.notices.length, 1);
});

test("opt-in revalidates the exact profile/PID/version and starts the same profile only after both stop proofs", async () => {
  const h = fixture(); await h.run();
  assert.deepEqual(effects(h.calls), ["confirm", "token", "stop", "launch"]);
  assert.equal(h.calls.filter(name => name === "stop").length, 1);
  assert.ok(h.pidPaths.every(name => name === join(h.dataDir, "proxy.pid")));
  assert.equal(h.env.UPTOKEY_TUI_SERVICE_CHECK, undefined);
  assert.equal(h.state.version, "v0.1.0-beta.15"); assert.equal(h.notices.length, 0);
});

test("profile, namespace, PID, version, and launch-plan changes after confirmation refuse the stop", async () => {
  for (const change of ["profile", "namespace", "pid", "version", "plan"] as const) {
    const h = fixture();
    h.deps.confirmUpdate = async () => {
      h.calls.push("confirm");
      if (change === "profile") h.env.UPTOKEY_QUIMERA_DATA_DIR = mkdtempSync(join(tmpdir(), "uptokey-service-other-"));
      if (change === "namespace") h.env.UPTOKEY_SECRET_SERVICE = "com.uptokey.quimera.proxy.changed";
      if (change === "pid") h.state.pid = 41003;
      if (change === "version") h.state.version = "v0.1.0-beta.16";
      return true;
    };
    if (change === "plan") h.deps.plan = async cwd => ({ cwd, args: ["start"], env: { ...h.env, UPTOKEY_QUIMERA_DATA_DIR: mkdtempSync(join(tmpdir(), "uptokey-service-other-")) } });
    await assert.rejects(h.run(), { name: "TuiServiceUpdateError" }, change);
    assert.equal(h.calls.includes("stop"), false, change); assert.equal(h.calls.includes("launch"), false, change);
  }
});

test("PID/profile rotation while the native vault is being read is revalidated before the administrative POST", async () => {
  for (const change of ["pid", "profile"] as const) {
    const h = fixture(); h.deps.readAdminToken = async () => {
      h.calls.push("token");
      if (change === "pid") h.state.pid = 41003;
      else h.env.UPTOKEY_QUIMERA_DATA_DIR = mkdtempSync(join(tmpdir(), "uptokey-service-other-"));
      return token;
    };
    await assert.rejects(h.run(), { name: "TuiServiceUpdateError" });
    assert.equal(h.calls.includes("stop"), false); assert.equal(h.calls.includes("launch"), false);
  }
});

test("missing credentials and refused administrative stops never spawn or retry a replacement", async () => {
  for (const code of [undefined, 401, 409, 503]) {
    const h = fixture();
    if (code === undefined) h.deps.readAdminToken = async () => { h.calls.push("token"); return undefined; };
    else h.deps.authorizeStop = async () => { h.calls.push("stop"); return code; };
    await assert.rejects(h.run(), { name: "TuiServiceUpdateError" });
    assert.equal(h.calls.filter(name => name === "stop").length, code === undefined ? 0 : 1);
    assert.equal(h.calls.includes("launch"), false);
  }
});

test("shutdown timeout requires both a removed PID file and unavailable health before launching", async () => {
  for (const remaining of ["both", "pid", "health"] as const) {
    const h = fixture();
    h.deps.authorizeStop = async () => {
      h.calls.push("stop"); h.state.record = remaining !== "health"; h.state.status = remaining === "pid" ? "error" : "ok"; return 204;
    };
    if (remaining === "pid") h.deps.readPid = () => { if (h.calls.includes("stop")) throw Error("proxy_not_running"); return h.state.pid; };
    await assert.rejects(h.run(), { name: "TuiServiceUpdateError" }, remaining);
    assert.equal(h.calls.filter(name => name === "stop").length, 1);
    assert.equal(h.calls.includes("launch"), false, remaining);
    assert.equal(h.calls.filter(name => name === "wait").length, 3, "wait is bounded without a stop/restart loop");
  }
});

test("a PID file disappearing between reads is a normal shutdown race, never permission to skip health proof", async () => {
  const h = fixture(); let afterStop = false, racing = true;
  h.deps.authorizeStop = async () => { h.calls.push("stop"); afterStop = true; h.state.status = "error"; return 204; };
  h.deps.readPid = () => {
    if (afterStop && racing) { racing = false; h.state.record = false; throw Object.assign(Error("removed"), { code: "ENOENT" }); }
    return h.state.pid;
  };
  await h.run();
  assert.deepEqual(effects(h.calls), ["confirm", "token", "stop", "launch"]);
  assert.equal(h.calls.filter(name => name === "wait").length, 1);
});

test("a competing replacement PID during shutdown is preserved without launching another service", async () => {
  const h = fixture(); h.deps.authorizeStop = async () => { h.calls.push("stop"); h.state.pid = 41003; return 204; };
  await assert.rejects(h.run(), { name: "TuiServiceUpdateError" });
  assert.equal(h.calls.includes("launch"), false); assert.equal(h.state.pid, 41003);
});

test("cancellation before consent, after consent, during vault read and during stop wait never starts a late service", async () => {
  for (const at of ["before", "confirm", "token", "wait"] as const) {
    const h = fixture(), cancellation = new AbortController(); h.deps.signal = cancellation.signal;
    const cancel = () => cancellation.abort(Object.assign(Error("test cancelled"), { name: "AbortError" }));
    if (at === "before") cancel();
    if (at === "confirm") h.deps.confirmUpdate = async () => { h.calls.push("confirm"); cancel(); return true; };
    if (at === "token") h.deps.readAdminToken = async () => { h.calls.push("token"); cancel(); return token; };
    if (at === "wait") {
      h.deps.authorizeStop = async () => { h.calls.push("stop"); return 204; };
      h.deps.wait = async () => { h.calls.push("wait"); cancel(); };
    }
    await assert.rejects(h.run(), { name: "AbortError" }, at);
    assert.equal(h.calls.includes("launch"), false, at);
    assert.equal(h.calls.includes("stop"), at === "wait", at);
  }
});

test("concurrent startup consumers share one decision and one authorized restart", async () => {
  const h = fixture(); let choose!: () => void;
  const choice = new Promise<void>(resolve => { choose = resolve; });
  h.deps.confirmUpdate = async () => { h.calls.push("confirm"); await choice; return true; };
  const first = h.run(), second = h.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(name => name === "confirm").length, 1);
  choose(); await Promise.all([first, second]);
  assert.equal(h.calls.filter(name => name === "stop").length, 1); assert.equal(h.calls.filter(name => name === "launch").length, 1);
});

test("an unavailable service starts normally without touching the vault, and unhealthy startup never reports success", async () => {
  const h = fixture(); h.state.status = "error"; h.state.record = false; await h.run();
  assert.deepEqual(effects(h.calls), ["launch"]);
  for (const wrong of ["v0.1.0-beta.11", "unversioned"]) {
    const failed = fixture(); failed.state.status = "error";
    failed.deps.launch = () => { failed.calls.push("launch"); failed.state.status = "ok"; failed.state.version = wrong; return {}; };
    await assert.rejects(failed.run(), { name: "TuiServiceUpdateError" });
    assert.equal(failed.calls.filter(name => name === "launch").length, 1);
  }
});

test("all ten locales define concise update and recovery text, with explicit default-no consent", () => {
  const locales = ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as const;
  for (const lang of locales) {
    setLang(lang);
    for (const key of Object.keys(SERVICE_UPDATE_STRINGS) as Array<keyof typeof SERVICE_UPDATE_STRINGS>) {
      assert.ok(serviceUpdateText(key).length > 10); assert.equal(serviceUpdateText(key), SERVICE_UPDATE_STRINGS[key][lang]);
      if (lang !== "en") assert.notEqual(serviceUpdateText(key), SERVICE_UPDATE_STRINGS[key].en);
    }
    assert.match(serviceUpdateText("confirm"), /\[[a-z]\/N\] /);
  }
  for (const answer of ["", "no", "n", "anything"]) assert.equal(serviceUpdateAccepted(answer), false);
  for (const answer of ["y", "YES", "sim", "sí", "oui", "ja", "はい", "네", "是", "نعم"]) assert.equal(serviceUpdateAccepted(answer), true);
  setLang("en");
});
