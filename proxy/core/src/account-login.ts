import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import type {SecretStore} from './secret-store.ts';
import {serialClientAuthority} from './client-authority-lock.ts';
import {accountControlProofPayload,accountMobilityProofPayload,isAccountAccessToken,readAccountControlRequest,readAccountMobilityRequest,type AccountControlProof,type AccountControlRequest,type AccountMobilityRequest,type AccountMobilityProof} from './account-login-protocol.ts';
import {readBoundedJson} from '@uptokey/sync-contract/limits';
import {ACCOUNT_ID,ACCOUNT_MAX_AVAILABLE,ACCOUNT_MAX_CLIENT_RESPONSE_BYTES,ACCOUNT_MAX_RESPONSE_BYTES,ACCOUNT_REF,accountProofPayload,readAccountAdoptInput,readAccountPublicSession,readAccountPublicUsage,readAccountUnlinkInput,trustedAccountOrigin,type AccountAdoptInput,type AccountAdoption,type AccountAvailable,type AccountAvailableEntry,type AccountProof,type AccountPublicSession,type AccountUnlinkInput} from './account-login-protocol.ts';

type StoredAccount={version:1;origin:string;id:string;privateKey:string;expiresAt:number;pending:boolean};
type AccountReference={ownerPrincipal:string;accountRef:string};
type AccountLink={version:1;origin:string;revision:number;signedOut:boolean;association?:AccountReference};
type AccountIndex={version:1;origin:string;accounts:AccountReference[]};
export type AccountAdmission=()=>Promise<void>;
export type AccountSourceAuthorizer=(recipientPrincipal:string,ownerPrincipal:string,accountRef:string)=>Promise<boolean|void>;

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const expired=(error:unknown)=>error instanceof Error&&['account_session_expired','account_session_revoked','account_challenge_expired'].includes(error.message);
// Shared service instances use the same vault owner; cancellation is ephemeral,
// never another identity store. Account mutations can interrupt slow mobility.
const mobilityOperations=new WeakMap<SecretStore,Map<string,Set<AbortController>>>();

export class AccountLoginService {
 private readonly origin:string|undefined;
 private readonly secrets:SecretStore;
 private readonly fetcher:typeof fetch;
 private readonly now:()=>number;
 private readonly sourceAuthorizer:AccountSourceAuthorizer|undefined;

 constructor(options:{secrets:SecretStore;origin?:string;production?:boolean;fetcher?:typeof fetch;now?:()=>number;sourceAuthorizer?:AccountSourceAuthorizer}) {
  this.origin=trustedAccountOrigin(options.origin,options.production);this.secrets=options.secrets;this.fetcher=options.fetcher??fetch;this.now=options.now??Date.now;this.sourceAuthorizer=options.sourceAuthorizer;
 }

