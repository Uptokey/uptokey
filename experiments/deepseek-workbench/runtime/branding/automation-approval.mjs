export const name = 'uptokey-automation-approval';
export const inject = ['tools', 'approval'];
import {prepareComputerFocus} from '../integrations/computer-focus-client.mjs';

const BROWSER_READS = new Set(['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages',
  'browser_network_requests', 'browser_find', 'browser_generate_locator', 'browser_wait_for',
  'browser_verify_element_visible', 'browser_verify_text_visible', 'browser_verify_list_visible', 'browser_verify_value',
  'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload',
  'browser_close', 'browser_resize', 'browser_hover']);
const COMPUTER_READS = new Set(['computer_status', 'computer_windows', 'computer_snapshot', 'computer_screenshot']);

function fingerprint(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function automationApprovalRequired(name, args = {}) {
  if (name.startsWith('mcp__browser__')) {
    const operation = name.slice('mcp__browser__'.length);
    return !BROWSER_READS.has(operation) && !(operation === 'browser_tabs' && ['list', 'new', 'close', 'select'].includes(args.action));
  }
  if (name.startsWith('mcp__computer__')) return !COMPUTER_READS.has(name.slice('mcp__computer__'.length));
  return false;
}

export function apply(ctx,{prepareFocus=prepareComputerFocus}={}) {
  const approvals = new Map();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow' || !automationApprovalRequired(exec.name, exec.arguments)) return decision;
    exec.signal.throwIfAborted();
    if (!exec.agent) return { kind: 'deny', reason: 'Automation requires an active agent and its approval channel.' };
    const requestedFingerprint = fingerprint(exec.arguments);
    const isHost = exec.name.startsWith('mcp__computer__');
    let focus;
    try {
    if(isHost)focus=await prepareFocus({sessionId:exec.agent.session?.id,callId:exec.callId,toolName:exec.name,fingerprint:requestedFingerprint},exec.signal);
    // The authenticated owner returns no focus ticket on macOS/X11. Reuse
    // the original approval prompt to explain the backend's bounded manual
    // return; this hint grants neither focus nor permission to dispatch.
    const manualForeground = isHost && !focus;
    const outcome = await ctx.approval.request({
      agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
      requireInteraction: true,
      ...(focus?{nativeFocus:focus.ticket}:{}),
      reason: isHost ? 'Interact with the user-selected desktop window.' : 'Interact with the current isolated browser page.',
      displayReason: {
        en: manualForeground ? 'After allowing, bring the selected desktop window to the foreground. The action will wait up to 15 seconds; if it times out, no input will be sent.'
          : isHost ? 'Allow this action in the selected desktop window?' : 'Allow this browser page interaction?',
        pt: manualForeground ? 'Após permitir, traga a janela selecionada para a frente. A ação aguardará até 15 segundos; se o prazo expirar, nenhuma entrada será enviada.'
          : isHost ? 'Permitir esta ação na janela selecionada do computador?' : 'Permitir esta interação na página do navegador?',
      },
    });
    exec.signal.throwIfAborted();
    if (outcome !== 'allowed-once') return { kind: 'deny', reason: `Automation approval ${outcome}; do not retry through a different tool.` };
    if (fingerprint(exec.arguments) !== requestedFingerprint) return { kind: 'deny', reason: 'Automation arguments changed while approval was pending.' };
    if (focus && !await focus.consume()) return {kind:'deny',reason:'The exact native focus handoff was not accepted. No input was dispatched.'};
    exec.signal.throwIfAborted();
    approvals.set(exec.token, { name: exec.name, fingerprint: requestedFingerprint });
    return decision;
    } catch(error) {
      exec.signal.throwIfAborted();
      return {kind:'deny',reason:'Native computer approval is unavailable. No input was dispatched.'};
    } finally {await focus?.cancel();}
  });
  ctx.tools.guard(exec => {
    if (!automationApprovalRequired(exec.name, exec.arguments)) return;
    const approved = approvals.get(exec.token);
    approvals.delete(exec.token);
    if (approved?.name !== exec.name || approved?.fingerprint !== fingerprint(exec.arguments))
      return 'This exact automation action has no current one-shot approval.';
  });
  ctx.on('tools/result', exec => { approvals.delete(exec.token); });
  ctx.on('dispose', () => approvals.clear());
}
import { createHash } from 'node:crypto';

