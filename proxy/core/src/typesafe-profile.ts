import {createHash} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import type {SecretStore} from './secret-store.ts';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
type StoredProfile = {revision:number; enabled:boolean; model:string; apiKey:string};
export type TypeSafeProfileInfo = {
  provider:'typesafe'; model:string; revision:number; enabled:boolean;
  keyPresent:boolean; configured:boolean; endpoint:string;
};
export class TypeSafeProfileError extends Error {
  constructor(code:string) { super(code); this.name='TypeSafeProfileError'; }
}
const locks = new WeakMap<SecretStore, Map<string, Promise<unknown>>>();
const modelValid = (value:unknown):value is string => typeof value==='string' && (value==='' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value));
const keyValid = (value:unknown):value is string => typeof value==='string' && value.length<=2048 && !/[\s\u0000-\u001f\u007f]/.test(value);
const revisionValid = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value)>=0 && Number(value)<Number.MAX_SAFE_INTEGER;
function keyFor(principal:string) {
  if(typeof principal!=='string'||!principal.trim()||principal.length>512||/[\u0000-\u001f\u007f]/.test(principal)) throw new TypeSafeProfileError('typesafe_principal_invalid');
  return 'typesafe:profile:v1:'+createHash('sha256').update(principal).digest('hex');
}
function publicInfo(value:StoredProfile):TypeSafeProfileInfo {
  return {provider:'typesafe',model:value.model,revision:value.revision,enabled:value.enabled,keyPresent:Boolean(value.apiKey),configured:value.enabled&&Boolean(value.apiKey)&&Boolean(value.model),endpoint:TYPESAFE_ENDPOINT};
}

/** The existing vault owns both profile and credential in one atomic entry. */
export class TypeSafeProfileStore {
  private readonly secrets:SecretStore;
  constructor(options:{secrets:SecretStore}) { this.secrets=options.secrets; }
  private async read(key:string):Promise<StoredProfile> {
    const raw=await this.secrets.get(key);
    if(raw===undefined) return {revision:0,enabled:false,model:'',apiKey:''};
    let value:unknown;
    try { value=JSON.parse(raw); } catch { throw new TypeSafeProfileError('typesafe_profile_invalid'); }
    if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='apiKey,enabled,model,revision'||!revisionValid(value.revision)||value.revision<1||typeof value.enabled!=='boolean'||!modelValid(value.model)||!keyValid(value.apiKey)||value.enabled&&(!value.model||!value.apiKey)) throw new TypeSafeProfileError('typesafe_profile_invalid');
    return value as StoredProfile;
  }
  async info(principal:string):Promise<TypeSafeProfileInfo> { return publicInfo(await this.read(keyFor(principal))); }
  async configure(principal:string,input:unknown):Promise<TypeSafeProfileInfo> {
    const key=keyFor(principal);
    if(!isDataRecord(input)||Object.keys(input).some(k=>!['expectedRevision','enabled','model','apiKey'].includes(k))||!revisionValid(input.expectedRevision)||typeof input.enabled!=='boolean'||!modelValid(input.model)||Object.hasOwn(input,'apiKey')&&!keyValid(input.apiKey)) throw new TypeSafeProfileError('typesafe_profile_invalid');
    // Snapshot validated input before the queue: callers cannot mutate a pending write.
    const patch={expectedRevision:input.expectedRevision,enabled:input.enabled,model:input.model,apiKey:input.apiKey as string|undefined};
    let pending=locks.get(this.secrets);
    if(!pending) { pending=new Map(); locks.set(this.secrets,pending); }
    const write=(pending.get(key)??Promise.resolve()).catch(()=>undefined).then(async()=>{
      const current=await this.read(key);
      if(current.revision!==patch.expectedRevision) throw new TypeSafeProfileError('typesafe_profile_changed');
      const next={revision:current.revision+1,enabled:patch.enabled,model:patch.model,apiKey:patch.apiKey??current.apiKey};
      if(next.enabled&&(!next.model||!next.apiKey)) throw new TypeSafeProfileError('typesafe_profile_not_configured');
      await this.secrets.set(key,JSON.stringify(next));
      return publicInfo(next);
    });
    pending.set(key,write);
    try { return await write; } finally { if(pending.get(key)===write) pending.delete(key); }
  }
  async resolveCredential(principal:string,revision:number,signal?:AbortSignal):Promise<string|undefined> {
    signal?.throwIfAborted();
    if(!revisionValid(revision)||revision<1) return undefined;
    const value=await this.read(keyFor(principal));
    signal?.throwIfAborted();
    return value.revision===revision&&value.enabled&&value.model ? value.apiKey||undefined : undefined;
  }
}
