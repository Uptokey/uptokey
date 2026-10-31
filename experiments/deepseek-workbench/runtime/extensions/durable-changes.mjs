import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,opendir,rename,unlink} from 'node:fs/promises';
import {join,resolve,parse,relative,sep} from 'node:path';
import {VaultCrypto} from './vendor/vault-crypto.ts';

// New writes use the existing vault cipher; legacy records stay byte-for-byte.
export const name='uptokey-durable-changes';
export const inject=['workspaceChanges'];
const LIMIT=8*1024*1024,ARCHIVE_LIMIT=128*1024*1024;
// Serialized plaintext and envelope disk bytes have separate bounds, not RSS guarantees.
const FILE_LIMIT=LIMIT*2,DISK_LIMIT=ARCHIVE_LIMIT*2,SCOPE='workspace-changes';
const FILE=/^[a-f0-9]{64}\.json$/;
const privateMode=stat=>process.platform==='win32'||!(stat.mode&0o077);
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const hash=data=>createHash('sha256').update(data).digest('hex');
const safeError=(error,fallback)=>Error(/^changes_[a-z_]+$/.test(error?.message??'')?error.message:fallback);

async function noLinkedParents(path){
 const root=parse(path).root;let current=root;
 for(const component of relative(root,path).split(sep).filter(Boolean)){
  current=join(current,component);
  try{if((await lstat(current)).isSymbolicLink())throw Error('changes_archive_link');}
  catch(error){if(error.code==='ENOENT')return;throw error;}
 }
}
async function readPrivate(path,limit,key=false){
 await noLinkedParents(path);
 const before=await lstat(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||!privateMode(before)||before.size>limit
  ||key&&process.platform!=='win32'&&(before.mode&0o777)!==0o400)throw Error('changes_archive_file');
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
 let data;
 try{
  const checked=await handle.stat();
  if(!sameFile(before,checked))throw Error('changes_archive_changed');
  // One extra byte detects growth without trusting a size checked before I/O.
  // Tiny records allocate their checked size, never a full archive-size buffer.
  data=Buffer.alloc(Math.min(checked.size+1,limit+1));let used=0;
  while(used<data.length){
   const {bytesRead}=await handle.read(data,used,Math.min(65536,data.length-used),null);
   if(!bytesRead)break;used+=bytesRead;
  }
  if(used>limit||used!==checked.size||!sameFile(checked,await handle.stat()))throw Error('changes_archive_file');
  data=data.subarray(0,used);
  return {data,stat:checked};
 }catch(error){data?.fill(0);throw error;}
 finally{await handle.close();}
}
function identity(id,seq){
 if(typeof id!=='string'||!id||!Number.isSafeInteger(seq)||seq<0)throw Error('changes_archive_identity');
 return hash(JSON.stringify([id,seq]));
}
function validate(plain,expected){
 let record;try{record=JSON.parse(plain.toString('utf8'));}catch{throw Error('changes_archive_record');}
 if(!record||Object.keys(record).sort().join(',')!=='diffs,id,seq,summary,version'||record.version!==1
  ||identity(record.id,record.seq)!==expected||!Array.isArray(record.summary?.files)||!Array.isArray(record.diffs)
  ||record.diffs.length!==record.summary.files.length)throw Error('changes_archive_record');
}

