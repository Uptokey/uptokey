import {accountInput,requestCanonicalAccount} from './canonical-account-client.mjs';
import {nativeSecret} from './core-bridge-server.mjs';
let raw='';
try{
 for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>20000)throw Error('account_request_invalid');}
 const input=JSON.parse(raw);raw='';
 if(!input||Object.keys(input).sort().join(',')!=='input,path')throw Error('account_request_invalid');
 accountInput(input.path,input.input);
 console.log(JSON.stringify(await requestCanonicalAccount(input.path,input.input,{token:nativeSecret('client-token')})));
}catch{console.log(JSON.stringify({status:503,body:{error:'account_unavailable'}}));process.exitCode=1;}
