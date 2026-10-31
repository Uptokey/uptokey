import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  parseClientKeyPolicy,
  parseClientKeyView,
  parseKeyMutation,
  parseProtocolCapability,
  PROTOCOL_CAPABILITY_MATRIX,
} from "../client-keys.js";
import { parseManagementKeyCommand } from "../openrouter-management.js";

const basePolicy = {
  schemaVersion: 1,
  id: randomUUID(),
  revision: 1,
  label: "ide",
  principalId: "local",
  projectIds: [],
  providerIds: [],
  modelIds: ["model-x"],
  scopes: ["inference:chat", "models:read"],
  expiresAt: null,
  enabled: true,
};

test("client-key policy parses; admin scope and wide limits rejected", () => {
  const policy = parseClientKeyPolicy(basePolicy);
  assert.equal(policy.revision, 1);
  assert.throws(() => parseClientKeyPolicy({ ...basePolicy, scopes: ["admin"] }), /client_key_invalid/);
  assert.throws(() => parseClientKeyPolicy({ ...basePolicy, schemaVersion: 2 }), /client_key_version_unsupported/);
  assert.throws(
    () => parseClientKeyPolicy({ ...basePolicy, limits: { requestsPerMinute: 10001 } }),
    /client_key_invalid/,
  );
  assert.throws(
    () => parseClientKeyPolicy({ ...basePolicy, modelIds: Array.from({ length: 65 }, (_, i) => `m${i}`) }),
    /client_key_invalid/,
  );
});

test("client-key view omits secrets and carries masked prefix", () => {
  const view = parseClientKeyView({
    ...basePolicy,
    prefixMasked: "utk_local_abcd1234…wxyz",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    usageBasis: "local_device_estimate",
  });
  assert.equal(view.prefixMasked.startsWith("utk_local_"), true);
  assert.throws(() => parseClientKeyView({ ...basePolicy, token: "x", prefixMasked: "utk_local_abcd…wxyz", createdAt: new Date().toISOString(), usageBasis: "b" }), /client_key_view_invalid/);
  assert.throws(() => parseClientKeyView({ ...basePolicy, value: "x", prefixMasked: "utk_local_abcd…wxyz", createdAt: new Date().toISOString(), usageBasis: "b" }), /client_key_view_invalid/);
});

test("key mutations require operationId and CAS revision", () => {
  const create = parseKeyMutation({ kind: "create", operationId: randomUUID(), expectedRevision: 1, label: "a", scopes: ["inference:chat"], limits: null });
  assert.equal(create.kind, "create");
  assert.throws(() => parseKeyMutation({ kind: "create", expectedRevision: 1, label: "a", scopes: ["inference:chat"], limits: null }), /key_mutation_invalid/);
  const update = parseKeyMutation({ kind: "update", operationId: randomUUID(), expectedRevision: 3, enabled: false });
  assert.equal(update.expectedRevision, 3);
  const rotate = parseKeyMutation({ kind: "rotate", operationId: randomUUID(), expectedRevision: 2 });
  assert.equal(rotate.kind, "rotate");
});

test("protocol capability matrix is fixed and validated", () => {
  assert.equal(PROTOCOL_CAPABILITY_MATRIX.length, 4);
  for (const entry of PROTOCOL_CAPABILITY_MATRIX) {
    assert.deepEqual(Object.keys(parseProtocolCapability(entry)).sort(), Object.keys(entry).sort());
  }
  assert.throws(() => parseProtocolCapability({ ...PROTOCOL_CAPABILITY_MATRIX[0], protocol: "nope" }), /protocol_capability_invalid/);
});

test("management commands validate; hash stays opaque", () => {
  const create = parseManagementKeyCommand({ kind: "create", operationId: randomUUID(), name: "ide", limit: 10, limitReset: "monthly", includeByokInLimit: false });
  assert.equal(create.kind, "create");
  const list = parseManagementKeyCommand({ kind: "list", operationId: randomUUID() });
  assert.equal(list.kind, "list");
  const disable = parseManagementKeyCommand({ kind: "disable", operationId: randomUUID(), remoteKeyHash: "hash-abcdefgh" });
  assert.equal(disable.kind, "disable");
  assert.throws(() => parseManagementKeyCommand({ kind: "delete", operationId: randomUUID(), remoteKeyHash: "short" }), /management_key_command_invalid/);
});
