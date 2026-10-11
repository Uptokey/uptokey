import type {Hono} from 'hono';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {assertProxyConfig} from './config.ts';
import type {ProxyConfig,ProviderName} from './types.ts';
import {candidatePricingEvidence,unitTariffEvidence} from './router.ts';

export function routingProjection(config:ProxyConfig){
 const fields={routingCombos:config.routingCombos??{},activeRoutingComboId:config.activeRoutingComboId??null,routingPolicy:config.routingPolicy??{},fallbackOrder:config.fallbackOrder};
 return {...structuredClone(fields),revisionDigest:createHash('sha256').update(canonicalJson(fields)).digest('hex')};
}
export interface RoutingHttpOptions{
 authorize(header:string|undefined,origin?:string):Promise<boolean>;
 read():ProxyConfig;
 persist(mutate:(next:ProxyConfig)=>void):Promise<ProxyConfig>;
 /** Current primary-account model scope; never carries credentials or changes routing policy. */
 resolveModels?(providerId:ProviderName,config:ProxyConfig):Promise<readonly string[]>;
}
/** Existing live Router configuration, with atomic optimistic concurrency and no credentials. */
export function registerRoutingRoutes(app:Hono,options:RoutingHttpOptions){
 app.get('/local/routing/costs',async c=>{
  if(!await options.authorize(c.req.header('authorization'),c.req.header('origin')))return c.json({error:{type:'unauthorized'}},401);
  const config=structuredClone(options.read());
  let models:unknown[];
  try{
   models=(await Promise.all(Object.entries(config.providers).filter(([,provider])=>provider?.enabled)
    .map(async([providerId,provider])=>{
     const declared=[...new Set([...provider!.models,...(provider!.defaultModel?[provider!.defaultModel]:[])])];
     const eligible=options.resolveModels?await options.resolveModels(providerId as ProviderName,config):provider!.configured?declared:[];
     return [...new Set(eligible)].filter(model=>declared.includes(model)).map(model=>({...candidatePricingEvidence(config,providerId as ProviderName,model),
      limits:{rpm:provider!.budget.rpm,tpm:provider!.budget.tpm,rpd:provider!.budget.rpd??null,tpd:provider!.budget.tpd??null,source:provider!.budget.source}}));
    }))).flat();
  }catch{return c.json({error:{type:'routing_unavailable'}},503);}
  // F1: per-unit media tariffs (image, second, character) are shown from the same snapshot that admits media executors.
  const pairs=[...new Map((config.tariffSnapshot??[]).filter(entry=>entry.unit!=='million_tokens'&&config.providers[entry.provider as ProviderName]).map(entry=>[`${entry.provider} ${entry.model}`,entry] as const)).values()];
  const unitTariffs=pairs.flatMap(entry=>unitTariffEvidence(config,entry.provider as ProviderName,entry.model).map(item=>({provider:entry.provider,model:entry.model,...item})));
  c.header('cache-control','no-store');return c.json({observedAt:new Date().toISOString(),models,unitTariffs});
 });
 app.get('/local/routing',async c=>{
  if(!await options.authorize(c.req.header('authorization'),c.req.header('origin')))return c.json({error:{type:'unauthorized'}},401);
  c.header('cache-control','no-store');return c.json(routingProjection(options.read()));
 });
 app.post('/local/routing',async c=>{
  if(!await options.authorize(c.req.header('authorization'),c.req.header('origin')))return c.json({error:{type:'unauthorized'}},401);
  try{
   const input:unknown=await c.req.json();
   if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='activeRoutingComboId,expectedDigest,fallbackOrder,routingCombos,routingPolicy'||typeof input.expectedDigest!=='string'||!isDataRecord(input.routingCombos))throw Error('routing_invalid');
   const next=await options.persist(config=>{
    if(input.expectedDigest!==routingProjection(config).revisionDigest)throw Error('revision_conflict');
    const combos=structuredClone(input.routingCombos) as NonNullable<ProxyConfig['routingCombos']>;
    for(const [id,combo] of Object.entries(combos)){
     if(!isDataRecord(combo))throw Error('routing_invalid');
     const previous=config.routingCombos?.[id];
     combo.revision=previous?(canonicalJson({...combo,revision:previous.revision})===canonicalJson(previous)?previous.revision:previous.revision+1):1;
    }
    config.routingCombos=combos;config.routingPolicy=structuredClone(input.routingPolicy) as ProxyConfig['routingPolicy'];config.fallbackOrder=structuredClone(input.fallbackOrder) as ProxyConfig['fallbackOrder'];
    if(input.activeRoutingComboId===null)delete config.activeRoutingComboId;else config.activeRoutingComboId=input.activeRoutingComboId as string;
    assertProxyConfig(config);
   });
   c.header('cache-control','no-store');return c.json(routingProjection(next));
  }catch(error){const conflict=error instanceof Error&&error.message==='revision_conflict';return c.json({error:{type:conflict?'revision_conflict':'routing_invalid'}},conflict?409:400);}
 });
}
