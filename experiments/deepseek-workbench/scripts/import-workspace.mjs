import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open, readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {hostEnvironment} from './host-environment.mjs';
const execute=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];

export async function importWorkspace(path,options={}){
 if(typeof path!=='string'||!path.toLowerCase().endsWith('.zip'))throw Error('workspace-zip-required');
 const file=await open(resolve(path),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 let archive;
 try{
  const before=await file.stat();
  if(!before.isFile()||before.size>34*1024*1024)throw Error('workspace-zip-invalid');
  archive=Buffer.alloc(before.size);
  let offset=0;
  while(offset<archive.length){const {bytesRead}=await file.read(archive,offset,archive.length-offset,offset);if(!bytesRead)throw Error('workspace-zip-changed');offset+=bytesRead;}
  const after=await file.stat();
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('workspace-zip-changed');
 }finally{await file.close();}
 return importWorkspaceBytes(archive,options);
}

// Both a selected ZIP and an approved core snapshot use the same isolated importer.
export async function importWorkspaceBytes(bytes,{signal,container='uptokey-workbench-executor'}={}){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>34*1024*1024)throw Error('workspace-zip-invalid');
 signal?.throwIfAborted();
 const archive=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const env=hostEnvironment();
 const result=await execute('podman',[...connection,'inspect',container],{env,windowsHide:true,timeout:5000,maxBuffer:1024*1024,signal});
 const item=JSON.parse(result.stdout)[0];
 if(item?.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State?.Running||item.Mounts?.some(m=>m.Type==='bind')||!/^[a-f0-9]{64}$/.test(item.Id))throw Error('workspace-unavailable');
 const program=await readFile(join(root,'scripts/workspace-import.py'),'utf8');
 signal?.throwIfAborted();
 // Once the finite local import starts, let the original importer finish or
 // clean up its own failed project. Do not orphan a remote write on UI cancellation.
 const receipt=await new Promise((resolve,reject)=>{
  const child=execFile('podman',[...connection,'exec','--user','1000:1000','-i',item.Id,'python3','-c',program+'\nimport sys,json\nprint(json.dumps(import_workspace(sys.stdin.buffer.read(34*1024*1024+1),"/workspace")))'],{env,windowsHide:true,timeout:60000,maxBuffer:16384},(error,stdout)=>error?reject(Error('workspace-import-failed')):resolve(stdout));
  child.stdin.on('error',()=>{});
  child.stdin.end(archive);
 });
 const value=JSON.parse(receipt);
 if(value?.imported!==true||!/^\/workspace\/import-[a-f0-9]{32}$/.test(value.project))throw Error('workspace-import-result-invalid');
 return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 importWorkspace(process.argv[2]).then(value=>console.log(JSON.stringify(value))).catch(()=>{console.log(JSON.stringify({imported:false,error:'workspace-import-unavailable'}));process.exitCode=1;});
}
