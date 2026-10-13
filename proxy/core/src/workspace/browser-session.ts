import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import type { SecretStore } from '../secret-store.ts';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { readClientRegistration, recordClientEnrollment } from './client-registration.ts';
import {browserEnrollmentKey,isPublicPwaOrigin} from './browser-enrollment.ts';
import {pairedBrowserSessionAuthority,renewPairedBrowserSession} from '../client-keys.ts';

export interface BrowserPublicJwk { kty:'EC'; crv:'P-256'; x:string; y:string; }
export interface BrowserChallenge { challengeId:string; nonce:string; }
type Pending = { publicJwk:BrowserPublicJwk; keyId:string; nonce:string; expiresAt:number; paired?:{origin:string;clientId:string;authority:string} };
const clientIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Validates a P-256 public JWK supplied by a workspace client (browser or native). */
export function parseWorkspacePublicJwk(value:unknown):BrowserPublicJwk {
  if(!isDataRecord(value)) throw new Error('browser_key_invalid');
  if(Object.keys(value).some(key=>!['kty','crv','x','y','ext','key_ops'].includes(key))) throw new Error('browser_key_invalid');
  const key=value as Record<string,unknown>;
  if(key.kty!=='EC'||key.crv!=='P-256'||typeof key.x!=='string'||typeof key.y!=='string'||![key.x,key.y].every(s=>/^[A-Za-z0-9_-]{43}$/.test(s)&&Buffer.from(s,'base64url').toString('base64url')===s)) throw new Error('browser_key_invalid');
  const projected:BrowserPublicJwk={kty:'EC',crv:'P-256',x:key.x,y:key.y};
  createPublicKey({key:{...projected},format:'jwk'});
  return projected;
}

/** PWA proofs retain their existing explicit reconnect behavior and 24h lease.
 * A paired public-PWA/Chrome proof restores only the exact previously approved, still-authorized
 * pairing, with a rolling 12h bearer. It cannot enroll or resurrect revoked authority. */
