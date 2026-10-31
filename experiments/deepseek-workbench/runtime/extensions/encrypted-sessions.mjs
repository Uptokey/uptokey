import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {SessionPersistence,SessionAlreadyExistsError,SessionPersistenceNotFoundError,materializeCreateHeader} from '@deepseek-ai/dsh-session-persistence';
import z from '@deepseek-ai/schemastery';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {EncryptedSessionStore} from './encrypted-sessions-store.mjs';

export const name='uptokey-encrypted-sessions';
export const Config=z.object({root:z.string().required(),legacyRoot:z.string().required(),keyPath:z.string().required()});

async function readAll(store,id){
 const handle=await store.open(id,'read');
 try{return{header:handle.header,inheritedEventCount:handle.inheritedEventCount,events:(await handle.read()).events};}
 finally{await handle.close();}
}
function equalSession(left,right){
 return left.inheritedEventCount===right.inheritedEventCount
  &&isDeepStrictEqual(left.header,right.header)&&isDeepStrictEqual(left.events,right.events);
}

export async function verifyLegacySessionParity(legacy,encrypted){
 const records=[];
 const snapshots=[...await legacy.list()].sort((a,b)=>String(a.header.id).localeCompare(String(b.header.id)));
 for(const snapshot of snapshots){
  const id=snapshot.header.id,source=await readAll(legacy,id),target=await readAll(encrypted,id);
  if(!equalSession(source,target))throw Error(`legacy_session_migration_mismatch:${id}`);
  const current=await legacy.stat(id);
  if(!current||current.revision!==snapshot.revision)throw Error(`legacy_session_changed_during_verification:${id}`);
  records.push([String(id),String(snapshot.revision),String((await encrypted.stat(id))?.revision??'')]);
 }
 return Object.freeze({
  verified:true,
  sessionCount:records.length,
  digest:createHash('sha256').update(JSON.stringify(records)).digest('hex'),
 });
}

// Copy every historical plaintext session through the public handle contract.
// The encrypted store publishes the complete first batch atomically. Originals
// remain byte-for-byte as recovery copies; once verified, routing and all future
// writes use only the encrypted copy. Physical retirement is a separate,
// explicitly destructive operation and is intentionally absent here.
export async function migrateLegacySessions(legacy,encrypted){
 const migrated=new Set();
 const snapshots=[...await legacy.list()].sort((a,b)=>String(a.header.id).localeCompare(String(b.header.id)));
 for(const snapshot of snapshots){
  const id=snapshot.header.id,source=await readAll(legacy,id);
  if(!await encrypted.stat(id)){
   const writer=await encrypted.create(source.header,{inheritedEventCount:source.inheritedEventCount});
   try{if(source.events.length)await writer.append(source.events);else await writer.flush();}
   finally{await writer.close();}
  }
  const target=await readAll(encrypted,id);
  if(!equalSession(source,target))throw Error(`legacy_session_migration_mismatch:${id}`);
  const current=await legacy.stat(id);
  if(!current||current.revision!==snapshot.revision)throw Error(`legacy_session_changed_during_migration:${id}`);
  migrated.add(id);
 }
 return migrated;
}

// Public consumers keep the original logical service. The old provider is
// private and is used only for sessions already stored in its directory.
export class CompositeSessionPersistence extends SessionPersistence {
 constructor(ctx,legacy,encrypted,{legacyRetired=false}={}){super(ctx);this.legacy=legacy;this.encrypted=encrypted;this.legacyRetired=legacyRetired;this.creating=new Set();}
 async locate(id,options){
  if(this.legacyRetired){const fresh=await this.encrypted.stat(id,options);return fresh?{store:this.encrypted,snapshot:fresh}:undefined;}
  const [old,fresh]=await Promise.all([this.legacy.stat(id,options),this.encrypted.stat(id,options)]);
  if(old&&fresh)throw Error('session_storage_identity_collision');
  return fresh?{store:this.encrypted,snapshot:fresh}:old?{store:this.legacy,snapshot:old}:undefined;
 }
 async create(header,options){
  options?.signal?.throwIfAborted();
  const snapshot=materializeCreateHeader(header);
  if(this.creating.has(snapshot.id))throw new SessionAlreadyExistsError(snapshot.id);
  this.creating.add(snapshot.id);
  try{
   if(await this.locate(snapshot.id,options))throw new SessionAlreadyExistsError(snapshot.id);
   return await this.encrypted.create(snapshot,options);
  }finally{this.creating.delete(snapshot.id);}
 }
 async open(id,access,options){
  const found=await this.locate(id,options);
  if(!found)throw new SessionPersistenceNotFoundError(id);
  return found.store.open(id,access,options);
 }
 async stat(id,options){return (await this.locate(id,options))?.snapshot;}
 async list(options){
  if(this.legacyRetired)return this.encrypted.list(options);
  const [old,fresh]=await Promise.all([this.legacy.list(options),this.encrypted.list(options)]);
  const seen=new Set(old.map(item=>item.header.id));
  for(const item of fresh)if(seen.has(item.header.id))throw Error('session_storage_identity_collision');else seen.add(item.header.id);
  return [...old,...fresh];
 }
 async flush(){
  const results=await Promise.allSettled(this.legacyRetired?[this.encrypted.flush()]:[this.legacy.flush(),this.encrypted.flush()]);
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,'session_storage_flush_failed');
 }
}

export async function apply(ctx,config){
 const oldRoot=resolve(config.legacyRoot),newRoot=resolve(config.root);
 const contains=(parent,child)=>{const path=relative(parent,child);return path===''||(!path.startsWith('..')&&!isAbsolute(path));};
 if(contains(oldRoot,newRoot)||contains(newRoot,oldRoot))throw Error('session_storage_roots_overlap');
 // Collect child disposers into one ordered resource effect. Removing the
 // public service drains injecting consumers before either tracker closes.
 let service;
 ctx.effect(function*(){
  let legacyCtx,legacy;
  if(existsSync(oldRoot)){
   legacyCtx=ctx.isolate('sessionPersistence');
   legacy=legacyCtx.plugin(Jsonl,{root:config.legacyRoot});
   yield legacy.dispose;
  }
  const encrypted=new EncryptedSessionStore({root:config.root,keyPath:config.keyPath});
  const close=()=>encrypted.close();yield close;
  const routing=encrypted.install(ctx);yield routing;
  service=ctx.plugin({name:'uptokey-encrypted-sessions-service',async apply(serviceCtx){
   await encrypted.ready();
   let old;
   if(legacy){
    await legacy.await();
    old=legacyCtx.get('sessionPersistence');if(!old)throw Error('session_storage_legacy_unavailable');
    await migrateLegacySessions(old,encrypted);
    await legacy.dispose();
   }
   new CompositeSessionPersistence(serviceCtx,old,encrypted,{legacyRetired:true});
  }});
  yield service.dispose;
  // Yielding each raw disposer above transfers it out of Cordis' concurrent
  // parent teardown. This finalizer attempts all ordered stages even on error;
  // later calls to those same transferred disposers are idempotent no-ops.
  yield async()=>{
   const failures=[];
   for(const dispose of [service.dispose,routing,close,legacy?.dispose].filter(Boolean))try{await dispose();}catch(error){failures.push(error);}
   if(failures.length)throw new AggregateError(failures,'session_storage_dispose_failed');
  };
 },'Uptokey session persistence resources');
 await service.await();
}
