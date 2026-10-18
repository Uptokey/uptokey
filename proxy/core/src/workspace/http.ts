import { resolve } from 'node:path';
import { terminalRouteMethod, terminalQuery, terminalAuthority, handleTerminal } from './interactive-terminal-http.ts';
import {isProjectGranted,resolveLocalRetentionMode, type LocalProjectGrant} from './principal.ts';
import {createWorkspaceAccessGuard} from './client-access-enforcement.ts';
import {handleRecipeExchange,assertRecipeSelectable} from './community-recipes.ts';
import {listPlanHistory} from './plan-history.ts';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import type { Hono } from 'hono';
import {streamSSE} from 'hono/streaming';
import {createHash} from 'node:crypto';
import { readBoundedJson,readArtifactImportJson } from '@uptokey/sync-contract/limits';
import { WORKFLOW_LIMITS, WorkflowContractError,parseWorkflowCommand } from '@uptokey/sync-contract/workflow';
import { WorkspaceError, type WorkspaceRuntime } from './runtime.ts';
import {PlanConsentService} from './plan-consent.ts';
import type {BrowserPublicJwk} from './browser-session.ts';
import type { SecretStore } from '../secret-store.ts';
import { SyncDataStore, SyncDataError } from './e2ee-sync.ts';
import { SinkAccessDeniedError } from './sink-authority.ts';
import { handleMobilityHttp, mobilityMethod, getBoundMobilityService, mobilityCapabilityFacet } from './mobility-http.ts';
import { withHostedAccountToken } from './hosted-account-context.ts';
import {readAccountMobilityRequest,type AccountMobilityRequest} from '../account-login-protocol.ts';
import { handleAutomationHttp, automationMethod } from './automation-http.ts';
import type { AutomationService } from './automation-service.ts';
import { getBoundAutomationService, automationsCapabilityFacet } from './automation-runtime-facet.ts';
import { handleAgentsCliHttp, agentsCliMethod } from './agents-cli-http.ts';
import {prepareSkillProjectPlan,prepareInstallProjectPlan} from './agents-cli-workspace.ts';
import { agentsCliCapabilityFacet } from './agents-cli-runtime-facet.ts';
// E2-15
import { handleUsageObservabilityHttp, usageObservabilityMethod, getBoundUsageObservabilityStore } from './usage-observability-http.ts';