 capability(){return {configured:Boolean(this.origin),loginAvailable:Boolean(this.origin),origin:this.origin??null};}
 private cancelMobility(principal:string){for(const controller of mobilityOperations.get(this.secrets)?.get(principal)??[])controller.abort();}
 async withMobilityCredential<T>(principal:string,input:AccountMobilityRequest,signal:AbortSignal,operation:(token:string,signal:AbortSignal,revalidate:AccountAdmission)=>Promise<T>,admit?:AccountAdmission):Promise<T>{
  const request=readAccountMobilityRequest(input),controller=new AbortController();
  const combined=AbortSignal.any([signal,controller.signal]);
  // Resolve under the existing identity locks; release before SDK/network waits
  // so logout/unlink are not queued behind a potentially slow transfer.
  const snapshot=await this.exclusive(principal,async link=>{
   await admit?.();combined.throwIfAborted();
   if(!this.origin)throw Error('account_service_not_configured');
   if(link.signedOut)throw Error('account_reauthentication_required');
   const owner=link.association?.ownerPrincipal??principal;
   const row=link.association?(await this.readSource(principal,link,link.association,admit)).row:await this.read(principal,admit);
   if(!row||row.pending)throw Error('account_reauthentication_required');
   const accountRef=this.accountRef(owner,row);
   if(link.revision!==request.revision||accountRef!==request.accountRef)throw Error('account_share_conflict');
   let deadline=row.expiresAt;
   const guard:AccountAdmission=async()=>{
    combined.throwIfAborted();await admit?.();await this.checkLink(principal,link,admit);
    if(link.association)await this.authorize(principal,link.association,admit);
    const current=await this.read(owner,admit);combined.throwIfAborted();
    if(!current||current.pending||this.accountRef(owner,current)!==accountRef)throw Error('account_session_revoked');
    if(current.expiresAt<=this.now()||deadline<=this.now())throw Error('account_session_expired');
   };
   let registry=mobilityOperations.get(this.secrets);if(!registry){registry=new Map();mobilityOperations.set(this.secrets,registry);}
   for(const identity of new Set([principal,owner])){let entries=registry.get(identity);if(!entries){entries=new Set();registry.set(identity,entries);}entries.add(controller);}
   return {row,owner,guard,boundExpiry:(expiresAt:number)=>{deadline=Math.min(deadline,expiresAt);}};
  },admit);
  try{
   await snapshot.guard();
   const data={id:snapshot.row.id,action:'mobility' as const,nonce:randomBytes(24).toString('base64url'),issuedAt:this.now(),request};
   const proof:AccountMobilityProof={...data,signature:sign('sha256',Buffer.from(accountMobilityProofPayload(data)),{key:snapshot.row.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
   const answer=await this.request('/api/account/native/mobility',proof,combined,snapshot.guard);
   if(Object.keys(answer).sort().join(',')!=='expiresAt,token'||!isAccountAccessToken(answer.token)||typeof answer.expiresAt!=='number'||!Number.isSafeInteger(answer.expiresAt))throw Error('account_response_invalid');
   snapshot.boundExpiry(answer.expiresAt);
   await snapshot.guard();
   try{const result=await operation(answer.token,combined,snapshot.guard);await snapshot.guard();return result;}
   finally{answer.token=undefined;}
  }catch(error){if(combined.aborted)throw Error('account_cancelled');if(expired(error))throw Error('account_reauthentication_required');throw error;}
  finally{
   controller.abort();const registry=mobilityOperations.get(this.secrets);
   for(const identity of new Set([principal,snapshot.owner])){const entries=registry?.get(identity);entries?.delete(controller);if(entries?.size===0)registry?.delete(identity);}
  }
 }
 async control(principal:string,input:AccountControlRequest,signal:AbortSignal,admit?:AccountAdmission):Promise<{status:number;body:unknown}>{
  const request=readAccountControlRequest(input),controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  const snapshot=await this.exclusive(principal,async link=>{
   await admit?.();combined.throwIfAborted();if(!this.origin)throw Error('account_service_not_configured');if(link.signedOut)throw Error('account_reauthentication_required');
   const owner=link.association?.ownerPrincipal??principal;
   const row=link.association?(await this.readSource(principal,link,link.association,admit)).row:await this.read(principal,admit);
   if(!row||row.pending)throw Error('account_reauthentication_required');
   const accountRef=this.accountRef(owner,row),guard:AccountAdmission=async()=>{combined.throwIfAborted();await admit?.();await this.checkLink(principal,link,admit);if(link.association)await this.authorize(principal,link.association,admit);const current=await this.read(owner,admit);combined.throwIfAborted();if(!current||current.pending||this.accountRef(owner,current)!==accountRef)throw Error('account_session_revoked');if(current.expiresAt<=this.now())throw Error('account_session_expired');};
   let registry=mobilityOperations.get(this.secrets);if(!registry){registry=new Map();mobilityOperations.set(this.secrets,registry);}for(const identity of new Set([principal,owner])){let entries=registry.get(identity);if(!entries){entries=new Set();registry.set(identity,entries);}entries.add(controller);}return {row,owner,guard};
  },admit);
  try{await snapshot.guard();const data={id:snapshot.row.id,action:'control' as const,nonce:randomBytes(24).toString('base64url'),issuedAt:this.now(),request};const proof:AccountControlProof={...data,signature:sign('sha256',Buffer.from(accountControlProofPayload(data)),{key:snapshot.row.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};const answer=await this.request('/api/account/native/control',proof,combined,snapshot.guard,ACCOUNT_MAX_CLIENT_RESPONSE_BYTES);if(Object.keys(answer).sort().join(',')!=='body,status'||typeof answer.status!=='number'||!Number.isSafeInteger(answer.status)||answer.status<100||answer.status>599)throw Error('account_response_invalid');await snapshot.guard();return {status:answer.status,body:answer.body};}
  catch(error){if(combined.aborted)throw Error('account_cancelled');if(expired(error))throw Error('account_reauthentication_required');throw error;}
  finally{controller.abort();const registry=mobilityOperations.get(this.secrets);for(const identity of new Set([principal,snapshot.owner])){const entries=registry?.get(identity);entries?.delete(controller);if(entries?.size===0)registry?.delete(identity);}}
 }
 private principalDigest(principal:string){if(!principal||principal.length>250||/[\u0000-\u0020\u007f]/.test(principal))throw Error('account_client_invalid');return digest(principal);}
 private key(principal:string){return 'uptokey-account:'+this.principalDigest(principal);}
 private linkKey(principal:string){return 'uptokey-account-link:'+this.principalDigest(principal);}
 private indexKey(){return 'uptokey-account-index:'+digest(this.origin??'');}
 private accountRef(principal:string,row:StoredAccount){const generation=digest(createPublicKey(row.privateKey).export({format:'der',type:'spki'}).toString('base64'));return 'acc_'+digest(JSON.stringify(['uptokey.account.reference.v1',row.origin,principal,row.id,generation]));}

 // Queue identities are shared across service instances. Sorted locks prevent
 // reciprocal adoption from deadlocking; they are not a cross-process vault CAS.
 private async withLocks<T>(principals:string[],work:()=>Promise<T>):Promise<T>{const keys=[...new Set(principals.map(principal=>'account-operation:'+this.principalDigest(principal)))].sort();const run=(at:number):Promise<T>=>at===keys.length?work():serialClientAuthority(this.secrets,keys[at]!,()=>run(at+1));return run(0);}
 private async exclusive<T>(principal:string,work:(link:AccountLink)=>Promise<T>,admit?:AccountAdmission):Promise<T>{const before=await this.readLink(principal,admit);return this.withLocks([principal,...(before.association?[before.association.ownerPrincipal]:[])],async()=>{const link=await this.readLink(principal,admit);if(link.association?.ownerPrincipal!==before.association?.ownerPrincipal)throw Error('account_share_conflict');return work(link);});}

 private async read(principal:string,admit?:AccountAdmission):Promise<StoredAccount|undefined>{
  await admit?.();const raw=await this.secrets.get(this.key(principal));await admit?.();if(raw===undefined)return undefined;
  let row:StoredAccount;try{if(raw.length>8192)throw Error();row=JSON.parse(raw);}catch{throw Error('account_store_invalid');}
  if(!row||typeof row!=='object'||Array.isArray(row)||row.version!==1||row.origin!==this.origin||typeof row.id!=='string'||!ACCOUNT_ID.test(row.id)||typeof row.privateKey!=='string'||row.privateKey.length>2048||!Number.isSafeInteger(row.expiresAt)||row.expiresAt<=0||typeof row.pending!=='boolean')throw Error('account_store_invalid');
  try{const key=createPrivateKey(row.privateKey);if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error();}catch{throw Error('account_store_invalid');}return row;
 }
 private async writeValue(key:string,value:string,admit?:AccountAdmission,after:AccountAdmission|undefined=admit){await admit?.();const previous=await this.secrets.get(key);await admit?.();await this.secrets.set(key,value);try{await after?.();}catch(error){if(await this.secrets.get(key)===value){if(previous===undefined)await this.secrets.delete(key);else await this.secrets.set(key,previous);}throw error;}}
 private async save(principal:string,row:StoredAccount,admit?:AccountAdmission){await this.writeValue(this.key(principal),JSON.stringify(row),admit);}
 private async remove(principal:string,admit?:AccountAdmission){await admit?.();await this.secrets.delete(this.key(principal));await admit?.();await this.unpublish(principal,admit);}
 private defaultLink():AccountLink{return {version:1,origin:this.origin??'',revision:0,signedOut:false};}
 private async readLink(principal:string,admit?:AccountAdmission):Promise<AccountLink>{
  await admit?.();const raw=await this.secrets.get(this.linkKey(principal));await admit?.();if(raw===undefined)return this.defaultLink();
  let row:AccountLink;try{if(raw.length>4096)throw Error();row=JSON.parse(raw);}catch{throw Error('account_store_invalid');}
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!==(row.association===undefined?'origin,revision,signedOut,version':'association,origin,revision,signedOut,version')||row.version!==1||row.origin!==(this.origin??'')||!Number.isSafeInteger(row.revision)||row.revision<0||typeof row.signedOut!=='boolean')throw Error('account_store_invalid');
  if(row.association!==undefined){const source=row.association;if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).sort().join(',')!=='accountRef,ownerPrincipal'||row.signedOut||typeof source.ownerPrincipal!=='string'||typeof source.accountRef!=='string'||!ACCOUNT_REF.test(source.accountRef))throw Error('account_store_invalid');this.principalDigest(source.ownerPrincipal);}return row;
 }
 private async checkLink(principal:string,expected:AccountLink,admit?:AccountAdmission){const current=await this.readLink(principal,admit);if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('account_share_conflict');}
 private async changeLink(principal:string,old:AccountLink,next:Omit<AccountLink,'revision'>,admit?:AccountAdmission,authority?:AccountAdmission):Promise<AccountLink>{if(old.revision>=Number.MAX_SAFE_INTEGER)throw Error('account_store_invalid');const updated={...next,revision:old.revision+1};const before=async()=>{await admit?.();await this.checkLink(principal,old,admit);await authority?.();};const after=async()=>{await admit?.();await this.checkLink(principal,updated,admit);await authority?.();};await this.writeValue(this.linkKey(principal),JSON.stringify(updated),before,after);this.cancelMobility(principal);return updated;}
 private async readIndex(admit?:AccountAdmission):Promise<AccountIndex>{await admit?.();const raw=await this.secrets.get(this.indexKey());await admit?.();if(raw===undefined)return {version:1,origin:this.origin??'',accounts:[]};let row:AccountIndex;try{if(raw.length>200_000)throw Error();row=JSON.parse(raw);}catch{throw Error('account_store_invalid');}if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='accounts,origin,version'||row.version!==1||row.origin!==(this.origin??'')||!Array.isArray(row.accounts)||row.accounts.length>ACCOUNT_MAX_AVAILABLE)throw Error('account_store_invalid');const seen=new Set<string>();for(const entry of row.accounts){if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='accountRef,ownerPrincipal'||typeof entry.ownerPrincipal!=='string'||typeof entry.accountRef!=='string'||!ACCOUNT_REF.test(entry.accountRef)||seen.has(entry.ownerPrincipal))throw Error('account_store_invalid');this.principalDigest(entry.ownerPrincipal);seen.add(entry.ownerPrincipal);}return row;}
 private async publish(principal:string,row:StoredAccount,admit?:AccountAdmission){if(row.pending)return;await serialClientAuthority(this.secrets,this.indexKey(),async()=>{const index=await this.readIndex(admit);const accountRef=this.accountRef(principal,row);if(index.accounts.some(entry=>entry.ownerPrincipal===principal&&entry.accountRef===accountRef))return;const accounts=index.accounts.filter(entry=>entry.ownerPrincipal!==principal);if(accounts.length>=ACCOUNT_MAX_AVAILABLE)throw Error('account_store_full');accounts.push({ownerPrincipal:principal,accountRef});await this.writeValue(this.indexKey(),JSON.stringify({...index,accounts}),admit);});}
 private async unpublish(principal:string,admit?:AccountAdmission){await serialClientAuthority(this.secrets,this.indexKey(),async()=>{const index=await this.readIndex(admit);const accounts=index.accounts.filter(entry=>entry.ownerPrincipal!==principal);if(accounts.length!==index.accounts.length)await this.writeValue(this.indexKey(),JSON.stringify({...index,accounts}),admit);});}

