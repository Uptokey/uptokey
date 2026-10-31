import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Encrypted from './encrypted-sessions.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'uptokey-session-composition-'));
 const config={root:join(root,'encrypted'),legacyRoot:join(root,'legacy'),keyPath:join(root,'key')};
 await writeFile(config.keyPath,randomBytes(32).toString('hex'),{mode:0o400});
 const contexts=[];
 t.after(async()=>{for(const ctx of contexts.reverse())await ctx.fiber.dispose();if(!resolve(root).startsWith(resolve(tmpdir())+sep+'uptokey-session-composition-'))throw Error('Unexpected cleanup');await rm(root,{recursive:true,force:true});});
 async function boot(plugin=Encrypted){const ctx=new Context();contexts.push(ctx);await ctx.plugin(SessionStore);const fiber=ctx.plugin(plugin,plugin===Jsonl?{root:config.legacyRoot}:config);await fiber.await();return{ctx,fiber};}
 return{root,config,boot};
}
const title=(session,text)=>session.append('session/title',{title:text,messageSeqs:[],source:{kind:'user'}});
async function files(root){const result=[];try{for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())result.push(...await files(path));else result.push(path);}}catch(error){if(error.code!=='ENOENT')throw error;}return result;}

test('real Cordis composition atomically copies legacy logs, preserves recovery bytes and routes encrypted copies',async t=>{
 const {config,boot}=await fixture(t),old=await boot(Jsonl);
 const oldSession=old.ctx.sessions.create(SessionId('legacy-compose'),{meta:{cwd:'/workspace/demo'}});
 const oldWrite=await old.ctx.sessionPersistence.create(oldSession.header);title(oldSession,'legacy synthetic title');await old.ctx.sessions.flush(oldSession);await oldWrite.close();await old.ctx.fiber.dispose();
 const legacyBefore=new Map(await Promise.all((await files(config.legacyRoot)).map(async path=>[path,await readFile(path)])));
 const first=await boot(),session=first.ctx.sessions.create(SessionId('encrypted-compose'),{meta:{cwd:'/workspace/demo'}});
 await first.ctx.sessionPersistence.create(session.header);title(session,'private synthetic title');assert.equal(await first.ctx.sessions.flush(session),true);
 const read=await first.ctx.sessionPersistence.open(session.id,'read');assert.equal((await read.read()).events[0].data.title,'private synthetic title');await read.close();
 assert.equal((await first.ctx.sessionPersistence.list()).length,2);
 const legacyCalls={open:0,stat:0,list:0,flush:0},originals={};
 for(const method of Object.keys(legacyCalls)){originals[method]=first.ctx.sessionPersistence.legacy[method].bind(first.ctx.sessionPersistence.legacy);first.ctx.sessionPersistence.legacy[method]=async(...args)=>{legacyCalls[method]++;return originals[method](...args);};}
 const migrated=await first.ctx.sessionPersistence.open(SessionId('legacy-compose'),'read');
 assert.equal((await migrated.read()).events[0].data.title,'legacy synthetic title');await migrated.close();
 assert.ok(await first.ctx.sessionPersistence.stat(SessionId('legacy-compose')));
 assert.equal((await first.ctx.sessionPersistence.list()).length,2);await first.ctx.sessionPersistence.flush();
 assert.deepEqual(legacyCalls,{open:0,stat:0,list:0,flush:0},'retired legacy provider must not be consulted after boot');
 for(const[method,original]of Object.entries(originals))first.ctx.sessionPersistence.legacy[method]=original;
 await first.ctx.fiber.dispose();
 for(const[path,bytes]of legacyBefore)assert.deepEqual(await readFile(path),bytes);
 assert.equal((await files(config.root)).filter(path=>path.endsWith('session.utkes1')).length,2);
 for(const path of await files(config.root)){const bytes=await readFile(path);for(const plain of ['private synthetic title','legacy synthetic title','/workspace/demo'])assert.equal(bytes.includes(Buffer.from(plain)),false);}
 const second=await boot();
 for(const[id,expected]of [['legacy-compose','legacy synthetic title'],['encrypted-compose','private synthetic title']]){const handle=await second.ctx.sessionPersistence.open(SessionId(id),'read');assert.equal((await handle.read()).events[0].data.title,expected);await handle.close();}
});

