const IMPORT = "import { approveTrustedPluginMutation } from '/opt/harness/branding/plugin-trust-approval.mjs';\n"

const OLD_DESCRIPTION = 'Every action requires danger-full-access permission or approval for this call. Approval does not change the session permission mode.'
const NEW_DESCRIPTION = 'Read-only lists use the current permission. Every profile change requires danger-full-access and one explicit approval for the exact call, including sessions already in danger-full-access. Approval does not change the session permission mode.'

const OLD_BLOCK = `            const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
            await approveEscalation({
                requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation',
                justification: \`plugin_manager \${JSON.stringify(args)}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.\`,
            }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
                toolName: 'plugin_manager', signal: exec.signal });
            exec.signal.throwIfAborted();`

const NEW_BLOCK = `            const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
            if (policy.mode === 'danger-full-access') {
                await approveTrustedPluginMutation({ args, approver: ctx.get('approval'), agent: exec.agent,
                    callId: exec.callId, signal: exec.signal });
            }
            else {
                await approveEscalation({
                    requestedMode: 'danger-full-access', effectiveMode: policy.mode, subject: 'plugin management operation',
                    justification: \`plugin_manager \${JSON.stringify(args)}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.\`,
                }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
                    toolName: 'plugin_manager', signal: exec.signal });
            }
            exec.signal.throwIfAborted();`

export function patchPluginBoundary(source) {
  if (source.includes(IMPORT.trim()) && source.includes(NEW_BLOCK)) return source
  if (!source.includes(OLD_DESCRIPTION)) throw new Error('Missing pinned plugin-manager description')
  if (!source.includes(OLD_BLOCK)) throw new Error('Missing pinned plugin-manager approval block')
  let patched = source.replace(OLD_DESCRIPTION, NEW_DESCRIPTION).replace(OLD_BLOCK, NEW_BLOCK)
  patched = IMPORT + patched
  if ((patched.match(/approveTrustedPluginMutation/g) ?? []).length !== 2) {
    throw new Error('Unexpected trusted plugin approval patch count')
  }
  return patched
}

