import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {hostEnvironment} from './host-environment.mjs';
const execute=promisify(execFile);
export async function reconnectServices(run){
 // Each bridge owns its key, known-hosts file, state and log. A slow/offline
 // local model service must not delay the independent core tunnel attempt.
 const targets=[['ollama','connect-local'],['core','connect-core']];
 const results=await Promise.allSettled(targets.map(([,command])=>Promise.resolve().then(()=>run(command))));
 const services=Object.fromEntries(targets.map(([name],index)=>[name,results[index].status==='fulfilled'?'connected':'unavailable']));
 return {reconnected:Object.values(services).every(state=>state==='connected'),services,coreRestarted:false,controllerRestarted:false};
}
async function main(){
 const root=fileURLToPath(new URL('..',import.meta.url));
 const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
 const env=hostEnvironment();
 let item;
 try{const result=await execute('podman',[...connection,'inspect','uptokey-deepseek-workbench'],{env,windowsHide:true,timeout:5000,maxBuffer:1024*1024});item=JSON.parse(result.stdout)[0]}catch{throw Error('runtime-unavailable')}
 if(item?.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State?.Running)throw Error('runtime-not-running');
 const result=await reconnectServices(command=>execute(process.execPath,[resolve(root,'scripts/lab.mjs'),command],{cwd:root,env,windowsHide:true,timeout:20000,maxBuffer:65536}));
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(()=>{console.log(JSON.stringify({reconnected:false,error:'runtime-unavailable',coreRestarted:false,controllerRestarted:false}));process.exitCode=1});
}
