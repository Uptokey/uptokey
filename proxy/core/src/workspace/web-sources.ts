/**
 * E2-12 — governed web search, page fetch and source citations.
 *
 * Fatia 12.B: SearchRequest/FetchRequest com motor sintético (fixture) e fetch
 * público somente-leitura, ambos pelo executor W5 canônico (plano → aprovação →
 * run → recibo → artefato persistido). Fatia 12.D: verificação de citações
 * contra o artefato realmente lido, sem fabricar offsets.
 *
 * Preparo não despacha nada; o dispatch reconfirma admissão `dispatched`,
 * bindings literais idênticos ao plano e orçamento de saída antes de qualquer
 * rede. O motor fixture é determinístico e nunca toca a rede; o perfil fetch
 * público nega destinos privados/metadata, limita redirects/tamanho e não
 * encaminha credenciais em nenhum salto.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {SecretStore} from '../secret-store.ts';
import {readBoundedJson} from '../media-dispatch.ts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import {
  parseCapabilityDescriptor,
  canonicalContextSnapshotPayload,
  parseExecutionPlan,
  validatePlanBindings,
  type CapabilityDescriptor,
  type ExecutionPlan,
} from '@uptokey/sync-contract/workflow';
import {
  parseWebSearchRequest, parseWebSearchResult, canonicalWebSearchPayload,
  parseWebFetchRequest, parseWebFetchResult, webPublicUrl,
  parseSourceCitation,
  type WebSearchRequest, type WebSearchResult, type WebFetchRequest, type WebFetchResult,
} from '@uptokey/sync-contract/web';
import { computePlanDigest } from './planner.ts';
import { fetchPinnedPublic, isDeniedHostname, isPrivateAddress } from '../network-policy.ts';
import type { EffectRequest, EffectOutcome } from './executor.ts';
import type { WorkspaceStore } from './store.ts';
import type { SourceInput } from './receipts.ts';

const UTF8 = new TextEncoder();

export const WEB_SEARCH_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1, id: 'web.search', createdAt: '2026-09-20T12:00:00.000Z', version: 1,
  titleKey: 'ws_web_search_title', descriptionKey: 'ws_web_search_description', tags: ['web', 'search'],
  inputSchemaId: 'web.search.input.v1', outputSchemaId: 'web.search.result.v1',
  effect: 'read_external', dataDestination: { kind: 'public_source', id: 'web_search' },
  availability: 'executable', supportLevel: 'experimental', requiredScopes: ['run:execute'],
  retryClass: 'read_only',
  limits: { maxSteps: 1, maxCalls: 1, maxOutputTokens: 1, timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
});

export const WEB_FETCH_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1, id: 'web.fetch', createdAt: '2026-09-20T12:00:00.000Z', version: 1,
  titleKey: 'ws_web_fetch_title', descriptionKey: 'ws_web_fetch_description', tags: ['web', 'fetch'],
  inputSchemaId: 'web.fetch.input.v1', outputSchemaId: 'web.fetch.result.v1',
  effect: 'read_external', dataDestination: { kind: 'public_source', id: 'web_fetch_public' },
  availability: 'executable', supportLevel: 'experimental', requiredScopes: ['run:execute'],
  retryClass: 'read_only',
  limits: { maxSteps: 1, maxCalls: 1, maxOutputTokens: 1, timeoutMs: 60_000, maxOutputBytes: 5_242_880 },
});

const WEB_ENGINE_NOTE = 'Local synthetic fixture engine. Results are generated in-process for testing and were not fetched from the web.';
const WEB_FETCH_NOTE = 'Public read-only fetch. Destination policy denied private, loopback and metadata addresses; no credentials were sent.';
const WEB_FETCH_USER_AGENT = 'Uptokey/0.1 (+https://uptokey.com) governed-public-fetch';
const WEB_FETCH_DEFAULT_MAX_BYTES = 1_048_576;
const WEB_FETCH_ENVELOPE_SLACK_BYTES = 4_096;
const WEB_FETCH_ALLOWED_MIME = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|ld\+json|xml|[a-z+]*\+xml))$/;

export interface WebSourcesOptions {
  secrets?:Pick<SecretStore,'get'|'set'|'delete'>;
  /** Test harness only; never enabled by a request. */
  allowFixture?:boolean;
  enabled?: () => boolean;
  fetchFn?: typeof fetch;
  /** Local SearXNG instance (no key). Loopback only; UPTOKEY_SEARXNG_URL or http://127.0.0.1:8888. */
  searxngUrl?: string;
  /** Fetch used only for the loopback SearXNG instance (defaults to the global fetch). */
  searxngFetch?: typeof fetch;
  /** Injectable DNS resolution; production default resolves via node:dns. */
  dnsLookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
}