export class ChangeArchive {
 constructor(directory,{keyPath,maxCacheBytes=ARCHIVE_LIMIT,maxDiskBytes=DISK_LIMIT}={}){
  this.directory=resolve(directory);this.keyPath=keyPath;
  if(!Number.isSafeInteger(maxCacheBytes)||maxCacheBytes<1||maxCacheBytes>ARCHIVE_LIMIT
   ||!Number.isSafeInteger(maxDiskBytes)||maxDiskBytes<1||maxDiskBytes>DISK_LIMIT)throw Error('changes_archive_limits');
  this.maxCacheBytes=maxCacheBytes;this.maxDiskBytes=maxDiskBytes;
  this.cache=new Map();this.cacheBytes=0;this.diskBytes=0;this.accepting=true;this.loaded=false;this.tail=Promise.resolve();
  const secrets={
   get:async account=>{
    if(account!=='vault:key')throw Error('changes_archive_key_account');
    let data;
    try{
     if(typeof this.keyPath!=='string'||!this.keyPath)throw Error();
     ({data}=await readPrivate(resolve(this.keyPath),64,true));
     const value=data.toString('utf8');if(!/^[a-f0-9]{64}$/.test(value))throw Error();
     const fingerprint=hash(data);
     if(this.keyFingerprint&&this.keyFingerprint!==fingerprint)throw Error();
     this.keyFingerprint=fingerprint;return value;
    }catch{throw Error('changes_archive_key_unavailable');}
    finally{data?.fill(0);}
   },
   set:async()=>{throw Error('changes_archive_key_readonly');},
   delete:async()=>{throw Error('changes_archive_key_readonly');},
  };
  this.crypto=new VaultCrypto(secrets,{vaultId:'deepseek-workbench',tenantScope:'local',maxPayloadBytes:LIMIT});
 }
 path(id,seq){return join(this.directory,identity(id,seq)+'.json');}
 async checkDirectory(){
  await noLinkedParents(this.directory);const stat=await lstat(this.directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!privateMode(stat))throw Error('changes_archive_directory');
  if(this.directoryIdentity&&(this.directoryIdentity.dev!==stat.dev||this.directoryIdentity.ino!==stat.ino))throw Error('changes_archive_changed');
  return stat;
 }
 async decode(filename){
  let raw,plain;
  try{
   const opened=await readPrivate(join(this.directory,filename),FILE_LIMIT);raw=opened.data;
   let record;try{record=JSON.parse(raw.toString('utf8'));}catch{throw Error('changes_archive_record');}
   if(Object.hasOwn(record??{},'schemaVersion')){
    const decrypted=await this.crypto.decryptObject(record,{objectId:filename.slice(0,-5),objectVersion:1,resourceScope:SCOPE});
    plain=Buffer.from(decrypted.buffer,decrypted.byteOffset,decrypted.byteLength);
   }else{plain=raw;raw=undefined;}
   if(plain.length>LIMIT)throw Error('changes_archive_size');
   validate(plain,filename.slice(0,-5));
   const result={plain,stat:opened.stat};plain=undefined;return result;
  }catch{throw Error('changes_archive_authentication_failed');}
  finally{raw?.fill(0);plain?.fill(0);}
 }
 ready(){
  if(!this.readyPromise){
   if(!this.accepting)return Promise.reject(Error('changes_archive_closed'));
   this.readyPromise=this.load();
  }
  return this.readyPromise;
 }
 async load(){
  const staged=new Map();let bytes=0,disk=0;
  try{
   await noLinkedParents(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});
   this.directoryIdentity=await this.checkDirectory();await this.crypto.ensureVaultKey();
   const directory=await opendir(this.directory);
   for await(const item of directory){
    if(!item.name.endsWith('.json'))continue;
    if(!FILE.test(item.name))throw Error('changes_archive_filename');
    const entry=await this.decode(item.name);bytes+=entry.plain.length;disk+=entry.stat.size;
    if(bytes>this.maxCacheBytes||disk>this.maxDiskBytes){entry.plain.fill(0);throw Error('changes_archive_quota');}
    staged.set(item.name,entry);
   }
   await this.checkDirectory();this.cache=staged;this.cacheBytes=bytes;this.diskBytes=disk;this.loaded=true;
  }catch(error){for(const entry of staged.values())entry.plain.fill(0);throw safeError(error,'changes_archive_unavailable');}
 }
 read(id,seq){
  const filename=identity(id,seq)+'.json';
  if(!this.accepting)throw Error('changes_archive_closed');
  if(!this.loaded)throw Error('changes_archive_not_ready');
  const entry=this.cache.get(filename);
  // Fresh caller-owned objects; the cache retains only one serialized Buffer.
  return entry?JSON.parse(entry.plain.toString('utf8')):undefined;
 }
 async unchangedInventory(){
  await this.checkDirectory();let count=0;
  const directory=await opendir(this.directory);
  for await(const item of directory){
   if(!item.name.endsWith('.json'))continue;
   const previous=this.cache.get(item.name),stat=await lstat(join(this.directory,item.name));
   if(!FILE.test(item.name)||!previous||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!privateMode(stat)
    ||!sameFile(previous.stat,stat))throw Error('changes_archive_changed');
   count++;
  }
  if(count!==this.cache.size)throw Error('changes_archive_changed');
 }
 write(id,seq,summary,diffs){
  if(!this.accepting)return Promise.reject(Error('changes_archive_closed'));
  const filename=identity(id,seq)+'.json',readiness=this.ready();
  const attempt=this.tail.then(async()=>{
   await readiness;let plain,temp;
   try{
    plain=Buffer.from(JSON.stringify({version:1,id,seq,summary,diffs}));
    if(plain.length>LIMIT)throw Error('changes_archive_size');validate(plain,filename.slice(0,-5));
    const previous=this.cache.get(filename),cacheBytes=this.cacheBytes-(previous?.plain.length??0)+plain.length;
    if(cacheBytes>this.maxCacheBytes)throw Error('changes_archive_quota');
    const envelope=await this.crypto.encryptObject(filename.slice(0,-5),plain,{resourceScope:SCOPE});
    const serialized=JSON.stringify(envelope),size=Buffer.byteLength(serialized),diskBytes=this.diskBytes-(previous?.stat.size??0)+size;
    if(size>FILE_LIMIT||diskBytes>this.maxDiskBytes)throw Error('changes_archive_quota');
    await this.crypto.ensureVaultKey();await this.checkDirectory();
    temp=join(this.directory,filename+'.'+randomUUID()+'.tmp');
    const handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
    try{await handle.writeFile(serialized,'utf8');await handle.sync();}finally{await handle.close();}
    // External changes invalidate this owner instead of overwriting stale or
    // unauthenticated bytes. Accepted async writes share one serialized tail.
    await this.unchangedInventory();await rename(temp,join(this.directory,filename));temp=undefined;
    const stat=await lstat(join(this.directory,filename));this.cache.set(filename,{plain,stat});plain=undefined;
    previous?.plain.fill(0);this.cacheBytes=cacheBytes;this.diskBytes=diskBytes;
   }finally{
    plain?.fill(0);
    if(temp)try{await unlink(temp);}catch(error){if(error.code!=='ENOENT')throw Error('changes_archive_cleanup');}
   }
  }).catch(error=>{throw safeError(error,'changes_archive_write_failed');});
  this.tail=attempt.catch(()=>undefined);return attempt;
 }
 close(){
  if(!this.closePromise){
   this.accepting=false;
   this.closePromise=Promise.allSettled([this.tail,this.readyPromise]).then(()=>{
    for(const entry of this.cache.values())entry.plain.fill(0);
    this.cache.clear();this.cacheBytes=0;this.diskBytes=0;this.loaded=false;
   });
  }
  return this.closePromise;
 }
}

