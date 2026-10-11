import { isDataRecord } from './plain-data.js';
import { canonicalJson } from './canonical.js';
import { parseBrowserReadRequest } from './browser.js';
import { RUN_STATUSES, parseExecutionPlan } from './workflow.js';

export const COMPOSITION_CONTRACT_VERSION = 1;
const requestKeys = ['containsText','next','requestId','schemaVersion','sourceRunId'];
const specKeys = [...requestKeys,'id','createdAt','projectId','principalId'].sort();
const invalid = () => { throw new Error('composition_invalid'); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

/** A local condition on a selected run's artifact. It proposes a new plan, never authorizes an effect. */
export function parseCompositionRequest(input) {
  if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== requestKeys.join(',') ||
      input.schemaVersion !== COMPOSITION_CONTRACT_VERSION || !identifier(input.requestId) || !identifier(input.sourceRunId) ||
      typeof input.containsText !== 'string' || !input.containsText.trim() || input.containsText.length > 200 || input.containsText.includes('\0')) invalid();
  let next; try { next = parseBrowserReadRequest(input.next); } catch { invalid(); }
  return Object.freeze({schemaVersion:1,requestId:input.requestId,sourceRunId:input.sourceRunId,containsText:input.containsText,next});
}
export function parseCompositionSpec(input) {
  if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== specKeys.join(',') ||
      !identifier(input.id) || !identifier(input.projectId) || !identifier(input.principalId) ||
      typeof input.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt)) invalid();
  const time = Date.parse(input.createdAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== input.createdAt) invalid();
  const request = parseCompositionRequest(Object.fromEntries(requestKeys.map(key => [key,input[key]])));
  return Object.freeze({...request,id:input.id,createdAt:input.createdAt,projectId:input.projectId,principalId:input.principalId});
}
export function canonicalCompositionRequest(input) { return canonicalJson(parseCompositionRequest(input)); }

export function parseCompositionGraphSnapshot(value) {
  if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='compositionId,interrupted,observedStatus,status'||
      !identifier(value.compositionId)||typeof value.interrupted!=='boolean'||
      !['review_required','proposal_ready','complete','stopped'].includes(value.status)||
      !(value.observedStatus===null||RUN_STATUSES.includes(value.observedStatus))||
      (['proposal_ready','complete'].includes(value.status)&&value.observedStatus!=='succeeded')||
      (value.interrupted&&value.status!=='review_required'))invalid();
  return Object.freeze({...value});
}
export function parseCompositionResult(input) {
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='plan,spec,state')invalid();
  const spec=parseCompositionSpec(input.spec);
  let state=null,plan=null;
  if(input.state!==null){
    state=parseCompositionGraphSnapshot(input.state);
    if(state.compositionId!==spec.id)invalid();
  }
  if(input.plan!==null){
    plan=parseExecutionPlan(input.plan);
    const step=plan.steps[0];
    if(!state||state.status!=='proposal_ready'||state.interrupted||plan.projectId!==spec.projectId||
        plan.steps.length!==1||step.capabilityId!=='browser.page.inspect'||step.capabilityVersion!==1||
        step.arguments.request?.kind!=='literal'||canonicalJson(parseBrowserReadRequest(step.arguments.request.value))!==canonicalJson(spec.next))invalid();
  }
  return Object.freeze({spec,state,plan});
}
