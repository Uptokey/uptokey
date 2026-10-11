import {createHash,randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {canonicalContextSnapshotPayload,parseRecipe,parseExecutionPlan,validatePlanBindings,type Recipe,type RecipeParameter,type RecipeBinding} from '@uptokey/sync-contract/workflow';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {WorkspaceError} from './runtime.ts';
import {assertNoForbiddenContent,inputShape,instantiateRecipe,buildRecipeProvenance,recipeLineageId,recipeRevocationRecordId,summarizeRecipeAuthorization,compareRecipeAuthorization,verifyRecipeSignature,signRecipePackage,computePublicKeyFingerprint,type RecipeProvenance,type RecipeAuthorSignature} from './recipes.ts';
import {computePlanDigest} from './planner.ts';
import type {WorkspaceRuntime} from './runtime.ts';

const fail=(code:string,status=400)=>Object.assign(new Error(code),{code,status});
/** Arguments prepared by the core itself (conversation, wire request, protocol): never recipient input. */
const CORE_PREPARED_ARGUMENTS=new Set(['chat','wire','messages','protocol','adaptation','provenance','response_style']);
/** Parameters that name an artifact must point to the recipient's own artifacts (local binding). */
export const isArtifactReference=(name:string)=>/artifact_?id$/i.test(name)||/artifactid$/i.test(name);
const parameterFailure=(error:unknown)=>{
 const message=error instanceof Error?error.message:'';
 const match=/^(missing_required_parameter|invalid_parameter_type|invalid_parameter_structure|invalid_parameter_control_characters|parameter_too_short):(.+)$/.exec(message);
 return match?new WorkspaceError('recipe_parameters_invalid',400,{reason:match[1],field:match[2]!.replace(/_expected_[a-z]+$/,'')}):undefined;
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeDefinition(input:unknown):Recipe{
 let encoded:string|undefined;try{encoded=JSON.stringify(input);}catch{throw fail('recipe_package_invalid');}
 if(!encoded)throw fail('recipe_package_invalid');
 if(Buffer.byteLength(encoded,'utf8')>28_000)throw fail('recipe_package_too_large');
 // Version gate with an actionable error: the wire contract only admits schemaVersion 1.
 // A future/anterior package is not "invalid JSON"; it needs an explicit upgrade path.
 if(isDataRecord(input)&&input.schemaVersion!==undefined&&input.schemaVersion!==1)throw fail('recipe_version_unsupported',422);
 let recipe:Recipe;
 try{recipe=parseRecipe(input);assertNoForbiddenContent(recipe);}
 catch(error){
  if(error&&typeof error==='object'&&'code' in error&&typeof (error as {code:unknown}).code==='string')throw error;
  const message=error instanceof Error?error.message:'';
  if(message.includes('forbidden_secret_solicitation_detected'))throw fail('recipe_secret_solicitation');
  if(message.includes('forbidden_unsafe_link_detected'))throw fail('recipe_unsafe_link');
  if(message.includes('forbidden_recipe_'))throw fail('recipe_content_blocked');
  throw fail('recipe_package_invalid');
 }
 // Imported data is inert, but reject common accidentally copied private data
 // before it is made durable or offered for publication. Canaries are synthetic
 // tripwires: any package carrying one is rejected here, never stored.
 if(/(?:uptokey|utk)[_-]canary[_-][A-Za-z0-9_-]{8,}/i.test(JSON.stringify(recipe)))throw fail('recipe_private_data_detected');
 if(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[A-Za-z]:[\\/]|\/(?:Users|home|etc|var|tmp)\/)|(?:root|session|client|grant)_[A-Za-z0-9_-]{6,}/i.test(JSON.stringify(recipe)))throw fail('recipe_private_data_detected');
 return recipe;
}
function dependencies(runtime:WorkspaceRuntime,recipe:Recipe){
 return [...new Set(recipe.steps.map(step=>`${step.capabilityId}@${step.capabilityVersion}`))].map(key=>{
  const step=recipe.steps.find(step=>`${step.capabilityId}@${step.capabilityVersion}`===key)!,cap=runtime.registry().get(step.capabilityId,step.capabilityVersion);
  return {id:step.capabilityId,version:step.capabilityVersion,available:cap?.availability==='executable',effect:cap?.effect??null,destination:cap?.dataDestination??null,requiredScopes:cap?.requiredScopes??[],reason:cap?cap.availability:'missing_capability'};
 });
}
function preview(runtime:WorkspaceRuntime,recipe:Recipe){return {recipe,digest:hash(recipe),dependencies:dependencies(runtime,recipe),authorization:summarizeRecipeAuthorization(recipe,runtime.registry()),provenance:buildRecipeProvenance(recipe),importMode:'draft_only' as const,executionRequiresApproval:true as const};}
function fields(input:unknown,expected:string):Record<string,unknown>{if(!isDataRecord(input)||Object.keys(input).sort().join(',')!==expected)throw fail('recipe_request_invalid');return input;}
function fieldsOptional(input:unknown,required:string,optional:string):Record<string,unknown>{
 if(!isDataRecord(input))throw fail('recipe_request_invalid');
 const requiredKeys=new Set(required.split(',')),allowed=new Set([...required.split(','),...optional.split(',')]);
 if([...requiredKeys].some(key=>!Object.hasOwn(input,key))||Object.keys(input).some(key=>!allowed.has(key)))throw fail('recipe_request_invalid');
 return input;
}
interface AuthorEnvelope{keyId:string;publicKeyPem:string;signature:string;}
function parseAuthor(input:unknown):AuthorEnvelope|undefined{
 if(input===undefined)return undefined;
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='keyId,publicKeyPem,signature')throw fail('recipe_request_invalid');
 if(typeof input.keyId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.keyId))throw fail('recipe_request_invalid');
 if(typeof input.publicKeyPem!=='string'||!/^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(input.publicKeyPem.trim()))throw fail('recipe_request_invalid');
 if(typeof input.signature!=='string'||!/^[A-Za-z0-9_-]{43,86}$/.test(input.signature))throw fail('recipe_request_invalid');
 return {keyId:input.keyId,publicKeyPem:input.publicKeyPem.trim(),signature:input.signature};
}
function verifyAuthor(recipe:Recipe,author:AuthorEnvelope|undefined,provenance:RecipeProvenance){
 if(!author)return;
 if(!verifyRecipeSignature(recipe,author.publicKeyPem,{alg:'ed25519',keyId:author.keyId,signature:author.signature}))throw fail('recipe_signature_invalid',409);
 // Key possession proves package integrity, never a human identity or a
 // content review; provenance records the verified technical key id only.
 provenance.signatureKeyId=author.keyId;
 provenance.signatureFingerprint=computePublicKeyFingerprint(author.publicKeyPem);
 provenance.signatureVerified=true;
}
async function revokedVersion(runtime:WorkspaceRuntime,principal:string,projectId:string,recipeId:string):Promise<number>{
 const recordId=recipeRevocationRecordId(recipeId);
 const rows=await runtime.store.listRecipes(principal,projectId);
 return rows.reduce((max,item)=>item.id===recordId?Math.max(max,item.version):max,0);
}
/** Shared admission check for any route that turns a stored recipe into a plan.
 * Revocation records themselves and versions at or below the durable tombstone
 * are rejected before planning. Consumed by this exchange and by the
 * recipes/:id/plan route (see the owner-01 patch for workspace/http.ts). */
