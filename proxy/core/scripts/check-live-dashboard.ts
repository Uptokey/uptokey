import {createOfficialSecretStore} from '../src/secret-store.ts';
const token = await createOfficialSecretStore().get('local:api-token');
if (!token) throw new Error('local_token_missing');
const response = await fetch('http://127.0.0.1:21435/v1/connections', {headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(5000)});
if (!response.ok) { console.log(JSON.stringify({status:response.status})); process.exitCode=1; }
else {
 const data=await response.json();
 console.log(JSON.stringify({status:response.status,providers:data.providers.map((item:any)=>({id:item.id,configured:item.configured,enabled:item.enabled,eligible:item.admission.eligible,reason:item.admission.reason,modelCount:item.models.length}))}));
}
const localModels = await fetch('http://127.0.0.1:21435/v1/local-models', {headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(5000)});
const localData = localModels.ok ? await localModels.json() : null;
console.log(JSON.stringify({route:'local-models',httpStatus:localModels.status,status:localData?.status,modelCount:localData?.models?.length}));
