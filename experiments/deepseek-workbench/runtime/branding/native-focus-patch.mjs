// Build-time adaptation of the pinned official approval presenter. The original
// waterfall, policy, audit and one-shot PendingApproval remain the authority.
export async function answerNativeFocusApproval(pending,outcome,native=globalThis.UptokeyDesktop) {
  if(outcome!=='allowed-once'||pending.nativeFocus===undefined)return pending.answer(outcome);
  const ticket=pending.nativeFocus;
  try {
    if(!pending.answerable||ticket.sessionId!==pending.sessionId||ticket.callId!==pending.callId||ticket.toolName!==pending.toolName
      ||typeof native?.approveComputerFocus!=='function')throw Error('Native focus unavailable');
    await native.approveComputerFocus(ticket);
    // A withdrawn request must not resolve allowed-once after asynchronous IPC.
    if(!pending.answerable)return;
    return await pending.answer('allowed-once');
  } catch {
    // Terminal rejection: never recycle an already consumed focus ticket or
    // leave Allow once spinning after an OS denial/expired lease/missing ACK.
    if(pending.answerable)return pending.answer('rejected');
  }
}

export function patchNativeFocusApproval(source) {
  if(source.includes('function answerNativeFocusApproval('))return source;
  const replace=(before,after)=>{
    if(source.split(before).length!==2)throw Error('Missing pinned native approval anchor');
    source=source.replace(before,after);
  };
  replace('this.displayReason = request.displayReason;','this.displayReason = request.displayReason;\nthis.nativeFocus = request.nativeFocus;');
  // Carry the ephemeral ticket through the existing scoped Remote Event, not
  // session logs, a generic question, a browser click listener or a second UI.
  const marker='...request.displayReason === void 0 ? {} : { displayReason: request.displayReason },';
  replace(marker,marker+'\n...request.nativeFocus === void 0 ? {} : { nativeFocus: request.nativeFocus },');
  replace('pending.answer(outcome).catch(', 'answerNativeFocusApproval(pending, outcome).catch(');
  return source+'\n'+answerNativeFocusApproval.toString()+'\n';
}
