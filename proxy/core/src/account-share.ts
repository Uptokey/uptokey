import {createHash} from 'node:crypto';
import type {SecretStore} from './secret-store.ts';
import {resolveBearer,type ResolvedClient} from './client-keys.ts';
import {serialClientAuthority} from './client-authority-lock.ts';
import {PairingService,type AccountPairing} from './pairing.ts';
import {authenticateContextCredential,contextEpoch,rawCredentialPrincipal} from './workspace/client-context-link.ts';
import type {IdentityEpoch} from './workspace/principal.ts';
import type {AccountAdmission} from './account-login.ts';
import type {AccountAvailable} from './account-login-protocol.ts';
import type {PairingAudience} from '@uptokey/sync-contract/client-keys';

export const ACCOUNT_SHARE_AUDIENCES = new Set(['pwa','tauri','tui','vscode','browser-extension']);
const REF=/^acc_[a-f0-9]{64}$/;
const PRINCIPAL=/^[a-f0-9]{24}_(?:admin|[a-f0-9-]{36})$/;
const HASH=/^[a-f0-9]{64}$/;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type Approval={ownerPrincipalId:string;ownerAuthorityDigest:string;accountRef:string;approvedAt:string};
type Grant={version:1;revision:number;recipientPrincipalId:string;recipientAuthorityDigest:string;approvals:Approval[]};
type Authority={principal:string;digest:string;client:ResolvedClient};
type OwnAccount=(principal:string,signal?:AbortSignal,admit?:AccountAdmission)=>Promise<AccountAvailable>;
export class AccountShareError extends Error {
 readonly code:string;readonly status:400|401|403|409|429;
 constructor(code:string,status:400|401|403|409|429=403){super(code);this.code=code;this.status=status;}
}
const fail=(code='account_share_denied',status:400|401|403|409|429=403):never=>{throw new AccountShareError(code,status);};
const key=(principal:string)=>{if(!PRINCIPAL.test(principal))return fail('account_client_invalid',400);return 'local:account-share:'+digest(principal);};

/** Account grants are separate from workspace ownership and contain no broker credential. */
export class AccountShareService {
 private readonly secrets:SecretStore;private readonly pairing:PairingService;
 private readonly epoch:()=>IdentityEpoch;private readonly ownAccount:OwnAccount;private readonly now:()=>number;
 constructor(secrets:SecretStore,pairing:PairingService,epoch:()=>IdentityEpoch,ownAccount:OwnAccount,now=Date.now){this.secrets=secrets;this.pairing=pairing;this.epoch=epoch;this.ownAccount=ownAccount;this.now=now;}

