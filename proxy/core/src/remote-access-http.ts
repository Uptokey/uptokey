import type { Context, Hono } from "hono";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import {
  RemoteAccessController,
  discoverRemoteTransport,
  planRemoteAccessProfile,
  type TransportObservation,
} from "./remote-access-ops.ts";
import type { RemoteAccessProfileKind, RemoteAccessTransportKind } from "./remote-access-profile.ts";

/** Rotas locais E2-18 — sem admin/cofre/pareamento. */
export const REMOTE_ACCESS_LOCAL_ROUTES = [
  { path: "/local/remote-access/config", method: "GET" as const },
  { path: "/local/remote-access/config", method: "POST" as const },
  { path: "/local/remote-access/discover", method: "GET" as const },
  { path: "/local/remote-access/plan", method: "POST" as const },
  { path: "/local/remote-access/start", method: "POST" as const },
  { path: "/local/remote-access/stop", method: "POST" as const },
  { path: "/local/remote-access/observe", method: "GET" as const },
  { path: "/local/remote-access/revoke", method: "POST" as const },
  { path: "/local/remote-access/grants", method: "GET" as const },
] as const;

const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Gate de query para discover/observe — mesmo padrão de workspaceUsageQuery. */
export function remoteAccessQueryAllowed(url: URL): boolean {
  if (url.pathname !== "/local/remote-access/discover" && url.pathname !== "/local/remote-access/observe") return false;
  const allowed = url.pathname.endsWith("/discover") ? ["transportKind", "platform"] : ["jobRef", "cursor"];
  const keys = [...url.searchParams.keys()];
  if (!keys.every((key) => allowed.includes(key) && url.searchParams.getAll(key).length === 1)) return false;
  const transportKind = url.searchParams.get("transportKind");
  if (transportKind !== null && !["cloudflared", "tailscale"].includes(transportKind)) return false;
  const platform = url.searchParams.get("platform");
  if (platform !== null && !["windows", "macos", "linux"].includes(platform)) return false;
  const jobRef = url.searchParams.get("jobRef");
  if (jobRef !== null && !REMOTE_ID.test(jobRef)) return false;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !/^\d+$/.test(cursor)) return false;
  return true;
}

export type RemoteAccessAuth = (authorizationHeader: string | undefined, origin?:string) => Promise<boolean>;

export interface RemoteAccessHttpOptions {
  managed?: import('./remote-access-supervisor.ts').ManagedRemoteAccess;
  controller?: RemoteAccessController;
  authorize: RemoteAccessAuth;
  /** Observação injetável — nunca faz install/login implícito. */
  observeTransport?: (kind: RemoteAccessTransportKind, platform: string) => TransportObservation;
  /** Supervisor opcional para gerenciar/validar ciclo de vida de processos reais. */
  supervisor?: import("./remote-access-ops.ts").ProcessSupervisor;
}

function jsonError(c: Context, type: string, status: 400 | 401 | 403 | 409 | 503 = 400) {
  return c.json({ error: { type } }, status);
}

function publicPlan(plan: ReturnType<typeof planRemoteAccessProfile>) {
  return {
    immutable: plan.immutable,
    revision: plan.revision,
    profileId: plan.profileId,
    kind: plan.kind,
    transport: plan.transport,
    origin: plan.origin,
    routes: plan.routes,
    audience: plan.audience,
    /** Só a referência — nunca o segredo. */
    credentialRefPresent: Boolean(plan.credentialRef),
    limits: plan.limits,
    policyRef: plan.policyRef,
    resolvedDestination: plan.resolvedDestination,
    copyableEndpoint: plan.copyableEndpoint,
  };
}

/**
 * Registra handlers E2-18 no app Hono já autenticado pelo chamador
 * (o middleware global de app.ts ainda exige path na allowlist).
 */
