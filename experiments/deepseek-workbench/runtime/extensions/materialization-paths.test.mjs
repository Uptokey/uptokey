import test from 'node:test';
import assert from 'node:assert/strict';
import {installImagePathHydration} from './encrypted-images.mjs';
import {installFilePathHydration} from './encrypted-files.mjs';
import {installAttachmentPreview} from './attachment-preview.mjs';
import {attachmentPreviewPath} from '../contracts/file-preview.mjs';

function fixture() {
  const calls=[];const original=async function(path){calls.push('base:'+path);return path;};
  const stat=async function(path,options,signal){signal?.throwIfAborted();calls.push('lstat:'+path);return{type:path==='/workspace/link'?'symlink':'file'};};
  const fs={resolve:original,lstat:stat,processPath:path=>path};
  const owner=name=>({async ensureMaterializedPath(path,signal){signal.throwIfAborted();calls.push(name+':'+path);return path?.startsWith('/'+name+'/');}});
  return{fs,original,stat,calls,images:owner('images'),files:owner('files')};
}
for(const first of ['images','files'])test('image/file owners unload safely with '+first+' first',async()=>{
  const f=fixture(),a=installImagePathHydration(f.fs,f.images),b=installFilePathHydration(f.fs,f.files);
  const owners={images:a,files:b},other=first==='images'?'files':'images';
  assert.equal(await f.fs.resolve('/files/a.csv'),'/files/a.csv');
  await owners[first].dispose();f.calls.length=0;
  assert.equal(await f.fs.resolve('/'+other+'/b'),'/'+other+'/b');
  assert.equal(f.calls.some(value=>value.startsWith(first+':')),false);
  assert.ok(f.calls.some(value=>value.startsWith(other+':')));
  await owners[other].dispose();assert.equal(f.fs.resolve,f.original);
  assert.equal(f.fs.lstat,f.stat);
  assert.equal(await f.fs.resolve('/plain'),'/plain');
});

test('cold metadata prepares the requested object without resolving symlink targets',async()=>{
  const f=fixture(),a=installImagePathHydration(f.fs,f.images),b=installFilePathHydration(f.fs,f.files);
  assert.equal((await f.fs.lstat('/images/cold.png',{},new AbortController().signal)).type,'file');
  assert.deepEqual(f.calls,['images:/images/cold.png','files:/images/cold.png','lstat:/images/cold.png']);
  f.calls.length=0;
  assert.equal((await f.fs.lstat('/workspace/link',{},new AbortController().signal)).type,'symlink');
  assert.deepEqual(f.calls,['images:/workspace/link','files:/workspace/link','lstat:/workspace/link']);
  await a.dispose();await b.dispose();
});

