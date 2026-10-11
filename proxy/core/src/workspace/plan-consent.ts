import {createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import type {BrowserPublicJwk} from './browser-session.ts';

export interface ConsentBinding {principalId:string;projectId:string;planId:string;planDigest:string;}
interface Pending {binding:ConsentBinding;publicJwk:BrowserPublicJwk;nonce:string;expiresAt:number;}
/** The caller must resolve the enrolled key from authenticated server state, never request JSON.
 * A signature proves possession of the browser key, not biological human presence. */
export class PlanConsentService {
  private pending=new Map<string,Pending>();
  private now:()=>number;
  constructor(now:()=>number=Date.now){this.now=now;}
  challenge(binding:ConsentBinding,publicJwk:BrowserPublicJwk) {
    const now=this.now();
    for(const [id,value] of this.pending)if(value.expiresAt<=now)this.pending.delete(id);
    if(this.pending.size>=128)throw new Error('consent_capacity');
    const copy={principalId:binding.principalId,projectId:binding.projectId,planId:binding.planId,planDigest:binding.planDigest};
    if(Object.values(copy).some(value=>typeof value!=='string'||!value||value.length>200)||! /^[a-f0-9]{64}$/.test(copy.planDigest))throw new Error('consent_binding_invalid');
    const key={kty:publicJwk.kty,crv:publicJwk.crv,x:publicJwk.x,y:publicJwk.y};
    createPublicKey({key,format:'jwk'});
    const challengeId=randomUUID();
    const nonce=JSON.stringify({domain:'uptokey-plan-consent-v1',challengeId,...copy,random:randomBytes(32).toString('base64url')});
    this.pending.set(challengeId,{binding:copy,publicJwk:key,nonce,expiresAt:now+60_000});
    return {challengeId,nonce};
  }
  consume(binding:ConsentBinding,challengeId:string,signature:string):void {
    const pending=this.pending.get(challengeId);this.pending.delete(challengeId);
    if(!pending||pending.expiresAt<=this.now()||Object.keys(pending.binding).some(key=>pending.binding[key as keyof ConsentBinding]!==binding[key as keyof ConsentBinding])||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))throw new Error('consent_invalid');
    const bytes=Buffer.from(signature,'base64url');
    if(bytes.toString('base64url')!==signature||!verify('sha256',Buffer.from(pending.nonce),{key:createPublicKey({key:{...pending.publicJwk},format:'jwk'}),dsaEncoding:'ieee-p1363'},bytes))throw new Error('consent_invalid');
  }
}
