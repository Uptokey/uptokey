export interface AccountPublicProfile { displayName?: string; email?: string; plan?: string }
export interface AccountPublicSession { configured: boolean; authenticated: boolean; loginAvailable: boolean; state: 'signed_out'|'connecting'|'connected'|'unavailable'; profile?: AccountPublicProfile;requiresSignIn?:boolean }
export const ACCOUNT_REF = /^acc_[a-f0-9]{64}$/;
export const ACCOUNT_MAX_AVAILABLE = 256;
export const ACCOUNT_MAX_CLIENT_RESPONSE_BYTES = 256 * 1024;
export interface AccountAvailableEntry {accountRef:string;owned:boolean;session:AccountPublicSession;expiresAt:number}
export interface AccountAvailable {revision:number;currentAccountRef:string|null;currentOwned:boolean|null;accounts:AccountAvailableEntry[]}
export interface AccountAdoption {revision:number;session:AccountPublicSession}
export interface AccountAdoptInput {accountRef:string;expectedRevision:number}
export interface AccountUnlinkInput {expectedRevision:number}
export type AccountShareAudience='pwa'|'tauri'|'tui'|'vscode'|'browser-extension';
export interface AccountShareChallenge {id:string;userCode:string;expiresAt:string}
export interface AccountShareRequest extends AccountShareChallenge {clientName:string;audience:AccountShareAudience}
export interface AccountShareRequests {requests:AccountShareRequest[]}
export interface AccountShareApproval {approved:true}
function accountRecord(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('account_response_invalid');return value as Record<string,unknown>;}
function accountRevision(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('account_response_invalid');return value;}
export function readAccountAvailable(value:unknown):AccountAvailable {
 const row=accountRecord(value),revision=accountRevision(row.revision);
 if(!Array.isArray(row.accounts)||row.accounts.length>ACCOUNT_MAX_AVAILABLE||!(row.currentAccountRef===null||typeof row.currentAccountRef==='string'&&ACCOUNT_REF.test(row.currentAccountRef))||!(row.currentOwned===null||typeof row.currentOwned==='boolean')||(row.currentAccountRef===null)!==(row.currentOwned===null))throw Error('account_response_invalid');
 const seen=new Set<string>();const accounts=row.accounts.map(value=>{const entry=accountRecord(value),session=readAccountPublicSession(entry.session);if(typeof entry.accountRef!=='string'||!ACCOUNT_REF.test(entry.accountRef)||seen.has(entry.accountRef)||typeof entry.owned!=='boolean'||!session.authenticated||typeof entry.expiresAt!=='number'||!Number.isSafeInteger(entry.expiresAt)||entry.expiresAt<=0)throw Error('account_response_invalid');seen.add(entry.accountRef);return {accountRef:entry.accountRef,owned:entry.owned,session,expiresAt:entry.expiresAt};});
 if(row.currentAccountRef!==null&&!accounts.some(entry=>entry.accountRef===row.currentAccountRef&&entry.owned===row.currentOwned))throw Error('account_response_invalid');
 return {revision,currentAccountRef:row.currentAccountRef as string|null,currentOwned:row.currentOwned as boolean|null,accounts};
}
export function readAccountAdoption(value:unknown):AccountAdoption{const row=accountRecord(value);return {revision:accountRevision(row.revision),session:readAccountPublicSession(row.session)};}
export function readAccountAdoptInput(value:unknown):AccountAdoptInput{const row=accountRecord(value);if(Object.keys(row).some(key=>!['accountRef','expectedRevision'].includes(key))||typeof row.accountRef!=='string'||!ACCOUNT_REF.test(row.accountRef))throw Error('account_request_invalid');try{return {accountRef:row.accountRef,expectedRevision:accountRevision(row.expectedRevision)};}catch{throw Error('account_request_invalid');}}
export function readAccountUnlinkInput(value:unknown):AccountUnlinkInput{const row=accountRecord(value);if(Object.keys(row).some(key=>key!=='expectedRevision'))throw Error('account_request_invalid');try{return {expectedRevision:accountRevision(row.expectedRevision)};}catch{throw Error('account_request_invalid');}}
export function readAccountShareChallenge(value:unknown):AccountShareChallenge{const row=accountRecord(value);if(typeof row.id!=='string'||!ACCOUNT_ID.test(row.id)||typeof row.userCode!=='string'||!/^[A-F0-9]{8}$/.test(row.userCode)||typeof row.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expiresAt)||!Number.isFinite(Date.parse(row.expiresAt)))throw Error('account_response_invalid');return {id:row.id,userCode:row.userCode,expiresAt:row.expiresAt};}
export function readAccountShareRequests(value:unknown):AccountShareRequests{const row=accountRecord(value);if(!Array.isArray(row.requests)||row.requests.length>20)throw Error('account_response_invalid');const seen=new Set<string>();return {requests:row.requests.map(value=>{const entry=accountRecord(value),challenge=readAccountShareChallenge(entry);if(seen.has(challenge.id)||typeof entry.clientName!=='string'||entry.clientName.length<1||entry.clientName.length>120||/[\u0000-\u001f\u007f]/.test(entry.clientName)||!['pwa','tauri','tui','vscode','browser-extension'].includes(String(entry.audience)))throw Error('account_response_invalid');seen.add(challenge.id);return {...challenge,clientName:entry.clientName,audience:entry.audience as AccountShareAudience};})};}
export function readAccountShareApproval(value:unknown):AccountShareApproval{if(accountRecord(value).approved!==true)throw Error('account_response_invalid');return {approved:true};}
export const ACCOUNT_CHALLENGE_TTL_MS = 5 * 60_000;
export const ACCOUNT_MAX_RESPONSE_BYTES = 16_384;
export const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface AccountProof { id: string; action: 'poll'|'status'|'logout'|'usage'; nonce: string; issuedAt: number; signature: string }
export interface AccountMobilityRequest { path: string; bodyDigest: string; accountRef:string; revision:number }
export interface AccountMobilityProof extends Omit<AccountProof,'action'> { action:'mobility'; request:AccountMobilityRequest }
export type AccountControlOperation='team.roster'|'team.invite'|'team.accept'|'team.role'|'team.revoke'|'billing.profile'|'billing.balances'|'billing.invoices'|'billing.portal'|'billing.client-config';
export interface AccountControlRequest {operation:AccountControlOperation;payload:Record<string,unknown>}
export interface AccountControlProof extends Omit<AccountProof,'action'> {action:'control';request:AccountControlRequest}
const accountControlOperations=new Set<AccountControlOperation>(['team.roster','team.invite','team.accept','team.role','team.revoke','billing.profile','billing.balances','billing.invoices','billing.portal','billing.client-config']);
const exactKeys=(row:Record<string,unknown>,keys:string[])=>Object.keys(row).sort().join(',')===keys.slice().sort().join(',');
const accountResourceId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{3,100}$/.test(value)?value:(()=>{throw Error('account_request_invalid');})();
const accountEmail=(value:unknown)=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)?value.toLowerCase():(()=>{throw Error('account_request_invalid');})();
const accountExpectedRevision=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:(()=>{throw Error('account_request_invalid');})();
export function readAccountControlRequest(value:unknown):AccountControlRequest{
 const row=accountRecord(value);if(!exactKeys(row,['operation','payload'])||typeof row.operation!=='string'||!accountControlOperations.has(row.operation as AccountControlOperation))throw Error('account_request_invalid');
 const operation=row.operation as AccountControlOperation,payload=accountRecord(row.payload);let clean:Record<string,unknown>;
 if(['team.roster','billing.profile','billing.balances','billing.invoices','billing.portal','billing.client-config'].includes(operation)){if(Object.keys(payload).length)throw Error('account_request_invalid');clean={};}
 else if(operation==='team.invite'){if(!exactKeys(payload,['email','role','requestId'])||!['member','admin'].includes(String(payload.role))||typeof payload.requestId!=='string'||!ACCOUNT_ID.test(payload.requestId))throw Error('account_request_invalid');clean={email:accountEmail(payload.email),role:payload.role,requestId:payload.requestId};}
 else if(operation==='team.accept'){if(!exactKeys(payload,['email','inviteToken'])||typeof payload.inviteToken!=='string'||!/^utk_team_invite_[A-Za-z0-9_-]{43}$/.test(payload.inviteToken))throw Error('account_request_invalid');clean={email:accountEmail(payload.email),inviteToken:payload.inviteToken};}
 else if(operation==='team.role'){if(!exactKeys(payload,['memberId','expectedRevision','role'])||!['member','admin'].includes(String(payload.role)))throw Error('account_request_invalid');clean={memberId:accountResourceId(payload.memberId),expectedRevision:accountExpectedRevision(payload.expectedRevision),role:payload.role};}
 else {if(!exactKeys(payload,['seatId','expectedRevision']))throw Error('account_request_invalid');clean={seatId:accountResourceId(payload.seatId),expectedRevision:accountExpectedRevision(payload.expectedRevision)};}
 return {operation,payload:clean};
}
export function accountControlProofPayload(proof:Omit<AccountControlProof,'signature'>):string{const request=readAccountControlRequest(proof.request);return JSON.stringify(['uptokey.account.control.v1',proof.id,proof.action,proof.nonce,proof.issuedAt,request.operation,request.payload]);}
export function isAccountMobilityPath(path:string):boolean{return /^\/v1\/workspace\/mobility\/(?:recovery\/(?:create|restore)|objects\/[A-Za-z0-9_:-]{3,100}\/(?:push|pull|remove|resolve))$/.test(path);}
export function readAccountMobilityRequest(value:unknown):AccountMobilityRequest{const row=accountRecord(value);if(Object.keys(row).sort().join(',')!=='accountRef,bodyDigest,path,revision'||typeof row.path!=='string'||!isAccountMobilityPath(row.path)||typeof row.bodyDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.bodyDigest)||typeof row.accountRef!=='string'||!ACCOUNT_REF.test(row.accountRef)||typeof row.revision!=='number'||!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('account_request_invalid');return {path:row.path,bodyDigest:row.bodyDigest,accountRef:row.accountRef,revision:row.revision};}
export function accountMobilityProofPayload(proof:Omit<AccountMobilityProof,'signature'>):string{const request=readAccountMobilityRequest(proof.request);return JSON.stringify(['uptokey.account.mobility.v1',proof.id,proof.action,proof.nonce,proof.issuedAt,request.path,request.bodyDigest,request.accountRef,request.revision]);}
export function isAccountAccessToken(value:unknown):value is string{return typeof value==='string'&&value.length>=8&&value.length<=16000&&!/\s/.test(value)&&!/^utk_/i.test(value);}
export interface AccountPublicUsage {state:'observed'|'not_configured'|'link_required'|'unavailable'|'reauthentication_required';verifiedAt:string;currency?:'USD';unit?:'micro_usd';availableMicros?:number;reservedMicros?:number;spentMicros?:number}
export function readAccountPublicUsage(value:unknown):AccountPublicUsage{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('account_usage_invalid');const row=value as Record<string,unknown>;if(!['observed','not_configured','link_required','unavailable','reauthentication_required'].includes(String(row.state))||typeof row.verifiedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.verifiedAt)||!Number.isFinite(Date.parse(row.verifiedAt)))throw Error('account_usage_invalid');if(row.state==='observed'){if(row.currency!=='USD'||row.unit!=='micro_usd'||![row.availableMicros,row.reservedMicros,row.spentMicros].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1e12))throw Error('account_usage_invalid');return {state:'observed',verifiedAt:row.verifiedAt,currency:'USD',unit:'micro_usd',availableMicros:row.availableMicros as number,reservedMicros:row.reservedMicros as number,spentMicros:row.spentMicros as number};}if(['availableMicros','reservedMicros','spentMicros','currency','unit'].some(key=>row[key]!==undefined))throw Error('account_usage_invalid');return {state:row.state as AccountPublicUsage['state'],verifiedAt:row.verifiedAt};}
export function accountProofPayload(proof: Omit<AccountProof,'signature'>): string { return JSON.stringify(['uptokey.account.broker.v1',proof.id,proof.action,proof.nonce,proof.issuedAt]); }
export function publicAccountProfile(value: unknown): AccountPublicProfile|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;const row=value as Record<string,unknown>,result:AccountPublicProfile={};
 if(typeof row.displayName==='string'&&row.displayName.length>0&&row.displayName.length<=120&&!/[\u0000-\u001f\u007f]/.test(row.displayName))result.displayName=row.displayName;
 if(typeof row.email==='string'&&row.email.length<=254&&!/[\u0000-\u001f\u007f]/.test(row.email)&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email))result.email=row.email;
 if(typeof row.plan==='string'&&['free','individual','team','enterprise'].includes(row.plan))result.plan=row.plan;
 return Object.keys(result).length?result:undefined;
}
export function readAccountPublicSession(value: unknown): AccountPublicSession {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('account_response_invalid');const row=value as Record<string,unknown>;
 if(typeof row.configured!=='boolean'||typeof row.authenticated!=='boolean'||typeof row.loginAvailable!=='boolean'||!['signed_out','connecting','connected','unavailable'].includes(String(row.state))||row.authenticated&&(!row.configured||row.state!=='connected')||!row.authenticated&&(row.profile!==undefined||row.state==='connected'))throw Error('account_response_invalid');
 const profile=publicAccountProfile(row.profile);if(row.profile!==undefined&&!profile)throw Error('account_response_invalid');
 if(row.requiresSignIn!==undefined&&(typeof row.requiresSignIn!=='boolean'||row.authenticated&&row.requiresSignIn))throw Error('account_response_invalid');
 return {configured:row.configured,authenticated:row.authenticated,loginAvailable:row.loginAvailable,state:row.state as AccountPublicSession['state'],...(profile?{profile}:{}),...(row.requiresSignIn!==undefined?{requiresSignIn:row.requiresSignIn as boolean}:{})};
}
export function trustedAccountOrigin(value: string|undefined, production=false): string|undefined {
 if(!value)return undefined;let url:URL;try{url=new URL(value);}catch{throw Error('account_service_origin_invalid');}
 if(url.origin!==value||url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&!production&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('account_service_origin_invalid');return url.origin;
}