export async function apply(ctx,config={}){
 const archive=new ChangeArchive(config.path||'/home/node/.dsh/workspace-changes',{keyPath:config.keyPath});
 const service=ctx.workspaceChanges,originalSummary=service.summary,originalDiff=service.diff;
 const summary=(...args)=>originalSummary.apply(service,args),diff=(...args)=>originalDiff.apply(service,args);
 const pending=new Set();let closed=false,warned=false,off;
 const warn=()=>{if(!warned){warned=true;ctx.logger.warn('Uptokey change archive unavailable; live changes remain available.');}};
 const read=(id,seq)=>{try{return archive.read(id,seq);}catch{warn();return undefined;}};
 const wrappedSummary=(id,seq)=>summary(id,seq)??read(id,seq)?.summary;
 const wrappedDiff=async(id,seq,index,signal)=>{signal?.throwIfAborted();return await diff(id,seq,index,signal)??read(id,seq)?.diffs[index]??undefined;};
 ctx.effect(()=>async()=>{
  closed=true;off?.();await Promise.allSettled([...pending]);
  if(service.summary===wrappedSummary)service.summary=originalSummary;
  if(service.diff===wrappedDiff)service.diff=originalDiff;
  await archive.close();
 });
 try{await archive.ready();}catch{warn();await archive.close();return;}
 if(closed)return;
 service.summary=wrappedSummary;service.diff=wrappedDiff;
 off=ctx.on('session/event',(session,event)=>{
  if(closed||event.type!=='workspace/changes')return;
  // The native recorder commits its record just after appending this event.
  const work=Promise.resolve().then(async()=>{
   const value=summary(session.id,event.seq);if(!value)throw Error('changes_native_summary_missing');
   const diffs=[],signal=AbortSignal.timeout(30000);let bytes=Buffer.byteLength(JSON.stringify(value));
   for(let i=0;i<value.files.length;i++){
    const item=await diff(session.id,event.seq,i,signal);if(!item)throw Error('changes_native_diff_missing');
    bytes+=Buffer.byteLength(JSON.stringify(item));if(bytes>LIMIT)throw Error('changes_archive_size');diffs.push(item);
   }
   await archive.write(session.id,event.seq,value,diffs);
  }).catch(warn);
  pending.add(work);void work.finally(()=>pending.delete(work));
 });
}
