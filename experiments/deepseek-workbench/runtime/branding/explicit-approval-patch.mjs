const OLD_POLICY = 'if (this.effectivePolicy(session) === "never") return "rejected";'
const NEW_POLICY = 'if (this.effectivePolicy(session) === "never" && req.requireInteraction !== true) return "rejected";'

export function patchExplicitApproval(source) {
  if (source.includes(NEW_POLICY)) return source
  if (!source.includes(OLD_POLICY)) throw new Error('Missing pinned approval policy branch')
  const patched = source.replace(OLD_POLICY, NEW_POLICY)
  if ((patched.match(/req\.requireInteraction/g) ?? []).length !== 1) {
    throw new Error('Unexpected explicit approval patch count')
  }
  return patched
}
