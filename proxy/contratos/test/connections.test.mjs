import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertViewHasNoSecrets,
  CONNECTIONS_SCHEMA_VERSION,
  CONNECTION_LIMITS,
  parseConnectionPatch,
  parseConnectionProfile,
  parseConnectionTestResult,
  parseConnectionTestSpec,
  parseModelInstallSpec,
  parseOAuthStart,
  projectConnectionView,
} from "../connections.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "groq",
    label: "Conta principal",
    accessMode: "byok",
    enabled: true,
    modelIds: ["openai/gpt-oss-20b"],
    ...overrides,
  };
}

test("E2-02 W0: perfil válido projeta visão pública sem segredo", () => {
  assert.equal(CONNECTIONS_SCHEMA_VERSION, 1);
  const parsed = parseConnectionProfile(profile({ id: UUID }));
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.priority, 0);
  const view = projectConnectionView(
    { ...parsed, credentialRef: "conn:segredo" },
    { credentialPresent: true, accountLabel: "conta ••4821", supportLevel: "built_in", status: "unknown", observedAt: new Date().toISOString() },
  );
  assert.equal("credentialRef" in view, false);
  assert.equal(view.accountLabel, "conta ••4821");
  assert.doesNotThrow(() => assertViewHasNoSecrets(view));
});

test("E2-02 W0: propriedades desconhecidas, protótipos e revisões obsoletas falham", () => {
  assert.throws(() => parseConnectionProfile({ ...profile(), extra: 1 }), /connection_unknown_property/);
  assert.throws(() => parseConnectionProfile({ ...profile(), schemaVersion: 0 }), /connection_stale_revision/);
  assert.throws(() => parseConnectionProfile(JSON.parse('{"__proto__":{"x":1},"schemaVersion":1}')), /connection_/);
  assert.throws(() => parseConnectionProfile({ ...profile(), label: "  " }), /connection_invalid_label/);
  assert.throws(() => parseConnectionProfile({ ...profile(), accessMode: "cookie" }), /connection_invalid_access_mode/);
  assert.throws(() => parseConnectionProfile({ ...profile(), endpointUrl: "https://x.test/cb#frag" }), /endpoint_denied/);
  assert.throws(() => parseConnectionProfile({ ...profile(), accessMode: "custom" }), /endpoint_denied/);
  assert.doesNotThrow(
    () => parseConnectionProfile({ ...profile(), accessMode: "custom", endpointUrl: "http://127.0.0.1:11434/v1/chat/completions" }),
  );
});

test("E2-02 W0: patch exige revisão e ao menos um campo", () => {
  assert.throws(() => parseConnectionPatch({ revision: 1 }), /connection_invalid_profile/);
  assert.throws(() => parseConnectionPatch({ label: "x" }), /connection_invalid_revision/);
  assert.deepEqual(parseConnectionPatch({ revision: 2, enabled: false }), { revision: 2, enabled: false });
});

test("E2-02 W0: spec de teste limita lote, repete operação e exige teto de inferência", () => {
  const spec = parseConnectionTestSpec({ connectionIds: [UUID], mode: "metadata" });
  assert.equal(spec.maxCalls, 1);
  assert.equal(spec.maxCostMicros, "0");
  assert.throws(() => parseConnectionTestSpec({ connectionIds: [UUID, UUID], mode: "metadata" }), /connection_invalid_test/);
  assert.throws(() => parseConnectionTestSpec({ connectionIds: [UUID], mode: "inference" }), /test_budget_exceeded/);
  const paid = parseConnectionTestSpec({ connectionIds: [UUID], mode: "inference", maxCostMicros: "5000", operationId: UUID });
  assert.equal(paid.operationId, UUID);
  assert.throws(() => parseConnectionTestSpec({ connectionIds: [UUID], mode: "metadata", maxCalls: 65 }), /connection_invalid_test/);
  assert.equal(CONNECTION_LIMITS.maxConnectionsPerDevice, 64);
  const result = parseConnectionTestResult({ connectionId: UUID, result: "ok", observedAt: new Date().toISOString() });
  assert.equal(result.result, "ok");
});

test("E2-02 W0: instalação exige runtime, modelo e destino; oauth exige escopos", () => {
  assert.throws(() => parseModelInstallSpec({ runtime: "ollama" }), /connection_invalid_install/);
  const spec = parseModelInstallSpec({ runtime: "ollama", modelId: "llama3.2", destinationId: "localhost" });
  assert.equal(spec.expectedDigest, null);
  assert.throws(() => parseOAuthStart({ providerId: "x", scopes: [] }), /oauth_scope_denied/);
  assert.deepEqual(parseOAuthStart({ providerId: "acme", scopes: ["chat"] }).scopes, ["chat"]);
});

test("E2-02 W0: canário falha fechado diante de segredo em projeção", () => {
  assert.throws(() => assertViewHasNoSecrets({ credentialRef: "conn:x" }), /connection_secret_leaked/);
  assert.throws(() => assertViewHasNoSecrets({ nested: { refresh_token: "abc" } }), /connection_secret_leaked/);
  assert.throws(() => assertViewHasNoSecrets({ nested: { accessToken: "abc" } }), /connection_secret_leaked/);
  assert.throws(() => assertViewHasNoSecrets({ data: { apiKey: "abc" } }), /connection_secret_leaked/);
  assert.doesNotThrow(() => assertViewHasNoSecrets({ accountLabel: "conta ••48", status: "unknown" }));
});
