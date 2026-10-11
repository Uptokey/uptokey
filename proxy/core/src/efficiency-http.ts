import {efficiencyProcessors,headroomEndpoint,prepareEfficiency} from './workspace/efficiency-transforms.ts';
import {responseStylePreview} from './response-style.ts';
import {projectInferenceRequest} from './inference-request-policy.ts';
import {detailedTokenEstimate} from './token-estimate.ts';
import type {ChatCompletionRequest} from './types.ts';
/**
 * E2-17 local HTTP routes:
 *   GET/PATCH /local/efficiency/policy
 *   GET       /local/efficiency/metrics
 *   POST      /local/efficiency/cache/invalidate
 * Keeps /local/cache/invalidate/:provider (existing) untouched.
 */
import type { Context, Hono, Next } from "hono";
import {
  assertEfficiencyPolicy,
  defaultEfficiencyPolicy,
  type EfficiencyPolicy,
} from "./efficiency-policy.ts";
import {
  getActiveEfficiencyPolicy,
  setActiveEfficiencyPolicy,
} from "./workspace/efficiency-pipeline.ts";

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

export const EFFICIENCY_LOCAL_ROUTES: Array<[string, string]> = [
  ["/local/efficiency/policy", "GET"],
  ["/local/efficiency/policy", "PATCH"],
  ["/local/efficiency/metrics", "GET"],
  ["/local/efficiency/cache/invalidate", "POST"],
  ["/local/efficiency/preview", "POST"],
];

export function matchEfficiencyLocalRoute(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if (pathname === "/local/efficiency/policy" && (m === "GET" || m === "PATCH")) return true;
  if (pathname === "/local/efficiency/preview" && m === "POST") return true;
  if (pathname === "/local/efficiency/metrics" && m === "GET") return true;
  if (pathname === "/local/efficiency/cache/invalidate" && m === "POST") return true;
  return false;
}

export interface EfficiencyHttpDeps {
  requireLocalAuth: AuthMiddleware;
  /** Existing local settings owner may persist the validated policy. No secret data. */
  persistPolicy?: (policy:EfficiencyPolicy)=>Promise<void>;
  /** Prefer router.efficiencyMetrics() when present (Windows Stage 10). */
  getMetrics?: () => unknown;
  cacheSupport?: {provenance:boolean;semantic:boolean;providerPrompt:boolean};
  getReadCacheMetrics?:()=>unknown;
  getProviderPromptMetrics?:()=>unknown;
  /** Scoped invalidate; kind must be explicit. */
  invalidateScoped?: (scope: {
    kind: "exact" | "semantic" | "provenance" | "provider";
    provider?: string;
    tenantId?: string;
  }) => Promise<{ ok: true; invalidated: number|null } | { ok: false; code: string; status: number }>;
}

