import test from 'node:test'
import assert from 'node:assert/strict'
import { patchExplicitApproval } from './explicit-approval-patch.mjs'

const fixture = `async decide(req, session) {
  if (this.effectivePolicy(session) === "never") return "rejected";
  return ask(req)
}`

test('trusted callers can require the canonical answerer even under never policy', () => {
  const patched = patchExplicitApproval(fixture)
  assert.match(patched, /effectivePolicy\(session\) === "never" && req\.requireInteraction !== true/)
  assert.equal(patchExplicitApproval(patched), patched)
})

test('ordinary approval requests keep the pinned never-policy behavior', () => {
  const patched = patchExplicitApproval(fixture)
  const decide = new Function('req', 'session', 'ask', `
    ${patched.match(/if \([^;]+;/)[0]}
    return ask(req)
  `)
  const service = { effectivePolicy: () => 'never' }
  assert.equal(decide.call(service, {}, {}, () => 'asked'), 'rejected')
  assert.equal(decide.call(service, { requireInteraction: true }, {}, () => 'asked'), 'asked')
})

test('version drift fails instead of silently disabling explicit approval', () => {
  assert.throws(() => patchExplicitApproval(fixture.replace('never', 'disabled')), /policy branch/)
})
