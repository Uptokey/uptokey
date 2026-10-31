import {randomBytes} from 'node:crypto';

const INPUTS = new Set(['mcp__computer__computer_click','mcp__computer__computer_type','mcp__computer__computer_key','mcp__computer__computer_scroll']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
export function validFocusCorrelation(value) {
  return value && Object.keys(value).length === 4 && text(value.sessionId) && text(value.callId)
    && INPUTS.has(value.toolName) && /^[a-f0-9]{64}$/.test(value.fingerprint);
}
const same = (a,b) => a && b && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => a[key] === b[key]);

// Ephemeral handshake within the existing owner, never another approval service.
// The Host guard remains the sole input authority. Neither a renderer boolean
// nor receipt of a ticket can mark it approved: only the private owner pipe can.
export function createFocusTickets({leaseId,expiresAt,required,notify,isReady,now=Date.now}) {
  const entries = new Map(); let closed = false;
  const remove = (id, notifyOwner=true) => {
    const entry=entries.get(id);if(!entry)return;
    entries.delete(id);clearTimeout(entry.timer);entry.register.reject(Error('Computer focus unavailable'));
    entry.decision.resolve(false);
    if(notifyOwner)notify({type:'focus-cancel',id});
  };
  const live = entry => !closed && isReady() && entry && entry.ticket.expiresAt>now() && expiresAt>now();
  return {
    async request(input) {
      if(closed || !isReady() || expiresAt<=now() || !input || !['prepare','consume','cancel'].includes(input.operation))throw Error('Computer focus unavailable');
      if(input.operation==='prepare') {
        if(Object.keys(input).length!==2 || !validFocusCorrelation(input.correlation))throw Error('Invalid computer focus request');
        if(!required)return {required:false};
        if(entries.size>=8)throw Error('Computer focus capacity');
        const id=randomBytes(16).toString('hex');
        const ticket={id,leaseId,...input.correlation,expiresAt:Math.min(expiresAt,now()+60000)};
        const entry={ticket,phase:'registering',register:Promise.withResolvers(),decision:Promise.withResolvers(),timer:null};
        // Rejections can precede the arm await during synchronous pipe failure.
        entry.register.promise.catch(()=>{});
        entry.timer=setTimeout(()=>remove(id),Math.min(60000,ticket.expiresAt-now()));entry.timer.unref?.();
        entries.set(id,entry);
        try {
          notify({type:'focus-register',ticket});
          let timeout;
          try {await Promise.race([entry.register.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Computer focus unavailable')),3000)})]);}
          finally {clearTimeout(timeout);}
          if(!live(entry)||entry.phase!=='registered')throw Error('Computer focus unavailable');
          return {required:true,ticket};
        }catch(error){remove(id);throw error;}
      }
      if(Object.keys(input).length!==2 || !input.ticket || input.ticket.leaseId!==leaseId)throw Error('Invalid computer focus ticket');
      const entry=entries.get(input.ticket.id);
      if(input.operation==='cancel') {
        if(entry&&!same(entry.ticket,input.ticket))throw Error('Invalid computer focus correlation');
        remove(input.ticket.id);return {cancelled:true};
      }
      if(!live(entry)||!same(entry.ticket,input.ticket))throw Error('Computer focus unavailable');
      let timeout;
      let approved=false;
      try {approved=await Promise.race([entry.decision.promise,new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),2000)})]);}
      finally {clearTimeout(timeout);}
      const consumed=approved && live(entry) && entries.get(entry.ticket.id)===entry && entry.phase==='approved';
      remove(entry.ticket.id);return {consumed:Boolean(consumed)};
    },
    acknowledge(message) {
      if(!message || Object.keys(message).length!==2 || !['focus-registered','focus-approved','focus-denied'].includes(message.type)
        || !/^[a-f0-9]{32}$/.test(message.id))throw Error('Invalid native focus acknowledgement');
      const entry=entries.get(message.id);
      // A cancellation/timeout may already have removed this exact request.
      if(!entry)return;
      if(!live(entry)){remove(message.id);return;}
      if(message.type==='focus-registered' && entry.phase==='registering') {
        entry.phase='registered';entry.register.resolve();return;
      }
      if(message.type==='focus-approved' && entry.phase==='registered') {
        entry.phase='approved';entry.decision.resolve(true);return;
      }
      if(message.type==='focus-denied'){remove(message.id);return;}
      throw Error('Invalid native focus acknowledgement order');
    },
    close(){if(closed)return;closed=true;for(const id of [...entries.keys()])remove(id);},
    size:()=>entries.size,
  };
}
