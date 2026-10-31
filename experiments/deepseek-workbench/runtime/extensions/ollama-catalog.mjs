// Pure projection of local Ollama metadata; no inference or credential access.
export function projectOllamaCatalog(discovered, previous, details, loaded){
 if(!Array.isArray(discovered)||!Array.isArray(previous)||!Array.isArray(loaded)||!(details instanceof Map))throw Error('ollama_catalog_invalid');
 const seen=new Set(),models=[],capacities=[];
 const positive=value=>Number.isSafeInteger(value)&&value>0;
 for(const row of discovered){
  if(typeof row?.id!=='string'||!row.id||row.id.length>512||/[\x00-\x20\x7f]/.test(row.id))throw Error('ollama_model_invalid');
  if(seen.has(row.id))continue;
  seen.add(row.id);
  const info=details.get(row.id);
  if(!info||typeof info!=='object')throw Error('ollama_model_metadata_missing');
  // Embedding-only models cannot serve the native chat adapter.
  if(Array.isArray(info.capabilities)&&!info.capabilities.includes('completion'))continue;
  const old=previous.find(model=>model.id===row.id);
  const explicit=Number(String(info.parameters??'').match(/^num_ctx\s+(\d+)/m)?.[1]);
  const active=loaded.find(model=>model.name===row.id)?.context_length;
  const context=positive(active)?active:positive(explicit)?explicit:4096;
  const finetune=String(info.model_info?.['general.finetune']??'');
  const model={...old,id:row.id,name:old?.name||row.id,contextWindow:context,maxTokens:positive(old?.maxTokens)?old.maxTokens:Math.max(1,Math.min(2048,Math.floor(context/2))),input:info.capabilities?.includes('vision')?['text','image']:['text'],reasoningEfforts:/thinking/i.test(finetune)?{high:'high'}:/instruct/i.test(finetune)?false:info.capabilities?.includes('thinking')?{off:'none',high:'high'}:false};
  models.push(model);
  capacities.push({id:row.id,contextWindow:context,maxTokens:model.maxTokens,source:positive(active)?'running':positive(explicit)?'model-parameter':'conservative-default'});
 }
 return {models,capacities};
}
