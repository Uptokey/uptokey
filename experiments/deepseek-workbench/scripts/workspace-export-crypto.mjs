import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hostEnvironment} from './host-environment.mjs';
const execute=promisify(execFile),connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
export const MAX_ENCRYPTED_EXPORT_BYTES=35*1024*1024;

export async function transformWorkspaceExport(bytes,mode,{container='uptokey-deepseek-workbench',secretName='uptokey-workbench-vault-key'}={}){
 if(!['encrypt','decrypt'].includes(mode)||!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>MAX_ENCRYPTED_EXPORT_BYTES)throw Error('workspace-export-crypto-invalid');
 if(typeof secretName!=='string'||secretName.length<1||secretName.length>128||!secretName.split('').every(value=>/[a-z0-9-]/.test(value)))throw Error('workspace-export-crypto-invalid');
 const env=hostEnvironment(),inspected=await execute('podman',[...connection,'inspect',container],{env,windowsHide:true,timeout:5000,maxBuffer:1024*1024});
 const item=JSON.parse(inspected.stdout)[0];
 if(item?.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State?.Running||item.Mounts?.some(m=>m.Type==='bind')
  ||!/^[a-f0-9]{64}$/.test(item.Id)||!item.Config?.Secrets?.some(secret=>secret.Name===secretName))throw Error('workspace-export-crypto-unavailable');
 const program=`import {readFile} from 'node:fs/promises';import {encryptWorkspaceExport,decryptWorkspaceExport} from '/opt/harness/extensions/encrypted-export.mjs';const mode=process.argv[1],limit=35*1024*1024,chunks=[];let length=0;for await(const chunk of process.stdin){length+=chunk.length;if(length>limit)throw Error('limit');chunks.push(Buffer.from(chunk))}const input=Buffer.concat(chunks),raw=await readFile('/run/secrets/uptokey-workbench-vault-key','utf8');if(!/^[a-f0-9]{64}$/.test(raw))throw Error('key');const key=Buffer.from(raw,'hex');try{const output=await(mode==='encrypt'?encryptWorkspaceExport(input,key):decryptWorkspaceExport(input,key));await new Promise((ok,bad)=>process.stdout.write(output,error=>error?bad(error):ok()))}finally{key.fill(0);input.fill(0);for(const chunk of chunks)chunk.fill(0)}`;
 const maximum=mode==='encrypt'?MAX_ENCRYPTED_EXPORT_BYTES:34*1024*1024;
 const output=await new Promise((resolve,reject)=>{
  const child=execFile('podman',[...connection,'exec','--user','1000:1000','-i',item.Id,'node','--input-type=module','-e',program,mode],
   {env,windowsHide:true,timeout:90000,maxBuffer:maximum,encoding:'buffer'},(error,stdout)=>error?reject(Error('workspace-export-crypto-failed')):resolve(stdout));
  child.stdin.on('error',()=>{});child.stdin.end(Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
 });
 if(!Buffer.isBuffer(output)||output.length===0||output.length>maximum)throw Error('workspace-export-crypto-failed');
 return output;
}