test('preexisting encrypted duplicate must match every legacy header, cut and event before routing',async()=>{
 const header={id:'collision',version:4,createdAt:1,isSeeded:false,cwd:'/workspace/demo'};
 const event=text=>({type:'plugin:test',ignorable:true,seq:0,time:1,data:{text}});
 const handle=(text,cut=0)=>({header,inheritedEventCount:cut,async read(){return{events:[event(text)]};},async close(){}});
 const legacy={async list(){return[{header,revision:'legacy-r1'}];},async stat(){return{header,revision:'legacy-r1'};},async open(){return handle('legacy');}};
 const encrypted={async list(){return[];},async stat(){return{header,revision:'encrypted-r1'};},async open(){return handle('different');}};
 await assert.rejects(Encrypted.migrateLegacySessions(legacy,encrypted),/legacy_session_migration_mismatch:collision/);
});

test('verified legacy parity produces a stable opaque proof for a retirement plan',async()=>{
 const header={id:'parity',version:4,createdAt:1,isSeeded:false,cwd:'/workspace/demo'};
 const event={type:'plugin:test',ignorable:true,seq:0,time:1,data:{text:'same'}};
 const handle=()=>({header,inheritedEventCount:0,async read(){return{events:[event]};},async close(){}});
 const legacy={async list(){return[{header,revision:'legacy-r1'}];},async stat(){return{header,revision:'legacy-r1'};},async open(){return handle();}};
 const encrypted={async stat(){return{header,revision:'encrypted-r1'};},async open(){return handle();}};
 const proof=await Encrypted.verifyLegacySessionParity(legacy,encrypted);
 assert.equal(proof.verified,true);assert.equal(proof.sessionCount,1);assert.match(proof.digest,/^[a-f0-9]{64}$/);
 assert.equal(Object.isFrozen(proof),true);
});

test('a staged-away legacy root stays absent while encrypted sessions remain writable',async t=>{
 const {config,boot}=await fixture(t),first=await boot();
 await assert.rejects(lstat(config.legacyRoot),error=>error.code==='ENOENT');
 const session=first.ctx.sessions.create(SessionId('encrypted-only'),{meta:{cwd:'/workspace/demo'}});
 await first.ctx.sessionPersistence.create(session.header);title(session,'encrypted only');
 assert.equal(await first.ctx.sessions.flush(session),true);
 const read=await first.ctx.sessionPersistence.open(session.id,'read');
 assert.equal((await read.read()).events[0].data.title,'encrypted only');await read.close();
 await assert.rejects(lstat(config.legacyRoot),error=>error.code==='ENOENT');
});

test('provider removal awaits an injecting consumer final event before tracker teardown',async t=>{
 const {boot}=await fixture(t),first=await boot();let session,done=false;
 const consumer=first.ctx.plugin({name:'synthetic-final-producer',inject:['sessionPersistence','sessions'],async apply(ctx){
  // The root owns this Session so consumer teardown can still publish to it,
  // matching the upstream persistence teardown fixture.
  session=first.ctx.sessions.create(SessionId('final-compose'),{meta:{cwd:'/workspace/demo'}});
  await ctx.sessionPersistence.create(session.header);title(session,'initial synthetic');
  ctx.effect(()=>async()=>{await new Promise(resolve=>setTimeout(resolve,20));title(session,'final synthetic');await ctx.sessions.flush(session);done=true;});
 }});await consumer.await();await first.fiber.dispose();assert.equal(done,true);
 const second=await boot(),handle=await second.ctx.sessionPersistence.open(session.id,'read');
 assert.deepEqual((await handle.read()).events.map(event=>event.data.title),['initial synthetic','final synthetic']);await handle.close();
});

test('combined flush waits for both backends and reports all failures',async()=>{
 const events=[],ctx=new Context();
 const service=new Encrypted.CompositeSessionPersistence(ctx,{async flush(){await new Promise(resolve=>setTimeout(resolve,15));events.push('legacy');throw Error('old');}},{async flush(){events.push('encrypted');throw Error('new');}});
 await assert.rejects(service.flush(),error=>error instanceof AggregateError&&error.errors.length===2);
 assert.deepEqual(events,['encrypted','legacy']);await ctx.fiber.dispose();
});
