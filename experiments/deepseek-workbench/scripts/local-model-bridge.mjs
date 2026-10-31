import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { statePath } from './harness-paths.mjs';
import { podmanSecretInput } from './podman-secret-input.mjs';

const name='uptokey-deepseek-workbench';
const secret='uptokey-workbench-local-model-public-key';
export function bridgePaths(root) {
  const dir=statePath(root,'.local','ssh');
  return {dir,key:statePath(root,'.local','ssh','model_ed25519'),known:statePath(root,'.local','ssh','model_known_hosts'),state:statePath(root,'.local','ssh','bridge.json'),log:statePath(root,'.local','ssh','bridge.log')};
}
function run(file,args,options={}) {
 const r=spawnSync(file,args,{encoding:'utf8',windowsHide:true,...options});
 if(r.error||r.status!==0)throw new Error(`${file} failed (${r.status}): ${r.error?.message||r.stderr||r.stdout||'no diagnostic'}`);
 return r.stdout;
}
export function ensureLocalBridge(root,connection,env) {
 const p=bridgePaths(root);mkdirSync(p.dir,{recursive:true,mode:0o700});
 if(lstatSync(p.dir).isSymbolicLink())throw new Error('Bridge path must be local');
 const names=run('podman',[...connection,'secret','ls','--format','{{.Name}}'],{env}).trim().split(/\r?\n/);
 if(!existsSync(p.key)&&names.includes(secret))throw new Error('Restore the original laboratory bridge identity; do not silently replace it');
 if(process.platform==='win32') {
   const sid=run('powershell.exe',['-NoProfile','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']).trim();
   if(!/^S-1-\d+(?:-\d+)+$/.test(sid))throw new Error('Invalid local identity');
   run('icacls.exe',[p.dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`]);
 }
 if(!existsSync(p.key))run('ssh-keygen',['-q','-t','ed25519','-N','','-C','uptokey-workbench-local-model','-f',p.key],{env});
 const pub=readFileSync(p.key+'.pub','utf8').trim();
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(pub))throw new Error('Invalid laboratory public key');
 if(!names.includes(secret)) {
   const created=podmanSecretInput([...connection,'secret','create','--label','io.uptokey.experiment=deepseek-workbench',secret,'-'],{env,input:`restrict,port-forwarding,permitlisten="127.0.0.1:43192" ${pub}\n`});
   if(created.error||created.status!==0)throw new Error('podman secret create failed');
 } else {
   const metadata=JSON.parse(run('podman',[...connection,'secret','inspect',secret],{env}))[0];
   if(metadata.Spec?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw new Error('Bridge public key belongs to another owner');
 }
}
export async function connectLocalBridge(root,connection,env) {
 const p=bridgePaths(root);
 const probe=()=>spawnSync('podman',[...connection,'exec',name,'node','-e','const r=await fetch("http://127.0.0.1:43192/v1/models",{signal:AbortSignal.timeout(1000)});if(!r.ok)process.exit(1);const j=await r.json();console.log(JSON.stringify({models:j.data.map(m=>m.id)}))'],{env,encoding:'utf8',windowsHide:true});
 const existing=probe();
 if(existing.status===0){console.log(existing.stdout.trim());return}
 const local=await fetch('http://127.0.0.1:11434/v1/models',{signal:AbortSignal.timeout(3000)});
 if(!local.ok)throw new Error('Local Ollama is unavailable');
 // Public host key comes from our authenticated Podman connection, never from
 // an unauthenticated network scan or an accept-any-host-key option.
 let pub;
 for(let attempt=0;attempt<30;attempt++) {
   const r=spawnSync('podman',[...connection,'exec',name,'cat','/tmp/lab-ssh/host_ed25519.pub'],{env,encoding:'utf8',windowsHide:true});
   if(r.status===0){pub=r.stdout.trim();break}
   await new Promise(r=>setTimeout(r,100));
 }
 if(!pub)throw new Error('Local bridge host key is unavailable');
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(pub))throw new Error('Invalid bridge host key');
 writeFileSync(p.known,`[127.0.0.1]:43191 ${pub}\n`,{mode:0o600});
 const log=openSync(p.log,'a',0o600);
 const args=['-F','none','-N','-T','-i',p.key,'-p','43191','-o',`UserKnownHostsFile=${p.known}`,'-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R','127.0.0.1:43192:127.0.0.1:11434','node@127.0.0.1'];
 const child=spawn('ssh',args,{env,detached:true,windowsHide:true,stdio:['ignore',log,log]});
 closeSync(log);
 await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail)});
 child.unref();writeFileSync(p.state,JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),key:p.key,endpoint:'http://127.0.0.1:43192/v1'},null,2));
 // Poll the actual endpoint, not just the existence of a detached process.
 for(let attempt=0;attempt<20;attempt++) {
   const r=probe();
   if(r.status===0){console.log(r.stdout.trim());return}
   await new Promise(r=>setTimeout(r,250));
 }
 child.kill();
 throw new Error('Bridge did not become ready; inspect the laboratory bridge log');
}
