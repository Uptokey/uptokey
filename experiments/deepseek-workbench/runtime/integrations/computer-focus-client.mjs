import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
import {connect} from 'node:net';

function readLease() {
  const fd=openSync('/tmp/uptokey-computer-session.json',constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const meta=fstatSync(fd);
    if(!meta.isFile()||(meta.mode&0o777)!==0o600||meta.size>4096)throw Error('Computer session unavailable');
    const value=JSON.parse(readFileSync(fd,'utf8'));
    if(value.schema!=='uptokey.computer.session.v1'||value.port!==43196||!Number.isSafeInteger(value.expiresAt)
      ||value.expiresAt<=Date.now()||!/^[a-f0-9]{32}$/.test(value.id)||!/^[a-f0-9]{64}$/.test(value.capability))throw Error('Computer session unavailable');
    return value;
  }finally{closeSync(fd);}
}

// Same capability/loopback tunnel as MCP; no new listener, provider or secret.
export function focusControl(lease,input,{open=connect,signal}={}) {
  return new Promise((resolve,reject)=>{
    let bytes=Buffer.alloc(0),done=false;
    const socket=open({host:'127.0.0.1',port:lease.port});
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(value);};
    const abort=()=>finish(Error('Computer focus cancelled'));
    const timeout=setTimeout(()=>finish(Error('Computer focus unavailable')),5000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    socket.once('connect',()=>socket.write(lease.capability+' focus '+JSON.stringify(input)+'\n'));
    socket.on('data',chunk=>{
      if(bytes.length+chunk.length>4096){finish(Error('Invalid computer focus response'));return;}
      bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf(10);if(end<0)return;
      try{const value=JSON.parse(bytes.subarray(0,end).toString());
        if(end!==bytes.length-1||value.error||!value||typeof value!=='object')throw Error();
        finish(null,value);
      }catch{finish(Error('Computer focus unavailable'));}
    });
    socket.once('error',()=>finish(Error('Computer focus unavailable')));
    socket.once('close',()=>finish(Error('Computer focus unavailable')));
  });
}

export async function prepareComputerFocus(correlation,signal,{lease=readLease(),request=focusControl}={}) {
  const prepared=await request(lease,{operation:'prepare',correlation},{signal});
  if(prepared.required===false && Object.keys(prepared).length===1)return null;
  const ticket=prepared.ticket;
  if(prepared.required!==true||Object.keys(prepared).length!==2||!ticket||Object.keys(ticket).length!==7
    ||ticket.leaseId!==lease.id||!/^[a-f0-9]{32}$/.test(ticket.id)||!Number.isSafeInteger(ticket.expiresAt)||ticket.expiresAt<=Date.now()||ticket.expiresAt>lease.expiresAt
    ||Object.keys(correlation).some(key=>ticket[key]!==correlation[key]))throw Error('Invalid computer focus correlation');
  let settled=false;
  const cancel=async()=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);
    try{await request(lease,{operation:'cancel',ticket});}catch{}};
  const onAbort=()=>{void cancel();};
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted){await cancel();throw Error('Computer focus cancelled');}
  return {
    ticket,
    async consume(){if(settled||signal?.aborted)return false;
      const response=await request(lease,{operation:'consume',ticket},{signal});
      settled=true;signal?.removeEventListener('abort',onAbort);
      return Object.keys(response).length===1&&response.consumed===true;},
    cancel,
  };
}
