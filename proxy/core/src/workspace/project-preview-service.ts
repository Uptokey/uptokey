import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseProjectPreviewSession,
  type ProjectPreviewSession,type ProjectFileManifest,type ProjectRunRequest
} from '@uptokey/sync-contract/project-agent';
import { ProjectRootService, isProtectedProjectPath } from './project-root-service.ts';
import {ProjectRunnerService} from './project-runner-service.ts';

export class ProjectPreviewError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ProjectPreviewError';
  }
}

interface ActiveServer {
  server: http.Server;
  session: ProjectPreviewSession;
  rootPath: string;
  rootBindingId:string;
  dynamicStop?:()=>Promise<void>;
  clients:Set<http.ServerResponse>;
  timer: ReturnType<typeof setTimeout>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

export class ProjectPreviewService {
  private readonly activeServers = new Map<string, ActiveServer>();
  private readonly rootService: ProjectRootService;
  private readonly runner?:ProjectRunnerService;
  private readonly frameOrigins:string[];

  constructor(rootService: ProjectRootService,runner?:ProjectRunnerService,options:{frameOrigins?:readonly string[]}={}) {
    this.rootService = rootService;
    this.runner=runner;
    this.frameOrigins=(options.frameOrigins??['http://127.0.0.1:5273','http://localhost:5273']).filter(origin=>{try{return new URL(origin).origin===origin&&/^https?:/.test(origin);}catch{return false;}});
  }


  broadcastReload(rootBindingId: string, changedPaths: readonly string[] = []): void {
    const payload = `data: ${JSON.stringify({ event: 'reload', timestamp: Date.now() })}\n\n`;
    for(const entry of this.activeServers.values()){if(entry.rootBindingId!==rootBindingId)continue;
    for (const client of entry.clients) {
      try {
        client.write(payload);
      } catch {
        entry.clients.delete(client);
      }
    }}
  }

