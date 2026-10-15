import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("../src/tui/frontend/node_modules/typescript");
const source = readFileSync(new URL("../src/tui/frontend/uptokey/bootstrap.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

test("direct visual/accessible bootstrap checks service version before identity and preserves service failures", async () => {
  for (const kind of ["TuiServiceUpdateError", "AbortError"]) {
    const calls: string[] = [];
    const failure = Object.assign(Error("localized:service_recovery"), { name: kind });
    const exports: any = {};
    runInNewContext(compiled, { exports, process: { env: {}, stderr: { write() { assert.fail("a service failure must not emit an identity diagnosis"); } } }, require: (id: string) => {
      if (id === "../../client.ts") return { discoverCoreUrl: () => "http://127.0.0.1:21435", TuiClient: class { constructor() { assert.fail("service boundary must run before constructing the identity client"); } } };
      if (id === "../../service-start.ts") return { adoptTuiServiceProfile: async () => { calls.push("adopt"); }, startSharedService: async () => { calls.push("service"); throw failure; } };
      if (id === "../../i18n.ts") return { setLang() {}, autoDetect: () => "en" };
      return {};
    } });
    await assert.rejects(exports.bootstrapFrontend({ cwd: "/synthetic-workspace" }), error => error === failure);
    assert.deepEqual(calls, ["adopt", "service"]);
  }
});