const id='[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const readPaths=new RegExp(`^/v1/workspace/(?:capabilities|classification/config|api-instruments|productivity|web|benchmarks|recipes|gateway|speech|embeddings|transcription|voice|image|video|browser|filesystem|composition|project-agent/capabilities|projects|projects/${id}|projects/${id}/(?:artifacts|project-roots|project-agent/manifest|project-agent/file|project-agent/media|project-agent/directory|project-agent/git-status|project-agent/git-diff|recipes|learned-recipes|usage-value|usage-classifications|usage-classifications/${id}|runs/${id}/(?:protocol-output|protocol-events|write-recovery|output)|artifacts/${id}(?:/(?:media|api-projection|verification))?|compositions/${id}|voice-sessions/${id}/(?:events|live)|plans|plans/${id}|project-agent/tasks|project-agent/tasks/${id}|multimodel-plans|multimodel-plans/${id}|multimodel-runs|multimodel-runs/${id}|benchmark-observations|benchmark-rankings|benchmark-runs|benchmark-runs/${id}))$`);
const writePaths=new RegExp(`^/v1/workspace/(?:classification/(?:config|judge)|web/config|voice/config|projects/(?:create|import)|projects/${id}/(?:delete|update|plans|api-plans|rss-plans|productivity-plans|project-roots/register|project-roots/${id}/(?:revoke|restore-file|restore-turn)|project-agent/preflight|project-agent/plans|project-agent/run-plans|project-agent/run-promotions|project-agent/git-plans|project-agent/host-command-plans|project-agent/host-command-sessions/close|project-agent/task-plans|project-agent/tasks/${id}/(?:cancel|resume)|project-agent/preview/(?:start|${id}/stop)|project-agent/export/zip|api-intent-plans|api-composite-plans|classification-plans|classification-results/apply|usage-classifications/${id}/correction|recipe-plans|chat-plans|adapted-chat-plans|audio-chat-plans|tool-plans|tool-result-plans|protocol-plans|browser-plans|browser-fill-plans|web-plans|web-citations|speech-plans|embeddings-plans|transcription-plans|audio-import|image-import|voice-plans|voice-sessions|voice-sessions/${id}/(?:interrupt|stop|audio|commit)|image-plans|video-plans|video-resume-plans|filesystem-plans|learned-recipe-plans|learned-recipes/(?:ingest|preview|match|export|review|revoke)|artifacts/${id}/derive|compositions/create|compositions/${id}/resume|consent/(?:challenge|complete)|runs/start|runs/${id}/(?:cancel|resolve-attention|output)|recipes/create|recipes/derive-preview|recipes/exchange/(?:preview|import|export|prepare|update|revoke)|recipes/${id}/(?:versions/[1-9][0-9]{0,8}/)?plan|multimodel-plans|multimodel-plans/${id}/(?:start|consent/(?:challenge|complete))|multimodel-runs/${id}/(?:cancel|reload)|multimodel-runs/${id}/branches/${id}/cancel|benchmark-evals/prepare|benchmark-evals/start|benchmark-runs/${id}/(?:cancel|reload)))$`);
export function workspaceUsageQuery(url:URL):boolean {
 if(terminalQuery(url))return true;
 const one=(names:string[])=>[...url.searchParams.keys()].every(key=>names.includes(key)&&url.searchParams.getAll(key).length===1);
 const cursor=(name:string,pattern:RegExp)=>!url.searchParams.has(name)||pattern.test(url.searchParams.get(name)!);
 const stable=new RegExp('^'+id+'$'),integer=/^(?:0|[1-9][0-9]{0,8})$/,limit=/^(?:[1-9]|[1-9][0-9]|100)$/;
 const path=(suffix:string)=>new RegExp('^/v1/workspace/projects/'+id+'/'+suffix+'$').test(url.pathname);
 if(path('voice-sessions/'+id+'/(?:events|live)')||path('runs/'+id+'/(?:protocol-events|output)'))return one(['after'])&&cursor('after',integer);
 if(path('plans')||path('artifacts'))return one(['after','limit'])&&cursor('after',stable)&&cursor('limit',limit);
 if(path('project-agent/manifest')||path('project-agent/git-status'))return one(['rootBindingId'])&&cursor('rootBindingId',stable);
 if(path('project-agent/git-diff'))return one(['rootBindingId','path','staged'])&&stable.test(url.searchParams.get('rootBindingId')??'')&&(url.searchParams.get('path')??'').length>0&&(url.searchParams.get('path')??'').length<=2048&&cursor('staged',/^[01]$/);
 if(path('project-agent/file'))return one(['rootBindingId','path','startLine','endLine'])&&stable.test(url.searchParams.get('rootBindingId')??'')&&(url.searchParams.get('path')??'').length>0&&(url.searchParams.get('path')??'').length<=2048&&url.searchParams.has('startLine')===url.searchParams.has('endLine')&&cursor('startLine',/^[1-9][0-9]{0,6}$/)&&cursor('endLine',/^[1-9][0-9]{0,6}$/);
 if(path('project-agent/media'))return one(['rootBindingId','path'])&&stable.test(url.searchParams.get('rootBindingId')??'')&&(url.searchParams.get('path')??'').length>0&&(url.searchParams.get('path')??'').length<=2048;
 if(path('project-agent/directory'))return one(['rootBindingId','path','offset'])&&stable.test(url.searchParams.get('rootBindingId')??'')&&(url.searchParams.get('path')??'').length<=2048&&cursor('offset',/^(?:0|[1-9][0-9]{0,4}|100000)$/);
 if(path('recipes'))return one(['after','limit'])&&cursor('after',/^(?:0|[1-9][0-9]{0,5})$/)&&cursor('limit',limit);
 if(url.pathname==='/v1/workspace/projects')return one(['after','limit'])&&cursor('after',stable)&&cursor('limit',limit);
 return path('usage-value')&&one(['period','after','limit'])&&cursor('after',stable)&&cursor('limit',limit)&&/^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('period')??'');
}
export function workspaceMethod(path:string,method?:string):'GET'|'POST'|'PATCH'|'DELETE'|undefined {
  if(new RegExp(`^/v1/workspace/projects/${id}/learned-recipes/[A-Za-z0-9_-]{1,100}/access$`).test(path))return method==='GET'?'GET':method==='PATCH'?'PATCH':method==='DELETE'?'DELETE':undefined;
  if(new RegExp(`^/v1/workspace/projects/${id}/learned-recipes/[A-Za-z0-9_-]{1,100}/(?:access/(?:configure|discover)|service-plans)$`).test(path))return 'POST';
  if(path==='/v1/workspace/services')return 'GET';
  if(/^\/v1\/workspace\/services\/[a-z][a-z0-9_-]{0,79}$/.test(path))return method==='GET'?'GET':method==='PATCH'?'PATCH':method==='DELETE'?'DELETE':undefined;
  if(/^\/v1\/workspace\/services\/[a-z][a-z0-9_-]{0,79}\/(?:configure|discover)$/.test(path))return 'POST';
  if(new RegExp(`^/v1/workspace/projects/${id}/service-plans$`).test(path))return 'POST';
  const terminal=terminalRouteMethod(path,method);if(terminal)return terminal;
  if(/^\/v1\/workspace\/(?:image|video|speech|transcription)\/config$/.test(path))return method==='GET'?'GET':'POST';
  if(path==='/v1/workspace/classification/config'&&method==='GET')return 'GET';
  // E2EE sync-data (H4/H5 — opt-in, ciphertext-only): POST grava, GET lê, DELETE tombstone.
  if(/^\/v1\/workspace\/sync-data\/[A-Za-z0-9_-]{3,100}$/.test(path)) {
    if(method==='GET') return 'GET';
    if(method==='POST') return 'POST';
    if(method==='DELETE') return 'DELETE';
    return undefined;
  }
  // B9-reparo: mobilidade local-first (GET status/objeto; POST ações explícitas).
  {const mobility=mobilityMethod(path,method);if(mobility)return mobility;}
  // A path can be both a read (list) and a write (create), e.g. projects/:id/plans: honor the
  // requested method instead of rejecting the read with 405.
  const write=writePaths.test(path),read=readPaths.test(path);
  if(write&&read) return method==='GET'?'GET':'POST';
  if(write) return 'POST';
  if(read) return 'GET';
  return undefined;
}
export type ConversationAdmissionFactory = (principalId:string,projectId:string,command:{requestId:string;planId:string;planDigest:string},conversationId:string|undefined,requestId:string|undefined,authorization?:string,contextRevision?:number) => import('./runtime.ts').RunAdmission | undefined;
export type MobilityAccountExecutor=<T>(authorization:string|undefined,request:AccountMobilityRequest,signal:AbortSignal,operation:(token:string,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<T>)=>Promise<T>;
export function mountWorkspaceRoutes(app:Hono, runtime:WorkspaceRuntime|undefined, ready:Promise<void>, principal:(header:string|undefined)=>Promise<string|undefined>,browserKey?:(header:string|undefined,origin:string|undefined)=>Promise<BrowserPublicJwk|undefined>,automationService?:AutomationService, secrets?: Pick<SecretStore,'get'|'set'|'delete'>,conversationAdmission?:ConversationAdmissionFactory,projectGrant?:(header:string|undefined)=>Promise<LocalProjectGrant|undefined>,mobilityAccount?:MobilityAccountExecutor) {
  const consent=new PlanConsentService();
  const syncData=secrets?new SyncDataStore(secrets):undefined;
  const serviceAccessGuard=secrets?createWorkspaceAccessGuard(secrets):undefined;
  let protocolSubscribers=0;
  app.all('/v1/workspace/*',async c=>{
    if(!runtime) return c.json({error:{type:'workspace_unavailable'}},503);
    try {
      await ready;
      const owner=await principal(c.req.header('authorization'));
      if(!owner) return c.json({error:{type:'unauthorized'}},401);
      const serviceAdmission=async(projectId?:string)=>{
        c.req.raw.signal.throwIfAborted();const header=c.req.header('authorization');
        if(await principal(header)!==owner||!serviceAccessGuard||await serviceAccessGuard(header,c.req.method,new URL(c.req.url).pathname)||secrets&&await resolveLocalRetentionMode(header,secrets)==='ephemeral')throw new WorkspaceError('service_cancelled',403);
        if(projectId){const current=projectGrant?await projectGrant(header):'*';if(current===undefined||!isProjectGranted(current,projectId))throw new WorkspaceError('service_cancelled',403);}
      };
      const parts=new URL(c.req.url).pathname.split('/').slice(3);
      const projects=projectGrant?await projectGrant(c.req.header('authorization')):'*';
      if(projects===undefined)return c.json({error:{type:'unauthorized'}},401);
      if(parts[0]==='services'){
        c.header('cache-control','no-store');
        if(parts.length===1&&c.req.method==='GET')return c.json(await runtime.serviceAccess.list(owner));
        if(parts.length===2&&c.req.method==='GET')return c.json(await runtime.serviceAccess.view(owner,parts[1]!));
        const kind=parts.length===2?(c.req.method==='PATCH'?'update':c.req.method==='DELETE'?'remove':undefined):parts.length===3&&c.req.method==='POST'&&['configure','discover'].includes(parts[2]!)?parts[2] as 'configure'|'discover':undefined;
        if(!kind)return c.json({error:{type:'method_not_allowed'}},405);
        const body=await readBoundedJson(c.req.raw,8192);if(!body.ok)throw new WorkspaceError('service_input_invalid');
        return c.json(await runtime.serviceAccess.mutate(owner,parts[1]!,kind,body.value,()=>serviceAdmission()));
      }
      if(parts[0]==='projects'&&parts[1]&&projects!=='*'){
        if(['create','import'].includes(parts[1])||!isProjectGranted(projects,parts[1]))return c.json({error:{type:'resource_not_granted'}},403);
      }
      if(parts.length===2&&parts[1]==='config'&&['image','video','speech','transcription'].includes(parts[0]!)){
        const kind=parts[0] as import('@uptokey/sync-contract/media-profile').ManagedMediaKind;
        c.header('cache-control','no-store');
        if(c.req.method==='GET')return c.json(await runtime.mediaConfigurationInfo(kind));
        if(c.req.method==='POST'){
          const input=await readBoundedJson(c.req.raw);
          if(!input.ok)throw new WorkspaceError('invalid_request');
          return c.json(await runtime.configureMedia(kind,input.value));
        }
        return c.json({error:{type:'method_not_allowed'}},405);
      }
      if(parts.length===1&&parts[0]==='capabilities'&&c.req.method==='GET')return c.json({...runtime.capabilitiesInfo(),...automationsCapabilityFacet(getBoundAutomationService()),...agentsCliCapabilityFacet(),...mobilityCapabilityFacet(getBoundMobilityService())});
      if(parts.join('/')==='classification/config'&&c.req.method==='GET')return c.json(await runtime.classificationInfo(owner));
      if(parts.length===1&&parts[0]==='productivity'&&c.req.method==='GET')return c.json(await runtime.productivityInfo(owner));
      if(parts.length===1&&parts[0]==='api-instruments'&&c.req.method==='GET')return c.json(await runtime.apiInstrumentsInfo(owner));
      if(parts.length===1&&parts[0]==='web'&&c.req.method==='GET')return c.json(await runtime.webInfo());
      if(parts.length===1&&parts[0]==='benchmarks'&&c.req.method==='GET')return c.json(runtime.benchmarksCatalogInfo());
      if(parts.length===1&&parts[0]==='recipes'&&c.req.method==='GET')return c.json(await runtime.recipeCatalogInfo());
      if(parts.length===1&&parts[0]==='gateway')return c.json(runtime.gatewayInfo());
      if(parts.length===1&&parts[0]==='image')return c.json(runtime.imageInfo());
      if(parts.length===1&&parts[0]==='video')return c.json(runtime.videoInfo());
      if(parts.length===1&&parts[0]==='speech')return c.json(runtime.speechInfo());
      if(parts.length===1&&parts[0]==='embeddings')return c.json(runtime.embeddingsInfo());
      if(parts.length===1&&parts[0]==='transcription')return c.json(runtime.transcriptionInfo());
      if(parts.length===2&&parts[0]==='voice'&&parts[1]==='config'&&c.req.method==='POST'){const config=await readBoundedJson(c.req.raw);if(!config.ok)throw new WorkspaceError('invalid_request');return c.json(await runtime.configureVoice(config.value));}
      if(parts.length===1&&parts[0]==='voice')return c.json(await runtime.voiceInfo());
      if(parts.length===1&&parts[0]==='browser')return c.json(runtime.browserInfo());
      if(parts.length===1&&parts[0]==='filesystem'&&c.req.method==='GET')return c.json(runtime.filesystemInfo());
      if(parts.length===1&&parts[0]==='composition')return c.json(runtime.compositionInfo());
      if(parts.length===2&&parts[0]==='project-agent'&&parts[1]==='capabilities'&&c.req.method==='GET')return c.json(await runtime.projectAgentInfo());

      let input:unknown;
      if(c.req.method==='POST' || (c.req.method==='DELETE' && parts[0]==='sync-data')) {
        const mediaImport = parts.length === 3 && parts[0] === 'projects' && ['audio-import','image-import'].includes(parts[2]!);
        const parsed=mediaImport ? await readArtifactImportJson(c.req.raw) : await readBoundedJson(c.req.raw,WORKFLOW_LIMITS.commandBytes);
        if(!parsed.ok) {
          // DELETE sem corpo chega ao SyncDataStore, que exige expectedVersion (CAS).
          if(c.req.method==='DELETE' && parsed.reason!=='too_large') {
            input = undefined;
          } else {
            return c.json({error:{type:parsed.reason==='too_large'?'workspace_request_too_large':'invalid_request'}},parsed.reason==='too_large'?413:400);
          }
        } else {
          input=parsed.value;
        }
      }

      if(parts.join('/')==='classification/config'&&c.req.method==='POST')return c.json(await runtime.configureClassification(owner,input));
      if(parts.join('/')==='classification/judge'&&c.req.method==='POST')return c.json(await runtime.judgeClassification(owner,input,c.req.raw.signal));
      if(parts.join('/')==='web/config'&&c.req.method==='POST')return c.json(await runtime.configureWeb(input));
      // E2-13 automations seam (additive; synthetic channels only)
      if(automationMethod(new URL(c.req.url).pathname,c.req.method)){
        const auto=automationService ?? getBoundAutomationService();
        if(!auto) return c.json({error:{type:'automations_unbound'}},503);
        let autoInput:unknown=input;
        const handled=await handleAutomationHttp(c.req.method,new URL(c.req.url).pathname,autoInput,{service:auto,principalId:owner,assertProject:(principalId,projectId)=>runtime.store.getProject(principalId,projectId)});
        if(handled) return c.json(handled.body, handled.status as Parameters<typeof c.json>[1]);
      }
      // E2-14 agents-cli / integrations seam (additive; copy≠install≠execute)
      {
        const agentsPath=new URL(c.req.url).pathname;
        if(agentsCliMethod(agentsPath)){
          const url=new URL(c.req.url);
          const queryInput:Record<string,string>={};
          url.searchParams.forEach((v,k)=>{queryInput[k]=v;});
          const agentsInput=(input&&typeof input==='object'&&!Array.isArray(input))
            ?{...(input as Record<string,unknown>),...queryInput}
            :(Object.keys(queryInput).length?queryInput:input);
          const headers:Record<string,string|undefined>={};
          c.req.raw.headers.forEach((v,k)=>{headers[k]=v;});
          const handled=await handleAgentsCliHttp(c.req.method,agentsPath,agentsInput,{
            principalId:owner,
            prepareSkillPlan:(...args)=>prepareSkillProjectPlan(runtime,...args),
            prepareInstallPlan:(...args)=>prepareInstallProjectPlan(runtime,...args),
            headers,
            resolveAuthorizedRoot: async (principal, proj, rootRef) => {
              const project = await runtime.store.getProject(principal, proj);
              if (project.ownerPrincipalId !== principal) throw new WorkspaceError('project_missing', 404);
              const roots = await runtime.store.listProjectRoots(principal, proj);
              const matched = roots.find(r => r.binding.id === rootRef || resolve(r.localPath) === resolve(rootRef));
              if (!matched) {
                const err = new Error('project_root_unauthorized');
                (err as any).code = 'project_root_unauthorized';
                (err as any).status = 403;
                throw err;
              }
              return matched.localPath;
            }
          });
          if(handled) return c.json(handled.body, handled.status as Parameters<typeof c.json>[1]);
        }
      }
      // E2-15 usage/observability seam (additive; local store; no mgmt keys in PWA)
      {
        const obsPath=new URL(c.req.url).pathname;
        if(usageObservabilityMethod(obsPath)||obsPath.split('?')[0]==='/v1/workspace/usage/query'||obsPath.split('?')[0]==='/v1/workspace/usage/detail'||obsPath.split('?')[0]==='/v1/workspace/usage/views'||obsPath.split('?')[0]==='/v1/workspace/usage/export'||obsPath.startsWith('/v1/workspace/observability/')){
          if(!getBoundUsageObservabilityStore()) return c.json({error:{type:'observability_unbound'}},503);
          const url=new URL(c.req.url);
          const queryInput:Record<string,string>={};
          url.searchParams.forEach((v,k)=>{queryInput[k]=v;});
          const obsInput=(input&&typeof input==='object'&&!Array.isArray(input))
            ?{...(input as Record<string,unknown>),...queryInput}
            :(Object.keys(queryInput).length?queryInput:input);
          const handled=await handleUsageObservabilityHttp(c.req.method,obsPath,obsInput,{principalId:owner});
          if(handled) return c.json(handled.body, handled.status as Parameters<typeof c.json>[1]);
        }
      }

      // B9-reparo (frente B): mobilidade local-first. Cifra no dispositivo, envelope
      // opaco, CAS remoto B8; o servidor nunca recebe BYOK, chave de recuperação ou plaintext.
      if(parts[0]==='mobility'){
        if(projects!=='*') return c.json({error:{type:'resource_not_granted'}},403);
        const mobility=getBoundMobilityService();
        if(!mobility) return c.json({error:{type:'mobility_unbound'}},503);
        c.header('cache-control','no-store');
        const path=new URL(c.req.url).pathname;
        const perform=(signal:AbortSignal)=>handleMobilityHttp(c.req.method,path,input,{service:mobility,principalId:owner,signal});
        let handled;
        if(c.req.header('x-uptokey-account-source')==='linked'){
          if(!mobilityAccount)throw new WorkspaceError('account_service_not_configured',503);
          const rawRevision=c.req.header('x-uptokey-account-revision')??'';
          let request:AccountMobilityRequest;
          try{if(!/^(?:0|[1-9][0-9]{0,15})$/.test(rawRevision))throw Error();request=readAccountMobilityRequest({path,bodyDigest:createHash('sha256').update(JSON.stringify(input)).digest('hex'),accountRef:c.req.header('x-uptokey-account-ref'),revision:Number(rawRevision)});}
          catch{throw new WorkspaceError('account_credential_boundary',400);}
          handled=await mobilityAccount(c.req.header('authorization'),request,c.req.raw.signal,(token,signal,revalidate)=>withHostedAccountToken(token,()=>perform(signal),revalidate));
        }else handled=await withHostedAccountToken(c.req.header('x-uptokey-account-token'),()=>perform(c.req.raw.signal));
        if(handled) return c.json(handled.body as object, handled.status as Parameters<typeof c.json>[1]);
        return c.json({error:{type:'route_not_found'}},404);
      }
      // E2EE sync data routes (H4/H5 — opt-in, ciphertext-only)
      // The route validates the opaque envelope format, not proof of encryption.
      // Encryption/decryption and collection consent belong to the client.
      // Nunca aceita private key por header ou URL.
      // Pacote 03/L4: SyncDataStore is the single owner — strict contract envelope (no plaintext),
      // mandatory CAS on create/update/delete, versioned tombstones, per-object serialization.
      // The proxy stores opaque envelopes; encryption/decryption stays in the client.
      if(parts[0]==='sync-data') {
        // Existing objects belong to the whole principal, with no verified project
        // provenance. A finite (including empty) grant cannot authorize their IO.
        if(projects!=='*') return c.json({error:{type:'resource_not_granted'}},403);
        if(!syncData) return c.json({error:{type:'sync_unavailable'}},503);
        if(parts.length!==2) return c.json({error:{type:'route_not_found'}},404);
        const objectId=parts[1]!;
        try {
          if(c.req.method==='POST'){const {version}=await syncData.put(owner,objectId,input);return c.json({stored:true,objectId,version});}
          if(c.req.method==='DELETE'){const {version}=await syncData.delete(owner,objectId,input);return c.json({deleted:true,objectId,version});}
          if(c.req.method==='GET'){
            const record=await syncData.get(owner,objectId);
            return c.json(record.state==='tombstone'?{deleted:true,objectId,version:record.version}:{objectId,version:record.version,updatedAt:record.updatedAt,envelope:record.envelope});
          }
        } catch(error) {
          if(error instanceof SyncDataError) return c.json({error:{type:error.message},...(error.currentVersion!==undefined?{currentVersion:error.currentVersion}:{})},error.status);
          if(error instanceof SinkAccessDeniedError) return c.json({error:{type:error.code}},403);
          throw error;
        }
        return c.json({error:{type:'route_not_found'}},404);
      }

      if(parts[0]!=='projects') return c.json({error:{type:'route_not_found'}},404);

      // Stage-19 helpers are not connected to canonical grants, plans, consent
      // or durable execution. A browser token alone must never authorize IO.
      // Stage-19 Project Agent routes are dispatched via canonical W5 handlers below.

      const project=parts[1]!;
      if(parts[2]==='terminals'){
        c.header('cache-control','no-store');
        const authority=await terminalAuthority(c.req.header('authorization'),owner,project,secrets,principal,projectGrant);
        return c.json(await handleTerminal(runtime,owner,project,parts,c.req.method,input,new URL(c.req.url),authority,c.req.raw.signal));
      }
      if(parts[0]==='projects'&&parts[1]&&parts[2]==='learned-recipes'&&parts[3]&&(parts[4]==='access'||parts[4]==='service-plans')){
        const projectId=parts[1],recipeId=parts[3];c.header('cache-control','no-store');
        const access=await runtime.learnedServiceAccess(owner,projectId,recipeId);
        if(parts.length===5&&parts[4]==='access'&&c.req.method==='GET')return c.json(await access.owner.view(owner,access.id));
        let value=input;if(c.req.method!=='POST'){const body=await readBoundedJson(c.req.raw,65536);if(!body.ok)throw new WorkspaceError('service_input_invalid');value=body.value;}
        if(parts.length===5&&parts[4]==='service-plans'&&c.req.method==='POST')return c.json(await runtime.createLearnedServicePlan(owner,projectId,recipeId,value));
        const kind=parts.length===5?(c.req.method==='PATCH'?'update':c.req.method==='DELETE'?'remove':undefined):parts.length===6&&c.req.method==='POST'&&['configure','discover'].includes(parts[5]!)?parts[5] as 'configure'|'discover':undefined;
        if(!kind)throw new WorkspaceError('service_input_invalid');
        return c.json(await access.owner.mutate(owner,access.id,kind,value,()=>serviceAdmission(projectId)));
      }
      if(c.req.method==='GET'&&parts[2]==='runs'&&parts[4]==='protocol-events'&&parts.length===5){
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        const header=c.req.header('last-event-id'),query=url.searchParams.get('after');
        if(header!==undefined&&!/^(?:0|[1-9][0-9]{0,8})$/.test(header)||header!==undefined&&query!==null&&header!==query)throw new WorkspaceError('gateway_protocol_cursor_invalid',409);
        let cursor=Number(query??header??0);
        let page=await runtime.protocolEvents(owner,project,parts[3]!,cursor,c.req.raw.signal);
        if(page.failed)throw new WorkspaceError('gateway_protocol_stream_failed',409);
        if(protocolSubscribers>=32)throw new WorkspaceError('gateway_protocol_subscriber_limit',429);
        protocolSubscribers++;
        c.header('X-Accel-Buffering','no');
        return streamSSE(c,async stream=>{
          const abort=()=>stream.abort();
          const stillAuthorized=async()=>{
            if(await principal(c.req.header('authorization'))!==owner)return false;
            const current=projectGrant?await projectGrant(c.req.header('authorization')):'*';
            return current!==undefined&&isProjectGranted(current,project);
          };
          const deadline=setTimeout(abort,120_000);
          c.req.raw.signal.addEventListener('abort',abort,{once:true});
          try{
            while(!stream.aborted){
              for(const event of page.events){
                if(stream.aborted)break;
                // The page read and previous write can both yield across a revocation.
                if(!await stillAuthorized()){stream.abort();break;}
                const slow=setTimeout(abort,5000);
                try{await stream.write(`id: ${++cursor}\n${event}`);}finally{clearTimeout(slow);}
              }
              if(page.done||page.failed||stream.aborted)break;
              await stream.sleep(250);
              if(stream.aborted)break;
              if(!await stillAuthorized()){stream.abort();break;}
              page=await runtime.protocolEvents(owner,project,parts[3]!,cursor,c.req.raw.signal);
            }
          }catch{stream.abort();}finally{protocolSubscribers--;clearTimeout(deadline);c.req.raw.signal.removeEventListener('abort',abort);}
        });
      }
      if(c.req.method==='GET'&&parts[2]==='runs'&&parts[4]==='protocol-output'&&parts.length===5)return c.json(await runtime.protocolOutput(owner,project,parts[3]!,c.req.raw.signal));if(c.req.method==='GET'&&parts[2]==='runs'&&parts[4]==='output'&&parts.length===5)return c.json(await runtime.readProjectRunOutput(owner,project,parts[3]!,Number(new URL(c.req.url).searchParams.get('after')||0),Number(new URL(c.req.url).searchParams.get('limit')||500)));

      if(parts.length===1) {
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        const after=url.searchParams.get('after')??'';const limit=Number(url.searchParams.get('limit')??100);
        return c.json(await runtime.store.listProjectsPage(owner,after,limit,projects));
      }
      if(project==='create') return c.json(await runtime.createProject(owner,input),201);
      if(project==='import')return c.json(await runtime.importProject(owner,input),201);
      if(parts.length===2) return c.json(await runtime.view(owner,project));
      if(parts[2]==='update')return c.json({project:await runtime.store.patchProject(owner,project,input)});
      if(parts[2]==='delete'){
        const body=input as {expectedRevision:number};
        if(!body||typeof body!=='object'||Object.keys(body).join(',')!=='expectedRevision'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1)throw new WorkspaceError('invalid_request');
        await runtime.deleteProject(owner,project,body.expectedRevision);return c.json({deleted:true,projectId:project});
      }
      if(parts[2]==='consent') {
        const key=await browserKey?.(c.req.header('authorization'),c.req.header('origin'));
        if(!key)throw new WorkspaceError('browser_consent_required',403);
        const payload=input as Record<string,unknown>;
        if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new WorkspaceError('invalid_request');
        const command=parseWorkflowCommand('startRun',parts[3]==='challenge'?payload:payload.command);
        const plan=await runtime.store.getPlan(owner,project,command.planId);
        if(!plan||plan.digest!==command.planDigest)throw new WorkspaceError('plan_digest_mismatch',409);
        const binding={principalId:owner,projectId:project,planId:plan.id,planDigest:plan.digest};
        if(parts[3]==='challenge')return c.json(consent.challenge(binding,key));
        if(Object.keys(payload).sort().join(',')!=='challengeId,command,signature'||typeof payload.challengeId!=='string'||typeof payload.signature!=='string')throw new WorkspaceError('invalid_request');
        try{consent.consume(binding,payload.challengeId,payload.signature);}catch{throw new WorkspaceError('consent_invalid',403);}
        return c.json(await runtime.startRun(owner,project,command,true,conversationAdmission?.(owner,project,command,c.req.header('x-uptokey-conversation-id'),c.req.header('x-uptokey-conversation-request-id'),c.req.header('authorization'),c.get('workspaceContextRevision' as never) as number|undefined)),202);
      }
      if(parts[2]==='usage-value') {
        const params=new URL(c.req.url).searchParams;
        if(!workspaceUsageQuery(new URL(c.req.url))) throw new WorkspaceError('invalid_period');
        const period=params.get('period')!;
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new WorkspaceError('invalid_period');
        const view=await runtime.view(owner,project,true);
        const after=params.get('after')??'';const limit=Number(params.get('limit')??100);
        const receipts=view.valueReceipts.filter(item=>item.createdAt.startsWith(`${period}-`)).sort((a,b)=>a.attemptId<b.attemptId?-1:a.attemptId>b.attemptId?1:0);
        const snapshotDigest=createHash('sha256').update(JSON.stringify({project,period,receipts,tariffs:view.tariffs})).digest('hex');
        const ordered=receipts.filter(item=>item.attemptId>after);
        const page=ordered.slice(0,limit);
        // Explicit projection: no project context, prompts, outputs or credentials.
        return c.json({contractRevision:view.contractRevision,projectId:project,period,snapshotDigest,
          valueReceipts:page,tariffs:view.tariffs,nextCursor:ordered.length>limit?page.at(-1)!.attemptId:null});
      }
      if(c.req.method==='GET'&&parts[2]==='artifacts'&&parts[4]==='verification'&&parts.length===5){c.header('cache-control','no-store');return c.json(await runtime.verifyArtifact(owner,project,parts[3]!,c.req.raw.signal));}
      if(c.req.method==='GET'&&parts[2]==='artifacts'&&parts[4]==='api-projection'&&parts.length===5)return c.json(await runtime.apiArtifactProjection(owner,project,parts[3]!));
      if(c.req.method==='POST'&&parts[2]==='artifacts'&&parts[4]==='derive'&&parts.length===5)return c.json(await runtime.deriveArtifact(owner,project,parts[3]!,input));
      if(parts[2]==='artifacts'&&parts[4]==='media') {
        const {bytes,mediaType}=await runtime.store.readBinaryArtifactMedia(owner,project,parts[3]!);
        const filenames={'audio/mpeg':'speech.mp3','audio/wav':'speech.wav','audio/ogg':'speech.ogg','audio/webm':'speech.webm','audio/mp4':'speech.mp4','image/png':'image.png','image/jpeg':'image.jpg','image/webp':'image.webp','video/mp4':'video.mp4'} as const;
        if(!(mediaType in filenames))throw new WorkspaceError('workspace_artifact_media_type_invalid');
        const filename=filenames[mediaType as keyof typeof filenames];
        return new Response(Buffer.from(bytes),{headers:{'Content-Type':mediaType,'Content-Length':String(bytes.byteLength),
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename="${filename}"`}});
      }
      if(parts[2]==='artifacts'&&parts.length===4) return c.json({content:await runtime.store.readTextArtifact(owner,project,parts[3]!)});
      // Project Agent / Roots routes
      if(parts[2]==='project-roots'&&parts.length===3&&c.req.method==='GET') {
        return c.json(await runtime.listProjectRoots(owner,project));
      }
      if(parts[2]==='project-roots'&&parts[3]==='register'&&c.req.method==='POST') {
        return c.json(await runtime.registerProjectRoot(owner,project,input), 201);
      }
      if(parts[2]==='project-roots'&&parts.length===5&&parts[4]==='revoke'&&c.req.method==='POST') {
        return c.json(await runtime.revokeProjectRoot(owner,project,parts[3]!));
      }
      if(parts[2]==='project-roots'&&parts.length===5&&parts[4]==='restore-file'&&c.req.method==='POST') {
        return c.json(await runtime.restoreProjectFile(owner,project,parts[3]!,input,c.req.raw.signal));
      }
      if(parts[2]==='project-roots'&&parts.length===5&&parts[4]==='restore-turn'&&c.req.method==='POST') {
        return c.json(await runtime.restoreProjectTurn(owner,project,parts[3]!,input,c.req.raw.signal));
      }
      if(parts[2]==='project-agent'&&parts[3]==='manifest'&&c.req.method==='GET') {
        const rootBindingId = c.req.query('rootBindingId') || '';
        return c.json(await runtime.getProjectManifest(owner,project,rootBindingId));
      }
      if(parts[2]==='project-agent'&&parts[3]==='file'&&c.req.method==='GET') {
        const url=new URL(c.req.url);
        if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        c.header('cache-control','no-store');
        if(url.searchParams.has('startLine'))return c.json(await runtime.readProjectFileRange(owner,project,url.searchParams.get('rootBindingId')||'',url.searchParams.get('path')||'',Number(url.searchParams.get('startLine')),Number(url.searchParams.get('endLine')),c.req.raw.signal));
        return c.json(await runtime.readProjectFile(owner,project,url.searchParams.get('rootBindingId')||'',url.searchParams.get('path')||''));
      }
      if(parts[2]==='project-agent'&&parts[3]==='media'&&c.req.method==='GET') {
        const url=new URL(c.req.url);
        if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        const pathParam=url.searchParams.get('path')||'';
        const { bytes, mediaType } = await runtime.readProjectMedia(owner,project,url.searchParams.get('rootBindingId')||'',pathParam, c.req.raw.signal);
        const filename=pathParam.split('/').pop() || 'media';
        return new Response(Buffer.from(bytes), { headers: { 'Content-Type': mediaType, 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${filename}"` }});
      }
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='directory'&&c.req.method==='GET') {
        const url=new URL(c.req.url);
        if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        c.header('cache-control','no-store');
        return c.json(await runtime.listProjectDirectory(owner,project,url.searchParams.get('rootBindingId')||'',url.searchParams.get('path')||'',Number(url.searchParams.get('offset')||'0'),c.req.raw.signal));
      }
      if(parts[2]==='project-agent'&&parts[3]==='preflight'&&c.req.method==='POST') {
        return c.json(await runtime.preflightProjectChangeSet(owner,project,input));
      }
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='run-plans'&&c.req.method==='POST')return c.json(await runtime.createProjectRunPlan(owner,project,input,c.req.raw.signal));
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='run-promotions'&&c.req.method==='POST')return c.json(await runtime.createProjectRunPromotionPlan(owner,project,input,c.req.raw.signal));
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='git-plans'&&c.req.method==='POST')return c.json(await runtime.createGitPlan(owner,project,input,c.req.raw.signal));
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='host-command-plans'&&c.req.method==='POST')return c.json(await runtime.createHostCommandPlan(owner,project,input,c.req.raw.signal));
      if(parts.length===5&&parts[2]==='project-agent'&&parts[3]==='host-command-sessions'&&parts[4]==='close'&&c.req.method==='POST'){
        const body=input as Record<string,unknown>|undefined;
        return c.json({closed:await runtime.closeHostCommandSession(owner,project,body?.rootBindingId as string|undefined,body?.conversationId as string|undefined)});
      }
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='git-status'&&c.req.method==='GET'){
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        c.header('cache-control','no-store');
        return c.json(await runtime.projectGitStatus(owner,project,url.searchParams.get('rootBindingId')||'',c.req.raw.signal));
      }
      if(parts.length===4&&parts[2]==='project-agent'&&parts[3]==='git-diff'&&c.req.method==='GET'){
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        c.header('cache-control','no-store');
        return c.json(await runtime.projectGitDiff(owner,project,url.searchParams.get('rootBindingId')||'',url.searchParams.get('path')||'',url.searchParams.get('staged')==='1',c.req.raw.signal));
      }
      if(parts[2]==='project-agent'&&parts[3]==='plans'&&c.req.method==='POST') {
        return c.json(await runtime.createProjectTaskPlan(owner,project,input,c.req.raw.signal));
      }
      if(parts[2]==='project-agent'&&parts[3]==='preview'&&parts[4]==='start'&&c.req.method==='POST') {
        return c.json(await runtime.startProjectPreview(owner,project,input));
      }
      if(parts[2]==='project-agent'&&parts[3]==='preview'&&parts.length===6&&parts[5]==='stop'&&c.req.method==='POST') {
        return c.json(await runtime.stopProjectPreview(owner,project,parts[4]!));
      }
      if(parts[2]==='project-agent'&&parts[3]==='export'&&parts[4]==='zip'&&c.req.method==='POST') {
        const rootBindingId = isDataRecord(input) && typeof (input as Record<string, unknown>).rootBindingId === 'string' ? String((input as Record<string, unknown>).rootBindingId) : '';
        const zip = await runtime.exportProjectZip(owner,project,rootBindingId);
        return new Response(zip as unknown as BodyInit, {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="project-${project}.zip"`
          }
        });
      }
      if(parts[2]==='project-agent'&&parts[3]==='task-plans'&&parts.length===4&&c.req.method==='POST')return c.json(await runtime.prepareProjectTask(owner,project,input),201);
      if(parts[2]==='project-agent'&&parts[3]==='tasks') {
        if(parts.length===4&&c.req.method==='GET')return c.json(await runtime.listProjectTasks(owner,project));
        if(parts.length===5&&c.req.method==='GET')return c.json(await runtime.getProjectTask(owner,project,parts[4]!));
        if(parts.length===6&&c.req.method==='POST'&&parts[5]==='cancel')return c.json(await runtime.cancelProjectTask(owner,project,parts[4]!));
        if(parts.length===6&&c.req.method==='POST'&&parts[5]==='resume')return c.json(await runtime.resumeProjectTask(owner,project,parts[4]!));
      }

      // E2-05 multimodel
      if(parts[2]==='multimodel-plans'){
        if(parts.length===3&&c.req.method==='GET')return c.json({plans: await runtime.listMultimodelPlans(owner,project)});
        if(parts.length===3&&c.req.method==='POST')return c.json(await runtime.createMultimodelPlan(owner,project,input),201);
        if(parts.length===4&&c.req.method==='GET')return c.json(await runtime.getMultimodelPlan(owner,project,parts[3]!));
        if(parts.length===6&&parts[4]==='consent'&&(parts[5]==='challenge'||parts[5]==='complete')&&c.req.method==='POST'){
          // Start de painel segue o mesmo consent canônico de runs/start: prova de posse da chave do browser.
          const plan=await runtime.getMultimodelPlan(owner,project,parts[3]!);
          const payload=input as Record<string,unknown>;
          if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new WorkspaceError('invalid_request');
          const command=parts[5]==='challenge'?payload:(payload as {command?:unknown}).command;
          if(!command||typeof command!=='object'||Array.isArray(command))throw new WorkspaceError('invalid_request');
          const {planId,planDigest}=command as {planId?:unknown;planDigest?:unknown};
          if(planId!==plan.id||planDigest!==plan.digest)throw new WorkspaceError('plan_digest_mismatch',409);
          const key=await browserKey?.(c.req.header('authorization'),c.req.header('origin'));
          if(!key)throw new WorkspaceError('browser_consent_required',403);
          const binding={principalId:owner,projectId:project,planId:plan.id,planDigest:plan.digest};
          if(parts[5]==='challenge')return c.json(consent.challenge(binding,key));
          if(Object.keys(payload).sort().join(',')!=='challengeId,command,signature'||typeof payload.challengeId!=='string'||typeof payload.signature!=='string')throw new WorkspaceError('invalid_request');
          try{consent.consume(binding,payload.challengeId,payload.signature);}catch{throw new WorkspaceError('consent_invalid',403);}
          return c.json(await runtime.startMultimodelRun(owner,project,plan.id),201);
        }
        if(parts.length===5&&parts[4]==='start'&&c.req.method==='POST')throw new WorkspaceError('browser_consent_required',403);
      }
      if(parts[2]==='multimodel-runs'){
        if(parts.length===3&&c.req.method==='GET')return c.json({runs: await runtime.listMultimodelRuns(owner,project)});
        if(parts.length===4&&c.req.method==='GET')return c.json(await runtime.getMultimodelRun(owner,project,parts[3]!));
        if(parts.length===5&&parts[4]==='cancel'&&c.req.method==='POST')return c.json(await runtime.cancelMultimodelRun(owner,project,parts[3]!));
        if(parts.length===5&&parts[4]==='reload'&&c.req.method==='POST')return c.json(await runtime.reloadMultimodelRun(owner,project,parts[3]!));
        if(parts.length===7&&parts[4]==='branches'&&parts[6]==='cancel'&&c.req.method==='POST')return c.json(await runtime.cancelMultimodelBranch(owner,project,parts[3]!,parts[5]!));
      }

      // E2-22 benchmarks — GET never starts; prepare/start only via explicit POST; rankings do not change routing
      if(parts[2]==='benchmark-observations'&&parts.length===3&&c.req.method==='GET')return c.json(await runtime.listBenchmarkObservations(owner,project));
      if(parts[2]==='benchmark-rankings'&&parts.length===3&&c.req.method==='GET')return c.json(await runtime.listBenchmarkRankings(owner,project));
      if(parts[2]==='benchmark-runs'){
        if(parts.length===3&&c.req.method==='GET')return c.json(await runtime.listBenchmarkRuns(owner,project));
        if(parts.length===4&&c.req.method==='GET')return c.json(await runtime.getBenchmarkRun(owner,project,parts[3]!));
        if(parts.length===5&&parts[4]==='cancel'&&c.req.method==='POST')return c.json(await runtime.cancelBenchmarkRun(owner,project,parts[3]!));
        if(parts.length===5&&parts[4]==='reload'&&c.req.method==='POST')return c.json(await runtime.reloadBenchmarkRun(owner,project,parts[3]!));
      }
      if(parts[2]==='benchmark-evals'){
        if(parts.length===4&&parts[3]==='prepare'&&c.req.method==='POST')return c.json(await runtime.prepareBenchmarkEval(owner,project,input),201);
        if(parts.length===4&&parts[3]==='start'&&c.req.method==='POST')return c.json(await runtime.startBenchmarkEval(owner,project,input),201);
      }

      if(parts[2]==='plans'&&parts.length===3&&c.req.method==='GET'){
        if(!workspaceUsageQuery(new URL(c.req.url)))throw new WorkspaceError('plan_history_query_invalid',400);
        return c.json(await listPlanHistory(runtime,owner,project,{after:c.req.query('after'),limit:c.req.query('limit')?Number(c.req.query('limit')):undefined}));
      }
      if(parts[2]==='plans'&&parts.length===4&&c.req.method==='GET')return c.json(await runtime.viewPlan(owner,project,parts[3]!));
      if(parts[2]==='rss-plans')return c.json(await runtime.createRssPlan(owner,project,input,c.req.raw.signal),201);
      if(parts[2]==='api-composite-plans')return c.json(await runtime.createApiCompositePlan(owner,project,input,c.req.raw.signal));
      if(parts.length===4&&parts[2]==='classification-results'&&parts[3]==='apply')return c.json(await runtime.applyClassificationResult(owner,project,input));
      if(parts[2]==='classification-plans')return c.json(await runtime.createClassificationPlan(owner,project,input,c.req.raw.signal),201);
      if(parts[2]==='usage-classifications'){
        if(parts.length===3&&c.req.method==='GET')return c.json(await runtime.listUsageClassifications(owner,project));
        if(parts.length===4&&c.req.method==='GET')return c.json(await runtime.getUsageClassification(owner,project,parts[3]!));
        if(parts.length===5&&parts[4]==='correction'&&c.req.method==='POST')return c.json(await runtime.correctUsageClassification(owner,project,parts[3]!,input),201);
      }
      if(parts[2]==='recipe-plans')return c.json(await runtime.createRecipePlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='api-intent-plans')return c.json(await runtime.createApiIntentPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='productivity-plans')return c.json(await runtime.createProductivityPlan(owner,project,input));
      if(parts[2]==='api-plans')return c.json(await runtime.createApiPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='service-plans')return c.json(await runtime.createServicePlan(owner,project,input));
      if(parts[2]==='web-plans')return c.json(await runtime.createWebPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='web-citations')return c.json(await runtime.verifyWebCitation(owner,project,input));
      if(parts[2]==='chat-plans')return c.json(await runtime.createChatPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='adapted-chat-plans')return c.json(await runtime.createAdaptedChatPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='audio-chat-plans')return c.json(await runtime.createAudioChatPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='image-plans')return c.json(await runtime.createImagePlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='video-plans')return c.json(await runtime.createVideoPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='video-resume-plans')return c.json(await runtime.createVideoResumePlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='speech-plans')return c.json(await runtime.createSpeechPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='audio-import')return c.json(await runtime.importAudioArtifact(owner,project,input),201);
      if(parts[2]==='image-import')return c.json(await runtime.importImageArtifact(owner,project,input),201);
      if(parts[2]==='embeddings-plans')return c.json(await runtime.createEmbeddingsPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='transcription-plans')return c.json(await runtime.createTranscriptionPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='voice-plans')return c.json(await runtime.createVoicePlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='voice-sessions'){
        if(parts.length===3&&c.req.method==='POST')return c.json(await runtime.startVoiceSession(owner,project,input),201);
        if(parts.length===5&&c.req.method==='POST'&&parts[4]==='interrupt')return c.json(await runtime.interruptVoiceSession(owner,project,parts[3]!,input));
        if(parts.length===5&&c.req.method==='POST'&&parts[4]==='stop')return c.json(await runtime.stopVoiceSession(owner,project,parts[3]!));
        if(parts.length===5&&c.req.method==='POST'&&parts[4]==='audio')return c.json(await runtime.voiceSessionAudio(owner,project,parts[3]!,input));
        if(parts.length===5&&c.req.method==='POST'&&parts[4]==='commit')return c.json(await runtime.voiceSessionCommit(owner,project,parts[3]!));
        if(parts.length===5&&c.req.method==='GET'&&['events','live'].includes(parts[4]!)){
          c.header('Cache-Control','no-store');
          const url=new URL(c.req.url),after=url.searchParams.get('after');
          if([...url.searchParams.keys()].some(key=>key!=='after')||after!==null&&!/^(?:0|[1-9][0-9]{0,8})$/.test(after))throw new WorkspaceError('invalid_request');
          return c.json(await (parts[4]==='live'?runtime.voiceSessionLive(owner,project,parts[3]!,after===null?0:Number(after)):runtime.voiceSessionEvents(owner,project,parts[3]!,after===null?0:Number(after))));
        }
      }
      if(parts[2]==='browser-fill-plans')return c.json(await runtime.createBrowserFillPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='browser-plans')return c.json(await runtime.createBrowserPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='filesystem-plans')return c.json(await runtime.createFilesystemPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='tool-plans')return c.json(await runtime.createToolProposalPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='tool-result-plans')return c.json(await runtime.createToolResultPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='learned-recipe-plans')return c.json(await runtime.createLearnedRecipePlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='learned-recipes') {
        if(parts.length===3&&c.req.method==='GET')return c.json(await runtime.listLearnedRecipes(owner,project));
        if(parts.length===4&&parts[3]==='ingest')return c.json(await runtime.ingestLearnedRecipe(owner,project,input,c.req.raw.signal),201);
        if(parts.length===4&&parts[3]==='preview')return c.json(await runtime.previewLearnedRecipe(owner,project,input));
        if(parts.length===4&&parts[3]==='match')return c.json(await runtime.matchLearnedRecipe(owner,project,input));
        if(parts.length===4&&parts[3]==='export') {
          if(!input||typeof input!=='object'||Array.isArray(input)||typeof (input as Record<string,unknown>).recipeId!=='string')throw new WorkspaceError('learned_invalid',400);
          return c.json(await runtime.exportLearnedPackage(owner,project,(input as Record<string,unknown>).recipeId as string));
        }
        if(parts.length===4&&parts[3]==='review')return c.json(await runtime.reviewLearnedRecipe(owner,project,input));
        if(parts.length===4&&parts[3]==='revoke')return c.json(await runtime.revokeLearnedRecipe(owner,project,input));
      }
      if(parts[2]==='protocol-plans')return c.json(await runtime.createProtocolPlan(owner,project,input,c.req.raw.signal));
      if(parts[2]==='compositions'){
        if(parts[3]==='create')return c.json(await runtime.createComposition(owner,project,input));
        if(parts[4]==='resume')return c.json(await runtime.resumeComposition(owner,project,parts[3]!,input));
        return c.json(await runtime.getComposition(owner,project,parts[3]!));
      }
      if(parts[2]==='plans'||parts[2]==='recipes'&&(parts[4]==='plan'||parts[4]==='versions'&&parts[6]==='plan')) {
        if(!input||typeof input!=='object'||Array.isArray(input)||!Object.hasOwn(input,'expectedRevision')||!Object.hasOwn(input,'objective')||Object.keys(input).some(key=>!['expectedRevision','objective','selectedEntryIds','selectedArtifactIds',...(parts[2]==='plans'?['sourceIds']:[])].includes(key))) throw new WorkspaceError('invalid_request');
        const value=input as {expectedRevision:number;objective:string;selectedEntryIds?:string[];selectedArtifactIds?:string[];sourceIds?:string[]};
        const candidates=parts[2]==='recipes'?(await runtime.store.listRecipes(owner,project)).filter(item=>item.id===parts[3]):[];
        const version=parts[4]==='versions'?Number(parts[5]):undefined;
        if(version===undefined&&candidates.length>1)throw new WorkspaceError('recipe_version_required',409);
        const recipe=version===undefined?candidates[0]:candidates.find(item=>item.version===version);
        if(parts[2]==='recipes'&&!recipe) throw new WorkspaceError('recipe_missing',404);
        // Revocation is durable per version: the plan path must refuse the same
        // tombstone the exchange and schedule paths refuse. A revoked recipe cannot
        // return through recipes/:id/plan or recipes/:id/versions/:v/plan.
        if(recipe) await assertRecipeSelectable(runtime,owner,project,recipe);
        return c.json(await runtime.createPlan(owner,project,value,recipe));
      }
      if(parts[2]==='artifacts'&&parts.length===3&&c.req.method==='GET'){
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        const after=url.searchParams.get('after')??'',limit=Number(url.searchParams.get('limit')??100);
        const artifacts=(await runtime.store.getBundle(owner,project)).artifacts.filter(item=>item.id>after);
        // Use the same code-point order for sorting and the cursor boundary.
        artifacts.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
        const page=artifacts.slice(0,limit);return c.json({artifacts:page,nextCursor:artifacts.length>limit?page.at(-1)!.id:null});
      }
      if(parts[2]==='runs'&&parts[3]==='start') {
        const command=parseWorkflowCommand('startRun',input);
        return c.json(await runtime.startRun(owner,project,command,false,conversationAdmission?.(owner,project,command,c.req.header('x-uptokey-conversation-id'),c.req.header('x-uptokey-conversation-request-id'),c.req.header('authorization'),c.get('workspaceContextRevision' as never) as number|undefined)),202);
      }
      if(parts[2]==='runs'&&parts[4]==='output'&&c.req.method==='DELETE'){return c.json(await runtime.deleteProjectRunOutput(owner,project,parts[3]!));}if(parts[2]==='runs'&&parts[4]==='cancel') {
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length) throw new WorkspaceError('invalid_request');
        return c.json(await runtime.cancel(owner,project,parts[3]!));
      }
      if(parts[2]==='runs'&&parts[4]==='write-recovery'&&c.req.method==='GET') {
        if(new URL(c.req.url).search) throw new WorkspaceError('invalid_request');
        c.header('cache-control','no-store');
        return c.json(await runtime.reviewInterruptedWrite(owner,project,parts[3]!));
      }
      if(parts[2]==='runs'&&parts[4]==='resolve-attention') {
        if(!input||typeof input!=='object'||Array.isArray(input)||typeof (input as Record<string,unknown>).action!=='string'||('reason' in input&&(input as Record<string,unknown>).reason!==undefined&&typeof (input as Record<string,unknown>).reason!=='string')) throw new WorkspaceError('invalid_request');
        return c.json(await runtime.resolveRunAttention(owner,project,parts[3]!,input));
      }
      if(parts[2]==='recipes'&&parts[3]==='exchange'&&parts.length===5&&c.req.method==='POST')return c.json(await handleRecipeExchange(runtime,owner,project,parts[4]!,input));
      if(parts[2]==='recipes'&&parts[3]==='derive-preview'&&parts.length===4&&c.req.method==='POST')return c.json(await runtime.previewRecipeDerivation(owner,project,input));
      if(parts[2]==='recipes'&&parts[3]==='create') return c.json(await runtime.saveRecipe(owner,project,input),201);
      if(parts[2]==='recipes') {
        const url=new URL(c.req.url);if(!workspaceUsageQuery(url))throw new WorkspaceError('invalid_request');
        const offset=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??100);
        // Tombstones are durable revocation records, not recipes: they stay in the
        // store for the lineage check but are never listed as selectable entries.
        const recipes=(await runtime.store.listRecipes(owner,project)).filter(item=>!item.id.startsWith('revoke_')).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.version-b.version);
        const snapshotDigest=createHash('sha256').update(JSON.stringify(recipes)).digest('hex');
        const page=recipes.slice(offset,offset+limit);
        return c.json({recipes:page,snapshotDigest,nextCursor:offset+page.length<recipes.length?String(offset+page.length):null});
      }


      return c.json({error:{type:'route_not_found'}},404);
    } catch(error) {
      if(error instanceof Error&&/^service_[a-z_]+$/.test(error.message))return c.json({error:{type:error.message}},error.message==='service_revision_conflict'?409:error.message==='service_not_found'?404:error.message==='service_auth_invalid'?401:error.message==='service_permission_denied'||error.message==='service_disabled'||error.message==='service_removed'?403:error.message==='service_rate_limited'?429:error.message==='service_unavailable'?503:400);
      if(error instanceof WorkspaceError) return c.json({error:{type:error.code,...(error.details!==undefined?{details:error.details}:{})}},error.status);
      if(error && typeof (error as any).status === 'number') return c.json({error:{type:(error as any).message}}, (error as any).status);
      if(error instanceof WorkflowContractError) return c.json({error:{type:'workflow_invalid'}},400);
      if((error as NodeJS.ErrnoException)?.code==='ENOENT') return c.json({error:{type:'workspace_not_found'}},404);
      if(error instanceof Error&&['workspace_project_not_found','workspace_artifact_not_found'].includes(error.message))return c.json({error:{type:'workspace_not_found'}},404);
      if(error instanceof Error&&error.message==='workspace_revision_conflict') return c.json({error:{type:'workspace_revision_conflict'}},409);
      if(error instanceof Error&&['project_run_active','workspace_delete_run_active'].includes(error.message)) return c.json({error:{type:'project_run_active'}},409);
      // Ausência de perfil/serviço é estado de produto esperado (ex.: mídia sem
      // serviço configurado) — o stack só é emitido sob diagnóstico explícito.
      if (process.env.UPTOKEY_WORKSPACE_DIAGNOSTICS === '1') console.error("workspaceMethod HTTP 503 fallback:", error);
      return c.json({error:{type:'workspace_unavailable'}},503);
    }
  });
}
