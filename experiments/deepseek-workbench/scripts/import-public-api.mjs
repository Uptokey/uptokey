import {open,readFile,mkdir,lstat,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {publicApiSelection} from './public-api-selection.mjs';
import {hostEnvironment} from './host-environment.mjs';
import {statePath} from './harness-paths.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
async function main(){
 const path=process.argv[2];
 if(!path||process.argv.length!==3||!path.toLowerCase().endsWith('.json'))throw Error('public_spec_required');
 const file=await open(resolve(path),constants.O_RDONLY|(constants.O_NOFOLLOW??0));let buffer;
 try{
  const before=await file.stat();if(!before.isFile()||before.size>1024*1024)throw Error('public_spec_size');
  buffer=Buffer.alloc(before.size);let offset=0;
  while(offset<buffer.length){const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)throw Error('public_spec_changed');offset+=bytesRead;}
  const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('public_spec_changed');
 }finally{await file.close();}
 const selected=publicApiSelection(JSON.parse(buffer.toString('utf8')));
 const folder=statePath(root,'output','public-apis');
 for(const dir of [statePath(root,'output'),folder]){await mkdir(dir,{recursive:true});if((await lstat(dir)).isSymbolicLink())throw Error('public_spec_path');}
 const copy=join(folder,selected.hash+'.json');
 try{await writeFile(copy,selected.serialized,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST'||(await lstat(copy)).isSymbolicLink()||await readFile(copy,'utf8')!==selected.serialized)throw Error('public_spec_identity');}
 const result=await promisify(execFile)(process.execPath,[join(root,'scripts/register-public-api.mjs'),selected.id,selected.baseUrl,copy],{cwd:root,env:hostEnvironment(),windowsHide:true,timeout:30000,maxBuffer:16384});
 const receipt=JSON.parse(result.stdout);
 if(receipt.registered!=='uptokey-api-'+selected.id)throw Error('public_spec_registration');
 console.log(JSON.stringify({registered:receipt.registered,apiId:selected.id,schemaSha256:selected.hash,endpoint:selected.baseUrl,operations:selected.operations}));
}
main().catch(()=>{console.log(JSON.stringify({registered:false,error:'public_api_import_failed'}));process.exitCode=1;});
