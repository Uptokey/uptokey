import test from 'node:test'
import assert from 'node:assert/strict'
import { patchPluginBoundary } from './plugin-boundary-patch.mjs'

const fixture = `export const description = 'Every action requires danger-full-access permission or approval for this call. Approval does not change the session permission mode.';
async function execute(args, exec) {
            const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
            await approveEscalation({
                requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation',
                justification: \`plugin_manager \${JSON.stringify(args)}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.\`,
            }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
                toolName: 'plugin_manager', signal: exec.signal });
            exec.signal.throwIfAborted();
}`

test('compiled tool gains one explicit full-access trust gate', () => {
  const patched = patchPluginBoundary(fixture)
  assert.match(patched, /approveTrustedPluginMutation/)
  assert.match(patched, /policy\.mode === 'danger-full-access'/)
  assert.match(patched, /Every profile change requires danger-full-access and one explicit approval/)
  assert.equal(patchPluginBoundary(patched), patched)
})

test('version drift fails instead of silently dropping the boundary', () => {
  assert.throws(() => patchPluginBoundary(fixture.replace('Every action requires', 'All actions need')), /description/)
  assert.throws(() => patchPluginBoundary(fixture.replace('exec.signal.throwIfAborted();', '')), /approval block/)
})