export async function assertRecipeSelectable(runtime:WorkspaceRuntime,principal:string,projectId:string,recipe:Recipe){
 if(recipe.id.startsWith('revoke_'))throw fail('recipe_missing',404);
 if(await revokedVersion(runtime,principal,projectId,recipe.id)>=recipe.version)throw fail('recipe_revoked',409);
}
async function selected(runtime:WorkspaceRuntime,principal:string,projectId:string,input:Record<string,unknown>){
 if(typeof input.recipeId!=='string'||!Number.isSafeInteger(input.recipeVersion))throw fail('recipe_request_invalid');
 const recipe=(await runtime.store.listRecipes(principal,projectId)).find(recipe=>recipe.id===input.recipeId&&recipe.version===input.recipeVersion);if(!recipe)throw fail('recipe_missing',404);
 // Durable revocation: versions at or below the recorded tombstone cannot be
 // prepared or exported. Recovering requires importing a newer reviewed version.
 await assertRecipeSelectable(runtime,principal,projectId,recipe);
 return recipe;
}
function recipeEqual(a:Recipe,b:Recipe){return canonicalJson(a)===canonicalJson(b);}

/** Import/export are local metadata operations. Preparation uses the same W5
 * registry, snapshot, planner, store, consent and run route as every other plan.
 * Imported packages form a versioned lineage keyed by the declared package id:
 * importing a newer version of an existing lineage is an update, and an update
 * that amplifies destinations, permissions or effects requires a new explicit
 * review instead of inheriting the previous authorization. Revocation records
 * are durable per version and are enforced before preparation and export. */
