// Owned by the native window. EOF is revocation; no background durable grant.
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostEnvironment} from './host-environment.mjs';
import {nativeComputerTransport} from './computer-transport.mjs';
import {computerSessionLeaseProgram} from './computer-session-lease.mjs';
import {createFocusTickets} from './computer-focus-tickets.mjs';
// Rust canonical paths use the Win32 extended namespace. Keep admission in the
// launcher, then pass equivalent ordinary paths to Podman/OpenSSH: their path
// parsers do not consistently understand that namespace (including the cwd).
export function computerSessionHostPath(path) {
  return process.platform==='win32'?fileURLToPath(pathToFileURL(path)):path;
}
export async function runComputerSession({executable,stateRoot,args}) {
executable=computerSessionHostPath(executable);
stateRoot=computerSessionHostPath(stateRoot);
// This process owns one session. Its descendants inherit the same admitted
// directory, with no change of volume, identity, privileges or containment.
process.chdir(computerSessionHostPath(process.cwd()));
const env=hostEnvironment();
for(const key of ['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS'])if(process.env[key])env[key]=process.env[key];
if(args.length!==4||args[0]!=='--window-id'||args[2]!=='--pid'||!/^\d{1,10}$/.test(args[1])||!/^\d{1,10}$/.test(args[3]))throw Error('Select one native window');
const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
const call=(a,input)=>execFileSync('podman',[...connection,...a],{env,windowsHide:true,encoding:'utf8',input,timeout:15_000,maxBuffer:1024*1024});
const container='uptokey-deepseek-workbench';
const item=JSON.parse(call(['inspect',container]))[0];
if(!item.State?.Running||item.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('Laboratory runtime unavailable');
mkdirSync(stateRoot,{recursive:true,mode:0o700});
const sessionDir=mkdtempSync(resolve(stateRoot,'computer-'));
// Synchronous exit cleanup also covers setup failures before the transport exists.
process.once('exit',()=>{for(const name of ['ed25519','ed25519.pub','known_hosts'])try{unlinkSync(resolve(sessionDir,name))}catch{}try{rmdirSync(sessionDir)}catch{}});
if(process.platform==='win32'){
  const sid=execFileSync('powershell.exe',['-NoProfile','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{env,windowsHide:true,encoding:'utf8'}).trim();
  if(!/^S-1-\d+(?:-\d+)+$/.test(sid))throw Error('Invalid local identity');
  execFileSync('icacls.exe',[sessionDir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{env,windowsHide:true,stdio:'ignore'});
}
const key=resolve(sessionDir,'ed25519'),known=resolve(sessionDir,'known_hosts');
execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','uptokey-computer-ephemeral','-f',key],{env,windowsHide:true,stdio:'ignore'});
const pub=readFileSync(key+'.pub','utf8').trim();
if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(pub))throw Error('Laboratory transport identity unavailable');
const host=call(['exec',container,'cat','/tmp/lab-ssh/host_ed25519.pub']).trim();
if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(host))throw Error('Invalid controller identity');
writeFileSync(known,`[127.0.0.1]:43191 ${host}\n`,{mode:0o600});
const capability=randomBytes(32).toString('hex'),id=randomBytes(16).toString('hex'),expiresAt=Date.now()+15*60_000;
const forwardingKey=`restrict,port-forwarding,permitlisten="127.0.0.1:43196" ${pub}\n`;
const state={schema:'uptokey.computer.session.v1',capability,id,expiresAt,port:43196,publicKeySha256:createHash('sha256').update(forwardingKey).digest('hex')};
let initialized,initializationFailed,tickets;const ready=new Promise((resolve,reject)=>{initialized=resolve;initializationFailed=reject});
const transport=await nativeComputerTransport({executable,args,env,capability,expiresAt,onInitialized:initialized,onStartupError:code=>initializationFailed(Error(code)),onControl:input=>tickets.request(input),onDisconnected:()=>close()});
let ssh,closed=false,stage='lease-claim';
function close(){
  if(closed)return;closed=true;tickets?.close();initialized();transport.close();ssh?.kill();
  let cleaned=false;
  const cleanup=()=>{if(cleaned)return;cleaned=true;try{execFileSync('podman',[...connection,'exec','-i',container,'node','-e',computerSessionLeaseProgram],{env,windowsHide:true,input:JSON.stringify({operation:'revoke',state}),stdio:['pipe','ignore','ignore'],timeout:5000})}catch{}for(const path of [key,key+'.pub',known])try{unlinkSync(path)}catch{}try{rmdirSync(sessionDir)}catch{}process.stdin.destroy();};
  // Flush revocation/EOF to the native owner before potentially slow cleanup.
  // A broken owner pipe is also terminal and still runs the same cleanup.
  process.stdout.once('error',cleanup);
  process.stdout.end('{"type":"focus-closed"}\n',cleanup);
}
tickets=createFocusTickets({leaseId:id,expiresAt,required:process.platform==='win32',isReady:()=>transport.ready()&&!closed,notify:message=>{if(!closed)process.stdout.write(JSON.stringify(message)+'\n')}});
// Only the owning Rust process can write this inherited pipe. Bounded frames
// acknowledge native registration/focus; EOF remains immediate revocation.
let acknowledgements=Buffer.alloc(0);
process.stdin.on('data',chunk=>{
  if(acknowledgements.length+chunk.length>4096){close();return;}
  acknowledgements=Buffer.concat([acknowledgements,chunk]);
  for(let end;(end=acknowledgements.indexOf(10))>=0;){
    const frame=acknowledgements.subarray(0,end),rest=Buffer.from(acknowledgements.subarray(end+1));
    try{tickets.acknowledge(JSON.parse(frame.toString()))}catch{close();}
    acknowledgements.fill(0);acknowledgements=rest;if(closed)return;
  }
});
process.stdin.once('end',close);process.stdin.resume();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,close);
try{
  // Claim the singleton before changing the forwarding identity. A second
  // desktop cannot silently replace a live window grant.
  call(['exec','-i',container,'node','-e',computerSessionLeaseProgram],JSON.stringify({operation:'claim',state,key:forwardingKey}));
  stage='ssh-spawn';
  ssh=spawn('ssh',['-F','none','-N','-T','-i',key,'-p','43191','-o',`UserKnownHostsFile=${known}`,'-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-R',`127.0.0.1:43196:127.0.0.1:${transport.port}`,'node@127.0.0.1'],{env,windowsHide:true,stdio:['ignore','ignore','ignore']});
  await new Promise((ok,fail)=>{ssh.once('spawn',ok);ssh.once('error',fail)});
  if(closed)throw Error('Computer session revoked');
  stage='ssh-connect';
  await new Promise((ok,fail)=>{const t=setTimeout(ok,800);ssh.once('exit',()=>{clearTimeout(t);fail(Error('Computer tunnel unavailable'))})});
  if(closed)throw Error('Computer session revoked');
  stage='profile-publish';
  call(['exec','-i',container,'node','-e',computerSessionLeaseProgram],JSON.stringify({operation:'publish',state}));
  stage='mcp-initialize';
  let deadline;try{await Promise.race([ready,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Native MCP did not initialize')),20000)})])}finally{clearTimeout(deadline)}
  if(closed)throw Error('Computer session revoked');
  process.stdout.write(JSON.stringify({ready:true,enabled:true,windowId:Number(args[1]),pid:Number(args[3]),expiresAt,leaseId:id})+'\n');
  ssh.once('exit',close);
  setTimeout(close,expiresAt-Date.now()).unref();
}catch(error){const metadata=transport.diagnostic();close();throw Error(`Computer session could not be enabled (${stage}; ${typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'operation_failed'}; ${JSON.stringify(metadata)})`)}
}
