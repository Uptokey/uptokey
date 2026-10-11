/**
 * E2-05 — Advisor, subagentes e fusão com juiz. Contrato W0 proponente.
 * Todos os schemas são PROPOSTOS até aprovação de onda.
 * Nenhum campo carrega segredo ou credencial. Painel é intenção tipada.
 */
import { isDataRecord } from './plain-data.js';
import { canonicalJson } from './canonical.js';

export const MULTIMODEL_CONTRACT_VERSION = 1;
export const MULTIMODEL_SCHEMA_VERSION = 1;

const MODES = ['advisor','subagents','compare','fusion','architect_coder'];
const ROLES = ['advisor','worker','critic','analyst','writer'];
const BRANCH_STATUSES = ['pending','running','succeeded','failed','cancelled','unknown'];
const RUN_STATUSES = ['draft','running','succeeded','failed','cancelled','needs_attention','partial'];

const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v);
const name = v => typeof v === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(v);
const text = (v, max=4000, empty=false) => typeof v==='string' && (empty||v.trim().length>0) && v.length<=max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v>=min && v<=max;
const date = v => typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString()===v;
const array = (v, check, max=64, min=0) => Array.isArray(v) && v.length>=min && v.length<=max && v.every(check);
const unique = (v, key=x=>x) => new Set(v.map(key)).size===v.length;
const nullable = check => v => v===null || check(v);

function fail(code='multimodel_invalid'){ throw new Error(code); }

function matchesFields(v, fields, optional=[]){
  if(!isDataRecord(v)) return false;
  const keys=Object.keys(v);
  return keys.every(k=>Object.hasOwn(fields,k)) && Object.entries(fields).every(([k,check])=> Object.hasOwn(v,k) ? check(v[k]) : optional.includes(k));
}

function parseLimits(v){
  if(!matchesFields(v,{maxMembers:v=>integer(v,1,8),maxConcurrency:v=>integer(v,1,4),maxDepth:v=>integer(v,0,2),maxCalls:v=>integer(v,1,24),maxElapsedMs:v=>integer(v,1000,300000),maxCostMicros:decimal,maxTokens:v=>integer(v,1,1000000)})) fail('multimodel_invalid');
  return Object.freeze({...v});
}
function parseQuorum(v, membersLen){
  if(!matchesFields(v,{minSuccess:v=>integer(v,1,Math.max(1,membersLen)),graceMs:v=>integer(v,0,10000),deadlineMs:v=>integer(v,1000,300000)})) fail('multimodel_invalid');
  return Object.freeze({...v});
}
function parsePanelMember(v){
  if(!matchesFields(v,{id,role:r=>ROLES.includes(r),modelId:s=>text(s,200),connectionId:s=>text(s,200),task:s=>text(s,8000),allowedCapabilityIds:a=>array(a,name,32)&&unique(a),contextRefs:a=>array(a,id,64)&&unique(a),outputSchemaRef:nullable(s=>text(s,200))},['outputSchemaRef'])) fail('multimodel_invalid');
  if(v.outputSchemaRef===undefined) v={...v,outputSchemaRef:null};
  return Object.freeze({...v, allowedCapabilityIds:[...v.allowedCapabilityIds], contextRefs:[...v.contextRefs]});
}

export function parseMultiModelPlan(input){
  if(!isDataRecord(input)) fail();
  const required=['schemaVersion','id','createdAt','projectId','principalId','revision','mode','principalModel','members','limits','quorum','contextSnapshotId','digest'];
  const optional=['analystModel','finalModel'];
  for(const k of required) if(!Object.hasOwn(input,k)) fail();
  for(const k of Object.keys(input)) if(![...required,...optional].includes(k)) fail();
  if(input.schemaVersion!==MULTIMODEL_SCHEMA_VERSION) fail();
  if(!id(input.id)) fail();
  if(!date(input.createdAt)) fail();
  if(!id(input.projectId)) fail();
  if(!id(input.principalId)) fail();
  if(!integer(input.revision,1,Number.MAX_SAFE_INTEGER)) fail();
  if(!MODES.includes(input.mode)) fail();
  if(!text(input.principalModel,200)) fail();
  if(!array(input.members, parsePanelMember,8,1) || !unique(input.members, m=>m.id)) fail();
  // analystModel / finalModel
  let analyst=null, finall=null;
  if(Object.hasOwn(input,'analystModel')){
    if(input.analystModel!==null && !text(input.analystModel,200)) fail();
    analyst=input.analystModel??null;
  }
  if(Object.hasOwn(input,'finalModel')){
    if(input.finalModel!==null && !text(input.finalModel,200)) fail();
    finall=input.finalModel??null;
  }
  // fusion requires at least 2 members to claim consensus; still parseable but planner will enforce
  const limits=parseLimits(input.limits);
  const quorum=parseQuorum(input.quorum, input.members.length);
  if(!id(input.contextSnapshotId)) fail();
  if(!hash(input.digest)) fail();
  // depth / cycle basic: if members contain analyst role + analystModel conflict, still allowed at parse; execution denies self-evaluation
  // destination validation is done in planner (allowedCapabilityIds non-empty for workers, empty allowed for advisor?)
  if(input.mode==='fusion' && analyst===null) fail('multimodel_invalid');
  if(input.mode!=='fusion' && input.mode!=='compare' && analyst!==null && analyst!==undefined) {
    // advisor/subagents may optionally have analyst; keep
  }
  return Object.freeze({
    schemaVersion:1,id:input.id,createdAt:input.createdAt,projectId:input.projectId,principalId:input.principalId,revision:input.revision,
    mode:input.mode,principalModel:input.principalModel,members:Object.freeze(input.members.map(parsePanelMember)),
    analystModel:analyst,finalModel:finall,limits,quorum,contextSnapshotId:input.contextSnapshotId,digest:input.digest
  });
}

