const READ_ACTIONS = new Set(['list_plugins', 'list_bundles', 'list_version_exemptions'])

export function isPluginMutation(action) {
  return !READ_ACTIONS.has(action)
}

export function safePluginTarget(value) {
  if (typeof value !== 'string' || value.length === 0) return '(current profile)'
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function outcomeError(outcome) {
  switch (outcome) {
    case 'rejected': return 'the user rejected this trusted plugin change; nothing changed, so stop instead of working around it'
    case 'cancelled': return 'approval for this trusted plugin change was cancelled'
    case 'unavailable': return 'this trusted plugin change requires approval, but no approval channel is available'
    default: return `unsupported plugin approval outcome: ${String(outcome)}`
  }
}

/** Require a one-shot, exact approval when full-access would otherwise silently trust Host code. */
export async function approveTrustedPluginMutation({ args, approver, agent, callId, signal }) {
  if (!isPluginMutation(args.action)) return
  if (approver === undefined) {
    throw new Error('this trusted plugin change requires approval, but no approval service is composed')
  }
  if (agent === undefined) {
    throw new Error('this trusted plugin change requires approval, but the call has no agent to route it through')
  }
  signal?.throwIfAborted()
  const target = safePluginTarget(args.target)
  const outcome = await approver.request({
    agent,
    toolName: 'plugin_manager',
    callId,
    requireInteraction: true,
    reason: `trusted controller plugin change: ${args.action} ${target}. This persists across sessions and runs outside the workspace sandbox.`,
    displayReason: {
      en: `Allow ${args.action} for ${target} as trusted controller code? This changes every session in this profile.`,
      pt: `Permitir ${args.action} para ${target} como código confiável do controlador? Isto altera todas as sessões deste perfil.`,
      zh: `允许将 ${target} 执行 ${args.action} 并作为控制器可信代码吗？这会影响此配置文件中的所有会话。`,
    },
    ...(signal ? { signal } : {}),
  })
  signal?.throwIfAborted()
  if (outcome !== 'allowed-once') throw new Error(outcomeError(outcome))
}

