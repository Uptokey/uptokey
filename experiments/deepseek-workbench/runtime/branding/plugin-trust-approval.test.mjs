import test from 'node:test'
import assert from 'node:assert/strict'
import {
  approveTrustedPluginMutation,
  isPluginMutation,
  safePluginTarget,
} from './plugin-trust-approval.mjs'

test('only profile-changing plugin actions require explicit trust approval', () => {
  for (const action of ['list_plugins', 'list_bundles', 'list_version_exemptions']) {
    assert.equal(isPluginMutation(action), false)
  }
  for (const action of ['set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'set_version_exemption']) {
    assert.equal(isPluginMutation(action), true)
  }
})

test('URL credentials, query and fragment never enter the approval ledger', () => {
  assert.equal(safePluginTarget('https://user:secret@example.test/pkg.tgz?token=hidden#x'), 'https://example.test/pkg.tgz')
  assert.equal(safePluginTarget('@uptokey/plugin@1.0.0'), '@uptokey/plugin@1.0.0')
})

test('read-only listing does not ask for an extra approval', async () => {
  let calls = 0
  await approveTrustedPluginMutation({
    args: { action: 'list_plugins' },
    approver: { request: async () => { calls++; return 'allowed-once' } },
    agent: {}, callId: 'read',
  })
  assert.equal(calls, 0)
})

test('exact mutation is approved once with a redacted, persistent-host warning', async () => {
  const seen = []
  await approveTrustedPluginMutation({
    args: { action: 'install_bundle', target: 'https://me:pw@example.test/plugin.tgz?auth=x' },
    approver: { request: async request => { seen.push(request); return 'allowed-once' } },
    agent: { id: 'agent' }, callId: 'call-1',
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].requireInteraction, true)
  assert.match(seen[0].reason, /install_bundle https:\/\/example\.test\/plugin\.tgz/)
  assert.match(seen[0].reason, /persists across sessions/)
  assert.doesNotMatch(JSON.stringify(seen[0]), /me:pw|auth=x/)
})

test('missing routing fails closed before plugin mutation', async () => {
  await assert.rejects(
    approveTrustedPluginMutation({ args: { action: 'remove_bundle', target: 'x' }, agent: {}, callId: 'x' }),
    /no approval service is composed/,
  )
  await assert.rejects(
    approveTrustedPluginMutation({ args: { action: 'remove_bundle', target: 'x' }, approver: {}, callId: 'x' }),
    /no agent to route it through/,
  )
})

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  test(`${outcome} never authorizes a mutation`, async () => {
    await assert.rejects(approveTrustedPluginMutation({
      args: { action: 'set_bundle', target: 'x', enabled: true },
      approver: { request: async () => outcome }, agent: {}, callId: outcome,
    }), new RegExp(outcome === 'rejected' ? 'rejected' : outcome === 'cancelled' ? 'cancelled' : 'no approval channel'))
  })
}

test('abort before and after the decision fails closed', async () => {
  const before = new AbortController(); before.abort()
  await assert.rejects(approveTrustedPluginMutation({
    args: { action: 'set_plugin', target: 'x', enabled: true },
    approver: { request: async () => 'allowed-once' }, agent: {}, callId: 'before', signal: before.signal,
  }), /abort/i)
  const after = new AbortController()
  await assert.rejects(approveTrustedPluginMutation({
    args: { action: 'set_plugin', target: 'x', enabled: true },
    approver: { request: async () => { after.abort(); return 'allowed-once' } },
    agent: {}, callId: 'after', signal: after.signal,
  }), /abort/i)
})

