import {createHash} from 'node:crypto';
import {mkdir,lstat,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {exportWorkspaceBytes} from './export-workspace.mjs';
import {transformWorkspaceExport} from './workspace-export-crypto.mjs';
import {statePath} from './harness-paths.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export async function exportWorkspaceEncryptedBytes({executorContainer='uptokey-workbench-executor',controllerContainer='uptokey-deepseek-workbench',controllerSecretName='uptokey-workbench-vault-key'}={}){
 let archive,encrypted;
 try{
  archive=await exportWorkspaceBytes({container:executorContainer});encrypted=await transformWorkspaceExport(archive,'encrypt',{container:controllerContainer,secretName:controllerSecretName});
  if(!encrypted.subarray(0,8).equals(Buffer.from('UPTKEX01')))throw Error('workspace-export-encrypted-invalid');
  return Buffer.from(encrypted);
 }finally{archive?.fill(0);encrypted?.fill(0)}
}
async function main(stream){
 let encrypted;
 try{
  encrypted=await exportWorkspaceEncryptedBytes();
  if(stream){process.stdout.on('error',()=>{});await new Promise((ok,bad)=>process.stdout.write(encrypted,error=>error?bad(error):ok()));return}
  const directory=statePath(root,'output','exports');for(const path of [statePath(root,'output'),directory]){await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink())throw Error('workspace-export-path-invalid')}
  const path=join(directory,'uptokey-workspace-'+Date.now()+'.uptokey');await writeFile(path,encrypted,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({exported:true,encrypted:true,path,bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')}));
 }finally{encrypted?.fill(0)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),stream=args.length===1&&args[0]==='--stream';
 if(args.length!==0&&!stream){process.stderr.write('workspace-export-invalid-arguments\n');process.exitCode=1}else main(stream).catch(()=>{if(stream)process.stderr.write('workspace-export-unavailable\n');else console.log(JSON.stringify({exported:false,error:'workspace-export-unavailable'}));process.exitCode=1});
}