export function registerEfficiencyRoutes(app: Hono, deps: EfficiencyHttpDeps): void {
  const { requireLocalAuth } = deps;
  app.use("/local/efficiency/*", requireLocalAuth);

  app.get("/local/efficiency/policy", (c) => {
    const policy=getActiveEfficiencyPolicy();return c.json({policy,cacheSupport:deps.cacheSupport??null,processors:efficiencyProcessors(),style:responseStylePreview(policy.enabled?policy.responseStyle:{kind:'default',level:'lite',codeOnly:false})});
  });

  app.post('/local/efficiency/preview',async c=>{
    try{const input=await c.req.json();if(!input||typeof input!=='object')throw Error();
      // Histórico (contrato PWA V3): projeção local de tokens da prévia do contexto.
      // Perdido na restauração do core em 28/09; restaurado a partir do bundle pré-incidente
      // (output/recovery-2026-09-28/compiled-before/cli.js), preservando os ramos responseStyle
      // e authoritative/content/policy. Consome token-estimate/token-catalog sem editá-los
      // (reserva T2–T4 preservada).
      if(Object.keys(input).join(',')==='tokenProjection'){
        const projection=input.tokenProjection;
        if(!projection||typeof projection!=='object'||Array.isArray(projection)||Object.keys(projection).sort().join(',')!=='full,model,selected'||typeof projection.model!=='string'||Buffer.byteLength(JSON.stringify(projection))>1_048_576)throw Error();
        const full=projectInferenceRequest({model:projection.model,messages:projection.full});
        const selected=projectInferenceRequest({model:projection.model,messages:projection.selected});
        if(!full||!selected)throw Error();
        const fullRequest:ChatCompletionRequest=full,selectedRequest:ChatCompletionRequest=selected;
        const summarize=(request:ChatCompletionRequest)=>{
          const value=detailedTokenEstimate(request);
          if(!value)throw Error();
          return {input:value.input,state:value.state,model:value.model,tokenizerId:value.tokenizerId,catalogVersion:value.catalogVersion,reason:value.reason};
        };
        c.header('cache-control','no-store');
        return c.json({scope:'history_preview',full:summarize(fullRequest),selected:summarize(selectedRequest)});
      }
      if(Object.keys(input).join(',')==='responseStyle')return c.json({style:responseStylePreview(input.responseStyle)});
      if(Object.keys(input).sort().join(',')!=='authoritative,content,policy'||typeof input.content!=='string'||Buffer.byteLength(input.content)>1_048_576||typeof input.authoritative!=='boolean')throw Error();
      const policy=assertEfficiencyPolicy(input.policy),result=await prepareEfficiency({callId:'preview',content:input.content,authoritative:input.authoritative,isError:false,truncatedUpstream:false,sourceArtifactRefs:[]},c.req.raw.signal,policy);
      return c.json({original:input.content,...result});
    }catch{return c.json({error:{type:'efficiency_policy_invalid'}},422);}
  });
  let serial=Promise.resolve();
  app.patch("/local/efficiency/policy", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { type: "efficiency_policy_invalid" } }, 422);
    }
    try {
      if(!body||typeof body!=='object'||Object.keys(body).sort().join(',')!=='expectedRevision,policy')throw Error('efficiency_policy_invalid');
      const command=body as {expectedRevision:number;policy:EfficiencyPolicy};
      const operation=serial.then(async()=>{
      const current = getActiveEfficiencyPolicy();
      if(command.expectedRevision!==current.revision)throw Error('revision_conflict');
      const merged = assertEfficiencyPolicy({
        ...command.policy,
        schemaVersion: 1,
        revision:current.revision + 1,
      });
      // Absent algorithms must fail explicitly, never silently downgrade a saved setting.
      if(merged.semanticCache&&!deps.cacheSupport?.semantic||merged.provenanceCache&&!deps.cacheSupport?.provenance||merged.providerPromptCache&&!deps.cacheSupport?.providerPrompt||merged.transforms.some(s=>s.kind==='headroom'&&s.enabled&&!headroomEndpoint())||merged.scope!=='request')throw Error('transformer_unavailable');
      await deps.persistPolicy?.(merged);
      const saved = setActiveEfficiencyPolicy(merged);
      return saved;
      });serial=operation.then(()=>{},()=>{});return c.json({policy:await operation});
    } catch(error) {
      const type=error instanceof Error?error.message:'efficiency_policy_invalid';
      return c.json({ error: { type:type==='revision_conflict'||type==='transformer_unavailable'?type:'efficiency_policy_invalid' } }, type==='revision_conflict'?409:type==='transformer_unavailable'?503:422);
    }
  });

  app.get("/local/efficiency/metrics", (c) => {
    const metrics =
      typeof deps.getMetrics === "function"
        ? deps.getMetrics()
        : { schemaVersion: 1, basis: "unavailable", note: "router.efficiencyMetrics not bound" };
    return c.json({ metrics, policy: getActiveEfficiencyPolicy(), processors:efficiencyProcessors(),cacheSupport:deps.cacheSupport??null,readCaches:deps.getReadCacheMetrics?.()??null,providerPrompt:deps.getProviderPromptMetrics?.()??null });
  });

  app.post("/local/efficiency/cache/invalidate", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['kind','provider','tenantId'].includes(key))||body.provider!==undefined&&typeof body.provider!=='string'||body.tenantId!==undefined&&typeof body.tenantId!=='string')return c.json({error:{type:'invalid_request'}},400);
    const kind = body.kind;
    if (kind !== "exact" && kind !== "semantic" && kind !== "provenance" && kind !== "provider") {
      return c.json({ error: { type: "invalid_request", message: "kind required" } }, 400);
    }
    if (kind === "semantic"&&!deps.cacheSupport?.semantic) {
      return c.json({ error: { type: "cache_scope_denied", message: "semantic cache OFF" } }, 403);
    }
    if (!deps.invalidateScoped) {
      return c.json({ error: { type: "transformer_unavailable" } }, 503);
    }
    const result = await deps.invalidateScoped({
      kind,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
    });
    if (!result.ok) return c.json({ error: { type: result.code } }, result.status as 403 | 404 | 422 | 503);
    return c.json(result);
  });
}

/** Seed default policy once at process start. */
export function ensureDefaultEfficiencyPolicy(): EfficiencyPolicy {
  return setActiveEfficiencyPolicy(defaultEfficiencyPolicy());
}
