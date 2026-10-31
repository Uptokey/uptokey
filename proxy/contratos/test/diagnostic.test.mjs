/**
 * E2-20 W0 contract tests — diagnostic MITM ops (published additive, default OFF).
 * Ported from integrations/e2-20-diagnostic/test/contracts.test.mjs with the
 * published_additive contract status.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIAGNOSTIC_OPERATIONS,
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_ERROR_CODES,
  DIAGNOSTIC_CONTRACT_STATUS,
  listDiagnosticCapabilities,
  describeDiagnosticCapability,
  parseDiscoverInput,
  parseDiscoverOutput,
  parsePlanInput,
  parsePlanOutput,
  parseStartInput,
  parseCertificateInspectInput,
  parseCertificateInspectOutput,
  parseRoutePlanInput,
  parseObserveExportInput,
  parseObserveExportOutput,
  parseStopInput,
  assertExactLoopbackOrigins,
  assertNoInsecureSkipVerify,
} from "../diagnostic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("E2-20 W0 diagnostic contracts (published additive)", () => {
  it("catalog lists all eight operations with W0-shaped fields", () => {
    assert.equal(DIAGNOSTIC_OPERATIONS.length, 8);
    assert.equal(DIAGNOSTIC_CONTRACT_STATUS, "published_additive");
    const caps = listDiagnosticCapabilities();
    assert.equal(caps.length, 8);
    for (const c of caps) {
      assert.equal(c.schemaVersion, 1);
      assert.equal(c.packageId, "E2-20");
      assert.equal(c.configurationObserved.defaultEnabled, false);
      assert.equal(c.configurationObserved.osCaMutation, false);
      assert.equal(c.configurationObserved.dnsMutation, false);
      assert.equal(c.configurationObserved.globalProxy, false);
      assert.ok(c.handler);
      assert.ok(Array.isArray(c.effectsAdmitted));
    }
    assert.deepEqual(
      describeDiagnosticCapability("diagnostic.start").effectsAdmitted,
      ["bind_loopback_proxy", "session_ca_ephemeral"]
    );
  });

  it("operations-diagnostic.json matches DIAGNOSTIC_OPERATIONS", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../operations-diagnostic.json"), "utf8")
    );
    assert.equal(raw.contractStatus, "published_additive");
    assert.equal(raw.defaultEnabled, false);
    const ids = raw.operations.map((o) => o.operationId);
    assert.deepEqual(ids, [...DIAGNOSTIC_OPERATIONS]);
  });

  it("discover parsers enforce zero capture/dns/trust", () => {
    const input = parseDiscoverInput({ platform: "product", mode: "explicit" });
    assert.equal(input.mode, "explicit");
    const out = parseDiscoverOutput({
      support: "product",
      version: "0.1.0",
      license: "UNLICENSED",
      configurationRequired: [],
      capture: false,
      dnsMutation: false,
      globalTrust: false,
    });
    assert.equal(out.capture, false);
    assert.throws(
      () =>
        parseDiscoverOutput({
          support: "x",
          version: "1",
          license: "l",
          capture: true,
          dnsMutation: false,
          globalTrust: false,
        }),
      /plan_invalid/
    );
  });

  it("plan rejects wildcard, non-loopback, insecureSkipVerify", () => {
    assert.throws(() => assertExactLoopbackOrigins(["*"]), /wildcard_origin_forbidden/);
    assert.throws(
      () => assertExactLoopbackOrigins(["example.com"]),
      /target_not_authorized/
    );
    assert.throws(
      () => assertNoInsecureSkipVerify({ insecureSkipVerify: true }),
      /insecure_skip_verify_forbidden/
    );
    const plan = parsePlanInput({
      appRef: "product-app",
      ownershipEvidenceRef: "human-owned",
      origins: ["127.0.0.1"],
      mode: "explicit",
      collectPolicy: "off",
      limits: { ttlMs: 60_000 },
    });
    assert.equal(plan.origins[0], "127.0.0.1");
    assert.ok(plan.limits.ttlMs <= DIAGNOSTIC_LIMITS.maxSessionTtlMs);
    const out = parsePlanOutput({
      planRef: "plan_abc",
      revision: 1,
      origins: ["127.0.0.1"],
      mode: "explicit",
      collectPolicy: "off",
      confidence: 1,
      effectsExplicit: ["no_os_ca"],
      destinations: ["127.0.0.1"],
      expiresAt: null,
      limits: plan.limits,
      osCaMutation: false,
      dnsMutation: false,
    });
    assert.equal(out.osCaMutation, false);
  });

  it("start / stop / inspect / observe / route parsers", () => {
    assert.deepEqual(parseStartInput({ approvedPlanRef: "p1", requestId: "r1" }), {
      approvedPlanRef: "p1",
      requestId: "r1",
    });
    assert.deepEqual(parseCertificateInspectInput({ sessionRef: "ds_1" }), {
      sessionRef: "ds_1",
    });
    const cert = parseCertificateInspectOutput({
      fingerprint: "abc",
      issuer: "E2-20-Lab-CA",
      scope: "session_test_client_only",
      trustState: "ephemeral_uninstalled",
      privateKeyExported: false,
    });
    assert.equal(cert.privateKeyExported, false);
    assert.throws(
      () =>
        parseCertificateInspectOutput({
          fingerprint: "x",
          privateKeyExported: true,
        }),
      /collection_not_authorized/
    );
    assert.throws(
      () =>
        parseRoutePlanInput({
          sessionRef: "ds_1",
          expectedRevision: 1,
          aliasMap: { a: "example.com:443" },
          grantedDestinations: ["127.0.0.1"],
        }),
      /target_not_authorized/
    );
    const route = parseRoutePlanInput({
      sessionRef: "ds_1",
      expectedRevision: 1,
      aliasMap: { local: "127.0.0.1:8443" },
      grantedDestinations: ["127.0.0.1"],
    });
    assert.equal(route.aliasMap.local, "127.0.0.1:8443");
    const obs = parseObserveExportInput({ sessionRef: "ds_1", cursor: 0 });
    assert.equal(obs.cursor, 0);
    const exp = parseObserveExportOutput({
      records: [{ method: "GET" }],
      droppedCount: 1,
      collectionState: "off",
      nextCursor: 1,
      artifactRef: null,
    });
    assert.equal(exp.collectionState, "off");
    assert.deepEqual(parseStopInput({ sessionRef: "ds_1", expectedRevision: 1 }), {
      sessionRef: "ds_1",
      expectedRevision: 1,
      reason: "user_stop",
    });
    assert.ok(DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
  });

  it("uncertain_state error code exists for crash-before-receipt", () => {
    assert.equal(DIAGNOSTIC_ERROR_CODES.uncertain_state, "uncertain_state");
    assert.ok(DIAGNOSTIC_ERROR_CODES.uncertain_state);
  });
});
