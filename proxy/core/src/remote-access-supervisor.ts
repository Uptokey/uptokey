import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import type { SecretStore } from './secret-store.ts';
import { parseRemoteAccessProfile, type RemoteAccessProfile } from './remote-access-profile.ts';
import { RemoteAccessController, assertSameProcessIdentity, createProcessIdentity, planRemoteAccessProfile, type ProcessIdentity, type RemoteJob } from './remote-access-ops.ts';
import { parseTransportVersion } from './remote-access-discover.ts';

const API_ROUTES = new Set(['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/messages', 'POST /v1/responses']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Configuration = { profile: RemoteAccessProfile; binaryPath: string; allowedModels: string[]; tunnelId?: string };
type Journal = { configuration: Configuration | null; requestId?: string; job?: RemoteJob; uncertain?: boolean; lease?: string };
// Fixed supervisor code: the transport dies on owner disconnection, expiration or explicit stop.
// A terminal receipt permits safe restart recovery without ever signalling a persisted PID.
const GUARDIAN = `const {spawn}=require('node:child_process');const fs=require('node:fs');let child,done=false,timer,config;
function finish(){if(done)return;done=true;clearTimeout(timer);if(config){for(const file of config.cleanup??[]){try{fs.unlinkSync(file)}catch{}}fs.writeFileSync(config.receipt,JSON.stringify({lease:config.lease,stopped:true}),{mode:384})}process.exit(0)}
function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return finish();child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')},1200).unref()}
process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('message',m=>{if(m.stop)return stop();if(config)return;config=m;child=spawn(m.binary,m.args,{env:m.env,shell:false,windowsHide:true,detached:false,stdio:'ignore'});child.once('error',finish);child.once('exit',finish);child.once('spawn',()=>{if(process.connected)process.send({pid:child.pid});else stop()});timer=setTimeout(stop,m.ttl)})`;
export function launchRemoteTransportGuardian(env:NodeJS.ProcessEnv) {
  return spawn(process.execPath,['-e',GUARDIAN],{shell:false,windowsHide:true,detached:false,stdio:['ignore','ignore','ignore','ipc'],env});
}
export type ManagedRemoteAccessOptions = {
  directory: string;
  secrets: SecretStore;
  /** Caller dispatches only the admitted inference/model route as the local owner. */
  dispatch: (path: string, request: Request) => Promise<Response>;
  /** Test seam: controlled local child, never selected by HTTP input. */
  launch?: (binary: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  probe?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string>;
};

/** One local configuration, child handle and journal owner. No PID-only kills or external setup. */
export class ManagedRemoteAccess {
  readonly controller = new RemoteAccessController();
  private readonly options: ManagedRemoteAccessOptions;
  private state: Journal;
  private child: ChildProcess | null = null;
  private identity: ProcessIdentity | null = null;
  private listener: Server | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly requests = new Set<AbortController>();
  private serial: Promise<unknown> = Promise.resolve();
  private readonly journalPath: string;
  private ingressOpen = false;
  private readonly transientFiles = new Set<string>();
  private guardian = false;

  constructor(options: ManagedRemoteAccessOptions) {
    this.options = options;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.journalPath = join(options.directory, 'state.json');
    this.state = existsSync(this.journalPath) ? JSON.parse(readFileSync(this.journalPath, 'utf8')) : { configuration: null };
    if (this.state.configuration) {
      const profile = parseRemoteAccessProfile(this.state.configuration.profile);
      this.state.configuration.profile = { ...profile, enabled: false };
      this.controller.adoptPlan(planRemoteAccessProfile({ expectedRevision: profile.revision, profile }), profile);
    }
    // After a crash a PID is insufficient evidence of ownership. Never launch a duplicate or kill a reused PID.
    if (this.state.job && ['running', 'starting', 'stopping', 'unknown'].includes(this.state.job.state) || this.state.uncertain) {
      this.state.uncertain = true;
      if (this.state.job) this.state.job = { ...this.state.job, state: 'unknown', lastHealth: 'unknown' };
      this.persist();
    }
    this.reconcileReceipt();
  }

  private reconcileReceipt() {
    if (!this.state.uncertain || !this.state.lease || !UUID.test(this.state.lease)) return;
    const path = join(this.options.directory, `${this.state.lease}.stopped.json`);
    if (!existsSync(path)) return;
    try {
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.lease !== this.state.lease || receipt.stopped !== true) return;
      this.state.uncertain = false;
      if (this.state.job) this.state.job = {...this.state.job,state:'stopped',lastHealth:'down'};
      this.persist();
    } catch { /* An incomplete receipt never authorizes another launch. */ }
  }

  private persist() {
    const temporary = `${this.journalPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.journalPath);
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.catch(() => undefined).then(action);
    this.serial = next; return next;
  }
  private clientKey(id: string) { return `remote-access:${id}:client`; }
  private tunnelKey(id: string) { return `remote-access:${id}:cloudflared`; }
  private configuration() { if (!this.state.configuration) throw new Error('setup_required'); return this.state.configuration; }
  private digest() { return createHash('sha256').update(JSON.stringify(this.configuration())).digest('hex'); }

  async getConfiguration() {
    this.reconcileReceipt();
    const config = this.state.configuration;
    return { configured: Boolean(config), revision: config?.profile.revision ?? 0,
      ...(config ? { configuration: config, planDigest: this.digest(),
        clientCredentialPresent: Boolean(await this.options.secrets.get(this.clientKey(config.profile.id))),
        tunnelCredentialPresent: config.profile.transport.kind === 'tailscale' || Boolean(await this.options.secrets.get(this.tunnelKey(config.profile.id))) } : {}),
      job: this.state.job ?? null, recoveryRequired: Boolean(this.state.uncertain) };
  }

  configure(input: unknown) { return this.locked(async () => {
    this.reconcileReceipt();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');
    const value = input as Record<string, unknown>;
    if (value.expectedRevision !== (this.state.configuration?.profile.revision ?? 0)) throw new Error('revision_conflict');
    if (this.state.uncertain || this.child || this.state.job?.state === 'running') throw new Error('remote_job_active');
    const profile = parseRemoteAccessProfile(value.profile);
    if (profile.revision !== Number(value.expectedRevision) + 1 || profile.enabled || profile.kind === 'local') throw new Error('invalid_request');
    if (profile.routes.some(route => !API_ROUTES.has(`${route.method} ${route.path}`))) throw new Error('route_not_declared');
    if (!Array.isArray(value.allowedModels) || !value.allowedModels.length || value.allowedModels.length > 100 || value.allowedModels.some(model=>typeof model!=='string'||!model.trim()||model.length>200||/[\s*]/.test(model))) throw new Error('allowed_models_required');
    const allowedModels=[...new Set(value.allowedModels as string[])];
    if (profile.credentialRef !== `ref:remote-client:${profile.id}`) throw new Error('remote_profile_credential_ref_invalid');
    if (typeof value.binaryPath !== 'string' || !isAbsolute(value.binaryPath) || value.binaryPath.includes('\0')) throw new Error('transport_unavailable');
    const binaryPath = realpathSync(value.binaryPath);
    const expectedName = profile.transport.kind + (process.platform === 'win32' ? '.exe' : '');
    if (!this.options.launch && basename(binaryPath).toLowerCase() !== expectedName) throw new Error('transport_unavailable');
    if (!lstatSync(binaryPath).isFile()) throw new Error('transport_unavailable');
    const clientToken = value.clientToken;
    if (clientToken !== undefined && (typeof clientToken !== 'string' || clientToken.length < 32 || clientToken.length > 4096 || /[\s\0]/.test(clientToken))) throw new Error('credential_invalid');
    if (!clientToken && !await this.options.secrets.get(this.clientKey(profile.id))) throw new Error('setup_required');
    let tunnelId: string | undefined;
    if (profile.transport.kind === 'cloudflared') {
      if (typeof value.tunnelId !== 'string' || !UUID.test(value.tunnelId)) throw new Error('setup_required');
      tunnelId = value.tunnelId;
      if (value.cloudflaredCredentials !== undefined) {
        if (typeof value.cloudflaredCredentials !== 'string' || value.cloudflaredCredentials.length > 16_384) throw new Error('credential_invalid');
        let credential; try { credential = JSON.parse(value.cloudflaredCredentials); } catch { throw new Error('credential_invalid'); }
        if (!credential || credential.TunnelID !== tunnelId || typeof credential.AccountTag !== 'string' || typeof credential.TunnelSecret !== 'string' || !credential.TunnelSecret) throw new Error('credential_invalid');
        await this.options.secrets.set(this.tunnelKey(profile.id), JSON.stringify({AccountTag:credential.AccountTag,TunnelSecret:credential.TunnelSecret,TunnelID:tunnelId}));
      } else {
        const stored=await this.options.secrets.get(this.tunnelKey(profile.id));
        if(!stored||JSON.parse(stored).TunnelID!==tunnelId)throw new Error('setup_required');
      }
    }
    if (typeof clientToken === 'string') await this.options.secrets.set(this.clientKey(profile.id), clientToken);
    this.state = { configuration: { profile, binaryPath, allowedModels, ...(tunnelId ? { tunnelId } : {}) } };
    this.persist();
    this.controller.adoptPlan(planRemoteAccessProfile({expectedRevision:profile.revision,profile}),profile);
    return this.getConfiguration();
  }); }

  async plan() {
    const config = this.configuration();
    return { ...planRemoteAccessProfile({expectedRevision:config.profile.revision,profile:config.profile}), planDigest: this.digest(), binaryPath:config.binaryPath, allowedModels:config.allowedModels };
  }

  private processEnvironment(): NodeJS.ProcessEnv {
    const home = join(this.options.directory, 'transport-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return { ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
      ...(process.env.TEMP ? {TEMP:process.env.TEMP,TMP:process.env.TEMP} : {}),
      HOME: home, USERPROFILE: home, APPDATA:home, LOCALAPPDATA:home, NO_COLOR:'1' };
  }

  private async openIngress(profile: RemoteAccessProfile) {
    this.listener = createServer((incoming, outgoing) => { void (async () => {
      const requestAbort = new AbortController();
      const finish = () => requestAbort.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.ingressOpen || this.requests.size >= profile.limits.maxConcurrent) { outgoing.writeHead(503).end(); return; }
        const url = incoming.url ?? '';
        const prefix = `/remote/${profile.id}`;
        const route = url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : '';
        const method = incoming.method ?? '';
        if (!profile.routes.some(item => item.path === route && item.method === method) || !API_ROUTES.has(`${method} ${route}`)) { outgoing.writeHead(403).end(); return; }
        this.requests.add(requestAbort);
        const bearer = incoming.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? '';
        const expected = await this.options.secrets.get(this.clientKey(profile.id));
        if (!expected || !bearer || !timingSafeEqual(createHash('sha256').update(bearer).digest(), createHash('sha256').update(expected).digest())) { outgoing.writeHead(401).end(); return; }
        timer = setTimeout(() => { requestAbort.abort(); outgoing.destroy(); }, profile.limits.streamTimeoutMs);
        incoming.once('aborted', finish); outgoing.once('close', finish);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > profile.limits.maxBodyBytes) { outgoing.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        if (!this.ingressOpen) { outgoing.writeHead(503).end(); return; }
        const body=Buffer.concat(chunks);
        const models=this.configuration().allowedModels;
        if (method==='POST') {
          let input;try{input=JSON.parse(body.toString('utf8'));}catch{outgoing.writeHead(400).end();return;}
          if (!input || !models.includes(input.model) || input.models!==undefined && (!Array.isArray(input.models)||input.models.some((model:unknown)=>!models.includes(String(model))))) { outgoing.writeHead(403).end();return; }
        }
        const response = await this.options.dispatch(route, new Request(`http://127.0.0.1${route}`, {
          method, headers: {'content-type':'application/json'}, signal:requestAbort.signal,
          ...(method === 'POST' ? {body} : {})
        }));
        if(method==='GET' && route==='/v1/models' && response.ok){const payload=await response.json() as {data?:Array<{id:string}>};outgoing.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({object:'list',data:Array.isArray(payload.data)?payload.data.filter(model=>models.includes(model.id)):[]}));return;}
        outgoing.writeHead(response.status, {'content-type':response.headers.get('content-type') ?? 'application/json','cache-control':'no-store'});
        if (response.body) {
          const reader = response.body.getReader();
          try { while (!requestAbort.signal.aborted) { const part = await reader.read(); if (part.done) break; if (!outgoing.write(part.value)) await new Promise<void>(resolve => { const done=()=>{outgoing.off('drain',done);outgoing.off('close',done);resolve();};outgoing.once('drain',done);outgoing.once('close',done); }); } }
          finally { await reader.cancel().catch(() => undefined); }
        }
        outgoing.end();
      } catch { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }
      finally { clearTimeout(timer); this.requests.delete(requestAbort); requestAbort.abort(); }
    })(); });
    this.listener.requestTimeout = profile.limits.timeoutMs;
    await new Promise<void>((resolve, reject) => { this.listener!.once('error',reject); this.listener!.listen(0,'127.0.0.1',resolve); });
    const address = this.listener.address();
    if (!address || typeof address === 'string') throw new Error('transport_unavailable');
    return `http://127.0.0.1:${address.port}`;
  }

  start(input: {requestId: string; expectedRevision: number; planDigest: string; ttlMs?: number}) { return this.locked(async () => {
    this.reconcileReceipt();
    const config = this.configuration();
    if (!/^[A-Za-z0-9_-]{3,90}$/.test(input.requestId)) throw new Error('invalid_request');
    if (input.expectedRevision !== config.profile.revision || input.planDigest !== this.digest()) throw new Error('revision_conflict');
    if (this.state.uncertain) throw new Error('process_identity_unknown');
    if (this.state.requestId === input.requestId && this.state.job) return this.observe();
    if(!await this.options.secrets.get(this.clientKey(config.profile.id)))throw new Error('credential_revoked');
    await this.observe();
    if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) await this.endProcess();
    if (this.child) throw new Error('remote_job_active');
    const ttl = input.ttlMs ?? 600_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 3_600_000) throw new Error('invalid_request');
    const env = this.processEnvironment();
    const versionOutput = this.options.probe ? await this.options.probe(config.binaryPath,env) : await new Promise<string>((resolve,reject) => {
      execFile(config.binaryPath,['--version'],{env,windowsHide:true,timeout:3000,maxBuffer:16384},(err,stdout)=>err?reject(new Error('transport_unavailable')):resolve(stdout));
    });
    const version = parseTransportVersion(versionOutput);
    if (!version || version !== config.profile.transport.clientVersion) throw new Error('transport_version_changed');
    this.state.requestId = input.requestId; this.state.lease=randomUUID(); this.state.uncertain = true; this.persist();
    try {
      const ingress = await this.openIngress(config.profile);
      let args: string[];
      if (config.profile.transport.kind === 'tailscale') {
        args = ['serve', `--https=${new URL(config.profile.origin).port || '443'}`, ingress];
      } else {
        const credentials = await this.options.secrets.get(this.tunnelKey(config.profile.id));
        if (!credentials) throw new Error('setup_required');
        const credentialPath = join(this.options.directory, `${randomUUID()}.credential.json`);
        const configPath = join(this.options.directory, `${randomUUID()}.config.json`);
        writeFileSync(credentialPath,credentials,{mode:0o600}); this.transientFiles.add(credentialPath);
        writeFileSync(configPath,JSON.stringify({tunnel:config.tunnelId,'credentials-file':credentialPath,ingress:[{hostname:new URL(config.profile.origin).hostname,service:ingress},{service:'http_status:404'}]}),{mode:0o600}); this.transientFiles.add(configPath);
        args=['tunnel','--no-autoupdate','--config',configPath,'run',config.tunnelId!];
      }
      this.guardian = !this.options.launch;
      const child = this.options.launch ? this.options.launch(config.binaryPath,args,{shell:false,windowsHide:true,detached:false,stdio:'ignore',env}) : launchRemoteTransportGuardian(env);
      this.child = child;
      await new Promise<void>((resolve,reject) => { child.once('spawn',resolve); child.once('error',()=>reject(new Error('transport_unavailable'))); });
      const pid = this.guardian ? await new Promise<number>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('transport_unavailable')),5000);
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('transport_unavailable'));});
        child.once('message',(message)=>{clearTimeout(timer);const pid=(message as {pid?:number}).pid;pid?resolve(pid):reject(new Error('process_identity_unknown'));});
        child.send!({binary:config.binaryPath,args,env,ttl,receipt:join(this.options.directory,`${this.state.lease}.stopped.json`),lease:this.state.lease,cleanup:[...this.transientFiles]});
      }) : child.pid;
      if (!pid) throw new Error('process_identity_unknown');
      this.identity = createProcessIdentity({processId:`remote-${this.state.lease}`,pid,startedAtMs:Date.now(),binaryPath:config.binaryPath,binaryVersion:version,args});
      await new Promise(resolve=>setTimeout(resolve,100));
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('transport_unavailable');
      this.state.job = this.controller.start({requestId:input.requestId,authorityPrincipal:'local-owner',processIdentity:this.identity,ttlMs:ttl});
      // Child liveness proves local transport, not authentication/readiness of the remote endpoint.
      this.state.job = {...this.state.job,lastHealth:'unknown'};
      this.state.uncertain = false; this.ingressOpen = true; this.persist();
      this.expiry = setTimeout(()=>{void this.stop(this.state.job!.jobRef,this.identity!).catch(()=>undefined);},ttl);
      this.expiry.unref();
      child.once('exit',()=>{this.ingressOpen=false;void this.closeIngress();});
      return this.observe();
    } catch (error) {
      await this.endProcess();
      this.state.uncertain = false; this.state.job = undefined; this.persist(); throw error;
    }
  }); }

  async observe() {
    this.reconcileReceipt();
    if (this.state.uncertain) return this.state.job ? {...this.state.job,state:'unknown' as const,lastHealth:'unknown' as const} : null;
    if (this.state.job?.state === 'running' && (!this.child || this.child.exitCode !== null || this.child.signalCode !== null)) {
      if(this.state.job.processIdentity)this.controller.stop({jobRef:this.state.job.jobRef,processIdentity:this.state.job.processIdentity});
      this.state.job = {...this.state.job,state:'stopped',lastHealth:'down'}; this.persist();
    }
    return this.state.job ? {...this.state.job} : null;
  }

  private async closeIngress() {
    this.ingressOpen = false;
    for (const request of this.requests) request.abort();
    if (this.listener) { const listener=this.listener; this.listener=null; listener.closeAllConnections(); await new Promise<void>(resolve=>listener.close(()=>resolve())); }
  }
  private async endProcess() {
    clearTimeout(this.expiry ?? undefined); this.expiry=null;
    await this.closeIngress();
    const child=this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (this.guardian && child.connected) child.send({stop:true}); else child.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),new Promise<void>(resolve=>setTimeout(resolve,1500))]);
      if (child.exitCode === null && child.signalCode === null) {
        // Never kill the guardian before it has reaped its transport.
        if (this.guardian) { this.state.uncertain=true;this.persist();throw new Error('process_identity_unknown'); }
        child.kill('SIGKILL'); await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      }
    }
    this.child=null; this.identity=null;
    for (const file of this.transientFiles) { try { unlinkSync(file); } catch {} }
    this.transientFiles.clear();
  }

  stop(jobRef: string, identity: ProcessIdentity) { return this.locked(async () => {
    this.reconcileReceipt();
    if (this.state.uncertain || !this.state.job || this.state.job.jobRef !== jobRef || !this.state.job.processIdentity) throw new Error('process_identity_unknown');
    assertSameProcessIdentity(this.state.job.processIdentity,identity);
    if(this.state.job.state==='stopped')return {...this.state.job};
    if (this.identity) assertSameProcessIdentity(this.identity,identity);
    await this.endProcess();
    this.state.job=this.controller.stop({jobRef,processIdentity:identity}); this.persist(); return this.state.job;
  }); }
  revoke(expectedRevision: number) { return this.locked(async () => {
    this.reconcileReceipt();
    const config=this.configuration(); if (config.profile.revision !== expectedRevision) throw new Error('revision_conflict');
    if (this.state.uncertain) throw new Error('process_identity_unknown');
    await this.endProcess();
    await this.options.secrets.delete(this.clientKey(config.profile.id));
    this.state.job=this.controller.revoke({expectedRevision}); this.persist(); return this.state.job;
  }); }
  async close() { await this.locked(async()=>{await this.endProcess();if(this.state.job&&!this.state.uncertain){if(this.state.job.state==='running'&&this.state.job.processIdentity)this.controller.stop({jobRef:this.state.job.jobRef,processIdentity:this.state.job.processIdentity});this.state.job={...this.state.job,state:'stopped',lastHealth:'down'};this.persist();}}); }
}