export function registerRemoteAccessRoutes(app: Hono, options: RemoteAccessHttpOptions): RemoteAccessController {
  const controller = options.managed?.controller ?? options.controller ?? new RemoteAccessController();
  let lastProfileInput: unknown = null;
  let lastPlanRevision: number | null = null;

  const requireAuth = async (c: Context): Promise<boolean> => {
    return options.authorize(c.req.header("authorization"),c.req.header('origin'));
  };

  app.get('/local/remote-access/config',async c=>{
    if(!await requireAuth(c))return jsonError(c,'unauthorized',401);
    if(!options.managed)return jsonError(c,'setup_required',503);
    try{return c.json(await options.managed.getConfiguration());}catch{return jsonError(c,'remote_configuration_unavailable',503);}
  });
  app.post('/local/remote-access/config',async c=>{
    if(!await requireAuth(c))return jsonError(c,'unauthorized',401);
    if(!options.managed)return jsonError(c,'setup_required',503);
    try{return c.json(await options.managed.configure(await c.req.json()));}
    catch(error){const type=error instanceof Error?error.message:'invalid_request';return jsonError(c,type,type==='revision_conflict'||type==='remote_job_active'?409:400);}
  });

  app.get("/local/remote-access/discover", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    const url = new URL(c.req.url);
    const transportKind = (url.searchParams.get("transportKind") ?? "cloudflared") as RemoteAccessTransportKind;
    const platform = (url.searchParams.get("platform") ?? "windows") as "windows" | "macos" | "linux";
    if (transportKind !== "cloudflared" && transportKind !== "tailscale") return jsonError(c, "transport_unavailable");
    if (platform !== "windows" && platform !== "macos" && platform !== "linux") return jsonError(c, "invalid_request");
    const observation = options.observeTransport?.(transportKind, platform) ?? { installed: false };
    const result = discoverRemoteTransport({ transportKind, platform }, observation);
    return c.json({ discover: result });
  });

  app.post("/local/remote-access/plan", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonError(c, "invalid_request"); }
    if (!record(body) || !Number.isSafeInteger(body.expectedRevision) || body.profile === undefined) {
      return jsonError(c, "invalid_request");
    }
    try {
      if(options.managed){
        const managedPlan=await options.managed.plan();
        if(body.expectedRevision!==managedPlan.revision)return jsonError(c,'revision_conflict',409);
        return c.json({plan:{...publicPlan(managedPlan),planDigest:managedPlan.planDigest,binaryPath:managedPlan.binaryPath,allowedModels:managedPlan.allowedModels}});
      }
      const plan = planRemoteAccessProfile({
        expectedRevision: body.expectedRevision as number,
        profile: body.profile,
      });
      lastProfileInput = body.profile;
      lastPlanRevision = plan.revision;
      controller.adoptPlan(plan, body.profile);
      return c.json({ plan: publicPlan(plan) });
    } catch (error) {
      const type = error instanceof Error ? error.message : "invalid_request";
      return jsonError(c, type, type === "revision_conflict" ? 409 : 400);
    }
  });

  app.post("/local/remote-access/start", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonError(c, "invalid_request"); }
    if(options.managed){
      if(!record(body)||typeof body.requestId!=='string'||!Number.isSafeInteger(body.expectedRevision)||typeof body.planDigest!=='string'||Object.keys(body).some(key=>!['requestId','expectedRevision','planDigest','ttlMs'].includes(key)))return jsonError(c,'invalid_request');
      try{return c.json({job:await options.managed.start({requestId:body.requestId,expectedRevision:Number(body.expectedRevision),planDigest:body.planDigest,...(body.ttlMs!==undefined?{ttlMs:Number(body.ttlMs)}:{})})});}
      catch(error){const type=error instanceof Error?error.message:'transport_unavailable';return jsonError(c,type,['revision_conflict','remote_job_active','process_identity_unknown'].includes(type)?409:503);}
    }
    if (!record(body) || typeof body.requestId !== "string" || typeof body.authorityPrincipal !== "string") {
      return jsonError(c, "invalid_request");
    }
    if (!lastProfileInput || lastPlanRevision === null) return jsonError(c, "setup_required", 503);
    // No PID, path or version supplied by a caller is proof of a running tunnel.
    if (!options.supervisor?.launchProcess) return jsonError(c, "transport_unavailable", 503);
    try {
      const identity = await options.supervisor.launchProcess(
        controller.getPlan()!,
        [], // Legacy supervisor owns argument construction; never accept commands from a request.
      );
      const alive = await options.supervisor.isProcessAlive(identity);
      if (!alive) return jsonError(c, "process_identity_unknown", 400);
      const job = controller.start({
        requestId: body.requestId,
        authorityPrincipal: body.authorityPrincipal,
        processIdentity: identity,
        ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
      });
      return c.json({ job });
    } catch (error) {
      const type = error instanceof Error ? error.message : "setup_required";
      return jsonError(c, type, type === "setup_required" ? 503 : 400);
    }
  });

  app.post("/local/remote-access/stop", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonError(c, "invalid_request"); }
    if (!record(body) || typeof body.jobRef !== "string" || !record(body.processIdentity)) {
      return jsonError(c, "invalid_request");
    }
    try {
      const pi = body.processIdentity;
      if (
        typeof pi.processId !== "string"
        || typeof pi.binaryPath !== "string"
        || typeof pi.binaryVersion !== "string"
        || typeof pi.argsDigest !== "string"
        || !Number.isSafeInteger(pi.pid)
        || !Number.isSafeInteger(pi.startedAtMs)
      ) {
        return jsonError(c, "process_identity_unknown", 409);
      }
      const identity = {
        processId: pi.processId,
        binaryPath: pi.binaryPath,
        binaryVersion: pi.binaryVersion,
        argsDigest: pi.argsDigest,
        pid: pi.pid as number,
        startedAtMs: pi.startedAtMs as number,
      };
      const job = options.managed ? await options.managed.stop(body.jobRef,identity) : controller.stop({ jobRef: body.jobRef, processIdentity: identity });
      return c.json({ job });
    } catch (error) {
      const type = error instanceof Error ? error.message : "process_identity_unknown";
      return jsonError(c, type, 409);
    }
  });

  app.get("/local/remote-access/observe", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    const url = new URL(c.req.url);
    if(options.managed){
      const job=await options.managed.observe();
      if(url.searchParams.has('jobRef')&&job&&url.searchParams.get('jobRef')!==job.jobRef)return jsonError(c,'process_identity_unknown',409);
      return c.json({observe:{job,state:job?.state??'planned',lastHealth:job?.lastHealth??'unknown',expiresAt:job?.expiresAt??null,nextCursor:'0'}});
    }
    const observed = controller.observe({
      jobRef: url.searchParams.get("jobRef") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return c.json({ observe: observed });
  });

  app.post("/local/remote-access/revoke", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return jsonError(c, "invalid_request"); }
    if (!record(body) || !Number.isSafeInteger(body.expectedRevision)) return jsonError(c, "invalid_request");
    try {
      const job = options.managed ? await options.managed.revoke(body.expectedRevision as number) : controller.revoke({
        expectedRevision: body.expectedRevision as number,
        clientRef: typeof body.clientRef === "string" ? body.clientRef : undefined,
      });
      return c.json({ job });
    } catch (error) {
      const type = error instanceof Error ? error.message : "revision_conflict";
      return jsonError(c, type, type === "revision_conflict" ? 409 : 400);
    }
  });

  app.get("/local/remote-access/grants", async (c) => {
    if (!(await requireAuth(c))) return jsonError(c, "unauthorized", 401);
    return c.json({
      grants: controller.listGrants(),
      capabilities: [
        { capability: "terminal", adapterStatus: "pending_external_api", connected: false },
        { capability: "desktop_view", adapterStatus: "pending_external_api", connected: false },
        { capability: "desktop_control", adapterStatus: "pending_external_api", connected: false },
        { capability: "files", adapterStatus: "pending_external_api", connected: false },
      ] as const,
    });
  });

  void (0 as unknown as RemoteAccessProfileKind);
  return controller;
}
