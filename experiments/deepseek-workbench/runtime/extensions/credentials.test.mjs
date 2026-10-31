import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Credentials from './credentials.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'uptokey-harness-credentials-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const keyPath=join(dir,'vault-key');
  await writeFile(keyPath,'4'.repeat(64),{mode:0o600});
  return {dir,config:{path:join(dir,'credentials.encrypted.json'),keyPath}};
}
async function boot(t,config) {
  const ctx=new Context();
  const fiber=ctx.plugin(Credentials,config);
  t.after(()=>fiber.dispose());
  await fiber;
  return ctx;
}

test('provider and BYOK credentials cannot be written or read outside the Uptokey core',async t=>{
  const {config}=await fixture(t);
  const historical=JSON.stringify({ciphertext:'historical-laboratory-rollback'});
  await writeFile(config.path,historical,{mode:0o600});
  const ctx=await boot(t,config);
  assert.equal(await ctx.credentials.resolve('OPENAI_API_KEY'),undefined);
  assert.deepEqual(await ctx.credentials.describe('OPENAI_API_KEY'),{configured:false,writable:false});
  await assert.rejects(ctx.credentials.set('OPENAI_API_KEY','synthetic-not-a-key'),/credential_owner_is_uptokey_core/);
  await assert.rejects(ctx.credentials.unset('OPENAI_API_KEY'),/credential_owner_is_uptokey_core/);
  assert.equal(await readFile(config.path,'utf8'),historical);
});

test('Uptokey core gate is a read-only capability and never copied into a credential file',async t=>{
  const {dir,config}=await fixture(t);
  const gate='A'.repeat(43),bridgeKeyPath=join(dir,'bridge-gate');
  await writeFile(bridgeKeyPath,gate,{mode:0o600});
  const ctx=await boot(t,{...config,bridgeKeyPath});
  assert.equal((await ctx.credentials.resolve('UPTOKEY_LOCAL_API_KEY')).value,gate);
  assert.deepEqual(await ctx.credentials.describe('UPTOKEY_LOCAL_API_KEY'),{configured:true,writable:false,source:'file'});
  await assert.rejects(ctx.credentials.set('UPTOKEY_LOCAL_API_KEY','other'),/readonly/);
  await assert.rejects(ctx.credentials.unset('UPTOKEY_LOCAL_API_KEY'),/readonly/);
  await assert.rejects(readFile(config.path,'utf8'),error=>error.code==='ENOENT');
});

test('authenticated local-model transport exposes only a read-only keyless marker',async t=>{
  const {dir,config}=await fixture(t);
  const localModelKeyPath=join(dir,'local-model-authorized-key');
  await writeFile(localModelKeyPath,'restrict,port-forwarding,permitlisten="127.0.0.1:43192" ssh-ed25519 '+Buffer.alloc(32,7).toString('base64')+' uptokey-local\n',{mode:0o600});
  const ctx=await boot(t,{...config,localModelKeyPath});
  assert.equal((await ctx.credentials.resolve('OLLAMA_LOCAL_API_KEY')).value,'uptokey-local-keyless');
  assert.deepEqual(await ctx.credentials.describe('OLLAMA_LOCAL_API_KEY'),{configured:true,writable:false,source:'local-transport'});
  await assert.rejects(ctx.credentials.set('OLLAMA_LOCAL_API_KEY','other'),/readonly/);
  await assert.rejects(ctx.credentials.unset('OLLAMA_LOCAL_API_KEY'),/readonly/);
});

test('local-model marker fails closed without the exact restricted transport',async t=>{
  const {dir,config}=await fixture(t);
  const localModelKeyPath=join(dir,'local-model-authorized-key');
  await writeFile(localModelKeyPath,'ssh-ed25519 '+Buffer.alloc(32,9).toString('base64')+' unrestricted\n',{mode:0o600});
  const ctx=await boot(t,{...config,localModelKeyPath});
  await assert.rejects(ctx.credentials.resolve('OLLAMA_LOCAL_API_KEY'),/local_model_transport_invalid/);
  assert.deepEqual(await ctx.credentials.describe('OLLAMA_LOCAL_API_KEY'),{configured:false,writable:false});
});

test('provider grant records have no controller-local authority',async t=>{
  const {config}=await fixture(t),ctx=await boot(t,config);
  assert.equal(await ctx.credentials.readRecord('llm-pi-ai/lab'),undefined);
  assert.deepEqual(await ctx.credentials.describeRecord('llm-pi-ai/lab'),{configured:false,writable:false});
  assert.deepEqual(await ctx.credentials.listRecords(),[]);
  await assert.rejects(ctx.credentials.modifyRecord('llm-pi-ai/lab',async()=>({kind:'api-key',key:'synthetic'})),/credential_owner_is_uptokey_core/);
  await assert.rejects(ctx.credentials.deleteRecord('llm-pi-ai/lab'),/credential_owner_is_uptokey_core/);
});

test('the exact Harness browser-session signing record uses a separate scoped store',async t=>{
  const {dir,config}=await fixture(t),ctx=await boot(t,config);
  const key='client-connection/browser-session';
  const record={kind:'grant',payload:{version:1,secret:'B'.repeat(43)}};
  assert.deepEqual(await ctx.credentials.modifyRecord(key,async current=>{assert.equal(current,undefined);return record;}),record);
  assert.deepEqual(await ctx.credentials.readRecord(key),record);
  assert.deepEqual(await ctx.credentials.describeRecord(key),{configured:true,writable:true,kind:'grant'});
  assert.deepEqual(await ctx.credentials.listRecords(),[{key,kind:'grant'}]);
  await assert.rejects(readFile(config.path,'utf8'),error=>error.code==='ENOENT');
  const envelope=JSON.parse(await readFile(join(dir,'browser-session.encrypted.json'),'utf8'));
  assert.equal(envelope.objectId,'harness-browser-session');
  assert.equal(envelope.resourceScope,'browser-session-auth');
  await ctx.credentials.deleteRecord(key);
  assert.equal(await ctx.credentials.readRecord(key),undefined);
});

test('browser-session store rejects malformed or provider-shaped records',async t=>{
  const {config}=await fixture(t),ctx=await boot(t,config);
  const key='client-connection/browser-session';
  await assert.rejects(ctx.credentials.modifyRecord(key,async()=>({kind:'api-key',payload:{version:1,secret:'B'.repeat(43)}})),/browser_session_record_invalid/);
  await assert.rejects(ctx.credentials.modifyRecord(key,async()=>({kind:'grant',payload:{version:1,secret:'provider-secret'}})),/browser_session_record_invalid/);
  await assert.rejects(ctx.credentials.modifyRecord('client-connection/other',async()=>({kind:'grant',payload:{version:1,secret:'B'.repeat(43)}})),/credential_owner_is_uptokey_core/);
});

test('ambient environment and prototype names never become credentials',async t=>{
  const {config}=await fixture(t);process.env.LAB_AMBIENT_KEY='synthetic';t.after(()=>delete process.env.LAB_AMBIENT_KEY);
  const ctx=await boot(t,config);
  for(const key of ['LAB_AMBIENT_KEY','constructor','__proto__']){
    assert.equal(await ctx.credentials.resolve(key),undefined);
    assert.deepEqual(await ctx.credentials.describe(key),{configured:false,writable:false});
  }
  await assert.rejects(ctx.credentials.set('__proto__','synthetic'),/credential_owner_is_uptokey_core/);
});
