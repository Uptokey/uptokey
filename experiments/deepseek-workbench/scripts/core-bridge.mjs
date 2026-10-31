import {spawn,spawnSync} from 'node:child_process';
import {Entry} from '@napi-rs/keyring';
import {createHmac,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {CORE_BRIDGE_PORT,CORE_BRIDGE_SERVICE,nativeSecret} from './core-bridge-server.mjs';
import {coreWorkspacePublicKey} from './context-identity.mjs';
import {statePath} from './harness-paths.mjs';
import {podmanSecretInput} from './podman-secret-input.mjs';

const name='uptokey-deepseek-workbench';
const publicKeySecret='uptokey-workbench-core-public-key';
const gateSecret='uptokey-workbench-core-gate';
const owner='io.uptokey.experiment=deepseek-workbench';
const entry=account=>new Entry(CORE_BRIDGE_SERVICE,account);
const paths=root=>({dir:statePath(root,'.local','ssh'),key:statePath(root,'.local','ssh','core_ed25519'),known:statePath(root,'.local','ssh','core_known_hosts'),log:statePath(root,'.local','ssh','core.log'),state:statePath(root,'.local','ssh','core.json'),pair:statePath(root,'.local','ssh','core-pair.json')});
function run(file,args,env,extra={}){
 const r=spawnSync(file,args,{env,encoding:'utf8',windowsHide:true,...extra});
 if(r.error||r.status!==0)throw Error(`${file} failed (${r.status})`);
 return r.stdout;
}
function secretNames(connection,env){return run('podman',[...connection,'secret','ls','--format','{{.Name}}'],env).trim().split(/\r?\n/)}
function createSecret(args,env,input){const r=podmanSecretInput(args,{env,input});if(r.error||r.status!==0)throw Error('podman secret create failed');}
function inspectSecret(connection,env,secret){
 const row=JSON.parse(run('podman',[...connection,'secret','inspect',secret],env))[0];
 if(row?.Spec?.Labels?.[owner.split('=')[0]]!=='deepseek-workbench')throw Error('Foreign laboratory secret');
}
export function ensureCoreBridge(root,connection,env){
 const p=paths(root);mkdirSync(p.dir,{recursive:true,mode:0o700});
 if(lstatSync(p.dir).isSymbolicLink())throw Error('Bridge path must stay local');
 if(process.platform==='win32'){
   const sid=run('powershell.exe',['-NoProfile','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],env).trim();
   if(!/^S-1-\d+(?:-\d+)+$/.test(sid))throw Error('Invalid local identity');
   run('icacls.exe',[p.dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],env);
 }
 const names=secretNames(connection,env);
 if(!existsSync(p.key)&&names.includes(publicKeySecret))throw Error('Restore the laboratory core bridge identity');
 if(!existsSync(p.key))run('ssh-keygen',['-q','-t','ed25519','-N','','-C','uptokey-workbench-core','-f',p.key],env);
 const pub=readFileSync(p.key+'.pub','utf8').trim();
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(pub))throw Error('Invalid core bridge public key');
 if(names.includes(publicKeySecret))inspectSecret(connection,env,publicKeySecret);
 else createSecret([...connection,'secret','create','--label',owner,publicKeySecret,'-'],env,`restrict,port-forwarding,permitlisten="127.0.0.1:43194" ${pub}\n`);
 let gate=nativeSecret('bridge-gate');
 if(names.includes(gateSecret)){
   inspectSecret(connection,env,gateSecret);
   if(!gate)throw Error('Restore the core bridge gate from the OS vault');
 }else{
   if(!gate){gate=randomBytes(32).toString('base64url');entry('bridge-gate').setPassword(gate)}
   createSecret([...connection,'secret','create','--label',owner,gateSecret,'-'],env,gate);
 }
}
async function api(path,body){
 const response=await fetch('http://127.0.0.1:21435'+path,{method:'POST',headers:{host:'127.0.0.1:21435','content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10_000)});
 const value=await response.json();return {status:response.status,value};
}
export async function startCorePairing(root){
 const p=paths(root);mkdirSync(p.dir,{recursive:true,mode:0o700});
 const result=await api('/local/pair/challenge',{clientName:'Uptokey Harness Lab',audience:'tauri'});
 if(result.status!==201)throw Error('Core pairing challenge unavailable');
 const {id,userCode,expiresAt}=result.value;
 if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[A-F0-9]{8}$/.test(userCode)||!Number.isFinite(Date.parse(expiresAt)))throw Error('Invalid core pairing challenge');
 writeFileSync(p.pair,JSON.stringify({id,expiresAt}),{mode:0o600});
 return {id,userCode,expiresAt,approveCommand:`uptokey proxy pair approve ${id} ${userCode} --audience tauri`};
}
export async function finishCorePairing(root){
 const p=paths(root);const pending=JSON.parse(readFileSync(p.pair,'utf8'));
 if(Date.now()>=Date.parse(pending.expiresAt))throw Error('Pairing expired; start a new challenge');
  const result=await api('/local/pair/consume',{id:pending.id,publicJwk:coreWorkspacePublicKey()});
 if(result.status!==200)throw Error(result.status===409?'Pairing awaits human approval':'Pairing failed');
 const {clientId,token}=result.value;
 if(!/^[0-9a-f-]{36}$/i.test(clientId)||!token?.startsWith(`utk_local_${clientId}.`)||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token))throw Error('Invalid paired client');
 entry('client-token').setPassword(token);
 return {clientId,stored:'OS credential vault',tokenDisplayed:false};
}
async function waitFor(probe){for(let i=0;i<25;i++){if(await probe())return true;await new Promise(r=>setTimeout(r,200))}return false}
export async function connectCoreBridge(root,connection,env){
 const token=nativeSecret('client-token');if(!token)return false;
 const p=paths(root);
 const health=async()=>{try{
   const gate=nativeSecret('bridge-gate');if(!gate)return false;
   const nonce=randomBytes(16).toString('hex');
   const response=await fetch(`http://127.0.0.1:${CORE_BRIDGE_PORT}/health?nonce=${nonce}`,{signal:AbortSignal.timeout(500)});
   return response.ok&&response.headers.get('x-uptokey-bridge-proof')===createHmac('sha256',gate).update(nonce).digest('hex');
 }catch{return false}};
 if(!await health()){
   const log=openSync(p.log,'a',0o600);
   const child=spawn(process.execPath,[resolve(root,'scripts','core-bridge-server.mjs')],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',log,log]});
   closeSync(log);await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail)});child.unref();
   if(!await waitFor(health))throw Error('Core bridge host service unavailable');
 }
 const probe=()=>spawnSync('podman',[...connection,'exec',name,'node','-e','fetch("http://127.0.0.1:43194/health",{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'],{env,windowsHide:true}).status===0;
 if(probe())return true;
 const key=run('podman',[...connection,'exec',name,'cat','/tmp/lab-ssh/host_ed25519.pub'],env).trim();
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(key))throw Error('Bridge host identity invalid');
 writeFileSync(p.known,`[127.0.0.1]:43191 ${key}\n`,{mode:0o600});
 const log=openSync(p.log,'a',0o600);
 const args=['-F','none','-N','-T','-i',p.key,'-p','43191','-o',`UserKnownHostsFile=${p.known}`,'-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',`-R`,`127.0.0.1:43194:127.0.0.1:${CORE_BRIDGE_PORT}`,'node@127.0.0.1'];
 const ssh=spawn('ssh',args,{env,detached:true,windowsHide:true,stdio:['ignore',log,log]});
 closeSync(log);await new Promise((ok,fail)=>{ssh.once('spawn',ok);ssh.once('error',fail)});ssh.unref();
 if(!await waitFor(probe)){ssh.kill();throw Error('Core bridge tunnel unavailable')}
 writeFileSync(p.state,JSON.stringify({pid:ssh.pid,endpoint:'http://127.0.0.1:43194/v1',connectedAt:new Date().toISOString()}),{mode:0o600});
 return true;
}
