import {parseWorkspaceContextLink,parseProjectRootBinding} from '../runtime/contracts/context-protocol.mjs';
import {importWorkspaceBytes} from './import-workspace.mjs';
import {ensureCoreWorkspaceIdentity} from './context-identity.mjs';

const CORE='http://127.0.0.1:21435',BASE='/local/workspace/session/context';
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONVERSATION=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE=/^[A-F0-9]{8}$/;
export const CONTEXT_ARCHIVE_LIMIT=34*1024*1024;
export class ContextSnapshotError extends Error {
  constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
const fail=(code,status)=>{throw new ContextSnapshotError(code,status);};
export function contextSelection(input){
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).sort().join(',')!=='clientId,conversationId,linkRevision,projectId,rootBindingId,rootRevision'
    ||typeof input.clientId!=='string'||!UUID.test(input.clientId)
    ||typeof input.conversationId!=='string'||!CONVERSATION.test(input.conversationId)
    ||typeof input.projectId!=='string'||!ID.test(input.projectId)
    ||typeof input.rootBindingId!=='string'||!ID.test(input.rootBindingId)
    ||!Number.isSafeInteger(input.linkRevision)||input.linkRevision<1
    ||!Number.isSafeInteger(input.rootRevision)||input.rootRevision<1)fail('context_selection_invalid',400);
  return {...input};
}
function client(options){
  const {token,fetcher=fetch,signal}=options;
  if(typeof token!=='string'||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token))fail('context_pairing_required',401);
  const lifetime=AbortSignal.any([AbortSignal.timeout(60000),...(signal?[signal]:[])]);
  const request=async(path,body)=>{
    lifetime.throwIfAborted();
    const response=await fetcher(CORE+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),credentials:'omit',cache:'no-store',redirect:'error',signal:lifetime});
    if(!response.ok){
      const type=await errorType(response);
      fail(response.status===401?'context_pairing_required'
        :type==='context_link_invalid'?'context_link_invalid'
        :type==='context_scope_denied'?'context_scope_denied'
        :type==='local_auth_rate_limited'?'context_rate_limited'
        :response.status===403?'context_snapshot_denied'
        :response.status===409&&path===BASE+'/consume'&&type==='context_link_pending_or_expired'?'context_link_pending'
        :response.status===409&&path===BASE+'/consume'?'context_link_changed'
        :response.status===409?'context_snapshot_changed':'context_snapshot_unavailable',response.status);
    }
    return response;
  };
  const bytes=async(response,limit)=>{
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>limit)){
      void response.body?.cancel().catch(()=>{});fail('context_snapshot_limit',413);
    }
    if(!response.body)fail('context_snapshot_unavailable',502);
    const reader=response.body.getReader(),chunks=[];let size=0;
    const read=()=>new Promise((resolve,reject)=>{
      const abort=()=>{lifetime.removeEventListener('abort',abort);reject(lifetime.reason);};
      lifetime.addEventListener('abort',abort,{once:true});
      reader.read().then(value=>{lifetime.removeEventListener('abort',abort);resolve(value);},error=>{lifetime.removeEventListener('abort',abort);reject(error);});
      if(lifetime.aborted)abort();
    });
    try{for(;;){lifetime.throwIfAborted();const next=await read();if(next.done)break;size+=next.value.byteLength;if(size>limit)fail('context_snapshot_limit',413);chunks.push(Buffer.from(next.value));}}
    finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
    return Buffer.concat(chunks,size);
  };
  const errorType=async(response)=>{
    try{
      const value=JSON.parse((await bytes(response,4096)).toString('utf8'));
      return value&&typeof value==='object'&&!Array.isArray(value)&&value.error&&typeof value.error==='object'&&!Array.isArray(value.error)&&typeof value.error.type==='string'?value.error.type:'';
    }catch{return'';}
  };
  const json=async(path,body,limit=256*1024)=>{
    try{return JSON.parse((await bytes(await request(path,body),limit)).toString('utf8'));}
    catch(error){if(error instanceof ContextSnapshotError||lifetime.aborted)throw error;fail('context_snapshot_invalid',502);}
  };
  const status=async()=>parseWorkspaceContextLink(await json(BASE,undefined,16384));
  const roots=async(projectId)=>{
    const rows=await json('/v1/workspace/projects/'+projectId+'/project-roots',undefined);
    if(!Array.isArray(rows)||rows.length>128)fail('context_snapshot_invalid',502);
    const seen=new Set();return rows.map(input=>{
      let root;try{root=parseProjectRootBinding(input);}catch{fail('context_snapshot_invalid',502);}
      if(root.projectId!==projectId||seen.has(root.id))fail('context_snapshot_invalid',502);
      seen.add(root.id);return root;
    }).filter(root=>!root.revokedAt&&Date.parse(root.expiresAt)>Date.now());
  };
  return{request,bytes,json,status,roots,signal:lifetime};
}
const sameLink=(a,b)=>a.linked&&b.linked&&a.clientId===b.clientId&&a.revision===b.revision
  &&a.conversationId===b.conversationId&&JSON.stringify([...a.projectIds].sort())===JSON.stringify([...b.projectIds].sort());
const selectedLink=(link,s)=>link.linked&&link.clientId===s.clientId&&link.revision===s.linkRevision
  &&link.conversationId===s.conversationId&&link.projectIds.includes(s.projectId);