export function canonicalMultiModelPlanPayload(value){
  const {digest:_, ...payload}=parseMultiModelPlan(value);
  return canonicalJson(payload);
}

export function parsePanelResult(input){
  if(!matchesFields(input,{memberId:id,runId:id,attemptIds:a=>array(a,id,8),status:s=>BRANCH_STATUSES.includes(s),actualModel:s=>text(s,200),artifactRefs:a=>array(a,id,16)&&unique(a),
    usage:nullable(u=>matchesFields(u,{basis:r=>['provider_reported','estimated','unknown'].includes(r),inputTokens:nullable(v=>integer(v,0,10000000)),outputTokens:nullable(v=>integer(v,0,10000000))}) &&
      (u.basis==='unknown' ? u.inputTokens===null&&u.outputTokens===null : (u.inputTokens!==null||u.outputTokens!==null))),
    cost:nullable(c=>matchesFields(c,{micros:decimal})),
    startedAt:nullable(date),completedAt:nullable(date),errorCode:nullable(name),responseHash:nullable(hash)},['errorCode','responseHash'])) fail();
  if(input.errorCode===undefined) input={...input,errorCode:null};
  if(input.responseHash===undefined) input={...input,responseHash:null};
  if(input.status==='succeeded' && input.errorCode!==null) fail();
  if(input.usage!==null && input.usage.basis==='unknown' && (input.usage.inputTokens!==null||input.usage.outputTokens!==null)) fail();
  if(['succeeded','failed','unknown'].includes(input.status) && input.completedAt===null) fail();
  if(!['succeeded','failed','unknown'].includes(input.status) && input.completedAt!==null) {
    // running/pending/cancelled may have null completedAt
  }
  return Object.freeze({...input, attemptIds:[...input.attemptIds], artifactRefs:[...input.artifactRefs],
    usage: input.usage===null?null:{...input.usage}, cost: input.cost===null?null:{...input.cost}});
}

export function parseSynthesisResult(input){
  if(!isDataRecord(input)) fail();
  const req=['agreement','contradictions','coverageGaps','uniqueInsights','blindSpots','sourceResultIds'];
  const opt=['finalArtifactRef'];
  for(const k of req) if(!Object.hasOwn(input,k)) fail();
  for(const k of Object.keys(input)) if(![...req,...opt].includes(k)) fail();
  if(!array(input.agreement, s=>text(s,4000,true),32)) fail();
  if(!array(input.contradictions, s=>text(s,4000,true),32)) fail();
  if(!array(input.coverageGaps, s=>text(s,4000,true),32)) fail();
  if(!array(input.uniqueInsights, s=>text(s,4000,true),32)) fail();
  if(!array(input.blindSpots, s=>text(s,4000,true),32)) fail();
  if(!array(input.sourceResultIds, id,32)) fail();
  if(Object.hasOwn(input,'finalArtifactRef') && input.finalArtifactRef!==null && !id(input.finalArtifactRef)) fail();
  return Object.freeze({
    agreement:[...input.agreement],contradictions:[...input.contradictions],coverageGaps:[...input.coverageGaps],
    uniqueInsights:[...input.uniqueInsights],blindSpots:[...input.blindSpots],sourceResultIds:[...input.sourceResultIds],
    finalArtifactRef: input.finalArtifactRef??null
  });
}