/** Failure with honest effect knowledge: `sent:false` only before any network use. */
export class WebEffectError extends Error {
  readonly code: string;
  readonly sent: boolean;
  constructor(code: string, sent: boolean) {
    super(code);
    this.name = 'WebEffectError';
    this.code = code;
    this.sent = sent;
  }
}

export class WorkspaceWebSources {
  private readonly customFetch: boolean;
  private readonly options: Required<Pick<WebSourcesOptions, 'fetchFn'>> & WebSourcesOptions;
  constructor(options: WebSourcesOptions = {}) {
    this.customFetch = options.fetchFn !== undefined;
    this.options = { fetchFn: options.fetchFn ?? fetch, ...options };
  }
  enabled(): boolean { return this.options.enabled?.() !== false; }

  capabilities(): CapabilityDescriptor[] {
    return this.enabled() ? [WEB_SEARCH_CAPABILITY, WEB_FETCH_CAPABILITY] : [];
  }

  /** The local SearXNG base URL, only on a loopback address (the search never leaves through another host's proxy). */
  private searxngBase():URL|null{
    try{
      const url=new URL(this.options.searxngUrl??process.env.UPTOKEY_SEARXNG_URL??'http://127.0.0.1:8888');
      if(url.protocol!=='http:'&&url.protocol!=='https:')return null;
      if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)return null;
      return url;
    }catch{return null;}
  }
  /** Observed, never assumed: the instance answers its health endpoint within one second. */
  private async searxngAvailable():Promise<boolean>{
    const base=this.searxngBase();if(!base||!this.enabled())return false;
    try{const response=await (this.options.searxngFetch??fetch)(new URL('healthz',base.href.endsWith('/')?base:base.href+'/'),{redirect:'error',signal:AbortSignal.timeout(1000)});await response.body?.cancel();return response.ok;}catch{return false;}
  }

  private async braveApiKey(): Promise<string | undefined> {
    const fromSecret = await this.options.secrets?.get('web:brave');
    if (fromSecret) return fromSecret;
    return process.env.BRAVE_SEARCH_SECRET_KEY || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  }

  async info() {
    const configured=Boolean(await this.braveApiKey());
    const searxng=await this.searxngAvailable();
    return {
      available: this.enabled(),
      contractRevision: 1,
      engines: [{id:'brave',available:this.enabled()&&configured,note:'Brave Search API'},{id:'searxng',available:searxng,note:'SearXNG local (metabusca, sem chave)'},...(this.options.allowFixture?[{ id: 'fixture', available: this.enabled(), note: WEB_ENGINE_NOTE }]:[])],
      fetchProfile: {
        id: 'public_read_only_v1',
        available: this.enabled(),
        maxRedirects: 3,
        maxBytes: WEB_FETCH_DEFAULT_MAX_BYTES,
        note: WEB_FETCH_NOTE,
      },
      citationVerification: { available: this.enabled(), algorithm: 'sha256', note: 'Citations are verified against the persisted artifact text; offsets are never produced, only checked.' },
    };
  }
  async configure(input:unknown){
    if(!this.options.secrets)throw new WebEffectError('web_configuration_unavailable',false);
    if(!isDataRecord(input)||Object.keys(input).join(',')!=='key'||typeof input.key!=='string'||input.key.length>4096||/[\s\x00-\x1f]/.test(input.key))throw new WebEffectError('web_key_invalid',false);
    if(input.key)await this.options.secrets.set('web:brave',input.key);else await this.options.secrets.delete('web:brave');
    return this.info();
  }

  /* ---------------------------- preparation --------------------------- */

  /** Compiles a search or fetch request into a bound plan; no effect occurs. */
  async prepare(store: WorkspaceStore, principal: string, projectId: string, input: unknown, signal: AbortSignal): Promise<ExecutionPlan> {
    if (!this.enabled()) throw new Error('web_sources_unavailable');
    if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== 'expectedRevision,request' ||
      !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new Error('web_plan_invalid');
    const capability = input.request && isDataRecord(input.request) && Object.hasOwn(input.request, 'query')
      ? WEB_SEARCH_CAPABILITY : WEB_FETCH_CAPABILITY;
    let request: WebSearchRequest | WebFetchRequest;
    try { request = capability === WEB_SEARCH_CAPABILITY ? parseWebSearchRequest(input.request) : parseWebFetchRequest(input.request); }
    catch { throw new Error(capability === WEB_SEARCH_CAPABILITY ? 'web_search_invalid' : 'web_fetch_invalid'); }
    if('engine' in request){
      if(request.engine==='fixture'&&!this.options.allowFixture)throw new WebEffectError('web_engine_unavailable',false);
      if(request.engine==='brave'&&!await this.braveApiKey())throw new WebEffectError('web_key_missing',false);
      if(request.engine==='searxng'&&!await this.searxngAvailable())throw new WebEffectError('web_engine_unavailable',false);
      if(request.engine==='brave'&&((request.maxResults??5)>20||request.query.length>600||request.query.split(/\s+/).length>75))throw new WebEffectError('web_search_invalid',false);
    }
    const project = await store.getProject(principal, projectId);
    if (project.revision !== input.expectedRevision) throw new Error('workspace_revision_conflict');
    const bundle = await store.getBundle(principal, projectId);
    if (bundle.runs.some(item => ['running', 'needs_attention', 'ready', 'awaiting_approval'].includes(item.run.status))) throw new Error('project_run_active');
    signal.throwIfAborted();
    const snapshot = await store.snapshotContext(principal, projectId, {
      selectedEntryIds: [], selectedArtifactIds: [], excludedEntryIds: project.entries.map(item => item.id),
      allowedDestinations: [capability.dataDestination], maxContextBytes: 32_000,
    });
    const objective = capability === WEB_SEARCH_CAPABILITY
      ? `search: ${(request as WebSearchRequest).query}`.slice(0, 300)
      : `fetch: ${(request as WebFetchRequest).url}`.slice(0, 300);
    let plan: ExecutionPlan = {
      schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), projectId,
      projectRevision: project.revision, contextSnapshotId: snapshot.id, contextSnapshotDigest: sha(canonicalContextSnapshotPayload(snapshot)),
      steps: [{ id: capability === WEB_SEARCH_CAPABILITY ? 'search' : 'fetch', capabilityId: capability.id, capabilityVersion: capability.version,
        arguments: { request: { kind: 'literal', value: JSON.parse(JSON.stringify(request)) }, objective: { kind: 'literal', value: objective } } }],
      limits: { ...capability.limits }, digest: '0'.repeat(64),
    };
    plan = parseExecutionPlan({ ...plan, digest: computePlanDigest(plan) });
    validatePlanBindings(plan, snapshot, [capability]);
    signal.throwIfAborted();
    await store.putPlan(principal, plan, snapshot);
    return plan;
  }

  /* ----------------------------- dispatch ----------------------------- */

  async dispatch(store: WorkspaceStore, request: EffectRequest): Promise<EffectOutcome> {
    if (!this.enabled()) return { kind: 'not_sent', code: 'web_sources_unavailable' };
    if (request.capability.id !== WEB_SEARCH_CAPABILITY.id && request.capability.id !== WEB_FETCH_CAPABILITY.id) return { kind: 'not_sent', code: 'web_operation_unavailable' };
    const admission = await this.admission(store, request);
    if ('kind' in admission) return admission;
    try {
      if (request.capability.id === WEB_SEARCH_CAPABILITY.id) return await this.searchOutcome(request, admission.remainingBytes);
      return await this.fetchOutcome(store, request, admission.remainingBytes);
    } catch (error) {
      if (error instanceof WebEffectError) {
        return error.sent ? { kind: 'failed', code: error.code, sent: 'yes' } : { kind: 'not_sent', code: error.code };
      }
      return { kind: 'failed', code: 'web_operation_failed', sent: 'unknown' };
    }
  }

  private async admission(store: WorkspaceStore, request: EffectRequest):
    Promise<{ kind: 'not_sent'; code: string } | { remainingBytes: number }> {
    const bundle = await store.getBundle(request.principalId, request.projectId);
    const run = bundle.runs.find(record => record.run.id === request.runId && record.run.principalId === request.principalId);
    if (!run) return { kind: 'not_sent', code: 'web_run_not_found' };
    const plan = bundle.plans.find(value => value.id === run.run.planId && value.digest === run.run.planDigest);
    const step = plan?.steps.find(value => value.id === request.stepId && value.capabilityId === request.capability.id && value.capabilityVersion === request.capability.version);
    const receipt = run.receipts.find(item => item.attemptId === request.attemptId && item.stepId === request.stepId &&
      item.capabilityId === request.capability.id && item.capabilityVersion === request.capability.version && item.status === 'dispatched');
    if (run.run.status !== 'running' || !plan || !step || !receipt) return { kind: 'not_sent', code: 'web_active_admission_required' };
    if (Object.keys(step.arguments).sort().join(',') !== Object.keys(request.arguments).sort().join(',')) return { kind: 'not_sent', code: 'web_argument_binding_mismatch' };
    for (const [name, binding] of Object.entries(step.arguments)) {
      const resolved = request.arguments[name];
      if (!resolved || resolved.kind !== 'literal' || binding.kind !== 'literal' || canonicalJson(resolved) !== canonicalJson(binding)) return { kind: 'not_sent', code: 'web_argument_binding_mismatch' };
    }
    const publishedRefs = new Set(run.receipts.flatMap(item => item.outputArtifactRefs));
    let publishedBytes = 0;
    for (const id of publishedRefs) {
      const artifact = bundle.artifacts.find(value => value.id === id && value.runId === request.runId);
      if (!artifact || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) return { kind: 'not_sent', code: 'web_prior_artifact_unavailable' };
      publishedBytes += artifact.byteLength;
    }
    const remainingBytes = Math.min(request.limits.maxOutputBytes ?? 0, plan.limits.maxOutputBytes ?? 0) - publishedBytes;
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes <= 0) return { kind: 'not_sent', code: 'web_response_too_large' };
    return { remainingBytes };
  }

  /* ------------------------ fixture search (12.B) ---------------------- */

  private async searchOutcome(request: EffectRequest, remainingBytes: number): Promise<EffectOutcome> {
    const binding = request.arguments.request;
    if (binding?.kind !== 'literal') return { kind: 'not_sent', code: 'web_argument_binding_mismatch' };
    let parsed: WebSearchRequest;
    try { parsed = parseWebSearchRequest(binding.value); } catch { return { kind: 'not_sent', code: 'web_search_invalid' }; }
    if(parsed.engine==='brave')return this.braveOutcome(parsed,request,remainingBytes);
    if(parsed.engine==='searxng')return this.searxngOutcome(parsed,request,remainingBytes);
    if(!this.options.allowFixture)return {kind:'not_sent',code:'web_engine_unavailable'};
    if (request.signal.aborted) return { kind: 'not_sent', code: 'web_cancelled' };
    if (!Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= Date.now()) return { kind: 'not_sent', code: 'web_deadline_exceeded' };
    const fetchedAt = new Date().toISOString();
    const envelope: WebSearchResult = {
      schemaVersion: 1, engine: 'fixture', query: parsed.query, fetchedAt,
      results: fixtureRows(parsed, fetchedAt),
      complete: true, engineNote: WEB_ENGINE_NOTE,
      coverage: { requestedMaxResults: parsed.maxResults ?? 5, returned: Math.min(parsed.maxResults ?? 5, 5) },
    };
    let serialized: string;
    try { serialized = JSON.stringify(envelope); parseWebSearchResult(envelope); }
    catch { return { kind: 'not_sent', code: 'web_search_envelope_invalid' }; }
    if (UTF8.encode(serialized).byteLength > remainingBytes) return { kind: 'not_sent', code: 'web_response_too_large' };
    const attemptId = request.attemptId;
    return {
      kind: 'completed',
      artifacts: [{ artifactId: `web_search_${attemptId}`, mediaType: 'application/json', bytes: UTF8.encode(serialized) }],
      outputArtifactRefs: [`web_search_${attemptId}`],
      sources: envelope.results.map((row): SourceInput => ({
        id: `source_${attemptId}_${row.rank}`, sourceId: 'web_search_fixture', externalId: row.url,
        title: row.title, url: row.url, retrievedAt: fetchedAt,
      })),
    };
  }
  private async searxngOutcome(parsed:WebSearchRequest,request:EffectRequest,remainingBytes:number):Promise<EffectOutcome>{
    const base=this.searxngBase();if(!base)return {kind:'not_sent',code:'web_engine_unavailable'};
    const remaining=Date.parse(request.deadlineAt)-Date.now();if(!Number.isFinite(remaining)||remaining<=0||request.signal.aborted)return {kind:'not_sent',code:'web_deadline_exceeded'};
    const query=parsed.query+(parsed.domains?.length?' '+parsed.domains.map(domain=>'site:'+domain).join(' OR '):'');
    const url=new URL('search',base.href.endsWith('/')?base:base.href+'/');
    url.searchParams.set('q',query);url.searchParams.set('format','json');
    if(parsed.language)url.searchParams.set('language',parsed.language);
    if(parsed.recency)url.searchParams.set('time_range',({day:'day',week:'week',month:'month',year:'year'})[parsed.recency]);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(Math.min(60000,remaining))]);
    const response=await (this.options.searxngFetch??fetch)(url,{headers:{accept:'application/json'},redirect:'error',signal});
    if(!response.ok){await response.body?.cancel();return {kind:'failed',code:response.status===429?'web_rate_limited':'web_search_failed',sent:'yes'};}
    const body=await readBoundedJson(response,Math.min(remainingBytes,4_194_304),signal);
    if(!isDataRecord(body)||!Array.isArray(body.results))throw new WebEffectError('web_search_response_invalid',true);
    // Metasearch rows from many engines: keep public http(s) results only, first occurrence of each URL.
    const seen=new Set<string>();
    // Engines behind the metasearch return URLs in their own spelling: cite the canonical form.
    const canonical=(value:unknown)=>{if(typeof value!=='string')return null;try{return new URL(value).href;}catch{return null;}};
    const rowsCanonical=body.results.map(row=>isDataRecord(row)&&canonical(row.url)?{...row,url:canonical(row.url)}:row);
    const selected=rowsCanonical.filter((row):row is Record<string,unknown>=>{
      if(!isDataRecord(row)||typeof row.url!=='string'||typeof row.title!=='string'||!webPublicUrl(row.url)||seen.has(row.url))return false;
      const host=new URL(row.url).hostname.toLowerCase().replace(/\.$/,'');
      // A metasearch row may point at a private or local host: never cite it as a public source.
      if(isDeniedHostname(host)||isPrivateAddress(host.replace(/^\[|\]$/g,'')))return false;
      if(parsed.domains?.length&&!parsed.domains.some(domain=>host===domain.toLowerCase()||host.endsWith('.'+domain.toLowerCase())))return false;
      seen.add(row.url);return true;
    }).slice(0,parsed.maxResults??5);
    const results:WebSearchResult['results']=selected.map((row,index)=>({rank:index+1,title:String(row.title).slice(0,500),url:String(row.url),snippet:(typeof row.content==='string'?row.content:'').replace(/<[^>]*>/g,'').slice(0,2000)}));
    const fetchedAt=new Date().toISOString(),envelope=parseWebSearchResult({schemaVersion:1,engine:'searxng',query:parsed.query,fetchedAt,results,complete:true,engineNote:'SearXNG local · metabusca em buscadores públicos, página única',coverage:{requestedMaxResults:parsed.maxResults??5,returned:results.length}});
    const bytes=UTF8.encode(JSON.stringify(envelope));if(bytes.byteLength>remainingBytes)throw new WebEffectError('web_response_too_large',true);
    const artifactId=`web_search_${request.attemptId}`;
    return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes}],outputArtifactRefs:[artifactId],sources:results.map(row=>({id:`source_${request.attemptId}_${row.rank}`,sourceId:'searxng',externalId:row.url,title:row.title,url:row.url,retrievedAt:fetchedAt}))};
  }
  private async braveOutcome(parsed:WebSearchRequest,request:EffectRequest,remainingBytes:number):Promise<EffectOutcome>{
    const key=await this.braveApiKey();if(!key)return {kind:'not_sent',code:'web_key_missing'};
    const remaining=Date.parse(request.deadlineAt)-Date.now();if(!Number.isFinite(remaining)||remaining<=0||request.signal.aborted)return {kind:'not_sent',code:'web_deadline_exceeded'};
    const url=new URL('https://api.search.brave.com/res/v1/web/search');
    const query=parsed.query+(parsed.domains?.length?' ('+parsed.domains.map(domain=>'site:'+domain).join(' OR ')+')':'');
    if(query.length>600||query.split(/\s+/).length>75||(parsed.maxResults??5)>20)return {kind:'not_sent',code:'web_search_invalid'};
    url.searchParams.set('q',query);url.searchParams.set('count',String(parsed.maxResults??5));
    if(parsed.language)url.searchParams.set('search_lang',parsed.language);
    if(parsed.country)url.searchParams.set('country',parsed.country);
    if(parsed.recency)url.searchParams.set('freshness',({day:'pd',week:'pw',month:'pm',year:'py'})[parsed.recency]);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(Math.min(60000,remaining))]);
    const response=await this.options.fetchFn(url,{headers:{accept:'application/json','X-Subscription-Token':key},redirect:'error',signal});
    if(!response.ok){await response.body?.cancel();return {kind:'failed',code:response.status===429?'web_rate_limited':'web_search_failed',sent:'yes'};}
    const body=await readBoundedJson(response,Math.min(remainingBytes,1_048_576),signal);
    if(!isDataRecord(body))throw new WebEffectError('web_search_response_invalid',true);
    // A search response can omit the web section when there are no web hits.
    const rows=body.web===undefined&&body.type==='search'&&isDataRecord(body.query)?[]:isDataRecord(body.web)&&Array.isArray(body.web.results)?body.web.results:null;
    if(!rows)throw new WebEffectError('web_search_response_invalid',true);
    const selected=rows.filter(row=>{
      if(!isDataRecord(row)||typeof row.url!=='string'||!webPublicUrl(row.url))throw new WebEffectError('web_search_response_invalid',true);
      const host=new URL(row.url).hostname.toLowerCase().replace(/\.$/,'');
      return !parsed.domains?.length||parsed.domains.some(domain=>host===domain.toLowerCase()||host.endsWith('.'+domain.toLowerCase()));
    }).slice(0,parsed.maxResults??5);
    const results:WebSearchResult['results']=selected.map((row,index)=>{
      if(!isDataRecord(row)||typeof row.title!=='string'||typeof row.url!=='string'||typeof row.description!=='string'||!webPublicUrl(row.url))throw new WebEffectError('web_search_response_invalid',true);
      return {rank:index+1,title:row.title,url:row.url,snippet:row.description.replace(/<[^>]*>/g,'')};
    });
    const fetchedAt=new Date().toISOString(),envelope=parseWebSearchResult({schemaVersion:1,engine:'brave',query:parsed.query,fetchedAt,results,complete:true,engineNote:'Brave Search API · página única',coverage:{requestedMaxResults:parsed.maxResults??5,returned:results.length}});
    const bytes=UTF8.encode(JSON.stringify(envelope));if(bytes.byteLength>remainingBytes)throw new WebEffectError('web_response_too_large',true);
    const artifactId=`web_search_${request.attemptId}`;
    return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes}],outputArtifactRefs:[artifactId],sources:results.map(row=>({id:`source_${request.attemptId}_${row.rank}`,sourceId:'brave',externalId:row.url,title:row.title,url:row.url,retrievedAt:fetchedAt}))};
  }

  /* -------------------- governed public fetch (12.B/C) ----------------- */

  private async fetchOutcome(store: WorkspaceStore, request: EffectRequest, remainingBytes: number): Promise<EffectOutcome> {
    const binding = request.arguments.request;
    if (binding?.kind !== 'literal') return { kind: 'not_sent', code: 'web_argument_binding_mismatch' };
    let parsed: WebFetchRequest;
    try { parsed = parseWebFetchRequest(binding.value); } catch { return { kind: 'not_sent', code: 'web_fetch_invalid' }; }
    if (request.signal.aborted) return { kind: 'not_sent', code: 'web_cancelled' };
    if (!Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= Date.now()) return { kind: 'not_sent', code: 'web_deadline_exceeded' };
    let sent = false;
    try {
      const downloadCap = Math.min(parsed.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES, WEB_FETCH_DEFAULT_MAX_BYTES);
      const result = await this.governedFetch(parsed, downloadCap, request);
      sent = true;
      const fetchedAt = new Date().toISOString();
      const contentHash = createHash('sha256').update(result.rawBytes).digest('hex');
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(result.rawBytes);
      const asHtml = /html/.test(result.contentType) && parsed.extractionMode !== 'raw';
      const budget = Math.max(0, remainingBytes - WEB_FETCH_ENVELOPE_SLACK_BYTES);
      if (budget <= 0) return { kind: 'failed', code: 'web_response_too_large', sent: 'yes' };
      let text = asHtml ? htmlToText(decoded) : decoded;
      let truncated = result.truncated || UTF8.encode(text).byteLength > budget;
      if (UTF8.encode(text).byteLength > budget) text = clipUtf8(text, budget);
      const links = asHtml ? extractLinks(decoded, result.finalUrl) : [];
      const title = asHtml ? htmlTitle(decoded) ?? new URL(result.finalUrl).hostname : `${new URL(result.finalUrl).hostname}${new URL(result.finalUrl).pathname}`.slice(0, 300);
      const envelope: WebFetchResult = {
        schemaVersion: 1, requestedUrl: parsed.url, finalUrl: result.finalUrl, status: result.status,
        contentType: result.contentType, contentHash, fetchedAt, text, truncated, links,
        engineNote: WEB_FETCH_NOTE,
      };
      try { parseWebFetchResult(envelope); }
      catch { return { kind: 'failed', code: 'web_fetch_envelope_invalid', sent: 'yes' }; }
      const serialized = UTF8.encode(JSON.stringify(envelope));
      if (serialized.byteLength > remainingBytes) return { kind: 'failed', code: 'web_response_too_large', sent: 'yes' };
      return {
        kind: 'completed',
        artifacts: [{ artifactId: `web_fetch_${request.attemptId}`, mediaType: 'application/json', bytes: serialized }],
        outputArtifactRefs: [`web_fetch_${request.attemptId}`],
        sources: [{ id: `source_${request.attemptId}`, sourceId: 'web_fetch_public', externalId: result.finalUrl, title, url: result.finalUrl, retrievedAt: fetchedAt }],
      };
    } catch (error) {
      if (error instanceof WebEffectError) return error.sent || sent
        ? { kind: 'failed', code: error.code, sent: 'yes' }
        : { kind: 'not_sent', code: error.code };
      if (request.signal.aborted) return sent ? { kind: 'failed', code: 'web_cancelled', sent: 'unknown' } : { kind: 'not_sent', code: 'web_cancelled' };
      return { kind: 'failed', code: 'web_fetch_failed', sent: 'unknown' };
    }
  }

  private async governedFetch(parsed: WebFetchRequest, downloadCap: number, request: EffectRequest): Promise<{ rawBytes: Uint8Array; finalUrl: string; status: number; contentType: string; truncated: boolean }> {
    const maxRedirects = parsed.maxRedirects ?? 3;
    let current = parsed.url;
    let hops = 0;
    for (;;) {
      // Destination and DNS are re-validated at every hop; failures here are provably pre-network
      // for the first hop and reported as refused redirects afterwards.
      let addresses:readonly {address:string;family:number}[];
      try { addresses=await this.assertPublicDestination(current); }
      catch (error) {
        if (error instanceof WebEffectError && hops > 0) throw new WebEffectError(error.code === 'fetch_url_denied' ? 'fetch_redirect_denied' : error.code, true);
        throw error;
      }
      if (request.signal.aborted) throw new WebEffectError('web_cancelled', false);
      const deadline = Date.parse(request.deadlineAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new WebEffectError('web_deadline_exceeded', false);
      let response: Response;
      try {
        const init:RequestInit = {
          redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
          headers: { 'user-agent': WEB_FETCH_USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' },
        };
        response = await (this.customFetch?this.options.fetchFn(current,init):fetchPinnedPublic(current,init,addresses));
      } catch (error) {
        if (request.signal.aborted) throw new WebEffectError('web_cancelled', true);
        if (error instanceof Error && error.name === 'TimeoutError') throw new WebEffectError('web_deadline_exceeded', true);
        // A refused connection never left with target semantics we cannot inspect.
        throw new WebEffectError('fetch_unreachable', true);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new WebEffectError('fetch_redirect_invalid', true);
        if (hops >= maxRedirects) throw new WebEffectError('fetch_redirect_denied', true);
        let next: URL;
        try { next = new URL(location, current); } catch { throw new WebEffectError('fetch_redirect_invalid', true); }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new WebEffectError('fetch_redirect_denied', true);
        current = next.href;
        hops += 1;
        continue;
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
      if (!WEB_FETCH_ALLOWED_MIME.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebEffectError('fetch_mime_unsupported', true);
      }
      if (!response.body) throw new WebEffectError('fetch_invalid_response', true);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      try {
        for (;;) {
          if (Date.now() >= Date.parse(request.deadlineAt)) { truncated = true; break; }
          if (request.signal.aborted) throw new WebEffectError('web_cancelled', true);
          const next = await reader.read();
          if (next.done) break;
          const remaining = downloadCap - total;
          if (next.value.byteLength > remaining) {
            if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
            total = downloadCap;
            truncated = true;
            break;
          }
          chunks.push(next.value);
          total += next.value.byteLength;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const rawBytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { rawBytes.set(chunk, offset); offset += chunk.byteLength; }
      return { rawBytes, finalUrl: current, status: response.status, contentType, truncated };
    }
  }

  /** Public read-only policy: refuse loopback, private, link-local and metadata targets before connecting. */
  private async assertPublicDestination(url: string): Promise<readonly {address:string;family:number}[]> {
    const parsed = webPublicUrl(url);
    if (!parsed) throw new WebEffectError('fetch_url_denied', false);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isDeniedHostname(hostname) || isPrivateAddress(hostname)) throw new WebEffectError('fetch_url_denied', false);
    let resolved: readonly { address: string; family: number }[];
    try { resolved = await this.resolve(hostname); }
    catch { throw new WebEffectError('fetch_dns_unavailable', false); }
    if (!resolved.length) throw new WebEffectError('fetch_dns_unavailable', false);
    if (resolved.some(item => isPrivateAddress(item.address))) throw new WebEffectError('fetch_url_denied', false);
    return resolved;
  }

  private resolve(hostname: string): Promise<readonly { address: string; family: number }[]> {
    if (this.options.dnsLookup) return this.options.dnsLookup(hostname);
    return dnsLookup(hostname, { all: true, verbatim: true });
  }

  /* ------------------------- citations (12.D) -------------------------- */

  /**
   * Verifies a citation against the artifact that was actually read. Never
   * produces offsets or digests of its own: the locator and expected digest
   * come from the caller and are only checked.
   */
  async verifyCitation(store: WorkspaceStore, principal: string, projectId: string, input: unknown) {
    if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== 'artifactId,citation' ||
      typeof input.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.artifactId)) throw new Error('web_citation_invalid');
    let citation;
    try { citation = parseSourceCitation(input.citation); }
    catch { throw new Error('web_citation_invalid'); }
    const bundle = await store.getBundle(principal, projectId);
    const artifact = bundle.artifacts.find(item => item.id === input.artifactId && item.projectId === projectId && item.mediaType === 'application/json');
    const run = artifact && bundle.runs.find(item => item.run.id === artifact.runId && item.run.principalId === principal);
    const receipt = run?.receipts.find(item => item.status === 'succeeded' && item.outputArtifactRefs.includes(artifact!.id) && artifact!.receiptRefs.includes(item.id));
    if (!artifact || !run || !receipt) throw new Error('workspace_artifact_not_found');
    if(citation.sourceArtifactId!==artifact.id)return refused(citation,'source_mismatch');
    if (receipt.capabilityId === WEB_SEARCH_CAPABILITY.id && citation.locator.kind === 'search_result') {
      const locator = citation.locator;
      const envelope = parseWebSearchResult(JSON.parse(await store.readTextArtifact(principal, projectId, artifact.id)));
      const row = envelope.results.find(item => item.rank === locator.rank);
      if (!row) return refused(citation, 'locator_out_of_range');
      if(citation.url!==row.url||citation.title!==row.title||citation.retrievedAt!==envelope.fetchedAt)return refused(citation,'source_mismatch');
      return digestCheck(citation, row.snippet);
    }
    if (receipt.capabilityId === WEB_FETCH_CAPABILITY.id && citation.locator.kind === 'text_offset') {
      const envelope = parseWebFetchResult(JSON.parse(await store.readTextArtifact(principal, projectId, artifact.id)));
      if(citation.url!==envelope.finalUrl||citation.retrievedAt!==envelope.fetchedAt)return refused(citation,'source_mismatch');
      if (citation.locator.end > envelope.text.length || citation.locator.start > citation.locator.end) return refused(citation, 'locator_out_of_range');
      return digestCheck(citation, envelope.text.slice(citation.locator.start, citation.locator.end));
    }
    throw new Error('web_citation_target_invalid');
  }
}

/* ----------------------------- helpers -------------------------------- */

function refused(citation: ReturnType<typeof parseSourceCitation>, reason: string) {
  return { schemaVersion: 1, verified: false, reason, citation: { ...citation, verified: false } };
}

function digestCheck(citation: ReturnType<typeof parseSourceCitation>, excerpt: string) {
  const digest = createHash('sha256').update(UTF8.encode(excerpt)).digest('hex');
  const verified = digest === citation.excerptDigest;
  return { schemaVersion: 1, verified, reason: verified ? null : 'digest_mismatch', citation: { ...citation, verified } };
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Deterministic in-process rows for the fixture engine; never a network result. */
function fixtureRows(request: WebSearchRequest, fetchedAt: string): WebSearchResult['results'] {
  const digest = createHash('sha256').update(canonicalWebSearchPayload(request)).digest('hex');
  const requested = request.maxResults ?? 5;
  const count = Math.min(requested, 5);
  return Object.freeze(Array.from({ length: count }, (_, index): WebSearchResult['results'][number] => {
    const rank = index + 1;
    const head = `Fixture result ${rank}: `;
    const queryBudget = 300 - UTF8.encode(head).byteLength - 3;
    const queryClipped = UTF8.encode(request.query).byteLength > queryBudget;
    const title = head + clipUtf8(request.query, queryBudget) + (queryClipped ? '…' : '');
    const snippetBase = `Synthetic fixture snippet ${rank}. Generated in-process from the query; this text was not fetched from the web. Query: "`;
    const snippetBudget = 512 - UTF8.encode(snippetBase).byteLength - 4;
    const snippetClipped = UTF8.encode(request.query).byteLength > snippetBudget;
    return Object.freeze({
      rank, title,
      url: `https://fixture-search.uptokey.test/${digest.slice(0, 16)}/${rank}`,
      snippet: `${snippetBase}${clipUtf8(request.query, snippetBudget)}${snippetClipped ? '…' : '"'}`,
    });
  }));
}

function clipUtf8(text: string, maxBytes: number): string {
  if (UTF8.encode(text).byteLength <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (UTF8.encode(text.slice(0, mid)).byteLength <= maxBytes) low = mid; else high = mid - 1;
  }
  return text.slice(0, low);
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;
  const title = htmlToText(match[1]!);
  return title ? title.slice(0, 300) : null;
}

function extractLinks(html: string, base: string): WebFetchResult['links'] {
  const links: WebFetchResult['links'][number][] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || /^(?:javascript|data|mailto|tel):/i.test(raw)) continue;
    let resolved: URL;
    try { resolved = new URL(raw, base); } catch { continue; }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    const href = resolved.href.slice(0, 2048);
    if (seen.has(href)) continue;
    seen.add(href);
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
    const relValue = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? '').trim().slice(0, 100) : undefined;
    links.push(Object.freeze({ url: href, ...(relValue ? { rel: relValue } : {}) }));
    if (links.length >= 200) break;
  }
  return Object.freeze(links);
}
