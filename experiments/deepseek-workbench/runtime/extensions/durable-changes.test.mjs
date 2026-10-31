import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rmdir,writeFile,readFile,chmod,symlink,readdir,lstat,mkdir,open,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {ChangeArchive,apply} from './durable-changes.mjs';
const summary={turn:1,cwd:'/workspace/demo',files:[{path:'demo.html',display:'demo.html',added:1,deleted:0}],total:1,added:1,deleted:0};
const diff={kind:'text',path:'demo.html',display:'demo.html',before:false,after:true,hunks:[{oldStart:1,oldLines:0,newStart:1,newLines:1,lines:['+<h1>Uptokey synthetic</h1>']}],coarse:false};
const digest=value=>createHash('sha256').update(value).digest('hex');
const record=(id,seq,change=diff)=>({version:1,id,seq,summary,diffs:[change]});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'uptokey-changes-')),path=join(root,'archive'),keyPath=join(root,'key');
 await writeFile(keyPath,randomBytes(32).toString('hex'),{mode:0o400});
 t.after(async()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep+'uptokey-changes-'))throw Error('Unexpected test cleanup path');await rm(root,{recursive:true,force:true});});
 return {root,path,keyPath,options:{keyPath}};
}
async function boot(t,options={}){const f=await fixture(t),archive=new ChangeArchive(f.path,{...f.options,...options});await archive.ready();t.after(()=>archive.close());return{...f,archive};}

 test('new envelopes hide filenames and code, reopen into synchronous caller-owned clones',async t=>{
 const {path,options,archive}=await boot(t);
 const value=structuredClone(summary),change=structuredClone(diff);
 await archive.write('session-a',9,value,[change]);
 const file=archive.path('session-a',9),disk=await readFile(file,'utf8'),envelope=JSON.parse(disk);
 assert.equal(envelope.schemaVersion,2);assert.equal(envelope.suiteId,'uptokey-vault-v1');assert.equal(envelope.resourceScope,'workspace-changes');
 assert.equal(envelope.objectId,digest(JSON.stringify(['session-a',9])));
 for(const text of ['session-a','demo.html','/workspace/demo','Uptokey synthetic'])assert.equal(disk.includes(text),false);
 assert.deepEqual(await readdir(path),[envelope.objectId+'.json']);
 const reopened=new ChangeArchive(path,options);await reopened.ready();t.after(()=>reopened.close());
 const result=reopened.read('session-a',9);assert.equal(typeof result?.then,'undefined');assert.deepEqual(result,record('session-a',9));
 result.summary.files[0].path='caller mutation';result.diffs[0].hunks[0].lines.push('caller mutation');
 assert.deepEqual(reopened.read('session-a',9),record('session-a',9));assert.deepEqual(value,summary);assert.deepEqual(change,diff);
 assert.equal(reopened.read('session-b',9),undefined);assert.equal(reopened.read('session-a',10),undefined);
 assert.throws(()=>reopened.read('session-a',-1),/identity/);
 if(process.platform!=='win32'){assert.equal((await lstat(path)).mode&0o777,0o700);assert.equal((await lstat(file)).mode&0o777,0o600);}
 });

 test('AAD rejects an envelope moved to another session or sequence without replacing bytes',async t=>{
 const {path,options,archive}=await boot(t);await archive.write('session-a',9,summary,[diff]);await archive.write('session-b',10,summary,[diff]);
 const source=await readFile(archive.path('session-b',10));await writeFile(archive.path('session-a',9),source);
 const reopened=new ChangeArchive(path,options);await assert.rejects(reopened.ready(),/authentication/);t.after(()=>reopened.close());
 await assert.rejects(archive.write('session-a',9,summary,[diff]),/changed/);
 assert.deepEqual(await readFile(archive.path('session-a',9)),source);assert.deepEqual(await readFile(archive.path('session-b',10)),source);
 });

 test('tamper, unknown envelope fields and unsupported versions fail closed without rewrite',async t=>{
 const f=await boot(t);await f.archive.write('session-a',9,summary,[diff]);const original=await readFile(f.archive.path('session-a',9),'utf8');
 for(const edit of [e=>{e.ciphertext=(e.ciphertext[0]==='A'?'B':'A')+e.ciphertext.slice(1);},e=>{e.unrecognized='synthetic';},e=>{e.schemaVersion=999;}]){
  const envelope=JSON.parse(original);edit(envelope);const bytes=JSON.stringify(envelope);await writeFile(f.archive.path('session-a',9),bytes);
  const rejected=new ChangeArchive(f.path,f.options);await assert.rejects(rejected.ready(),/authentication/);await rejected.close();
  await assert.rejects(f.archive.write('session-a',9,summary,[diff]),/changed/);assert.equal(await readFile(f.archive.path('session-a',9),'utf8'),bytes);
 }
 });

 test('missing, malformed or replaced keys never reset an existing encrypted record',async t=>{
 const f=await boot(t);await f.archive.write('session-a',9,summary,[diff]);const before=await readFile(f.archive.path('session-a',9));
 await rm(f.keyPath);await assert.rejects(f.archive.write('session-a',9,summary,[diff]),/key_unavailable/);
 await writeFile(f.keyPath,randomBytes(32).toString('hex'),{mode:0o400});
 await assert.rejects(f.archive.write('session-a',9,summary,[diff]),/key_unavailable/);
 const wrong=new ChangeArchive(f.path,f.options);await assert.rejects(wrong.ready(),/authentication/);await wrong.close();
 await chmod(f.keyPath,0o600);await writeFile(f.keyPath,'x'.repeat(64));await chmod(f.keyPath,0o400);
 const malformed=new ChangeArchive(f.path,f.options);await assert.rejects(malformed.ready(),/key_unavailable/);await malformed.close();
 assert.deepEqual(await readFile(f.archive.path('session-a',9)),before);assert.deepEqual(f.archive.read('session-a',9).summary,summary);
 });

 test('legacy plaintext stays readable and byte-identical when a new encrypted record is added',async t=>{
 const f=await fixture(t);await mkdir(f.path,{mode:0o700});const archive=new ChangeArchive(f.path,f.options),old=JSON.stringify(record('legacy',2))+'\n';
 await writeFile(archive.path('legacy',2),old,{mode:0o600});await archive.ready();t.after(()=>archive.close());
 assert.deepEqual(archive.read('legacy',2),record('legacy',2));await archive.write('new-session',3,summary,[diff]);
 assert.equal(await readFile(archive.path('legacy',2),'utf8'),old);assert.equal(JSON.parse(await readFile(archive.path('new-session',3),'utf8')).schemaVersion,2);
 });

 test('a high-bit key byte is rejected rather than folded into valid ASCII hex',async t=>{
 const f=await fixture(t),key=Buffer.from('a'.repeat(64));key[0]=0xe1;
 await chmod(f.keyPath,0o600);await writeFile(f.keyPath,key);await chmod(f.keyPath,0o400);
 const archive=new ChangeArchive(f.path,f.options);await assert.rejects(archive.ready(),/key_unavailable/);
 assert.deepEqual(await readFile(f.keyPath),key);assert.deepEqual(await readdir(f.path),[]);await archive.close();
 });

 test('a record growing after stat is rejected with a checked-size allocation',async t=>{
 const f=await fixture(t);await mkdir(f.path,{mode:0o700});const archive=new ChangeArchive(f.path,f.options);
 const file=archive.path('legacy-growing',1),bytes=Buffer.from(JSON.stringify(record('legacy-growing',1)));
 await writeFile(file,bytes,{mode:0o600});
 const probe=await open(f.keyPath,'r'),prototype=Object.getPrototypeOf(probe),originalRead=prototype.read;await probe.close();
 const allocationSizes=[];let grown=false;
 t.mock.method(prototype,'read',async function(buffer,...args){
  if(buffer.length>65){
   allocationSizes.push(buffer.length);
   if(!grown){grown=true;await appendFile(file,Buffer.alloc(65536,32));}
  }
  return originalRead.call(this,buffer,...args);
 });
 await assert.rejects(archive.ready(),/authentication/);await archive.close();
 assert.equal(grown,true);assert.ok(allocationSizes.length>0);
 assert.ok(allocationSizes.every(size=>size<=bytes.length+1));
 assert.equal((await lstat(file)).size,bytes.length+65536);
 });

 test('oversized and malformed writes preserve the last accepted record',async t=>{
 const {archive}=await boot(t);await archive.write('session-a',9,summary,[diff]);const before=await readFile(archive.path('session-a',9));
 await assert.rejects(archive.write('session-a',9,summary,[{text:'x'.repeat(8*1024*1024)}]),/size/);
 await assert.rejects(archive.write('session-a',9,summary,[]),/record/);
 assert.deepEqual(await readFile(archive.path('session-a',9)),before);assert.deepEqual(archive.read('session-a',9),record('session-a',9));
 });

 test('async writers serialize quota and only committed records enter the cache',async t=>{
 const bytes=Buffer.byteLength(JSON.stringify(record('session-a',9))),f=await boot(t,{maxCacheBytes:bytes});
 const writes=await Promise.allSettled([f.archive.write('session-a',9,summary,[diff]),f.archive.write('session-b',9,summary,[diff])]);
 assert.equal(writes[0].status,'fulfilled');assert.equal(writes[1].status,'rejected');assert.match(writes[1].reason.message,/quota/);
 assert.equal(f.archive.cache.size,1);assert.equal(f.archive.cacheBytes,bytes);assert.equal(f.archive.read('session-b',9),undefined);
 assert.equal((await readdir(f.path)).filter(name=>name.endsWith('.json')).length,1);
 const tinyDisk=new ChangeArchive(join(f.root,'tiny-disk'),{keyPath:f.keyPath,maxDiskBytes:1});await tinyDisk.ready();
 await assert.rejects(tinyDisk.write('session-a',9,summary,[diff]),/quota/);assert.equal(tinyDisk.cache.size,0);assert.deepEqual(await readdir(tinyDisk.directory),[]);await tinyDisk.close();
 });

 test('preload enforces the plaintext cache budget and close drains then clears retained buffers',async t=>{
 const f=await boot(t);const first=f.archive.write('session-a',9,summary,[diff]),second=f.archive.write('session-b',9,summary,[diff]);
 await f.archive.close();await Promise.all([first,second]);assert.equal(f.archive.cache.size,0);assert.equal(f.archive.cacheBytes,0);
 const small=new ChangeArchive(f.path,{keyPath:f.keyPath,maxCacheBytes:Buffer.byteLength(JSON.stringify(record('session-a',9)))});
 await assert.rejects(small.ready(),/quota/);assert.equal(small.cache.size,0);assert.equal(small.cacheBytes,0);await small.close();
 assert.throws(()=>f.archive.read('session-a',9),/closed/);await assert.rejects(f.archive.write('other',1,summary,[diff]),/closed/);
 });

 test('private keys and no-follow archive paths are enforced on the Linux runtime',async t=>{
 const f=await fixture(t);
 if(process.platform!=='win32'){
  await chmod(f.keyPath,0o600);const writable=new ChangeArchive(f.path,f.options);await assert.rejects(writable.ready(),/key_unavailable/);await writable.close();await chmod(f.keyPath,0o400);
  // Key admission can create the empty archive directory before refusing it.
  assert.deepEqual(await readdir(f.path),[]);await rmdir(f.path);
  const target=join(f.root,'outside');await mkdir(target,{mode:0o700});await symlink(target,f.path);const linked=new ChangeArchive(f.path,f.options);await assert.rejects(linked.ready(),/link/);await linked.close();await rm(f.path);
  await mkdir(f.path,{mode:0o700});const archive=new ChangeArchive(f.path,f.options);await archive.ready();await archive.write('session-a',9,summary,[diff]);await archive.close();
  const file=archive.path('session-a',9),original=await readFile(file);await writeFile(join(target,'record'),original,{mode:0o600});await rm(file);await symlink(join(target,'record'),file);
  const recordLink=new ChangeArchive(f.path,f.options);await assert.rejects(recordLink.ready(),/authentication/);await recordLink.close();assert.deepEqual(await readFile(join(target,'record')),original);
 }else{
  const archive=new ChangeArchive(f.path,f.options);await archive.ready();await archive.write('session-a',9,summary,[diff]);await archive.close();
  t.diagnostic('POSIX permission/symlink cases require the production Linux container; Windows only exercises its regular-file path here.');
 }
 });

 test('fixture preload and synchronous lookup measurements retain one serialized buffer per record',async t=>{
 const f=await boot(t),change={...diff,hunks:[{...diff.hunks[0],lines:['+'+'synthetic '.repeat(1600)]}]};
 for(let i=0;i<16;i++)await f.archive.write('fixture-'+i,i,summary,[change]);await f.archive.close();
 const reopened=new ChangeArchive(f.path,f.options),start=performance.now();await reopened.ready();const preloadMs=performance.now()-start,readStart=performance.now();
 for(let i=0;i<160;i++)assert.equal(reopened.read('fixture-'+i%16,i%16).diffs.length,1);
 const synchronousReadsMs=performance.now()-readStart;
 assert.equal(reopened.cache.size,16);assert.ok(reopened.cacheBytes<=128*1024*1024);
 for(const entry of reopened.cache.values())assert.ok(Buffer.isBuffer(entry.plain));
 t.diagnostic(JSON.stringify({fixtureRecords:16,serializedPlaintextBytes:reopened.cacheBytes,preloadMs,synchronousReads:160,synchronousReadsMs,scope:'synthetic fixture only; not a heap or global latency claim'}));await reopened.close();
 });

 test('native append order, disposal flush, restart fallback and cancellation preserve live contracts',async t=>{
 const f=await fixture(t);let listener,dispose,live,warnings=0;
 const originalSummary=()=>live,originalDiff=async()=>live?diff:undefined,service={summary:originalSummary,diff:originalDiff};
 const context={workspaceChanges:service,logger:{warn:()=>{warnings++;}},on:(_,fn)=>{listener=fn;return()=>{listener=undefined;}},effect:fn=>{dispose=fn();}};
 await apply(context,{path:f.path,keyPath:f.keyPath});listener({id:'session-a'},{type:'workspace/changes',seq:9});live=summary;
 await dispose();assert.equal(service.summary,originalSummary);assert.equal(service.diff,originalDiff);live=undefined;
 await apply(context,{path:f.path,keyPath:f.keyPath});assert.deepEqual(service.summary('session-a',9),summary);assert.deepEqual(await service.diff('session-a',9,0,new AbortController().signal),diff);
 await assert.rejects(service.diff('session-a',9,0,AbortSignal.abort()));assert.equal(service.summary('other',9),undefined);await dispose();assert.equal(warnings,0);
 });

 test('archive initialization failure leaves the original live service active with a fixed warning',async t=>{
 const f=await fixture(t),warnings=[];let dispose;
 await rm(f.keyPath);const service={summary:()=>summary,diff:async()=>diff},original={...service};
 await apply({workspaceChanges:service,logger:{warn:message=>warnings.push(message)},on:()=>assert.fail('Failed archive must not subscribe'),effect:fn=>{dispose=fn();}},{path:f.path,keyPath:f.keyPath});
 assert.equal(service.summary,original.summary);assert.equal(service.diff,original.diff);assert.deepEqual(service.summary('live',1),summary);assert.equal(warnings.length,1);assert.equal(warnings[0].includes(f.root),false);await dispose();
 });

 test('actual Cordis provider lifecycle persists encrypted changes and restores the original methods',async t=>{
 const {Context}=await import('@deepseek-ai/cordis');const f=await fixture(t),ctx=new Context();let live;
 const service={summary:()=>live,diff:async()=>live?diff:undefined},original={...service};ctx.provide('workspaceChanges',service);
 const plugin={name:'test-archive',inject:['workspaceChanges'],apply};
 const first=ctx.plugin(plugin,{path:f.path,keyPath:f.keyPath});await first;
 ctx.emit('session/event',{id:'session-cordis'},{type:'workspace/changes',seq:4});live=summary;await first.dispose();live=undefined;
 assert.equal(service.summary,original.summary);assert.equal(service.diff,original.diff);
 const reopened=ctx.plugin(plugin,{path:f.path,keyPath:f.keyPath});await reopened;
 assert.deepEqual(ctx.workspaceChanges.summary('session-cordis',4),summary);assert.deepEqual(await ctx.workspaceChanges.diff('session-cordis',4,0,new AbortController().signal),diff);await reopened.dispose();
 assert.equal(JSON.parse(await readFile(new ChangeArchive(f.path,f.options).path('session-cordis',4),'utf8')).schemaVersion,2);
 });