export function parseMultimodelRun(input){
  if(!isDataRecord(input)) fail();
  const req=['schemaVersion','id','projectId','principalId','planId','planDigest','status','branches','synthesis','createdAt','updatedAt','revision'];
  const opt=['finishedAt'];
  for(const k of req) if(!Object.hasOwn(input,k)) fail();
  for(const k of Object.keys(input)) if(![...req,...opt].includes(k)) fail();
  if(input.schemaVersion!==1) fail();
  if(!id(input.id)) fail();
  if(!id(input.projectId)) fail();
  if(!id(input.principalId)) fail();
  if(!id(input.planId)) fail();
  if(!hash(input.planDigest)) fail();
  if(!RUN_STATUSES.includes(input.status)) fail();
  if(!array(input.branches, parsePanelResult,8)) fail();
  if(!unique(input.branches, b=>b.memberId)) fail();
  if(input.synthesis!==null) parseSynthesisResult(input.synthesis);
  if(!date(input.createdAt)) fail();
  if(!date(input.updatedAt)) fail();
  if(!integer(input.revision,1,Number.MAX_SAFE_INTEGER)) fail();
  if(Object.hasOwn(input,'finishedAt') && input.finishedAt!==null && !date(input.finishedAt)) fail();
  if(['succeeded','failed','cancelled'].includes(input.status) && (input.finishedAt===undefined || input.finishedAt===null)) fail();
  if(!['succeeded','failed','cancelled'].includes(input.status) && input.finishedAt) {
    // partial etc may be null
  }
  return Object.freeze({...input, branches:input.branches.map(parsePanelResult), synthesis: input.synthesis?parseSynthesisResult(input.synthesis):null, finishedAt: input.finishedAt??null});
}

export function parseCreateMultimodelPlanCommand(input){
  if(!isDataRecord(input)) fail();
  const req=['expectedRevision','mode','principalModel','members','limits','quorum','contextSnapshotId'];
  const opt=['analystModel','finalModel','objective'];
  for(const k of req) if(!Object.hasOwn(input,k)) fail();
  for(const k of Object.keys(input)) if(![...req,...opt].includes(k)) fail();
  if(!integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER)) fail();
  if(!MODES.includes(input.mode)) fail();
  if(!text(input.principalModel,200)) fail();
  if(!array(input.members, v=> {
    if(!isDataRecord(v)) return false;
    // allow simplified creation: need role, modelId, task; id auto
    const has = ['role','modelId','task'].every(k=>Object.hasOwn(v,k));
    if(!has) return false;
    if(!ROLES.includes(v.role)) return false;
    if(!text(v.modelId,200)) return false;
    if(!text(v.task,8000)) return false;
    if(Object.hasOwn(v,'connectionId') && !text(v.connectionId,200)) return false;
    if(Object.hasOwn(v,'allowedCapabilityIds') && !(array(v.allowedCapabilityIds,name,32))) return false;
    if(Object.hasOwn(v,'contextRefs') && !(array(v.contextRefs,id,64))) return false;
    return true;
  },8,1)) fail();
  if(Object.hasOwn(input,'analystModel') && input.analystModel!==null && !text(input.analystModel,200)) fail();
  if(Object.hasOwn(input,'finalModel') && input.finalModel!==null && !text(input.finalModel,200)) fail();
  if(!matchesFields(input.limits,{maxMembers:v=>integer(v,1,8),maxConcurrency:v=>integer(v,1,4),maxDepth:v=>integer(v,0,2),maxCalls:v=>integer(v,1,24),maxElapsedMs:v=>integer(v,1000,300000),maxCostMicros:decimal,maxTokens:v=>integer(v,1,1000000)})) fail();
  if(!matchesFields(input.quorum,{minSuccess:v=>integer(v,1,Math.max(1,input.members.length)),graceMs:v=>integer(v,0,10000),deadlineMs:v=>integer(v,1000,300000)})) fail();
  if(!id(input.contextSnapshotId)) fail();
  if(Object.hasOwn(input,'objective') && input.objective!==undefined && input.objective!==null && !text(input.objective,8000,true)) fail();
  return Object.freeze({
    expectedRevision:input.expectedRevision,mode:input.mode,principalModel:input.principalModel,
    members:input.members.map(m=>Object.freeze({...m, connectionId:m.connectionId??'local', allowedCapabilityIds:m.allowedCapabilityIds??[], contextRefs:m.contextRefs??[], outputSchemaRef:m.outputSchemaRef??null})),
    analystModel:input.analystModel??null,finalModel:input.finalModel??null,limits:{...input.limits},quorum:{...input.quorum},
    contextSnapshotId:input.contextSnapshotId,objective: input.objective??null
  });
}

// helpers for error codes
export const MULTIMODEL_ERRORS = {
  invalid:'multimodel_invalid',
  budget_exceeded:'panel_budget_exceeded',
  cycle:'dependency_cycle',
  destination_denied:'destination_denied',
  quorum_unmet:'quorum_unmet',
  member_failed:'panel_member_failed',
  judge_failed:'judge_failed',
  uncertain:'panel_outcome_uncertain',
  revision_conflict:'plan_revision_conflict',
  unsupported:'unsupported_remote_panel'
};