export class BrowserSessionService {
  private pending=new Map<string,Pending>();
  private queue:Promise<unknown>=Promise.resolve();
  private readonly secrets:SecretStore;
  private readonly now:()=>number;
  constructor(secrets:SecretStore,now:()=>number=Date.now) {this.secrets=secrets;this.now=now;}
  challenge(value:unknown):BrowserChallenge {
    const publicJwk=parseWorkspacePublicJwk(value);
    const now=this.now();
    for(const [id,item] of this.pending) if(item.expiresAt<=now)this.pending.delete(id);
    if(this.pending.size>=128)throw new Error('browser_challenge_capacity');
    const keyId=createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex');
    const challengeId=randomUUID();
    const nonce=`uptokey-workspace-browser-v1:${challengeId}:${keyId}:${randomBytes(32).toString('base64url')}`;
    this.pending.set(challengeId,{publicJwk,keyId,nonce,expiresAt:now+60_000});
    return {challengeId,nonce};
  }
  async challengeExtension(value:unknown,origin:string):Promise<BrowserChallenge> {
    if(!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))throw Error('browser_origin_rejected');
    return this.challengePaired(value,origin);
  }
  async challengePublicPwa(value:unknown,origin:string):Promise<BrowserChallenge> {
    if(!isPublicPwaOrigin(origin))throw Error('browser_origin_rejected');
    return this.challengePaired(value,origin);
  }
  private async challengePaired(value:unknown,origin:string):Promise<BrowserChallenge> {
    const publicJwk=parseWorkspacePublicJwk(value);
    const clientId=await this.secrets.get(browserEnrollmentKey(origin,publicJwk));
    if(!clientId||!clientIdPattern.test(clientId))throw Error('browser_enrollment_rejected');
    const authority=await pairedBrowserSessionAuthority(this.secrets,clientId,origin,JSON.stringify(publicJwk),this.now());
    const result=this.challenge(publicJwk);
    this.pending.get(result.challengeId)!.paired={origin,clientId,authority};
    return result;
  }
  complete(challengeId:unknown,signature:unknown,origin?:string):Promise<{token:string;clientId:string}> {
    // Consume before waiting on vault I/O. Invalid proofs consume their challenge too.
    const pending=typeof challengeId==='string'?this.pending.get(challengeId):undefined;
    if(typeof challengeId==='string')this.pending.delete(challengeId);
    if(!pending||pending.expiresAt<=this.now()||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))return Promise.reject(new Error('browser_proof_invalid'));
    if(pending.paired?origin!==pending.paired.origin:origin?.startsWith('chrome-extension://')||isPublicPwaOrigin(origin))return Promise.reject(new Error('browser_origin_rejected'));
    const bytes=Buffer.from(signature,'base64url');
    if(bytes.length!==64||bytes.toString('base64url')!==signature||!verify('sha256',Buffer.from(pending.nonce),{key:createPublicKey({key:{...pending.publicJwk},format:'jwk'}),dsaEncoding:'ieee-p1363'},bytes))return Promise.reject(new Error('browser_proof_invalid'));
    const result=this.queue.then(async()=>{
      if(pending.expiresAt<=this.now())throw new Error('browser_proof_invalid');
      if(pending.paired)return renewPairedBrowserSession(this.secrets,pending.paired.clientId,pending.paired.origin,JSON.stringify(pending.publicJwk),pending.paired.authority,this.now());
      const account=`local:workspace-browser:${pending.keyId}`;
      const stored=await this.secrets.get(account);
      let record:{publicJwk:BrowserPublicJwk;clientId:string};
      try {
        const value:unknown=stored===undefined?{publicJwk:pending.publicJwk,clientId:randomUUID()}:JSON.parse(stored);
        if(!isDataRecord(value)||Object.keys(value).some(k=>!['publicJwk','clientId'].includes(k))||typeof value.clientId!=='string'||!clientIdPattern.test(value.clientId))throw new Error();
        const publicJwk=parseWorkspacePublicJwk(value.publicJwk);
        if(JSON.stringify(publicJwk)!==JSON.stringify(pending.publicJwk))throw new Error();
        record={publicJwk,clientId:value.clientId};
      }catch{throw new Error('browser_enrollment_invalid');}
      if(stored===undefined)await this.secrets.set(account,JSON.stringify(record));
      await this.secrets.set(`local:client:${record.clientId}:workspace-key`,JSON.stringify(pending.publicJwk));
      // L1: audience fixed by this origin-bound, key-signed enrollment — never by a display name.
      // An explicit administrative transition of this same identity (pwa → tui) is authoritative:
      // renewal keeps the narrower audience instead of failing or silently restoring pwa.
      const current=await readClientRegistration(this.secrets,record.clientId);
      if(!(current?.enrolledVia==='browser-session'&&current.audience==='tui'))await recordClientEnrollment(this.secrets,{clientId:record.clientId,audience:'pwa',enrolledVia:'browser-session'});
      const token=`utk_local_${record.clientId}.${randomBytes(24).toString('base64url')}`;
      // Invalidate the old lease before replacing its token. A failed write must not
      // renew the previous bearer or leave a replacement with an unbounded lifetime.
      // Separate vault accounts are not transactional; reconnect is the recovery path.
      await this.secrets.set(`local:client:${record.clientId}:expires`,new Date(0).toISOString());
      await this.secrets.set(`local:client:${record.clientId}`,token);
      await this.secrets.set(`local:client:${record.clientId}:expires`,new Date(this.now()+86_400_000).toISOString());
      return {token,clientId:record.clientId as string};
    });
    this.queue=result.catch(()=>undefined);return result;
  }
  async enrolledKey(header:string|undefined):Promise<BrowserPublicJwk|undefined> {
    const match=/^Bearer utk_local_([0-9a-f-]{36})\.[A-Za-z0-9_-]+$/.exec(header??'');
    if(!match||!clientIdPattern.test(match[1]!))return undefined;
    const stored=await this.secrets.get(`local:client:${match[1]}:workspace-key`);
    return stored?parseWorkspacePublicJwk(JSON.parse(stored)):undefined;
  }
}
