import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {hostEnvironment} from './host-environment.mjs';
const execute=promisify(execFile);
const owner='deepseek-workbench';
const commandDirectory=fileURLToPath(new URL('..',import.meta.url));
export function commandFailureKind(error){
 if(error?.code==='ENOENT')return 'missing-from-path';
 if(['EACCES','EPERM'].includes(error?.code))return 'execution-denied';
 return 'command-failed';
}

export function containerSummary(item){
 if(!item)return {state:'missing'};
 if(item.Config?.Labels?.['io.uptokey.experiment']!==owner)return {state:'foreign-owner'};
 const image=String(item.Image??'').replace(/^sha256:/,'');
 return {state:item.State?.Running===true?'running':'stopped',
  ...(Number.isInteger(item.State?.ExitCode)?{exitCode:item.State.ExitCode}:{}),
  ...(/^[a-f0-9]{64}$/.test(image)?{image}:{}),
  bindMounts:Array.isArray(item.Mounts)?item.Mounts.filter(m=>m.Type==='bind').length:0};
}
export async function collectRuntimeHealth(){
 let engineCommand='not-observed';
 const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
 const podman=async args=>{
  try{const result=await execute('podman',[...connection,...args],{cwd:commandDirectory,env:hostEnvironment(),windowsHide:true,timeout:7000,maxBuffer:1024*1024});engineCommand='located';return result;}
  catch(error){engineCommand=commandFailureKind(error);return undefined;}
 };
 const inspect=async name=>{
  const found=await podman(['container','exists',name]);
  if(!found){
   const engine=await podman(['info','--format','{{.Host.Arch}}']);
   return {state:engine?'missing':'unavailable'};
  }
  const result=await podman(['inspect',name]);
  try{return containerSummary(JSON.parse(result.stdout)[0])}catch{return {state:'unavailable'}}
 };
 const probe=async(url,accepted)=>{
  const started=performance.now();
  try{
   const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(2000)});
   await response.body?.cancel();
   return {state:accepted.includes(response.status)?'reachable':'unexpected-response',httpStatus:response.status,durationMs:Math.round(performance.now()-started)};
  }catch{return {state:'unavailable',durationMs:Math.round(performance.now()-started)}}
 };
 const [controller,executor,web,core,broker,ollama]=await Promise.all([
  inspect('uptokey-deepseek-workbench'),inspect('uptokey-workbench-executor'),
  probe('http://127.0.0.1:43180/',[200,401]),probe('http://127.0.0.1:21435/health',[200]),
  probe('http://127.0.0.1:43193/health',[200]),probe('http://127.0.0.1:11434/api/version',[200]),
 ]);
 return {schema:1,application:'uptokey-harness-lab',generatedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,
  engineCommand,containers:{controller,executor},listeners:{web,core,broker,ollama},
  scope:'Reachability and owned container state only; not authenticated inference or provider availability',
  privateDataExported:false};
}
