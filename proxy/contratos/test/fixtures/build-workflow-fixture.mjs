/** Reproducible synthetic data, no network/provider calls. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonicalContextSnapshotPayload, canonicalPlanPayload } from '../../workflow.js';
const sha = s => createHash('sha256').update(s).digest('hex');
const t = '2026-09-16T12:00:00.000Z', end = '2026-09-16T12:00:10.000Z';
const base = id => ({schemaVersion:1,id,createdAt:t});
const limits = {maxSteps:12,maxCalls:12,maxOutputTokens:4096,timeoutMs:120000,maxOutputBytes:1048576};
const unknownUsage = {basis:'unknown',inputTokens:null,outputTokens:null,cachedInputTokens:null};
const destinations = [{kind:'public_source',id:'crossref'},{kind:'public_source',id:'open-library'},
  {kind:'provider',id:'configured-provider'},{kind:'local',id:'project-store'}];
const specs = [
  ['sources.crossref.search', 'read_external', destinations[0], 'read_only'],
  ['sources.open-library.search', 'read_external', destinations[1], 'read_only'],
  ['inference.report', 'inference', destinations[2], 'never_automatic'],
  ['artifacts.markdown.create', 'produce_artifact', destinations[3], 'idempotent_local'],
];
const capabilities = specs.map(([id,effect,dataDestination,retryClass])=>({
  ...base(id),version:1,titleKey:`workflow.${id}.title`,descriptionKey:`workflow.${id}.description`,tags:['research'],
  inputSchemaId:`${id}.input.v1`,outputSchemaId:`${id}.output.v1`,effect,dataDestination,
  availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass,limits,
}));
const project = {...base('project_demo'),ownerPrincipalId:'principal_demo',revision:1,name:'Research demo',
  goal:'Create a sourced report',constraints:['Use selected public sources only'],entries:[
    {id:'entry_goal',kind:'decision',origin:'user',content:'Produce a short Markdown report.',sourceRefs:[],status:'confirmed',createdAt:t,supersedes:null},
  ],sources:[],artifactRefs:[],updatedAt:t};
const snapshot = {...base('snapshot_demo'),projectId:project.id,projectRevision:1,
  entries:[{id:'entry_goal',sha256:sha(project.entries[0].content)}],artifacts:[],sourceRefs:[],
  allowedDestinations:destinations,maxContextBytes:64000,excludedEntryIds:[]};
const literal = value=>({kind:'literal',value});
const output = (stepId,name)=>({kind:'step_output',stepId,output:name});
const steps = [
  {id:'search_papers',capabilityId:specs[0][0],capabilityVersion:1,arguments:{query:literal('open knowledge')}},
  {id:'search_books',capabilityId:specs[1][0],capabilityVersion:1,arguments:{query:literal('open knowledge')}},
  {id:'write_report',capabilityId:specs[2][0],capabilityVersion:1,arguments:{papers:output('search_papers','records'),books:output('search_books','records')}},
  {id:'save_report',capabilityId:specs[3][0],capabilityVersion:1,arguments:{content:output('write_report','text')}},
];
const plan = {...base('plan_demo'),projectId:project.id,projectRevision:1,contextSnapshotId:snapshot.id,
  contextSnapshotDigest:sha(canonicalContextSnapshotPayload(snapshot)),steps,limits,digest:'0'.repeat(64)};
plan.digest=sha(canonicalPlanPayload(plan));
const grant = {...base('grant_demo'),principalId:'principal_demo',projectId:project.id,revision:1,
  scopes:['project:read','project:write','plan:create','run:execute','run:cancel','artifact:read','recipe:write'],
  capabilityIds:capabilities.map(c=>c.id),destinations,limits,expiresAt:'2026-09-17T12:00:00.000Z',revokedAt:null};
const run = {...base('run_demo'),projectId:project.id,principalId:'principal_demo',planId:plan.id,planDigest:plan.digest,
  policyRevision:1,requestId:'request_demo',status:'succeeded',stepStates:steps.map(s=>({stepId:s.id,status:'succeeded',attemptIds:[`attempt_${s.id}`],receiptIds:[`receipt_${s.id}`]})),updatedAt:end,finishedAt:end};
const paper={id:'source_paper',sourceId:'crossref',externalId:'fixture-paper',title:'Synthetic research record',url:'https://example.org/paper',retrievedAt:t,receiptId:'receipt_search_papers'};
const book={id:'source_book',sourceId:'open-library',externalId:'fixture-book',title:'Synthetic book record',url:'https://example.org/book',retrievedAt:t,receiptId:'receipt_search_books'};
const receipts=steps.map(s=>({...base(`receipt_${s.id}`),projectId:project.id,runId:run.id,stepId:s.id,attemptId:`attempt_${s.id}`,
  capabilityId:s.capabilityId,capabilityVersion:1,status:'succeeded',startedAt:t,finishedAt:end,
  inputArtifactRefs:[],outputArtifactRefs:s.id==='save_report'?['artifact_report']:[],
  sources:s.id==='search_papers'?[paper]:s.id==='search_books'?[book]:[],errorCode:null,
  usage:s.id==='write_report'?{basis:'provider_reported',inputTokens:1000000,outputTokens:200000,cachedInputTokens:0}:unknownUsage}));
const content='# Synthetic report\n\nFixture content, not a model response.\n';
const artifact={...base('artifact_report'),projectId:project.id,runId:run.id,version:1,mediaType:'text/markdown',filename:'report.md',
  byteLength:Buffer.byteLength(content),sha256:sha(content),receiptRefs:receipts.map(r=>r.id),sourceRefs:[paper.id,book.id]};
const recipe={...base('recipe_demo'),version:1,title:'Repeat sourced research',description:'Synthetic example',parameters:[{name:'topic',type:'string',required:true}],
  steps:steps.map(s=>({...s,arguments:s.id.startsWith('search_')?{query:{kind:'parameter',parameter:'topic'}}:s.arguments})),limits,expectedOutputs:['report.markdown']};
const tariff={...base('tariff_demo'),version:1,provider:'configured-provider',model:'synthetic-model',accessMode:'byok',currency:'USD',unit:'million_tokens',
  inputMicrosPerMillion:'200000',outputMicrosPerMillion:'800000',cachedInputMicrosPerMillion:null,sourceUrl:'https://example.org/synthetic-prices',
  checkedAt:t,validFrom:t,validUntil:null,comparisonBasis:'same_service'};
const valueReceipt={...base('value_demo'),projectId:project.id,runId:run.id,stepId:'write_report',attemptId:'attempt_write_report',
  provider:'configured-provider',model:'synthetic-model',accessMode:'byok',cache:'none',usage:receipts[2].usage,tariffId:tariff.id,tariffVersion:1,
  referenceValue:{numeratorMicros:'360000000000',denominator:'1000000'},estimatedProviderCharge:null,
  confirmedUptokeyCharge:{numeratorMicros:'0',denominator:'1'},coverage:'included'};
const updatedProject={...project,revision:2,updatedAt:end,sources:[paper,book],artifactRefs:[artifact.id]};
const nextSnapshot={...snapshot,id:'snapshot_update',projectRevision:2,createdAt:end,artifacts:[{id:artifact.id,sha256:artifact.sha256}],sourceRefs:[paper.id,book.id]};
const updatePlan={...plan,id:'plan_update',projectRevision:2,createdAt:end,contextSnapshotId:nextSnapshot.id,
  contextSnapshotDigest:sha(canonicalContextSnapshotPayload(nextSnapshot)),digest:'0'.repeat(64)};
updatePlan.digest=sha(canonicalPlanPayload(updatePlan));
const fixture={notice:'Synthetic fixture only. No live calls or actual market prices.',capabilities,project,snapshot,plan,grant,run,receipts,artifact,artifactContent:content,recipe,tariff,valueReceipt,updatedProject,nextSnapshot,updatePlan};
await writeFile(new URL('./workflow.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n');