 private async authority(client:ResolvedClient,token:string):Promise<Authority>{
  if(client.delegation||client.kind==='client'&&(!client.clientId||!client.registration||!client.policy||
   !ACCOUNT_SHARE_AUDIENCES.has(client.registration.audience)||client.policy.retentionMode==='ephemeral'))return fail();
  const epoch=this.epoch(),principal=rawCredentialPrincipal(epoch,client);
  const workspaceKey=client.kind==='client'?await this.secrets.get(`local:client:${client.clientId}:workspace-key`):undefined;
  // Key-bound clients keep their identity across ordinary bearer renewal. An admin or
  // legacy keyless client is bound to the current credential fingerprint instead.
  const identity=workspaceKey?digest(workspaceKey):digest(token);
  return {principal,client,digest:digest(JSON.stringify([contextEpoch(epoch),principal,identity,client.policy??null,client.registration??null]))};
 }
 async capture(header:string|undefined):Promise<Authority>{
  const client=await authenticateContextCredential(header,this.secrets,this.now());
  const token=/^Bearer (\S+)$/i.exec(header??'')?.[1];if(!token)return fail('unauthorized',401);
  const authority=await this.authority(client,token);
  const current=await authenticateContextCredential(header,this.secrets,this.now());
  const refreshed=await this.authority(current,token);
  if(authority.digest!==refreshed.digest)return fail();return refreshed;
 }
 private async active(principal:string):Promise<Authority|undefined>{
  const prefix=contextEpoch(this.epoch())+'_';if(!principal.startsWith(prefix))return;
  const suffix=principal.slice(prefix.length),token=await this.secrets.get(suffix==='admin'?'local:api-token':`local:client:${suffix}`);
  if(!token)return;const current=await resolveBearer(this.secrets,token,this.now());
  if(!current.ok||current.resolved.delegation)return;
  try{const value=await this.authority(current.resolved,token);return value.principal===principal?value:undefined;}catch{return;}
 }
 private async read(principal:string):Promise<Grant|undefined>{
  const raw=await this.secrets.get(key(principal));if(raw===undefined)return;
  if(raw.length>65536)return fail('account_store_invalid',400);
  let value:Grant;try{value=JSON.parse(raw);}catch{return fail('account_store_invalid',400);}
  if(!value||Object.keys(value).sort().join(',')!=='approvals,recipientAuthorityDigest,recipientPrincipalId,revision,version'||value.version!==1||
   value.recipientPrincipalId!==principal||!HASH.test(value.recipientAuthorityDigest)||!Number.isSafeInteger(value.revision)||value.revision<1||
   !Array.isArray(value.approvals)||value.approvals.length>64)return fail('account_store_invalid',400);
  for(const row of value.approvals)if(!row||Object.keys(row).sort().join(',')!=='accountRef,approvedAt,ownerAuthorityDigest,ownerPrincipalId'||
   !PRINCIPAL.test(row.ownerPrincipalId)||!HASH.test(row.ownerAuthorityDigest)||!REF.test(row.accountRef)||
   typeof row.approvedAt!=='string'||!Number.isFinite(Date.parse(row.approvedAt)))return fail('account_store_invalid',400);
  if(new Set(value.approvals.map(row=>row.accountRef)).size!==value.approvals.length)return fail('account_store_invalid',400);return value;
 }
 async authorizes(recipientPrincipal:string,ownerPrincipal:string,accountRef:string):Promise<boolean>{
  if(recipientPrincipal===ownerPrincipal)return Boolean(await this.active(ownerPrincipal));
  const grant=await this.read(recipientPrincipal),approval=grant?.approvals.find(row=>row.accountRef===accountRef&&row.ownerPrincipalId===ownerPrincipal);
  if(!grant||!approval)return false;
  const [recipient,owner]=await Promise.all([this.active(recipientPrincipal),this.active(ownerPrincipal)]);
  if(!recipient||!owner||recipient.digest!==grant.recipientAuthorityDigest||owner.digest!==approval.ownerAuthorityDigest)return false;
  const current=await this.read(recipientPrincipal);
  return current?.revision===grant.revision&&current.recipientAuthorityDigest===grant.recipientAuthorityDigest&&
   current.approvals.some(row=>row.accountRef===accountRef&&row.ownerPrincipalId===ownerPrincipal&&row.ownerAuthorityDigest===owner.digest);
 }
 async request(header:string|undefined){
  const recipient=await this.capture(header),old=await this.read(recipient.principal);
  const fresh=await this.capture(header);if(fresh.digest!==recipient.digest)return fail();
  const clientName=recipient.client.kind==='admin'?'Uptokey terminal':await this.secrets.get(`local:client:${recipient.client.clientId}:name`)??'Uptokey';
  const audience=recipient.client.kind==='admin'?'tui':recipient.client.registration!.audience;
  return this.pairing.createAccountLink({recipientPrincipalId:recipient.principal,recipientAuthorityDigest:recipient.digest,expectedGrantRevision:old?.revision??0},clientName,audience as PairingAudience | 'pwa');
 }
 private async owned(authority:Authority,signal?:AbortSignal,admit?:AccountAdmission){
  const value=await this.ownAccount(authority.principal,signal,admit);
  return value.accounts.filter(row=>row.owned&&row.session.authenticated);
 }
 async requests(header:string|undefined,signal?:AbortSignal,admit?:AccountAdmission){
  const owner=await this.capture(header);if(!(await this.owned(owner,signal,admit)).length)return {requests:[]};
  const current=await this.capture(header);if(current.digest!==owner.digest)return fail();await admit?.();
  return {requests:this.pairing.accountRequests(owner.principal)};
 }
 async approve(header:string|undefined,input:{id:string;userCode:string;accountRef:string},signal?:AbortSignal,admit?:AccountAdmission){
  if(!REF.test(input.accountRef))return fail('account_request_invalid',400);
  const owner=await this.capture(header),rows=await this.owned(owner,signal,admit);
  if(!rows.some(row=>row.accountRef===input.accountRef))return fail();
  const current=await this.capture(header);if(current.digest!==owner.digest)return fail();await admit?.();
  if(!this.pairing.approveAccountLink(input.id,input.userCode,{ownerPrincipalId:owner.principal,ownerAuthorityDigest:owner.digest,accountRef:input.accountRef}))return fail('account_share_pending',409);
  return {approved:true as const};
 }
 async consume(header:string|undefined,id:string,signal?:AbortSignal,admit?:AccountAdmission){
  const recipient=await this.capture(header);
  const result=await this.pairing.consumeAccountLink(id,recipient.principal,pending=>this.commit(header,recipient,pending,signal,admit));
  if(!result)return fail('account_share_pending',409);return result;
 }
 private async commit(header:string|undefined,recipient:Authority,pending:AccountPairing,signal?:AbortSignal,admit?:AccountAdmission){
  return serialClientAuthority(this.secrets,`account-share:${recipient.principal}`,async()=>{
   const old=await this.read(recipient.principal);if((old?.revision??0)!==pending.expectedGrantRevision)return fail('account_share_conflict',409);
   const fresh=await this.capture(header),approval=pending.approval!;
   if(fresh.digest!==recipient.digest||fresh.digest!==pending.recipientAuthorityDigest)return fail();
   const owner=await this.active(approval.ownerPrincipalId);if(!owner||owner.digest!==approval.ownerAuthorityDigest)return fail();
   if(!(await this.owned(owner,signal,admit)).some(row=>row.accountRef===approval.accountRef))return fail();
   const next:Grant={version:1,revision:(old?.revision??0)+1,recipientPrincipalId:recipient.principal,recipientAuthorityDigest:fresh.digest,
    approvals:[...(old?.recipientAuthorityDigest===fresh.digest?old.approvals:[]).filter(row=>row.accountRef!==approval.accountRef),{...approval,approvedAt:new Date(this.now()).toISOString()}]};
   if(next.approvals.length>64)return fail('account_share_capacity',429);
   await admit?.();const bytes=JSON.stringify(next);await this.secrets.set(key(recipient.principal),bytes);
   try{await admit?.();if(!await this.authorizes(recipient.principal,approval.ownerPrincipalId,approval.accountRef))return fail();}
   catch(error){if(await this.secrets.get(key(recipient.principal))===bytes)await this.secrets.set(key(recipient.principal),JSON.stringify({...next,revision:next.revision+1,approvals:[]}));throw error;}
   return {approved:true as const};
  });
 }
}