export async function handleRecipeExchange(runtime:WorkspaceRuntime,principal:string,projectId:string,action:string,input:unknown){
 await runtime.store.getProject(principal,projectId);
 if(action==='preview')return preview(runtime,safeDefinition(fields(input,'recipe').recipe));
 if(action==='import'){
  const body=fieldsOptional(input,'recipe,reviewedDigest','author'),recipe=safeDefinition(body.recipe);
  if(body.reviewedDigest!==hash(recipe))throw fail('recipe_review_changed',409);
  const provenance=buildRecipeProvenance(recipe);verifyAuthor(recipe,parseAuthor(body.author),provenance);
  const lineageId=recipeLineageId(recipe.id);
  const existing=(await runtime.store.listRecipes(principal,projectId)).filter(item=>item.id===lineageId);
  if(await revokedVersion(runtime,principal,projectId,lineageId)>=recipe.version)throw fail('recipe_revoked',409);
  const imported=parseRecipe({...recipe,id:lineageId});
  const sameVersion=existing.find(item=>item.version===imported.version);
  if(sameVersion){
   if(!recipeEqual(sameVersion,imported))throw fail('recipe_version_conflict',409);
   return {...preview(runtime,sameVersion),saved:true,provenance,scopeDiff:null};
  }
  const latest=existing.reduce<Recipe|null>((max,item)=>max===null||item.version>max.version?item:max,null);
  const scopeDiff=latest?compareRecipeAuthorization(summarizeRecipeAuthorization(latest,runtime.registry()),summarizeRecipeAuthorization(imported,runtime.registry())):null;
  await runtime.store.putRecipe(principal,projectId,imported);
  return {...preview(runtime,imported),saved:true,provenance,scopeDiff,...(scopeDiff?.escalates?{authorizationEscalated:true,reasons:scopeDiff.reasons}:{authorizationInherited:latest!==null})};
 }
 if(action==='update'){
  const body=fieldsOptional(input,'recipe,reviewedDigest','author,escalationApproved'),recipe=safeDefinition(body.recipe);
  if(body.reviewedDigest!==hash(recipe))throw fail('recipe_review_changed',409);
  if(body.escalationApproved!==undefined&&typeof body.escalationApproved!=='boolean')throw fail('recipe_request_invalid');
  const provenance=buildRecipeProvenance(recipe);verifyAuthor(recipe,parseAuthor(body.author),provenance);
  const lineageId=recipeLineageId(recipe.id);
  const rows=(await runtime.store.listRecipes(principal,projectId)).filter(item=>item.id===lineageId);
  if(!rows.length)throw fail('recipe_missing',404);
  if(await revokedVersion(runtime,principal,projectId,lineageId)>=recipe.version)throw fail('recipe_revoked',409);
  const maxVersion=Math.max(...rows.map(item=>item.version));
  if(recipe.version<maxVersion)throw fail('recipe_update_version_conflict',409);
  const projected=parseRecipe({...recipe,id:lineageId});
  if(recipe.version===maxVersion){
   const current=rows.find(item=>item.version===recipe.version)!;
   if(recipeEqual(current,projected))return {...preview(runtime,current),saved:false,unchanged:true,scopeDiff:null};
   throw fail('recipe_update_version_conflict',409);
  }
  const current=rows.find(item=>item.version===maxVersion)!;
  const diff=compareRecipeAuthorization(summarizeRecipeAuthorization(current,runtime.registry()),summarizeRecipeAuthorization(projected,runtime.registry()));
  // An update that amplifies destinations, permissions, effects or capabilities
  // never inherits the previous authorization: nothing is stored until the
  // caller reviews the expanded diff and acknowledges it explicitly. Execution
  // remains gated by W5 plan approval regardless of this local review.
  if(diff.escalates&&body.escalationApproved!==true)return {...preview(runtime,projected),saved:false,requiresAuthorization:true,scopeDiff:diff,reasons:diff.reasons};
  await runtime.store.putRecipe(principal,projectId,projected);
  return {...preview(runtime,projected),saved:true,provenance,authorizationInherited:!diff.escalates,...(diff.escalates?{authorizationEscalated:true}:{}),scopeDiff:diff,reasons:diff.reasons};
 }
 if(action==='revoke'){
  const body=fields(input,'recipeId,recipeVersion');
  const recipeId=body.recipeId,recipeVersionRaw=body.recipeVersion;
  if(typeof recipeId!=='string'||!recipeId||recipeId.startsWith('revoke_')||typeof recipeVersionRaw!=='number'||!Number.isSafeInteger(recipeVersionRaw)||recipeVersionRaw<1)throw fail('recipe_request_invalid');
  const recipeVersion:number=recipeVersionRaw;
  const rows=(await runtime.store.listRecipes(principal,projectId)).filter(item=>item.id===recipeId);
  if(!rows.some(item=>item.version===recipeVersion))throw fail('recipe_missing',404);
  const recordId=recipeRevocationRecordId(recipeId);
  if(await revokedVersion(runtime,principal,projectId,recipeId)>=recipeVersion)return {recipeId,recipeVersion,revoked:true,tombstoneId:recordId};
  // The tombstone is a recipe-shaped durable record: its version marks every
  // version at or below it as revoked. It is never executable (capability is
  // unavailable) and is rejected as a selection target before preparation.
  const tombstone=parseRecipe({schemaVersion:1,id:recordId,createdAt:new Date().toISOString(),version:recipeVersion,
   title:'Revoked recipe',description:`Local revocation record for ${recipeId}. Versions up to ${recipeVersion} remain revoked; import a newer reviewed version to replace it. This record is not executable.`,
   parameters:[],steps:[{id:'revoked',capabilityId:'sources.archive.search',capabilityVersion:1,arguments:{}}],
   limits:{maxSteps:1,maxCalls:1,maxOutputTokens:1,timeoutMs:1000,maxOutputBytes:1},expectedOutputs:[]});
  await runtime.store.putRecipe(principal,projectId,tombstone);
  return {recipeId,recipeVersion,revoked:true,tombstoneId:recordId};
 }
 if(action==='export'){
  const body=fieldsOptional(input,'description,recipeId,recipeVersion,title','signingKeyId,signingPrivateKeyPem'),source=await selected(runtime,principal,projectId,body);
  if(typeof body.title!=='string'||!body.title.trim()||typeof body.description!=='string'||!body.description.trim())throw fail('recipe_request_invalid');
  const parameters:RecipeParameter[]=[],stepIds=new Map(source.steps.map((step,index)=>[step.id,`step_${index+1}`])),names=new Map<string,string>();
  const steps=source.steps.map((step,index)=>({...step,id:stepIds.get(step.id)!,arguments:Object.fromEntries(Object.entries(step.arguments).map(([name,binding]):[string,RecipeBinding]=>{
   if(binding.kind==='step_output')return [name,{...binding,stepId:stepIds.get(binding.stepId)!}];
   if(binding.kind==='parameter'){
    let renamed=names.get(binding.parameter);if(!renamed){renamed=`input_${names.size+1}`;names.set(binding.parameter,renamed);const {defaults,...original}=source.parameters.find(item=>item.name===binding.parameter)!;
     // Defaults are the author's reviewed values: they never travel. The recipient fills the whole shape.
     const fixedShape=defaults?inputShape(defaults):null;
     parameters.push(fixedShape&&fixedShape.type==='object'&&original.schema?.type==='object'?{...original,name:renamed,schema:{type:'object',properties:{...fixedShape.properties,...original.schema.properties},required:[...new Set([...(fixedShape.required??[]),...(original.schema.required??[])])]}}:{...original,name:renamed});}return [name,{kind:'parameter',parameter:renamed}];
   }
   const type=typeof binding.value==='string'?'string':typeof binding.value==='boolean'?'boolean':Number.isSafeInteger(binding.value)?'integer':null;
   const parameter=`step${index+1}_${name}`;
   if(!type){
    // V7: a structured value travels only as its shape (field names and types, never the author's
    // values); the recipient fills it with their own data. Core-prepared requests never travel.
    if(CORE_PREPARED_ARGUMENTS.has(name))throw fail('recipe_step_not_reusable',422);
    const schema=inputShape(binding.value);
    if(!schema||(schema.type!=='object'&&schema.type!=='array'))throw fail('recipe_structured_input_requires_edit',422);
    parameters.push({name:parameter,type:'json',required:true,schema});return [name,{kind:'parameter',parameter}];
   }
   parameters.push({name:parameter,type,required:true});return [name,{kind:'parameter',parameter}];
  }))}));
  const {origin:_authorOrigin,...publishable}=source;void _authorOrigin;
  const recipe=safeDefinition({...publishable,id:`public_${randomUUID().replaceAll('-','')}`,createdAt:new Date().toISOString(),version:1,title:body.title.trim(),description:body.description.trim(),parameters,steps,expectedOutputs:source.expectedOutputs.map(id=>stepIds.get(id)??id)});
  let authorSignature:RecipeAuthorSignature|null=null;
  if(typeof body.signingPrivateKeyPem==='string'&&typeof body.signingKeyId==='string'){
   try{authorSignature=signRecipePackage(recipe,body.signingPrivateKeyPem,body.signingKeyId);}
   catch{throw fail('recipe_request_invalid');}
  }
  return {...preview(runtime,recipe),authorSignature,literalValuesRemoved:true};
 }
 if(action==='prepare'){
  const body=fields(input,'expectedRevision,parameters,recipeId,recipeVersion'),recipe=await selected(runtime,principal,projectId,body);
  if(!isDataRecord(body.parameters)||Object.keys(body.parameters).some(name=>!recipe.parameters.some(parameter=>parameter.name===name)))throw fail('recipe_parameters_invalid');
  const bundle=await runtime.store.getBundle(principal,projectId);if(body.expectedRevision!==bundle.project.revision)throw fail('workspace_revision_conflict',409);
  if(bundle.runs.some(item=>['running','needs_attention','ready','awaiting_approval'].includes(item.run.status)))throw fail('project_run_active',409);
  const registry=runtime.registry(),scopes=[...new Set(recipe.steps.flatMap(step=>registry.get(step.capabilityId,step.capabilityVersion)?.requiredScopes??[]))];
  // V7: a dependency the recipient does not have is named, before any plan, so the UI can route
  // to its configuration and keep the entered inputs. It is not a server outage.
  for(const step of recipe.steps){
   const capability=registry.get(step.capabilityId,step.capabilityVersion);
   if(!capability||capability.availability!=='executable')throw new WorkspaceError('recipe_capability_unavailable',409,{capabilityId:step.capabilityId,capabilityVersion:step.capabilityVersion,reason:capability?capability.availability:'not_installed'});
   registry.assertExecutable(step.capabilityId,step.capabilityVersion,scopes);
  }
  const destinations=recipe.steps.map(step=>registry.get(step.capabilityId,step.capabilityVersion)!.dataDestination).filter((item,index,rows)=>rows.findIndex(row=>row.id===item.id&&row.kind===item.kind)===index);
  const snapshot=await runtime.store.snapshotContext(principal,projectId,{selectedEntryIds:[],excludedEntryIds:bundle.project.entries.map(entry=>entry.id),selectedArtifactIds:[],allowedDestinations:destinations,maxContextBytes:32_000});
  // Local binding: artifact-reference inputs must name the recipient's own artifacts in this project.
  for(const parameter of recipe.parameters){
   const value=(body.parameters as Record<string,unknown>)[parameter.name];
   if(parameter.type==='string'&&isArtifactReference(parameter.name)&&typeof value==='string'&&!bundle.artifacts.some(item=>item.id===value))throw new WorkspaceError('recipe_parameters_invalid',400,{reason:'artifact_not_found',field:parameter.name});
  }
  let plan:ReturnType<typeof instantiateRecipe>;
  try{plan=instantiateRecipe(recipe,{projectId,projectRevision:bundle.project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),parameters:body.parameters as Record<string,unknown>,registry,grantedScopes:scopes});}
  catch(error){throw parameterFailure(error)??error;}
  plan={...plan,id:randomUUID()};plan=parseExecutionPlan({...plan,digest:computePlanDigest(plan)});validatePlanBindings(plan,snapshot,registry.forPlan(plan));
  await runtime.store.putPlan(principal,plan,snapshot);return runtime.viewPlan(principal,projectId,plan.id);
 }
 throw fail('recipe_exchange_not_found',404);
}
