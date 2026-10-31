import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,lstat,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {hostEnvironment} from './host-environment.mjs';
import {statePath} from './harness-paths.mjs';
const execute=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
const env=hostEnvironment();
export async function exportWorkspaceBytes({container='uptokey-workbench-executor'}={}){
 const result=await execute('podman',[...connection,'inspect',container],{env,windowsHide:true,timeout:5000,maxBuffer:1024*1024});
 const item=JSON.parse(result.stdout)[0];
 if(item?.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State?.Running||item.Mounts?.some(m=>m.Type==='bind')||!/^[a-f0-9]{64}$/.test(item.Id))throw Error('workspace-unavailable');
 const program=await readFile(join(root,'scripts/workspace-archive.py'),'utf8');
 // Execute only as the ordinary executor user; bytes are captured, not printed.
 const archive=await new Promise((resolve,reject)=>{
  const child=execFile('podman',[...connection,'exec','--user','1000:1000','-i',item.Id,'python3','-'],{env,windowsHide:true,timeout:60000,maxBuffer:34*1024*1024,encoding:'buffer'},(error,stdout)=>error?reject(Error('workspace-export-failed')):resolve(stdout));
  child.stdin.on('error',()=>{});
  child.stdin.end(program+'\nimport sys\nsys.stdout.buffer.write(workspace_archive("/workspace"))\n');
 });
 if(!Buffer.isBuffer(archive)||archive.length<22||archive.length>34*1024*1024||archive.readUInt32LE(0)!==0x04034b50)throw Error('workspace-archive-invalid');
 return archive;
}
async function main(stream){
 const archive=await exportWorkspaceBytes();
 try{
 if(stream){
  // Native Save As already selected its sole destination. Do not persist an
  // intermediate ZIP; the native owner validates and saves these bounded bytes.
  process.stdout.on('error',()=>{});
  await new Promise((resolve,reject)=>process.stdout.write(archive,error=>error?reject(error):resolve()));
  return;
 }
 const directory=statePath(root,'output','exports');
 for(const path of [statePath(root,'output'),directory]){await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink())throw Error('workspace-export-path-invalid');}
 const path=join(directory,'uptokey-workspace-'+Date.now()+'.zip');
 await writeFile(path,archive,{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({exported:true,path,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex')}));
 }finally{archive?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),stream=args.length===1&&args[0]==='--stream';
 if(args.length!==0&&!stream){process.stderr.write('workspace-export-invalid-arguments\n');process.exitCode=1;}
 else main(stream).catch(()=>{
  if(stream)process.stderr.write('workspace-export-unavailable\n');
  else console.log(JSON.stringify({exported:false,error:'workspace-export-unavailable'}));
  process.exitCode=1;
 });
}
