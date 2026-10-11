import {createHash} from 'node:crypto';
import type {ProjectRunRequest} from '@uptokey/sync-contract/project-agent';
import {assertPublicHost,fetchPinnedPublic,type HostResolver} from '../network-policy.ts';
import {ProjectRuntimeError} from './project-oci.ts';

/** Downloads only the exact W5-approved public artifacts. Container traffic remains disabled.
 * This stages archives for offline tools; it does not resolve npm/pip packages or run installers on the host. */
export async function fetchProjectDependencies(
 dependencies:NonNullable<ProjectRunRequest['execution']>['dependencies'],
 signal:AbortSignal|undefined,
 assertAuthority:()=>void|Promise<void>,
 transport:{resolve?:HostResolver;fetch?:typeof fetchPinnedPublic}={},
):Promise<{path:string;bytes:Buffer}[]>{
 const files:{path:string;bytes:Buffer}[]=[];let total=0;
 const deadline=AbortSignal.timeout(30000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
 const wait=<T>(operation:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  if(bounded.aborted){operation.catch(()=>{});reject(bounded.reason);return;}
  const abort=()=>reject(bounded.reason);bounded.addEventListener('abort',abort,{once:true});
  operation.then(resolve,reject).finally(()=>bounded.removeEventListener('abort',abort));
 });
 for(const item of dependencies??[]){
  bounded.throwIfAborted();await assertAuthority();
  const target=new URL(item.url);
  if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw new ProjectRuntimeError('runtime_dependency_url_invalid');
  const addresses=await wait(assertPublicHost(target.hostname,transport.resolve));
  bounded.throwIfAborted();await assertAuthority();
  const response=await wait((transport.fetch??fetchPinnedPublic)(item.url,{method:'GET',redirect:'manual',signal:bounded,headers:{accept:'application/octet-stream'}},addresses));
  if(response.status!==200||!response.body){await response.body?.cancel();throw new ProjectRuntimeError('runtime_dependency_download_failed');}
  const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;
  try{for(;;){bounded.throwIfAborted();const {done,value}=await wait(reader.read());if(done)break;length+=value.length;total+=value.length;
    if(length>8*1048576||total>16*1048576)throw new ProjectRuntimeError('runtime_dependency_size_limit');chunks.push(Buffer.from(value));}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=Buffer.concat(chunks);
  if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new ProjectRuntimeError('runtime_dependency_integrity_failed');
  bounded.throwIfAborted();await assertAuthority();
  files.push({path:`.uptokey-dependencies/${item.path}`,bytes});
 }
 return files;
}
