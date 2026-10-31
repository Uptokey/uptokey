import test from "node:test";
import assert from "node:assert/strict";
import { parseHostedRequest } from "../hosted-request.js";

const input = {
  requestId: "request-1",
  model: "provider/model",
  messages: [{ role: "user", content: "hello" }],
  expectedPriceVersion: "free-v1",
};
test("hosted request parsing projects and freezes messages without inventing identity or cost", () => {
  const parsed = parseHostedRequest(input);
  assert.deepEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed.messages));
  assert.ok(Object.isFrozen(parsed.messages[0]));
  input.messages[0].content = "changed";
  assert.equal(parsed.messages[0].content, "hello");
  input.messages[0].content = "hello";
  for (const key of [
    "walletId",
    "deviceId",
    "accountRef",
    "providerKey",
    "amount",
  ])
    assert.throws(
      () => parseHostedRequest({ ...input, [key]: "injected" }),
      /hosted_request_invalid/,
    );
});
test("hosted request enforces message count, UTF-8 total, roles and a nonempty user turn", () => {
  for (const messages of [
    [],
    [{ role: "tool", content: "x" }],
    [{ role: "user", content: " " }],
    [{ role: "assistant", content: "x" }],
    Array.from({ length: 101 }, () => ({ role: "user", content: "x" })),
  ])
    assert.throws(
      () => parseHostedRequest({ ...input, messages }),
      /hosted_request_invalid/,
    );
  assert.throws(
    () =>
      parseHostedRequest({
        ...input,
        messages: [{ role: "user", content: "界".repeat(90_000) }],
      }),
    /hosted_request_too_large/,
  );
  assert.throws(
    () => parseHostedRequest({ ...input, maxOutputTokens: 1_000_001 }),
    /hosted_request_invalid/,
  );
  assert.throws(
    () =>
      parseHostedRequest({ ...input, expectedPriceVersion: "invalid version" }),
    /hosted_request_invalid/,
  );
});
