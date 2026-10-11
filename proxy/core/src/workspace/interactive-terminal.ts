import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { IPty, IDisposable } from '@lydell/node-pty';
import { TERMINAL_LIMITS, type TerminalCreate, type TerminalEvent, type TerminalInput, type TerminalPage, type TerminalSession, type TerminalShell, type TerminalSize } from '@uptokey/sync-contract/interactive-terminal';
import type { ProjectRootService } from './project-root-service.ts';
import type { WorkspaceStore } from './store.ts';

/** Human-operated host terminals. These sessions are never registered as model tools.
 * The selected root is a starting directory, not an OS sandbox. */
export class InteractiveTerminalError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  constructor(code:string,status:InteractiveTerminalError['status']=400){super(code);this.status=status;}
}
export type TerminalAuthority = () => Promise<void>;
type Entry = {owner:string;view:TerminalSession;requestId:string;requestDigest:string;pty:IPty;events:TerminalEvent[];bytes:number;cursor:number;
  inputDigest:string;listeners:Set<()=>void>;subscriptions:IDisposable[];authority:TerminalAuthority;exit:Promise<void>;resolveExit:()=>void;closing?:Promise<void>};

/** Only ordinary shell environment: service tokens, provider keys and daemon controls never inherit. */
export function terminalEnvironment(source:NodeJS.ProcessEnv=process.env):Record<string,string> {
  const names=new Set(['path','pathext','systemroot','windir','comspec','temp','tmp','tmpdir','home','userprofile','homedrive','homepath','username','user','logname','appdata','localappdata','programfiles','programfiles(x86)','programw6432','commonprogramfiles','lang','lc_all','lc_ctype','shell']);
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(source))if(value!==undefined&&names.has(key.toLowerCase()))env[key]=value;
  return {...env,TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Uptokey'};
}
function shellCommand(shell:TerminalShell):{file:string;args:string[];shell:TerminalShell;title:string}{
  if(process.platform==='win32'){
    const windows=process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows';
    if(shell==='default'||shell==='powershell')return {file:join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile'],shell:'powershell',title:'PowerShell'};
    if(shell==='cmd')return {file:join(windows,'System32','cmd.exe'),args:['/d'],shell:'cmd',title:'Command Prompt'};
  }else{
    const preferred=process.env.SHELL;
    const candidate=shell==='default'?(preferred&&isAbsolute(preferred)&&['bash','zsh','sh'].includes(basename(preferred))?preferred:'/bin/sh'):`/bin/${shell}`;
    if((shell==='default'||shell==='bash'||shell==='zsh')&&existsSync(candidate))return {file:candidate,args:[],shell:shell==='default'?'default':shell,title:basename(candidate)};
  }
  throw new InteractiveTerminalError('terminal_shell_unavailable',409);
}
export function terminalShells():TerminalShell[]{
  return (['default','powershell','cmd','bash','zsh'] as TerminalShell[]).filter(shell=>{try{return existsSync(shellCommand(shell).file);}catch{return false;}});
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export class InteractiveTerminalService {
  private readonly sessions=new Map<string,Entry>();
  private readonly roots:ProjectRootService;
  private readonly store:WorkspaceStore;
  private readonly active:(owner:string)=>Promise<boolean>;
  private creates:Promise<unknown>=Promise.resolve();
  private closed=false;
  private checking=false;
  private readonly timer:NodeJS.Timeout;
  constructor(store:WorkspaceStore,roots:ProjectRootService,active:(owner:string)=>Promise<boolean>){
    this.store=store;this.roots=roots;this.active=active;
    // A revocation stops its own processes even when no browser is polling. This is not an idle timeout.
    this.timer=setInterval(()=>{void this.checkAuthority();},2000);this.timer.unref();
  }
  private async root(owner:string,projectId:string,rootBindingId:string,authority:TerminalAuthority){
    await authority();
    if(!await this.active(owner))throw new InteractiveTerminalError('terminal_authority_revoked',403);
    const project=await this.store.getProject(owner,projectId);
    if(project.ownerPrincipalId!==owner)throw new InteractiveTerminalError('terminal_missing',404);
    const root=await this.roots.ensureRootLoaded(rootBindingId,this.store,owner,projectId);
    if(root.binding.accessMode!=='read_write')throw new InteractiveTerminalError('terminal_write_access_required',403);
    await authority();
    return this.roots.getVerifiedRoot(rootBindingId);
  }
  private view(entry:Entry):TerminalSession{return {...entry.view};}
  private async entry(owner:string,projectId:string,id:string,authority:TerminalAuthority):Promise<Entry>{
    const entry=this.sessions.get(id);
    if(!entry||entry.owner!==owner||entry.view.projectId!==projectId)throw new InteractiveTerminalError('terminal_missing',404);
    try {await this.root(owner,projectId,entry.view.rootBindingId,authority);}
    catch(error){if(entry.view.state!=='exited')await this.stop(entry).catch(()=>undefined);throw error;}
    return entry;
  }
  async list(owner:string,projectId:string,authority:TerminalAuthority):Promise<{sessions:TerminalSession[];shells:TerminalShell[]}>{
    await authority();await this.store.getProject(owner,projectId);
    const sessions:TerminalSession[]=[];
    for(const entry of this.sessions.values())if(entry.owner===owner&&entry.view.projectId===projectId){
      try {await this.entry(owner,projectId,entry.view.id,authority);sessions.push(this.view(entry));}
      catch(error){
        // Revoked/moved roots disappear from this projection without hiding other valid sessions.
        if(error instanceof Error&&['terminal_missing','project_root_revoked','project_root_expired','project_root_not_found','project_root_identity_changed','project_root_link_forbidden','terminal_write_access_required'].includes(error.message))continue;
        throw error;
      }
    }
    return {sessions,shells:terminalShells()};
  }
  create(owner:string,projectId:string,input:TerminalCreate,authority:TerminalAuthority):Promise<{session:TerminalSession}>{
    const next=this.creates.catch(()=>undefined).then(async()=>{
      if(this.closed)throw new InteractiveTerminalError('terminal_unavailable',503);
      const root=await this.root(owner,projectId,input.rootBindingId,authority);
      const requestDigest=digest(JSON.stringify(input));
      const existing=[...this.sessions.values()].find(entry=>entry.owner===owner&&entry.view.projectId===projectId&&entry.requestId===input.requestId);
      if(existing){if(existing.requestDigest!==requestDigest)throw new InteractiveTerminalError('terminal_request_conflict',409);return {session:this.view(existing)};}
      const entries=[...this.sessions.values()],running=entries.filter(entry=>entry.view.state!=='exited');
      if(running.length>=TERMINAL_LIMITS.activeTotal||running.filter(entry=>entry.owner===owner).length>=TERMINAL_LIMITS.activePerOwner)throw new InteractiveTerminalError('terminal_session_limit',429);
      const owned=entries.filter(entry=>entry.owner===owner);
      while(owned.length>=TERMINAL_LIMITS.retainedPerOwner){const index=owned.findIndex(entry=>entry.view.state==='exited');if(index<0)break;const [old]=owned.splice(index,1);this.sessions.delete(old!.view.id);}
      while(this.sessions.size>=TERMINAL_LIMITS.retainedTotal){const old=[...this.sessions.values()].find(entry=>entry.view.state==='exited');if(!old)throw new InteractiveTerminalError('terminal_session_limit',429);this.sessions.delete(old.view.id);}
      const command=shellCommand(input.shell);
      let spawn:typeof import('@lydell/node-pty').spawn;
      try {({spawn}=await import('@lydell/node-pty'));}catch{throw new InteractiveTerminalError('terminal_runtime_unavailable',503);}
      await this.root(owner,projectId,input.rootBindingId,authority);
      if(this.closed)throw new InteractiveTerminalError('terminal_unavailable',503);
      let child:IPty;
      try {child=spawn(command.file,command.args,{name:'xterm-256color',cwd:root.localPath,cols:input.cols,rows:input.rows,env:terminalEnvironment(),useConpty:true});}
      catch{throw new InteractiveTerminalError('terminal_start_failed',503);}
      let resolveExit!:()=>void;
      const exit=new Promise<void>(resolve=>{resolveExit=resolve;});
      const ordinal=1+entries.filter(entry=>entry.owner===owner&&entry.view.projectId===projectId).reduce((max,entry)=>Math.max(max,Number(/ (\d+)$/.exec(entry.view.title)?.[1]??0)),0);
      const entry:Entry={owner,view:{id:randomUUID(),projectId,rootBindingId:input.rootBindingId,title:`${command.title} ${ordinal}`,shell:command.shell,cols:input.cols,rows:input.rows,state:'running',exitCode:null,createdAt:new Date().toISOString(),closedAt:null,acceptedSequence:0},requestId:input.requestId,requestDigest,pty:child,events:[],bytes:0,cursor:0,inputDigest:'',listeners:new Set(),subscriptions:[],authority,exit,resolveExit};
      this.sessions.set(entry.view.id,entry);
      entry.subscriptions.push(child.onData(data=>this.append(entry,data)),child.onExit(event=>{
        entry.view.state='exited';entry.view.exitCode=event.exitCode;entry.view.closedAt=new Date().toISOString();
        // The upstream public teardown also releases ConPTY's output worker after a natural shell exit.
        // The exit code above remains the observed code, never the cleanup request's result.
        try {child.kill();}catch{/* Terminal has already released its native handles. */}
        entry.resolveExit();for(const listener of entry.listeners)listener();for(const subscription of entry.subscriptions)subscription.dispose();
      }));
      return {session:this.view(entry)};
    });this.creates=next;return next;
  }
  private append(entry:Entry,data:string){
    // Bound both a producer burst and retained replay. Do not persist or inspect command/output contents.
    for(let offset=0;offset<data.length;){let end=Math.min(data.length,offset+8192);if(end<data.length&&/[\uD800-\uDBFF]/.test(data[end-1]!))end--;const part=data.slice(offset,end);offset=end;
      entry.events.push({sequence:++entry.cursor,data:part});entry.bytes+=Buffer.byteLength(part);
      while((entry.bytes>TERMINAL_LIMITS.outputBytes||entry.events.length>TERMINAL_LIMITS.outputEvents)&&entry.events.length>1)entry.bytes-=Buffer.byteLength(entry.events.shift()!.data);
    }
    for(const listener of entry.listeners)listener();
  }
  async input(owner:string,projectId:string,id:string,input:TerminalInput,authority:TerminalAuthority){
    const entry=await this.entry(owner,projectId,id,authority),hash=digest(input.data);
    if(input.sequence===entry.view.acceptedSequence&&hash===entry.inputDigest)return {acceptedSequence:entry.view.acceptedSequence};
    if(input.sequence!==entry.view.acceptedSequence+1)throw new InteractiveTerminalError('terminal_input_conflict',409);
    if(entry.view.state!=='running')throw new InteractiveTerminalError('terminal_exited',409);
    // Synchronous admission+write: a concurrent request cannot insert bytes between these steps.
    entry.pty.write(input.data);entry.view.acceptedSequence=input.sequence;entry.inputDigest=hash;
    return {acceptedSequence:entry.view.acceptedSequence};
  }
  async resize(owner:string,projectId:string,id:string,size:TerminalSize,authority:TerminalAuthority){
    const entry=await this.entry(owner,projectId,id,authority);
    if(entry.view.state!=='running')throw new InteractiveTerminalError('terminal_exited',409);
    entry.pty.resize(size.cols,size.rows);Object.assign(entry.view,size);return {session:this.view(entry)};
  }
  async read(owner:string,projectId:string,id:string,after:number,authority:TerminalAuthority,signal?:AbortSignal):Promise<TerminalPage>{
    if(!Number.isSafeInteger(after)||after<0)throw new InteractiveTerminalError('terminal_cursor_invalid');
    let entry=await this.entry(owner,projectId,id,authority);
    if(after>entry.cursor)throw new InteractiveTerminalError('terminal_cursor_invalid',409);
    if(after===entry.cursor&&entry.view.state==='running'&&!signal?.aborted){
      if(entry.listeners.size>=8)throw new InteractiveTerminalError('terminal_reader_limit',429);
      await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);entry.listeners.delete(done);signal?.removeEventListener('abort',done);resolve();};
        const timer=setTimeout(done,TERMINAL_LIMITS.pollMs);entry.listeners.add(done);signal?.addEventListener('abort',done,{once:true});
        if(signal?.aborted)done();
      });
    }
    signal?.throwIfAborted();
    entry=await this.entry(owner,projectId,id,authority);
    const oldestCursor=entry.events[0]?.sequence??entry.cursor+1,events:TerminalEvent[]=[];let bytes=0;
    for(const event of entry.events)if(event.sequence>after){if(events.length&&bytes+Buffer.byteLength(event.data)>TERMINAL_LIMITS.pageBytes)break;events.push({...event});bytes+=Buffer.byteLength(event.data);}
    return {session:this.view(entry),events,nextCursor:events.at(-1)?.sequence??after,oldestCursor,truncated:after<oldestCursor-1};
  }
  async closeSession(owner:string,projectId:string,id:string,authority:TerminalAuthority){const entry=await this.entry(owner,projectId,id,authority);await this.stop(entry);return {session:this.view(entry)};}
  private async stop(entry:Entry):Promise<void>{
    if(entry.view.state==='exited')return;
    if(entry.closing)return entry.closing;
    entry.view.state='closing';
    const operation=(async()=>{
      try{entry.pty.kill();}catch{/* Only the exit event confirms termination. */}
      let timer:NodeJS.Timeout|undefined;
      try {await Promise.race([entry.exit,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new InteractiveTerminalError('terminal_stop_unconfirmed',503)),5000);})]);}
      finally{if(timer)clearTimeout(timer);}
    })();entry.closing=operation;try{await operation;}finally{entry.closing=undefined;}
  }
  async closeRoot(rootBindingId:string){await Promise.all([...this.sessions.values()].filter(entry=>entry.view.rootBindingId===rootBindingId).map(entry=>this.stop(entry)));}
  async closeProject(owner:string,projectId:string){await Promise.all([...this.sessions.values()].filter(entry=>entry.owner===owner&&entry.view.projectId===projectId).map(entry=>this.stop(entry)));}
  private async checkAuthority(){
    if(this.checking||this.closed)return;this.checking=true;
    try {await Promise.allSettled([...this.sessions.values()].filter(entry=>entry.view.state!=='exited').map(async entry=>{
      try{await this.root(entry.owner,entry.view.projectId,entry.view.rootBindingId,entry.authority);}catch{await this.stop(entry);}
    }));}finally{this.checking=false;}
  }
  async close(){this.closed=true;clearInterval(this.timer);await this.creates.catch(()=>undefined);await Promise.all([...this.sessions.values()].map(entry=>this.stop(entry)));}
}
