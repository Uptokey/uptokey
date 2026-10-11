import {ProvenanceCache,type CacheContext} from "../../../integracoes/api-instruments/src/provenance-cache.ts";
import type {PreparedApiCall} from "../../../integracoes/api-instruments/src/types.ts";
import {getActiveEfficiencyPolicy} from './efficiency-pipeline.ts';
import type {EfficiencyPolicy} from '../efficiency-policy.ts';

/** Provenance cache for structured reads. The semantic candidate helper is not yet
 * wired to a safe equivalence proof, so semantic-only settings never activate it. */
export class GovernedReadCache {
 private results=new ProvenanceCache();private generation=0;
 metrics(){return this.results.metrics();}
 limits(){return this.results.limits();}
 semanticMetrics(){return {reusedResults:0,rejectedBindings:0,mode:'disabled_no_safe_equivalence' as const};}
 invalidateAll(){const count=this.results.size();this.generation++;this.results.invalidateAll();return count;}
 scoped(policy:EfficiencyPolicy):Pick<ProvenanceCache,'get'|'put'>|undefined {
  if(!policy.enabled||!policy.provenanceCache)return undefined;
  const generation=this.generation,current=()=>{const next=getActiveEfficiencyPolicy();return generation===this.generation&&next.enabled&&next.id===policy.id&&next.revision===policy.revision&&next.provenanceCache===policy.provenanceCache&&next.semanticCache===policy.semanticCache;};
  return {
   get:(principal,project,prepared,now=Date.now(),context)=>{
    if(!current()||prepared.method!=='GET')return null;
    return this.results.get(principal,project,prepared,now,context);
   },
   put:(principal,project,prepared,outcome,ttl,now=Date.now(),context)=>{
    if(!current()||prepared.method!=='GET')return;
    this.results.put(principal,project,prepared,outcome,ttl,now,context);
   },
  };
 }
}
