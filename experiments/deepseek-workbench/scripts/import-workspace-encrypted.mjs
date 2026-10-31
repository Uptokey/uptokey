import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {importWorkspaceBytes} from './import-workspace.mjs';
import {MAX_ENCRYPTED_EXPORT_BYTES,transformWorkspaceExport} from './workspace-export-crypto.mjs';

export async function importEncryptedWorkspace(path,{controllerContainer='uptokey-deepseek-workbench',executorContainer='uptokey-workbench-executor',controllerSecretName='uptokey-workbench-vault-key'}={}){
 if(typeof path!=='string'||!path.toLowerCase().endsWith('.uptokey'))throw Error('workspace-encrypted-required');
 const file=await open(resolve(path),constants.O_RDONLY|(constants.O_NOFOLLOW??0));let encrypted,archive;
 try{
  const before=await file.stat();if(!before.isFile()||before.size<12||before.size>MAX_ENCRYPTED_EXPORT_BYTES)throw Error('workspace-encrypted-invalid');
  encrypted=Buffer.alloc(before.size);let offset=0;while(offset<encrypted.length){const {bytesRead}=await file.read(encrypted,offset,encrypted.length-offset,offset);if(!bytesRead)throw Error('workspace-encrypted-changed');offset+=bytesRead}
  const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('workspace-encrypted-changed');
  archive=await transformWorkspaceExport(encrypted,'decrypt',{container:controllerContainer,secretName:controllerSecretName});return await importWorkspaceBytes(archive,{container:executorContainer});
 }finally{await file.close();encrypted?.fill(0);archive?.fill(0)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){importEncryptedWorkspace(process.argv[2]).then(value=>console.log(JSON.stringify(value))).catch(()=>{console.log(JSON.stringify({imported:false,error:'workspace-import-unavailable'}));process.exitCode=1})}
