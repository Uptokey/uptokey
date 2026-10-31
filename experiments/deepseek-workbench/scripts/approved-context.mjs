import {listApprovedContexts,importApprovedContext,revokeApprovedContext,beginApprovedContextConnection,consumeApprovedContextConnection,ContextSnapshotError} from './approved-context-client.mjs';
import {nativeSecret} from './core-bridge-server.mjs';
let raw='';
try{
  for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error('input_limit');}
  const input=JSON.parse(raw);raw='';
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('input_invalid');
  const keys=Object.keys(input).sort().join(',');
  if(input.operation==='list'&&keys==='operation'){
    console.log(JSON.stringify(await listApprovedContexts({token:nativeSecret('client-token')})));
  }else if(input.operation==='import'&&keys==='operation,selection'){
    console.log(JSON.stringify(await importApprovedContext(input.selection,{token:nativeSecret('client-token')})));
  }else if(input.operation==='revoke'&&keys==='operation'){
    console.log(JSON.stringify(await revokeApprovedContext({token:nativeSecret('client-token')})));
  }else if(input.operation==='connect-begin'&&keys==='operation'){
    console.log(JSON.stringify(await beginApprovedContextConnection({token:nativeSecret('client-token')})));
  }else if(input.operation==='connect-consume'&&keys==='operation,session'){
    const link=await consumeApprovedContextConnection(input.session,{token:nativeSecret('client-token')});
    console.log(JSON.stringify({connected:true,clientId:link.clientId,revision:link.revision}));
  }else throw Error('input_invalid');
}catch(error){
  const code=error instanceof ContextSnapshotError?error.code:'context_snapshot_unavailable';
  console.log(JSON.stringify({error:code}));process.exitCode=1;
}
