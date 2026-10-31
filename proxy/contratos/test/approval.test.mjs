import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanApproval } from '../workflow.js';
const approval = { id:'approval_1', projectId:'project_1', planId:'plan_1', planDigest:'a'.repeat(64), principalId:'client_1', destinations:[{kind:'provider',id:'groq'}], expiresAt:'2026-09-16T23:00:00.000Z', consumedByRunId:null };
test('approval preserves canonical W3 shape and returns a detached record', () => {
  const parsed = parsePlanApproval(approval);
  assert.deepEqual(parsed, approval);
  parsed.destinations[0].id = 'gemini';
  assert.equal(approval.destinations[0].id, 'groq');
});
test('approval rejects invalid dates, destinations, digest and injected fields', () => {
  for (const patch of [{expiresAt:'2026-02-30T00:00:00.000Z'}, {destinations:[]}, {planDigest:'invalid'}, {token:'secret'}, {consumedByRunId:'../run'}]) {
    assert.throws(() => parsePlanApproval({...approval,...patch}));
  }
});
