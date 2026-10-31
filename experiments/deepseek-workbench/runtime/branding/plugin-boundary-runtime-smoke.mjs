import assert from 'node:assert/strict'
import { apply } from '/opt/harness/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js'

function harness(outcome = 'allowed-once') {
  let tool
  const approvals = []
  const managerCalls = []
  const ctx = {
    tools: { register(value) { tool = value } },
    sandboxPolicy: { resolve() { return { mode: 'danger-full-access' } } },
    get(name) {
      assert.equal(name, 'approval')
      return { request: async request => { approvals.push(request); return outcome } }
    },
    pluginManager: {
      async listPlugins() { managerCalls.push(['listPlugins']); return [] },
      async setBundleEnabled(target, enabled) {
        managerCalls.push(['setBundleEnabled', target, enabled])
        return { application: 'applied' }
      },
    },
  }
  apply(ctx)
  assert.ok(tool?.execute)
  return { tool, approvals, managerCalls }
}

const exec = { agent: { session: {} }, callId: 'compiled-smoke', signal: new AbortController().signal }

const read = harness()
assert.deepEqual(JSON.parse(await read.tool.execute({ action: 'list_plugins' }, exec)), {
  entries: [], total: 0, nextOffset: null,
})
assert.equal(read.approvals.length, 0)
assert.deepEqual(read.managerCalls, [['listPlugins']])

const allowed = harness()
assert.equal(JSON.parse(await allowed.tool.execute({
  action: 'set_bundle', target: '@uptokey/proof', enabled: false,
}, exec)).application, 'applied')
assert.equal(allowed.approvals.length, 1)
assert.equal(allowed.approvals[0].requireInteraction, true)
assert.match(allowed.approvals[0].reason, /trusted controller plugin change/)
assert.deepEqual(allowed.managerCalls, [['setBundleEnabled', '@uptokey/proof', false]])

const denied = harness('rejected')
await assert.rejects(denied.tool.execute({
  action: 'set_bundle', target: '@uptokey/proof', enabled: true,
}, exec), /rejected this trusted plugin change/)
assert.equal(denied.approvals.length, 1)
assert.deepEqual(denied.managerCalls, [])

console.log(JSON.stringify({
  compiledPackage: '@deepseek-ai/dsh-plugin-manager',
  fullAccessReadApprovals: read.approvals.length,
  fullAccessMutationApprovals: allowed.approvals.length,
  rejectedMutationCalls: denied.managerCalls.length,
}))

