import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "../../../quimera/uptokey/uptokey-pwa/node_modules/playwright/index.mjs";
import { createApp, EXPECTED_HOST } from "../src/app.ts";
import { defaultConfig } from "../src/config.ts";
import { MemorySecretStore } from "../src/secret-store.ts";

test("Mini-UI fences repeated provider changes and preserves edits made while saving", { timeout: 25000 }, async () => {
  const previousDataDir = process.env.UPTOKEY_QUIMERA_DATA_DIR;
  const previousSecretService = process.env.UPTOKEY_SECRET_SERVICE;
  const fixture = await mkdtemp(join(tmpdir(), "uptokey-provider-actions-"));
  const data = join(fixture, "data");
  const packageRoot = process.env.UPTOKEY_TEST_CORE_PACKAGE;
  await mkdir(data);
  process.env.UPTOKEY_QUIMERA_DATA_DIR = data;
  const origin = "http://127.0.0.1:21435";
  const original = "gsk_SYNTHETIC_MINI_UI_FIRST";
  const replacement = "gsk_SYNTHETIC_MINI_UI_SECOND";
  const rejected = "invalid_synthetic_provider_key";
  const firstSaved = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const mutations = [];
  const errors = [];
  let app, browser, getKey;
  try {
    if (packageRoot) {
      const { startPackagedCore } = await import("../../../quimera/uptokey/vscode-extension/scripts/installed-packaged-core.mjs");
      app = await startPackagedCore(packageRoot, fixture, structuredClone(defaultConfig), () => {
        throw new Error("external account refused");
      }, process.env.UPTOKEY_TEST_CORE_DEPENDENCIES);
      const vault = globalThis[Symbol.for("uptokey.installed.packaged.keyring")].values;
      getKey = () => vault.get("provider:groq");
    } else {
      const secrets = new MemorySecretStore();
      app = createApp(structuredClone(defaultConfig), {
        async invalidateProviderCache() {},
      }, secrets, async () => ({ allowed: true }));
      getKey = () => secrets.get("provider:groq");
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const headers = new Headers(await request.allHeaders());
      headers.set("host", EXPECTED_HOST);
      const mutation = url.pathname === "/local/provider/save" || url.pathname === "/local/provider/revoke";
      if (mutation) mutations.push(url.pathname);
      const first = mutation && mutations.length === 1;
      const response = await app.request(url.pathname + url.search, {
        method: request.method(),
        headers,
        body: request.postDataBuffer() ?? undefined,
      });
      if (first) {
        const body = await response.clone().json();
        firstSaved.resolve({ status: response.status, error: body.error?.type });
        await releaseFirst.promise;
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.goto(origin + "/ui?view=standalone#api-connections");
    await page.locator(".connection-presets > summary").click();
    const key = page.locator("#groq-key");
    const save = page.locator('[data-save="groq"]');
    const revoke = page.locator('[data-revoke="groq"]');
    const feedback = page.locator('[data-msg="groq"]');
    await key.fill(original);
    await save.click();
    assert.deepEqual(await Promise.race([
      firstSaved.promise,
      feedback.filter({ hasText: "Erro ao salvar" }).waitFor().then(() => ({ status: 0 })),
    ]), { status: 200, error: undefined });
    assert.ok(await revoke.isDisabled(), "revocation stays disabled until the save is confirmed");
    assert.ok(await save.isDisabled());
    await page.locator("#groq-revoke").fill("REVOGAR");
    await page.locator('form[data-provider="groq"]').evaluate(form => form.requestSubmit());
    await revoke.evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await key.fill(replacement);
    releaseFirst.resolve();
    await page.locator('[data-msg="groq"].ok').waitFor();
    assert.ok(await key.inputValue() === replacement, "a later edit stays in the field");
    assert.ok(await getKey() === original);
    assert.deepEqual(mutations, ["/local/provider/save"]);

    await key.fill(rejected);
    await save.click();
    await page.locator('[data-msg="groq"].err').waitFor();
    assert.ok(await key.inputValue() === rejected, "failed save keeps the editable value");
    assert.ok(await getKey() === original);
    assert.ok(await revoke.isEnabled());

    await key.fill(replacement);
    await save.click();
    await page.locator('[data-msg="groq"].ok').waitFor();
    assert.equal(await key.inputValue(), "");
    assert.ok(await getKey() === replacement);
    const savedConfig = await readFile(join(data, "proxy-config.json"), "utf8");
    assert.ok(!savedConfig.includes(original) && !savedConfig.includes(replacement), "keys stay outside configuration");
    await page.locator("#groq-revoke").fill("REVOGAR");
    await revoke.click();
    await page.locator('[data-msg="groq"].ok').filter({ hasText: "revogado" }).waitFor();
    assert.equal(await getKey(), undefined);
    assert.deepEqual(mutations, ["/local/provider/save", "/local/provider/save", "/local/provider/save", "/local/provider/revoke"]);
    assert.ok(!((await page.locator("body").innerText()).includes(original)));
    assert.deepEqual(errors, []);
    if (packageRoot) console.log(JSON.stringify({
      fixture, version: app.identity.version, cliSha256: app.identity.cliSha256,
      packagedCli: true, providerMutations: mutations.length, credentialsInConfig: false
    }));
  } finally {
    releaseFirst.resolve();
    await browser?.close();
    await app?.closeWorkspace();
    if (previousDataDir === undefined) delete process.env.UPTOKEY_QUIMERA_DATA_DIR;
    else process.env.UPTOKEY_QUIMERA_DATA_DIR = previousDataDir;
    if (previousSecretService === undefined) delete process.env.UPTOKEY_SECRET_SERVICE;
    else process.env.UPTOKEY_SECRET_SERVICE = previousSecretService;
  }
});