test('metadata cancellation and owner unload abort pending preparation before no-follow inspection',async()=>{
  const f=fixture();let entered;const started=new Promise(done=>{entered=done;});
  f.files.ensureMaterializedPath=async(path,signal)=>new Promise((_,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  const a=installFilePathHydration(f.fs,f.files),stop=new AbortController();
  const first=assert.rejects(f.fs.lstat('/files/cold.csv',{},stop.signal),{code:'FS_ABORTED'});
  await started;stop.abort();await first;
  const second=assert.rejects(f.fs.lstat('/files/cold.csv',{},new AbortController().signal),{code:'FS_ABORTED'});
  await Promise.resolve();await a.dispose();await second;
  assert.equal(f.calls.some(value=>value.startsWith('lstat:')),false);assert.equal(f.fs.lstat,f.stat);
});

for(const first of ['images','files'])test('virtual metadata composes with the shared router, unload '+first+' first',async()=>{
  const f=fixture(),a=installImagePathHydration(f.fs,f.images),b=installFilePathHydration(f.fs,f.files);
  const ref={attachmentId:'sha256:'+'a'.repeat(64),name:'demo.csv',bytes:3};
  const alias=installAttachmentPreview(f.fs,{fileHostPath:()=>'/files/demo.csv'});
  assert.equal((await f.fs.lstat(attachmentPreviewPath(ref),{},new AbortController().signal)).type,'file');
  assert.deepEqual(f.calls,['images:/files/demo.csv','files:/files/demo.csv','lstat:/files/demo.csv']);
  const owners={images:a,files:b},other=first==='files'?'images':'files';
  await owners[first].dispose();f.calls.length=0;
  await f.fs.lstat(attachmentPreviewPath(ref),{},new AbortController().signal);
  assert.equal(f.calls.some(value=>value.startsWith(first+':')),false);
  await owners[other].dispose();alias.dispose();
  // A captured detached wrapper remains a passthrough after its owners leave.
  f.calls.length=0;await f.fs.lstat('/workspace/plain',{},new AbortController().signal);
  assert.deepEqual(f.calls,['lstat:/workspace/plain']);
});

test('owner unload aborts an in-flight resolver and preserves the other owner',async()=>{
  const f=fixture();let entered;const waiting=new Promise(resolve=>{entered=resolve;});
  f.images.ensureMaterializedPath=async(path,signal)=>{entered();return await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
  const a=installImagePathHydration(f.fs,f.images),b=installFilePathHydration(f.fs,f.files);
  const pending=f.fs.resolve('/images/a');const failure=assert.rejects(pending,{code:'FS_ABORTED'});await waiting;
  await a.dispose();await failure;assert.equal(await f.fs.resolve('/files/a'),'/files/a');
  await b.dispose();assert.equal(f.fs.resolve,f.original);
});

test('an external wrapper capturing the router remains usable after all owners unload',async()=>{
  const f=fixture(),a=installImagePathHydration(f.fs,f.images),captured=f.fs.resolve;
  const external=async function(path,options){return await captured.call(this,path,options);};
  Object.defineProperty(f.fs,'resolve',{value:external,configurable:true,writable:true});
  await a.dispose();assert.equal(f.fs.resolve,external);assert.equal(await f.fs.resolve('/plain'),'/plain');
  const b=installFilePathHydration(f.fs,f.files);f.calls.length=0;
  assert.equal(await f.fs.resolve('/files/b'),'/files/b');assert.ok(f.calls.some(value=>value.startsWith('files:')));
  await b.dispose();assert.equal(f.fs.resolve,external);assert.equal(await f.fs.resolve('/plain2'),'/plain2');
});

import {Context, Service} from '@deepseek-ai/cordis';
for(const first of ['images','files'])test('Cordis context-aware filesystem shares owners with '+first+' unloaded first',async t=>{
  const ctx=new Context(),calls=[],views={},adapters={},scopes={};
  class Filesystem extends Service {
    constructor(scope){super(scope,'fs');}
    async resolve(path){calls.push({kind:'base',fiber:this.ctx.fiber,path});return path;}
    async lstat(path,options,signal){signal?.throwIfAborted();calls.push({kind:'stat',fiber:this.ctx.fiber,path});return{type:'file'};}
    processPath(path){return path;}
  }
  const provider=ctx.plugin(Filesystem);await provider.await();t.after(()=>ctx.fiber.dispose());
  for(const kind of ['images','files']){
    const child=ctx.plugin(scope=>{scopes[kind]=scope;views[kind]=scope.get('fs');const store={async ensureMaterializedPath(path,signal){signal.throwIfAborted();calls.push({kind,path});return path.startsWith('/'+kind+'/');}};adapters[kind]=(kind==='images'?installImagePathHydration:installFilePathHydration)(views[kind],store);scope.effect(()=>()=>adapters[kind].dispose());});
    await child.await();
  }
  assert.equal(await views.files.resolve('/files/first'),'/files/first');
  assert.equal(calls.find(value=>value.kind==='base').fiber,scopes.files.fiber);
  await views.files.lstat('/files/meta',{},new AbortController().signal);
  assert.equal(calls.find(value=>value.kind==='stat').fiber,scopes.files.fiber);
  await adapters[first].dispose();calls.length=0;const other=first==='images'?'files':'images';
  assert.equal(await views[other].resolve('/'+other+'/after'),'/'+other+'/after');
  assert.equal(calls.some(value=>value.kind===first),false);assert.ok(calls.some(value=>value.kind===other));
  await adapters[other].dispose();calls.length=0;
  assert.equal(await views.files.resolve('/plain'),'/plain');assert.deepEqual(calls.map(value=>value.kind),['base']);
});

test('reinstallation intercepts a replacement that does not delegate to the old router',async()=>{
  const f=fixture(),a=installImagePathHydration(f.fs,f.images);
  const replacement=async path=>'replacement:'+path;
  Object.defineProperty(f.fs,'resolve',{value:replacement,configurable:true,writable:true});await a.dispose();
  const b=installFilePathHydration(f.fs,f.files);f.calls.length=0;
  assert.equal(await f.fs.resolve('/files/new'),'replacement:/files/new');assert.ok(f.calls.some(value=>value.startsWith('files:')));
  await b.dispose();assert.equal(f.fs.resolve,replacement);
});