  async startPreview(params: {
    taskId: string;
    rootBindingId: string;
    manifestDigest: string;
    runtimeProfileId: string;
    allowedResourceIds: readonly string[];
    entrypointPath?: string;
    ttlSeconds?: number;
    manifest?:ProjectFileManifest;
    runId?:string;
    signal?:AbortSignal;
    request?:ProjectRunRequest;
  }): Promise<ProjectPreviewSession> {
    const root = this.rootService.getVerifiedRoot(params.rootBindingId);

    const sessionId = `preview-${randomUUID()}`;
    const ttlSeconds=params.ttlSeconds??3600;
    if(!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>3600)throw new ProjectPreviewError('preview_ttl_invalid',400);
    const allowed=new Set(params.allowedResourceIds);
    if(allowed.size===0||allowed.size>100||[...allowed].some(resource=>isProtectedProjectPath(resource)))throw new ProjectPreviewError('preview_resources_invalid',400);
    for(const resource of allowed)this.rootService.resolveVerifiedPath(params.rootBindingId,resource);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    params.signal?.throwIfAborted();
    const dynamic=params.runtimeProfileId==='static-web'?undefined:await this.runner?.startPreview({runId:params.runId??sessionId,rootBindingId:params.rootBindingId,manifest:params.manifest,signal:params.signal,request:params.request??{taskId:params.taskId,manifestDigest:params.manifestDigest,runtimeProfileId:params.runtimeProfileId,actionId:'preview',relativeWorkingDirectory:'.',artifactInputRefs:[],timeoutMs:Math.min(ttlSeconds*1000,300000),outputLimitBytes:1048576}});
    if(params.runtimeProfileId!=='static-web'&&!dynamic)throw new ProjectPreviewError('runtime_not_configured',503);
    const prefix=`/_uptokey/${sessionId}/`,clients=new Set<http.ServerResponse>();

    const server = http.createServer(async (req, res) => {
      // Strict Security Headers
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; connect-src 'self'; form-action 'none'; frame-src 'none'; frame-ancestors ${this.frameOrigins.join(' ')||"'none'"}; sandbox allow-scripts`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }

      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const address=server.address();
        if(!address||typeof address==='string'||req.headers.host!==`127.0.0.1:${address.port}`||!reqUrl.pathname.startsWith(prefix)){res.statusCode=403;res.end('Preview session required');return;}
        // The approved iframe is an opaque sandbox origin. The session prefix is still required.
        if(req.headers.origin==='null')res.setHeader('Access-Control-Allow-Origin','null');
        this.rootService.getVerifiedRoot(params.rootBindingId);
        if(Date.now()>=Date.parse(expiresAt)||params.signal?.aborted){res.statusCode=410;res.end('Preview expired');return;}
        const resourcePath=reqUrl.pathname.slice(prefix.length);

        if (resourcePath === 'preview/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          res.write(': connected\n\n');
          const client = res;
          clients.add(client);
          req.on('close', () => {
            clients.delete(client);
          });
          return;
        }
        let cleanPath = decodeURIComponent(resourcePath);
        if (cleanPath === '/' || cleanPath === '') {
          cleanPath = params.entrypointPath || 'web/index.html';
        }
        if (cleanPath.startsWith('/')) {
          cleanPath = cleanPath.slice(1);
        }
        if(isProtectedProjectPath(cleanPath)||cleanPath.split('/').includes('..')||!dynamic&&!allowed.has(cleanPath)) {
          res.statusCode=403;res.end('Resource Not Allowed');return;
        }

        if(dynamic){const response=await dynamic.fetch(`/${resourcePath}${reqUrl.search}`);res.statusCode=response.status;res.setHeader('Content-Type',response.contentType);let bytes=response.bytes;if(response.contentType.includes('text/html'))bytes=Buffer.from(`<base href="${prefix}">`+bytes.toString('utf8'));res.end(req.method==='HEAD'?undefined:bytes);return;}
        // Validate that requested resource is within project root
        const absFile = this.rootService.resolveVerifiedPath(params.rootBindingId, cleanPath);

        if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }

        const ext = path.extname(absFile).toLowerCase();
        if(fs.statSync(absFile).size>8*1024*1024){res.statusCode=413;res.end('Resource Too Large');return;}
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);

        let fileBytes = req.method === 'HEAD' ? undefined : fs.readFileSync(absFile);
        const wantLiveReload = reqUrl.searchParams.has('livereload') || reqUrl.searchParams.has('live') || req.headers['x-uptokey-live-reload'] === '1';
        if (fileBytes && (ext === '.html' || ext === '.htm') && wantLiveReload) {
          let htmlStr = fileBytes.toString('utf8');
          const reloadScript = `<script>(() => { try { const es = new EventSource('${prefix}preview/events'); es.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.event === 'reload') window.location.reload(); } catch(_) {} }; } catch(_) {} })();</script>`;
          if (htmlStr.includes('</body>')) {
            htmlStr = htmlStr.replace('</body>', reloadScript + '</body>');
          } else {
            htmlStr += reloadScript;
          }
          fileBytes = Buffer.from(htmlStr, 'utf8');
          res.setHeader('Content-Length', fileBytes.length);
        }
        res.statusCode = 200;
        res.end(fileBytes);
      } catch {
        res.statusCode = 400;
        res.end('Invalid Request');
      }
    });

    return new Promise<ProjectPreviewSession>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          reject(new ProjectPreviewError('Failed to bind preview server', 500));
          return;
        }

        const origin = `http://127.0.0.1:${addr.port}`;
        const rawSession = {
          id: sessionId,
          taskId: params.taskId,
          manifestDigest: params.manifestDigest,
          runtimeJobRef: dynamic?.jobId??null,
          origin,
          allowedResourceIds: [...params.allowedResourceIds],
          expiresAt,
          status: 'running' as const
        };

        const session = parseProjectPreviewSession(rawSession);
        this.activeServers.set(sessionId, {
          server,
          session,
          rootPath: root.localPath
          ,rootBindingId:params.rootBindingId,clients,dynamicStop:dynamic?.stop,timer:setTimeout(()=>{void this.stopPreview(sessionId).catch(()=>{});},ttlSeconds*1000)
        });
        params.signal?.addEventListener('abort',()=>{void this.stopPreview(sessionId).catch(()=>{});},{once:true});

        resolve(session);
      });

      server.on('error', err => {
        void dynamic?.stop().catch(()=>{});
        reject(new ProjectPreviewError(`Preview server error: ${err.message}`, 500));
      });
    });
  }

  getPreview(sessionId:string){const entry=this.activeServers.get(sessionId);return entry?{session:entry.session,rootBindingId:entry.rootBindingId}:undefined;}
  async stopRoot(rootBindingId:string){await Promise.all([...this.activeServers].filter(([,entry])=>entry.rootBindingId===rootBindingId).map(([id])=>this.stopPreview(id)));}
  async stopPreview(sessionId: string): Promise<void> {
    const entry = this.activeServers.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      for(const client of entry.clients)client.end();entry.clients.clear();
      await entry.dynamicStop?.();
      entry.server.close();
      entry.server.closeAllConnections();
      this.activeServers.delete(sessionId);
    }
  }

  async stopAll(): Promise<void> {await Promise.all([...this.activeServers.keys()].map(id=>this.stopPreview(id)));}
}