 private async authorize(principal:string,source:AccountReference,admit?:AccountAdmission){await admit?.();if(source.ownerPrincipal===principal)return;if(!this.sourceAuthorizer)throw Error('account_share_denied');const allowed=await this.sourceAuthorizer(principal,source.ownerPrincipal,source.accountRef);await admit?.();if(allowed===false)throw Error('account_share_denied');}
 private sourceGuard(principal:string,link:AccountLink,source:AccountReference,admit?:AccountAdmission):AccountAdmission{return async()=>{await admit?.();await this.checkLink(principal,link,admit);await this.authorize(principal,source,admit);};}
 private async readSource(principal:string,link:AccountLink,source:AccountReference,admit?:AccountAdmission){const guard=this.sourceGuard(principal,link,source,admit);await guard();const row=await this.read(source.ownerPrincipal,guard);if(!row||row.pending||this.accountRef(source.ownerPrincipal,row)!==source.accountRef)throw Error('account_share_pending');await guard();return {row,guard};}

 private async request(path:string,body:unknown,signal?:AbortSignal,admit?:AccountAdmission,maxBytes=ACCOUNT_MAX_RESPONSE_BYTES):Promise<Record<string,unknown>>{if(!this.origin)throw Error('account_service_not_configured');await admit?.();let response:Response;try{response=await this.fetcher(this.origin+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body),redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000)});}catch{await admit?.();throw Error(signal?.aborted?'account_cancelled':'account_service_unavailable');}await admit?.();const parsed=await readBoundedJson(response,maxBytes);await admit?.();if(!parsed.ok||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value))throw Error('account_response_invalid');const row=parsed.value as Record<string,unknown>;if(!response.ok){const code=typeof row.error==='string'&&/^account_[a-z_]{1,80}$/.test(row.error)?row.error:'account_service_unavailable';throw Error(code);}return row;}
 private proof(row:StoredAccount,action:AccountProof['action']):AccountProof{const data={id:row.id,action,nonce:randomBytes(24).toString('base64url'),issuedAt:this.now()};return {...data,signature:sign('sha256',Buffer.from(accountProofPayload(data)),{key:row.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};}
 private signedOut():AccountPublicSession{return {configured:Boolean(this.origin),loginAvailable:Boolean(this.origin),authenticated:false,state:'signed_out'};}
 private async statusUnchecked(principal:string,row:StoredAccount,signal?:AbortSignal,admit?:AccountAdmission):Promise<AccountPublicSession>{if(row.pending&&row.expiresAt<=this.now()){await this.remove(principal,admit);return this.signedOut();}try{const answer=await this.request('/api/account/native/'+(row.pending?'poll':'status'),this.proof(row,row.pending?'poll':'status'),signal,admit);const session=readAccountPublicSession(answer);if(session.authenticated){if(typeof answer.expiresAt!=='number'||!Number.isSafeInteger(answer.expiresAt)||answer.expiresAt<=this.now())throw Error('account_response_invalid');const updated={...row,pending:false,expiresAt:answer.expiresAt};if(row.pending||row.expiresAt!==answer.expiresAt)await this.save(principal,updated,admit);await this.publish(principal,updated,admit);}else if(session.state==='signed_out')await this.remove(principal,admit);await admit?.();return session;}catch(error){if(expired(error)){await this.remove(principal,admit);return this.signedOut();}throw error;}}
 private async currentStatus(principal:string,link:AccountLink,signal?:AbortSignal,admit?:AccountAdmission):Promise<AccountPublicSession>{await admit?.();if(!this.origin||link.signedOut)return this.signedOut();if(!link.association){const row=await this.read(principal,admit);return row?this.statusUnchecked(principal,row,signal,admit):this.signedOut();}try{const {row,guard}=await this.readSource(principal,link,link.association,admit);return await this.statusUnchecked(link.association.ownerPrincipal,row,signal,guard);}catch(error){if(error instanceof Error&&error.message==='account_share_pending')return this.signedOut();throw error;}}

 async login(principal:string,signal?:AbortSignal,admit?:AccountAdmission){return this.exclusive(principal,async link=>{await admit?.();if(!this.origin)throw Error('account_service_not_configured');if(link.association){const session=await this.currentStatus(principal,link,signal,admit);if(session.authenticated)return {session};}if(link.signedOut||link.association)link=await this.changeLink(principal,link,{version:1,origin:this.origin,signedOut:false},admit);const old=await this.read(principal,admit);if(old?.pending&&old.expiresAt>this.now())return {loginUrl:this.origin+'/api/account/native/authorize?id='+old.id,userCode:old.id.replaceAll('-','').slice(0,8).toUpperCase(),expiresAt:old.expiresAt};if(old&&!old.pending){const status=await this.statusUnchecked(principal,old,signal,admit);if(status.authenticated)return {session:status};}
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=pair.publicKey.export({format:'jwk'}),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();const answer=await this.request('/api/account/native/challenge',{publicKey},signal,admit);if(typeof answer.id!=='string'||!ACCOUNT_ID.test(answer.id)||typeof answer.expiresAt!=='number'||!Number.isSafeInteger(answer.expiresAt)||answer.expiresAt<=this.now()||answer.expiresAt>this.now()+6*60_000)throw Error('account_response_invalid');const row:StoredAccount={version:1,origin:this.origin,id:answer.id,privateKey,expiresAt:answer.expiresAt,pending:true};await this.save(principal,row,admit);return {loginUrl:this.origin+'/api/account/native/authorize?id='+row.id,userCode:row.id.replaceAll('-','').slice(0,8).toUpperCase(),expiresAt:row.expiresAt};},admit);}

 async status(principal:string,signal?:AbortSignal,admit?:AccountAdmission){return this.exclusive(principal,link=>this.currentStatus(principal,link,signal,admit),admit);}
 async logout(principal:string,signal?:AbortSignal,admit?:AccountAdmission){await admit?.();this.cancelMobility(principal);return this.exclusive(principal,async link=>{if(link.association){await this.changeLink(principal,link,{version:1,origin:this.origin??'',signedOut:true},admit);return this.signedOut();}const row=await this.read(principal,admit);if(row)await this.request('/api/account/native/logout',this.proof(row,'logout'),signal,admit);await this.remove(principal,admit);await this.changeLink(principal,link,{version:1,origin:this.origin??'',signedOut:true},admit);return this.signedOut();},admit);}
 async usage(principal:string,signal?:AbortSignal,admit?:AccountAdmission){return this.exclusive(principal,async link=>{await admit?.();const verifiedAt=new Date(this.now()).toISOString();if(!this.origin)return {state:'not_configured' as const,verifiedAt};if(link.signedOut)return {state:'reauthentication_required' as const,verifiedAt};let row:StoredAccount|undefined;let guard=admit;if(link.association){try{const source=await this.readSource(principal,link,link.association,admit);row=source.row;guard=source.guard;}catch(error){if(error instanceof Error&&error.message==='account_share_pending')return {state:'reauthentication_required' as const,verifiedAt};throw error;}}else row=await this.read(principal,admit);if(!row||row.pending)return {state:'reauthentication_required' as const,verifiedAt};try{const answer=await this.request('/api/account/native/usage',this.proof(row,'usage'),signal,guard);return readAccountPublicUsage(answer);}catch(error){if(expired(error))return {state:'reauthentication_required' as const,verifiedAt};throw error;}},admit);}

 async available(principal:string,signal?:AbortSignal,admit?:AccountAdmission):Promise<AccountAvailable>{await admit?.();const link=await this.readLink(principal,admit);const accounts:AccountAvailableEntry[]=[];if(!this.origin)return {revision:link.revision,currentAccountRef:null,currentOwned:null,accounts};await this.withLocks([principal],async()=>{await this.checkLink(principal,link,admit);const row=await this.read(principal,admit);if(row){const session=await this.statusUnchecked(principal,row,signal,admit);if(session.authenticated){const current=await this.read(principal,admit);if(current)accounts.push({accountRef:this.accountRef(principal,current),owned:true,session,expiresAt:current.expiresAt});}}});const index=await this.readIndex(admit);for(const source of index.accounts){if(source.ownerPrincipal===principal)continue;try{await this.withLocks([principal,source.ownerPrincipal],async()=>{const {row,guard}=await this.readSource(principal,link,source,admit);const session=await this.statusUnchecked(source.ownerPrincipal,row,signal,guard);if(session.authenticated){const current=await this.read(source.ownerPrincipal,guard);if(current&&this.accountRef(source.ownerPrincipal,current)===source.accountRef)accounts.push({accountRef:source.accountRef,owned:false,session,expiresAt:current.expiresAt});}});}catch(error){if(!(error instanceof Error&&['account_share_denied','account_share_pending'].includes(error.message)))throw error;}}
  await this.checkLink(principal,link,admit);for(const entry of accounts){const source=index.accounts.find(row=>row.accountRef===entry.accountRef);if(source)await this.authorize(principal,source,admit);}await this.checkLink(principal,link,admit);const current=link.signedOut?undefined:link.association?accounts.find(entry=>entry.accountRef===link.association!.accountRef&&!entry.owned):accounts.find(entry=>entry.owned);return {revision:link.revision,currentAccountRef:current?.accountRef??null,currentOwned:current?.owned??null,accounts};
 }

 async adopt(principal:string,input:AccountAdoptInput,signal?:AbortSignal,admit?:AccountAdmission):Promise<AccountAdoption>{const request=readAccountAdoptInput(input);await admit?.();const index=await this.readIndex(admit);const source=index.accounts.find(entry=>entry.accountRef===request.accountRef);if(!source)throw Error('account_share_pending');return this.withLocks([principal,source.ownerPrincipal],async()=>{const link=await this.readLink(principal,admit);if(link.revision!==request.expectedRevision)throw Error('account_share_conflict');const {row,guard}=await this.readSource(principal,link,source,admit);const session=await this.statusUnchecked(source.ownerPrincipal,row,signal,guard);if(!session.authenticated)throw Error('account_share_pending');const current=await this.read(source.ownerPrincipal,guard);if(!current||this.accountRef(source.ownerPrincipal,current)!==source.accountRef)throw Error('account_share_pending');const authority=()=>this.authorize(principal,source,admit);const updated=await this.changeLink(principal,link,{version:1,origin:this.origin!,signedOut:false,...(source.ownerPrincipal!==principal?{association:source}:{})},admit,authority);return {revision:updated.revision,session};});}
 async unlink(principal:string,input:AccountUnlinkInput,admit?:AccountAdmission):Promise<AccountAdoption>{const request=readAccountUnlinkInput(input);return this.exclusive(principal,async link=>{if(link.revision!==request.expectedRevision)throw Error('account_share_conflict');const updated=await this.changeLink(principal,link,{version:1,origin:this.origin??'',signedOut:true},admit);return {revision:updated.revision,session:this.signedOut()};},admit);}
}
