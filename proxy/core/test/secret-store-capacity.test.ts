import assert from "node:assert/strict";
import test from "node:test";
import { NativeSecretStore, SecureStorageFullError, secretStoreFailureCode } from "../src/secret-store.ts";
import { PairingService, provisionPairedClient } from "../src/pairing.ts";
import { createApp, EXPECTED_HOST } from "../src/app.ts";
import { defaultConfig } from "../src/config.ts";

const nativeMessage = "Platform failure: Windows error code 8\n\nCaused by:\n    Windows error code 8";
const nativeFailure = (message = nativeMessage, code = "GenericFailure") => Object.assign(new Error(message), { code });
const entry = (failure: Error) => ({ getPassword(): string | null { throw failure; }, setPassword() { throw failure; }, deletePassword(): boolean { throw failure; } });

test("Windows native capacity keeps legacy operation messages and discards native error data", async () => {
  const store = new NativeSecretStore(() => entry(nativeFailure()), "win32");
  for (const [operation, invoke] of [["read", () => store.get("account-canary")], ["write", () => store.set("account-canary", "value-canary")], ["delete", () => store.delete("account-canary")]] as const) {
    await assert.rejects(invoke(), error => {
      assert.ok(error instanceof SecureStorageFullError);
      assert.equal(error.message, `secret_store_${operation}_unavailable`);
      assert.equal(error.code, "secure_storage_full");
      assert.equal(secretStoreFailureCode(error), "secure_storage_full");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /Windows|account-canary|value-canary|GenericFailure/);
      return true;
    });
  }
  const factoryFailure = new NativeSecretStore(async () => { throw nativeFailure(nativeMessage.replace(/\n/g, "\r\n")); }, "win32");
  await assert.rejects(factoryFailure.set("account-canary", "value-canary"), SecureStorageFullError);
});

test("capacity classification requires the exact Windows binding envelope", async () => {
  for (const [platform, failure] of [
    ["linux", nativeFailure()], ["darwin", nativeFailure()],
    ["win32", nativeFailure(nativeMessage, "EACCES")],
    ["win32", nativeFailure("native failure 8 account-canary value-canary")],
    ["win32", nativeFailure(nativeMessage + "\naccount-canary")],
    ["win32", nativeFailure(nativeMessage.replaceAll("code 8", "code 80"))],
    ["win32", nativeFailure(nativeMessage.replaceAll("code 8", "code 5"))],
  ] as const) {
    const store = new NativeSecretStore(() => entry(failure), platform);
    await assert.rejects(store.set("account-canary", "value-canary"), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "secret_store_write_unavailable");
      assert.equal(secretStoreFailureCode(error), undefined);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /account-canary|value-canary|Windows|EACCES/);
      return true;
    });
  }
});

test("typed capacity survives bounded rollback aggregates without mutating cleanup failures", () => {
  const full = new SecureStorageFullError("write"), cleanup = new Error("secret_store_delete_unavailable");
  const aggregate = new AggregateError([full, cleanup], "client_provision_rollback_failed");
  const outer = new Error("sanitized_outer", { cause: aggregate });
  assert.equal(secretStoreFailureCode(outer), "secure_storage_full");
  assert.equal(aggregate.errors[0], full); assert.equal(aggregate.errors[1], cleanup);
  assert.equal(aggregate.message, "client_provision_rollback_failed");
  let accessed = false;
  const accessor = new Error("opaque"); Object.defineProperty(accessor, "cause", { get() { accessed = true; throw Error("private-canary"); } });
  assert.equal(secretStoreFailureCode(accessor), undefined); assert.equal(accessed, false);
  const cycle = new Error("cycle"); Object.defineProperty(cycle, "cause", { value: cycle });
  assert.equal(secretStoreFailureCode(cycle), undefined);
  assert.equal(secretStoreFailureCode({ code: "secure_storage_full" }), undefined);
  assert.equal(secretStoreFailureCode(new AggregateError(Array.from({ length: 32 }, () => new Error("generic")), "generic")), undefined);
});

function pairingStore(rollbackFails: boolean, capacity = true) {
  const values = new Map<string, string>(); let failedWrites = 0, deletes = 0;
  const store = new NativeSecretStore((_service, account) => ({
    getPassword: () => values.get(account) ?? null,
    setPassword(value: string) {
      if (account.startsWith("local:client-reg:")) { failedWrites++; throw capacity ? nativeFailure() : nativeFailure("private-native-canary", "EACCES"); }
      values.set(account, value);
    },
    deletePassword() { deletes++; if (rollbackFails) throw new Error("private-delete-canary"); return values.delete(account); },
  }), "win32");
  return { store, values, counts: () => ({ failedWrites, deletes }) };
}

test("pair provisioning preserves typed capacity and original rollback failure information", async () => {
  for (const rollbackFails of [false, true]) {
    const f = pairingStore(rollbackFails);
    await assert.rejects(provisionPairedClient(f.store, "Synthetic test client"), error => {
      assert.equal(secretStoreFailureCode(error), "secure_storage_full");
      if (rollbackFails) {
        assert.ok(error instanceof AggregateError); assert.equal(error.message, "client_provision_rollback_failed");
        assert.ok(error.errors.some((child: unknown) => child instanceof Error && child.message === "secret_store_delete_unavailable"));
      } else assert.ok(error instanceof SecureStorageFullError);
      return true;
    });
    assert.equal(f.counts().failedWrites, 1); assert.equal(f.counts().deletes, 2);
    if (!rollbackFails) assert.equal(f.values.size, 0);
  }
});

test("pair consume exposes sanitized capacity 503 through the actual app error handler", async () => {
  for (const [rollbackFails, capacity] of [[false, true], [true, true], [false, false]] as const) {
    const f = pairingStore(rollbackFails, capacity), pairing = new PairingService(f.store);
    const challenge = pairing.create("Synthetic test client"); assert.equal(pairing.approve(challenge.id, challenge.userCode), true);
    const app = createApp(structuredClone(defaultConfig), {} as never, f.store, async () => ({ allowed: true }), undefined, pairing);
    const response = await app.request("/local/pair/consume", { method: "POST", headers: { host: EXPECTED_HOST, "content-type": "application/json" }, body: JSON.stringify({ id: challenge.id }) });
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: { type: capacity ? "secure_storage_full" : "proxy_unavailable" } });
    assert.equal(f.counts().failedWrites, 1, "the endpoint must not retry a failed vault mutation");
  }
});
