import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../canonical.js";
import { isSyncEnvelope } from "../envelope.js";
import { readBoundedBody, readBoundedJson } from "../limits.js";
import { isDataRecord, projectStringArray } from "../plain-data.js";
import { signRateSubject, verifyRateSubject } from "../rate-subject.js";
import { parseTailnetControlOrigin } from "../tailnet-origin.js";

test("all public browser-safe contracts reject ambiguous input", async () => {
  assert.equal(canonicalJson({ z: 1, a: "ok" }), '{"a":"ok","z":1}');
  assert.throws(() => canonicalJson({ value: undefined }), /sync_non_json_value/);
  const getter = {};
  Object.defineProperty(getter, "secret", { enumerable: true, get() { throw new Error("getter_executed"); } });
  assert.throws(() => canonicalJson(getter), /sync_non_json_value/);

  assert.equal(isSyncEnvelope({}), false);
  assert.equal(isDataRecord(Object.create(null)), true);
  assert.equal(isDataRecord(new Date()), false);
  assert.deepEqual(projectStringArray(["a", "b"], 2), ["a", "b"]);
  assert.equal(projectStringArray(["a", 1], 2), undefined);

  assert.equal(parseTailnetControlOrigin("https://device.tail.example.ts.net:21436"), "https://device.tail.example.ts.net:21436");
  assert.equal(parseTailnetControlOrigin("https://device.tail.example.ts.net"), undefined);
  assert.equal(parseTailnetControlOrigin("https://device.tail.example.ts.net:21436/path"), undefined);

  const secret = "s".repeat(32);
  const signed = signRateSubject("127.0.0.1", secret, 100);
  assert.match(verifyRateSubject(new Headers(signed), secret, 100, 0), /^bff:/);
  assert.equal(verifyRateSubject(new Headers(signed), secret, 101, 0), undefined);

  const accepted = await readBoundedJson(new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"ok":true}'
  }), 32, 1_000);
  assert.deepEqual(accepted, { ok: true, value: { ok: true } });
  const rejected = await readBoundedJson(new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '"too large"'
  }), 4, 1_000);
  assert.deepEqual(rejected, { ok: false, reason: "too_large" });
  const raw = await readBoundedBody(new Request("http://localhost", { method: "POST", body: "signed:body" }), 32, 1_000);
  assert.equal(raw.ok, true);
  if (raw.ok) assert.equal(new TextDecoder().decode(raw.value), "signed:body");
});
