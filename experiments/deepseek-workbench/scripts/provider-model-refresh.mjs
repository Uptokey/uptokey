import {refreshProviderModels} from './provider-model-refresh-client.mjs';
import {nativeSecret} from './core-bridge-server.mjs';
let raw='';
try{
 for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1024)throw Error('provider_model_refresh_invalid');}
 const input=JSON.parse(raw);raw='';
 if(!input||Object.keys(input).join(',')!=='providerId'||typeof input.providerId!=='string')throw Error('provider_model_refresh_invalid');
 console.log(JSON.stringify(await refreshProviderModels(input.providerId,{token:nativeSecret('client-token')})));
}catch(error){
 const code=error instanceof Error&&/^provider_[a-z_]{1,80}$/.test(error.message)?error.message:'provider_model_refresh_failed';
 console.log(JSON.stringify({error:code}));process.exitCode=1;
}
