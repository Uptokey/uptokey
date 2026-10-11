import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEgressProxy,
  projectEgressProxyPublic,
  parseProxyPool,
  parseProxyBinding,
  parseEgressReceipt,
  parseProxyTestJob,
  validateNoProxyRules,
  EGRESS_ERROR_CODES,
} from "../egress.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

it('CIDR exceptions reject malformed octets and prefix lengths',()=>{
  for(const rule of ['999.0.0.1/8','10.0.0.0/33','10.0.0.0/99','01.2.3.4/8']){
    assert.throws(()=>validateNoProxyRules([rule]),/no_proxy_invalid/);
  }
  assert.deepEqual(validateNoProxyRules(['10.0.0.0/8','0.0.0.0/0','*.example.com']),['10.0.0.0/8','0.0.0.0/0','*.example.com']);
});

describe("E2-19 W0 EgressProxy", () => {
  it("parses valid http proxy and strips credential from public projection", () => {
    const proxy = parseEgressProxy({
      schemaVersion: 1,
      id: ID1,
      revision: 1,
      label: "office-http",
      kind: "http",
      endpointUrl: "http://proxy.example:8080",
      enabled: true,
      credentialRef: "vault:proxy-office",
    });
    assert.equal(proxy.credentialRef, "vault:proxy-office");
    const pub = projectEgressProxyPublic(proxy);
    assert.equal(pub.hasCredential, true);
    assert.equal("credentialRef" in pub, false);
    assert.equal(pub.endpointUrl.includes("@"), false);
  });

  it("rejects userinfo and fragment in endpointUrl", () => {
    assert.throws(
      () =>
        parseEgressProxy({
          schemaVersion: 1,
          id: ID1,
          revision: 1,
          label: "bad",
          kind: "http",
          endpointUrl: "http://user:pass@proxy.example:8080",
          enabled: true,
        }),
      /endpoint_url_userinfo_forbidden/,
    );
    assert.throws(
      () =>
        parseEgressProxy({
          schemaVersion: 1,
          id: ID1,
          revision: 1,
          label: "bad",
          kind: "https",
          endpointUrl: "https://proxy.example/#frag",
          enabled: true,
        }),
      /endpoint_url_fragment_forbidden/,
    );
  });
});

describe("E2-19 W0 ProxyPool", () => {
  it("rejects strict + allowDirectFallback", () => {
    assert.throws(
      () =>
        parseProxyPool({
          id: ID2,
          revision: 1,
          memberIds: [ID1],
          strategy: "fixed",
          strict: true,
          allowDirectFallback: true,
          noProxy: [],
        }),
      /proxy_pool_strict_fallback_conflict/,
    );
  });

  it("accepts round_robin pool with noProxy suffix/CIDR", () => {
    const pool = parseProxyPool({
      id: ID2,
      revision: 2,
      memberIds: [ID1, ID3],
      strategy: "round_robin",
      strict: true,
      allowDirectFallback: false,
      noProxy: [".internal.example", "10.0.0.0/8"],
    });
    assert.equal(pool.memberIds.length, 2);
    assert.deepEqual(pool.noProxy, [".internal.example", "10.0.0.0/8"]);
  });

  it("rejects universal wildcard noProxy", () => {
    assert.throws(() => validateNoProxyRules(["*"]), /no_proxy_universal_forbidden/);
  });
});

describe("E2-19 W0 binding/receipt/test", () => {
  it("parses binding and receipt without credential host", () => {
    const binding = parseProxyBinding({
      ownerKind: "connection",
      ownerId: "conn-1",
      poolId: ID2,
      inherit: false,
      expectedRevision: 2,
    });
    assert.equal(binding.poolId, ID2);
    const receipt = parseEgressReceipt({
      attemptId: "att-1",
      poolId: ID2,
      poolRevision: 2,
      memberId: ID1,
      finalHost: "proxy.example:8080",
      transportKind: "http",
      usedDirect: false,
      reason: "selected",
    });
    assert.equal(receipt.usedDirect, false);
    assert.throws(
      () =>
        parseEgressReceipt({
          attemptId: "att-2",
          finalHost: "user:pass@proxy.example",
          transportKind: "http",
          usedDirect: false,
          reason: "leak",
        }),
      /egress_receipt_credential_leak/,
    );
  });

  it("parses test job", () => {
    const job = parseProxyTestJob({
      id: ID3,
      memberIds: [ID1],
      approvedTargetId: "fixture:echo",
      operationId: "op-1",
      state: "queued",
      cursor: 0,
    });
    assert.equal(job.state, "queued");
  });

  it("exposes expected HTTP status map", () => {
    assert.equal(EGRESS_ERROR_CODES.strict_pool_unavailable, 503);
    assert.equal(EGRESS_ERROR_CODES.proxy_auth_failed, 407);
    assert.equal(EGRESS_ERROR_CODES.pool_revision_conflict, 409);
  });
});
