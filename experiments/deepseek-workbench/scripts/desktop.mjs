import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyTauriTransposition} from './transposition-gate.mjs';
import {dirname,resolve} from 'node:path';
import {existsSync,mkdirSync,mkdtempSync,openSync,closeSync,writeFileSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {hostEnvironment} from './host-environment.mjs';
import {authenticatedStartupLink} from './startup-link.mjs';
import {desktopEngineAvailable,desktopTarget} from './desktop-target.mjs';
import {ensureRuntimeEngine} from './runtime-engine.mjs';
import {desktopPreviewExecutable,newDesktopTarget,publishDesktopTarget} from './desktop-build-target.mjs';
import {publishComputerResource} from '../../../quimera/tauri/scripts/computer-resource.mjs';

const root=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
const env=hostEnvironment();
const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
// The previous Windows artifact can remain locked by a surviving WebView2
// handle after the native window closes. Keep it as evidence and use the
// current generation directory so build/start never fall back to stale UI.
const command=process.argv[2]??'start';
const foreground=process.argv.includes('--foreground');
function run(file,args,extra={}) {
 const r=spawnSync(file,args,{cwd:root,env,encoding:'utf8',windowsHide:true,...extra});
 if(r.error||r.status!==0)throw Error(`${file} failed (${r.status})`);
 return r.stdout;
}
if(command==='build'||command==='test') {
 verifyTauriTransposition(root,env);
 // Build-only dependencies stay out of the installed start/recovery closure.
 const {prepareComputerRuntime}=await import('../../../quimera/tauri/scripts/computer-runtime.mjs');
 const local=resolve(root,'.local');mkdirSync(local,{recursive:true});
 const computerStage=mkdtempSync(resolve(local,'computer-build-'));
 try {
  const computer=prepareComputerRuntime(computerStage,{env,targetDir:resolve(local,'computer-target')});
  publishComputerResource(local,resolve(computerStage,computer.binary));
 } finally {
  if(dirname(realpathSync(computerStage))!==realpathSync(local))throw Error('computer_build_staging_invalid');
  rmSync(computerStage,{recursive:true});
 }
 const target=command==='build'?newDesktopTarget(root):resolve(root,'.local/tauri-target-test');
 run('cargo',[command==='build'?'build':'test','--locked','--manifest-path','desktop/Cargo.toml','-j','1'],{env:{...env,CARGO_TARGET_DIR:target},stdio:'inherit'});
 if(command==='build')publishDesktopTarget(target);
} else if(['start','inspect','recover','inspect-recovery'].includes(command)) {
 const inspecting=command==='inspect'||command==='inspect-recovery';
 const executable=desktopPreviewExecutable(root);
 if(!existsSync(executable))throw Error('Build the desktop candidate first: npm run desktop:build');
 const profile=resolve(root,'.local/desktop-profile');
 mkdirSync(profile,{recursive:true,mode:0o700});
 if(lstatSync(profile).isSymbolicLink())throw Error('Desktop profile must stay local');
 if(process.platform==='win32') {
   const sid=run('powershell.exe',['-NoProfile','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).trim();
   if(!/^S-1-\d+(?:-\d+)+$/.test(sid))throw Error('Invalid local identity');
   run('icacls.exe',[profile,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`]);
 }
 let item;
 const launch=await desktopTarget({
 engineAvailable:()=>desktopEngineAvailable({recovery:command==='recover'||command==='inspect-recovery',ensure:ensureRuntimeEngine}),
 start:async()=>{run(process.execPath,['scripts/lab.mjs','start'],{stdio:'inherit'});
 item=JSON.parse(run('podman',[...connection,'inspect','uptokey-deepseek-workbench']))[0];
 if(item.Config.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State.Running)throw Error('Laboratory runtime not available');
 },
 authenticate:async()=>{
 // Container "running" precedes the web listener. Ignore links from earlier
 // starts and verify the current launch token without following its redirect.
 const url=await authenticatedStartupLink(async()=>{
   const logs=spawnSync('podman',[...connection,'logs','--since',item.State.StartedAt,'uptokey-deepseek-workbench'],{cwd:root,env,encoding:'utf8',windowsHide:true});
   if(logs.status!==0)throw Error('Startup link unavailable');
   return logs.stdout+logs.stderr;
 });
 return url;
 }});
 const fd=openSync(resolve(profile,'native.log'),'a',0o600);
 const child=spawn(executable,[],{cwd:root,env,detached:true,windowsHide:true,stdio:['pipe',fd,fd]});
 closeSync(fd);
 await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail)});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 child.stdin.end(JSON.stringify({...launch,profile,inspect:inspecting,node_executable:process.execPath}));
 const earlyExit=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve(null),1000))]);
 const processReceipt={pid:child.pid,executable,startedAt:new Date().toISOString(),inspectionEnabled:inspecting,recovery:launch.recovery,...(earlyExit?{earlyExit}:{} )};
 writeFileSync(resolve(profile,'process.json'),JSON.stringify(processReceipt,null,2),{mode:0o600});
 if(earlyExit)throw Error(`Desktop candidate exited during startup (${earlyExit.code??earlyExit.signal??'unknown'})`);
 console.log(JSON.stringify({desktop:'Uptokey',pid:child.pid,inspectionEnabled:inspecting,recovery:launch.recovery,runtime:'http://127.0.0.1:43180',personalProfileUsed:false}));
 if(foreground){
   const result=await exited;
   if(result.code!==0)throw Error(`Desktop candidate exited (${result.code??result.signal??'unknown'})`);
 }else child.unref();
} else throw Error('Use start, build, test, or inspect');