export async function listApprovedContexts(options={}){
  const api=client(options),link=await api.status();
  if(!link.linked)return{linked:false,choices:[]};
  const choices=[];
  for(const projectId of link.projectIds)for(const root of await api.roots(projectId)){
    if(choices.length>=128)fail('context_snapshot_limit',413);
    choices.push({label:root.displayName,selection:{clientId:link.clientId,linkRevision:link.revision,conversationId:link.conversationId,projectId,rootBindingId:root.id,rootRevision:root.revision}});
  }
  if(!sameLink(link,await api.status()))fail('context_snapshot_changed');
  return{linked:true,choices};
}

export async function importApprovedContext(input,options={}){
  const selection=contextSelection(input),api=client(options),before=await api.status();
  if(!selectedLink(before,selection))fail('context_snapshot_changed');
  const root=(await api.roots(selection.projectId)).find(root=>root.id===selection.rootBindingId);
  if(!root||root.revision!==selection.rootRevision)fail('context_snapshot_changed');
  const response=await api.request('/v1/workspace/projects/'+selection.projectId+'/project-agent/export/zip',{rootBindingId:selection.rootBindingId});
  if(response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/zip'){
    void response.body?.cancel().catch(()=>{});fail('context_snapshot_invalid',502);
  }
  const archive=await api.bytes(response,CONTEXT_ARCHIVE_LIMIT);
  try{
    // Revocation guards on the core stream stop reads; this second check also
    // rejects bytes retained after a completed response but before local import.
    const current=(await api.roots(selection.projectId)).find(candidate=>candidate.id===root.id);
    if(!current||current.revision!==root.revision)fail('context_snapshot_changed');
    // Status must be last: the root request may succeed under a replacement
    // link to the same project, which cannot authorize the retained old archive.
    if(!sameLink(before,await api.status()))fail('context_snapshot_changed');
    api.signal.throwIfAborted();
    return await (options.importArchive??importWorkspaceBytes)(archive,{signal:api.signal});
  }finally{archive.fill(0);}
}

export async function revokeApprovedContext(options={}){
  const api=client(options),before=await api.status();
  if(!before.linked)fail('context_not_linked',409);
  const after=parseWorkspaceContextLink(await api.json(BASE+'/revoke',{expectedRevision:before.revision},16384));
  if(after.linked||after.clientId!==before.clientId||after.revision!==before.revision+1)fail('context_snapshot_invalid',502);
  return{revoked:true,clientId:after.clientId,revision:after.revision};
}

function connectionSession(input,now=Date.now()){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='clientId,expectedRevision,expiresAt,id'
    ||typeof input.clientId!=='string'||!UUID.test(input.clientId)||typeof input.id!=='string'||!UUID.test(input.id)
    ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.expiresAt!=='string'||!Number.isFinite(Date.parse(input.expiresAt)))fail('context_connection_invalid',400);
  if(Date.parse(input.expiresAt)<=now)fail('context_link_expired',409);
  return{clientId:input.clientId,expectedRevision:input.expectedRevision,id:input.id,expiresAt:input.expiresAt};
}
function challenge(input,now=Date.now()){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expiresAt,id,userCode'
    ||typeof input.id!=='string'||!UUID.test(input.id)||typeof input.userCode!=='string'||!CODE.test(input.userCode)
    ||typeof input.expiresAt!=='string')fail('context_connection_invalid',502);
  const expiresAt=Date.parse(input.expiresAt);
  if(!Number.isFinite(expiresAt)||expiresAt<=now||expiresAt>now+10*60*1000)fail('context_connection_invalid',502);
  return{id:input.id,userCode:input.userCode,expiresAt:input.expiresAt};
}
export async function beginApprovedContextConnection(options={}){
  const api=client(options),before=await api.status(),now=options.now?.()??Date.now();
  let created;
  try{created=challenge(await api.json(BASE+'/challenge',{},16384),now);}
  catch(error){
    if(!(error instanceof ContextSnapshotError)||error.code!=='context_link_invalid')throw error;
    try{await (options.ensureIdentity??ensureCoreWorkspaceIdentity)({token:options.token,fetcher:options.fetcher??fetch,signal:api.signal});}
    catch(identityError){
      const code=identityError instanceof Error?identityError.message:'';
      const mapped=code==='context_pairing_required'?'context_pairing_required':code==='context_scope_denied'?'context_scope_denied':
        code==='local_auth_rate_limited'?'context_rate_limited':'context_link_invalid';
      fail(mapped,mapped==='context_pairing_required'?401:mapped==='context_rate_limited'?429:403);
    }
    created=challenge(await api.json(BASE+'/challenge',{},16384),now);
  }
  const expiresInMs=Date.parse(created.expiresAt)-now;
  // The core captures expectedBindingRevision while creating the challenge.
  // Re-read after creation so a link/revoke completed before that capture does
  // not make us reject the receipt after the core has already committed it.
  const captured=await api.status();
  if(captured.clientId!==before.clientId)fail('context_connection_invalid',502);
  return{challenge:created,expiresInMs,session:{clientId:captured.clientId,expectedRevision:captured.revision,id:created.id,expiresAt:created.expiresAt}};
}
export async function consumeApprovedContextConnection(input,options={}){
  const session=connectionSession(input,options.now?.()??Date.now()),api=client(options);
  const link=parseWorkspaceContextLink(await api.json(BASE+'/consume',{id:session.id},16384));
  if(!link.linked||link.clientId!==session.clientId||link.revision!==session.expectedRevision+1)fail('context_connection_invalid',502);
  return link;
}
