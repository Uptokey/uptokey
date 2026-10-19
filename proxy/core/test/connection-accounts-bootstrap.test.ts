import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTIONS_SCHEMA_VERSION } from '@uptokey/sync-contract/connections';
import { createApp, ensureLocalToken, EXPECTED_HOST } from '../src/app.ts';
import { assertProxyConfig, defaultConfig } from '../src/config.ts';
import { connectionSecretRef, defaultProfileId, memoryConnectionStorage } from '../src/connection-profiles.ts';
import { createProviderSetupService } from '../src/tui/provider-setup.ts';
import { MemorySecretStore } from '../src/secret-store.ts';
import { QuotaLedger } from '../src/quota-ledger.ts';
import { Router } from '../src/router.ts';
import type { ProviderAdapter, ProviderName } from '../src/types.ts';
import { loadConnections, comparisonCandidates } from '../src/tui/connections.ts';

test('disconnecting the migrated default preserves both named routes and never overrides an explicit provider disable', async () => {
  const output=fileURLToPath(new URL('../../../output/tui-canonica/account-credits-20261018/provider-disconnect-20261019/',import.meta.url));await mkdir(output,{recursive:true});
  for(const enabled of [true,false]) {
    const directory=await mkdtemp(join(output,'remaining-accounts-'));
    const env={UPTOKEY_QUIMERA_DATA_DIR:join(directory,'data'),UPTOKEY_CONVERSATIONS_DIR:join(directory,'conversations'),UPTOKEY_AUTOMATIONS_DIR:join(directory,'automations')};
    const previous=Object.fromEntries(Object.keys(env).map(name=>[name,process.env[name]]));Object.assign(process.env,env);
    let app:ReturnType<typeof createApp>|undefined;
    try {
      const secrets=new MemorySecretStore(),token=await ensureLocalToken(secrets),config=structuredClone(defaultConfig);
      await secrets.set('provider:groq','fixture-default');await secrets.set('provider:gemini','fixture-unrelated');
      for(const provider of Object.values(config.providers))provider.enabled=false;
      Object.assign(config.providers.groq,{enabled,configured:true,models:['fixture-chat'],defaultModel:'fixture-chat',max429Retries:0,budget:{rpm:1000,tpm:1000000,rpd:10000,tpd:10000000,source:'official_headers'}});config.fallbackOrder=['groq','gemini'];assertProxyConfig(config);
      const received:string[]=[];
      const adapter:ProviderAdapter={name:'groq',dispatch:async(_request,key)=>{received.push(key!);return Response.json({id:'fixture',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'fixture'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}};
      const ledger=new QuotaLedger(join(directory,'ledger.json'));await ledger.initialize();
      const router=new Router(config,new Map<ProviderName,ProviderAdapter>([['groq',adapter]]),secrets,ledger,async()=>{});
      let external=0;const noNetwork:typeof fetch=async()=>{external++;throw Error('external_forbidden')};
      const options:Parameters<typeof createApp>=[config,router,secrets,async()=>({allowed:true})];options[25]=noNetwork;options[26]={profiles:memoryConnectionStorage(),fetchImpl:noNetwork};app=createApp(...options);await app.workspaceReady;
      const headers={host:EXPECTED_HOST,authorization:`Bearer ${token}`,'content-type':'application/json'};
      const post=(path:string,body:unknown)=>app!.request(path,{method:'POST',headers,body:JSON.stringify(body)});
      const add=async(label:string,key:string)=>{const response=await post('/local/connections',{schemaVersion:1,providerId:'groq',accessMode:'byok',label,enabled:true,modelIds:['fixture-chat'],secret:key});assert.equal(response.status,201,await response.clone().text());return response.json()};
      const first=await add('Work','fixture-work'),second=await add('Personal','fixture-personal');
      const list=await (await app.request('/local/connections',{headers})).json();
      const original=list.connections.find((row:{id:string})=>row.id===defaultProfileId('groq'));assert.ok(original);
      const setup=createProviderSetupService({secrets,fetch:(async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,'http://127.0.0.1:21435');return app!.request(url.pathname,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),host:EXPECTED_HOST}})})as typeof fetch,loadConfig:async()=>config,reload:async()=>{throw Error('profile_route_never_reloads')},updateConfig:async()=>{throw Error('profile_route_never_broadens')}});
      await setup.disconnect('groq',original.id,undefined,original.revision);
      assert.equal(await secrets.get('provider:groq'),undefined);assert.equal(await secrets.get('provider:gemini'),'fixture-unrelated');assert.equal(config.providers.groq.configured,false);assert.equal(config.providers.groq.enabled,enabled);
      const after=await (await app.request('/local/connections',{headers})).json();assert.equal(after.connections.some((row:{id:string})=>row.id===original.id),false);
      assert.equal(after.connections.filter((row:{providerId:string})=>row.providerId==='groq').length,2);
      const projected = await (await app.request('/v1/connections', {headers})).json();
      const publicProvider = projected.providers.find((row:{id:string}) => row.id === 'groq');
      assert.equal(publicProvider.configured, true, 'actual named credentials configure only the public projection');
      assert.equal(publicProvider.admission.eligible, enabled);
      if (!enabled) assert.equal(publicProvider.admission.reason, 'disabled');
      for (const profile of [first,second]) assert.equal(projected.connections.find((row:{id:string})=>row.id===profile.id)?.eligible,enabled);
      const snapshot = await loadConnections({fetchRaw:(path:string)=>app!.request(path,{headers})} as never);
      assert.equal(snapshot.providers.find(row=>row.id==='groq')?.eligible,enabled);
      assert.deepEqual(comparisonCandidates(snapshot).filter(row=>row.providerId==='groq').map(row=>row.connectionId).sort(),enabled?[first.id,second.id].sort():[]);
      assert.equal(config.providers.groq.configured,false, 'status/catalog reads do not reconfigure or recreate the removed default');
      assert.equal(router.connectionMetrics().providers.find(row=>row.id==='groq')?.configured,false, 'unqualified metrics retain the persisted legacy state');
      assert.equal((await (await app.request('/local/connections',{headers})).json()).connections.some((row:{id:string})=>row.id===original.id),false);
      for(const profile of [first,second]) {
        const response=await post('/v1/chat/completions',{model:'fixture-chat',uptokey_provider:'groq',uptokey_account:profile.id,uptokey_require_model:true,messages:[{role:'user',content:'fixture'}]});
        if(enabled)assert.equal(response.status,200,await response.clone().text());else assert.notEqual(response.status,200,'explicit provider disabled switch still denies every profile');
      }
      assert.deepEqual(received,enabled?['fixture-work','fixture-personal']:[]);assert.equal(external,0);
      await secrets.delete(connectionSecretRef(first.id));
      const missing = await (await app.request('/v1/connections',{headers})).json();
      assert.equal(missing.connections.find((row:{id:string})=>row.id===first.id)?.eligible,false);
      assert.equal(missing.connections.find((row:{id:string})=>row.id===second.id)?.eligible,enabled);
      if (enabled) {
        config.providers.groq.budget.rpm=1;
        const limited = await (await app.request('/v1/connections',{headers})).json();
        assert.equal(limited.providers.find((row:{id:string})=>row.id==='groq')?.admission.reason,'local_minute_limit');
        assert.equal(limited.connections.some((row:{providerId:string;eligible:boolean})=>row.providerId==='groq'&&row.eligible),false,'real named credentials do not bypass a provider quota');
      }
      assert.equal(config.providers.groq.configured,false);
    } finally {await app?.closeWorkspace();for(const[name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value}}
  }
});

test('browser account management feeds the real app router without credential or disabled-account bypass', async () => {
  const output = fileURLToPath(new URL("../../../quimera/output/chat-evolucao/runtime/", import.meta.url));
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, 'accounts-bootstrap-'));
  const env = {
    UPTOKEY_QUIMERA_DATA_DIR: join(root, 'data'),
    UPTOKEY_CONVERSATIONS_DIR: join(root, 'conversations'),
    UPTOKEY_AUTOMATIONS_DIR: join(root, 'automations'),
  };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const secrets = new MemorySecretStore();
    await ensureLocalToken(secrets);
    await secrets.set('provider:groq', 'fixture-legacy');
    const config = structuredClone(defaultConfig);
    for (const provider of Object.values(config.providers)) provider.enabled = false;
    Object.assign(config.providers.groq, {
      enabled: true, configured: false, models: ['fixture-chat'], defaultModel: 'fixture-chat',
      maxTransientRetries: 0, max429Retries: 0,
      budget: { rpm: 1000, tpm: 1_000_000, rpd: 10000, tpd: 10_000_000 },
    });
    config.fallbackOrder = ['groq'];
    const receivedKeys: (string | undefined)[] = [];
    const forwardedRequests: Record<string, unknown>[] = [];
    const adapter: ProviderAdapter = {
      name: 'groq',
      dispatch: async (_request, key) => {
        forwardedRequests.push(_request);
        receivedKeys.push(key);
        return Response.json({ id: 'fixture-id', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      },
    };
    const ledger = new QuotaLedger(join(root, 'ledger.json'));
    await ledger.initialize();
    const router = new Router(config, new Map<ProviderName, ProviderAdapter>([['groq', adapter]]), secrets, ledger, async () => {});
    let externalCalls = 0;
    const noNetwork: typeof fetch = async () => { externalCalls++; throw new Error('fixture forbids external fetch'); };
    const options: Parameters<typeof createApp> = [config, router, secrets, async () => ({ allowed: true })];
    options[25] = noNetwork;
    options[26] = { profiles: memoryConnectionStorage(), fetchImpl: noNetwork };
    app = createApp(...options);
    await app.workspaceReady;
    const baseHeaders = { host: EXPECTED_HOST, origin: 'http://127.0.0.1:5273', 'content-type': 'application/json' };
    const browserKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const challengeResponse = await app.request('/local/workspace/session/challenge', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ publicJwk: browserKey.publicKey.export({ format: 'jwk' }) }) });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    const completedResponse = await app.request('/local/workspace/session/complete', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ challengeId: challenge.challengeId, signature: sign('sha256', Buffer.from(challenge.nonce), { key: browserKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }) });
    assert.equal(completedResponse.status, 200);
    const session = await completedResponse.json();
    const headers = { ...baseHeaders, authorization: `Bearer ${session.token}` };
    const request = (path: string, body: unknown, method = 'POST') => app!.request(path, { method, headers, body: JSON.stringify(body) });
    const add = async (label: string, enabled: boolean, secret: string) => {
      const response = await request('/local/connections', { schemaVersion: CONNECTIONS_SCHEMA_VERSION, providerId: 'groq', accessMode: 'byok', label, enabled, secret });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    };
    await add('Disabled fixture', false, 'fixture-disabled');
    const active = await add('Active fixture', true, 'fixture-active');
    const metadata = await app.request('/local/connections', { headers });
    assert.equal(metadata.status, 200);
    const metadataText = await metadata.text();
    for (const value of ['fixture-legacy', 'fixture-disabled', 'fixture-active']) assert.equal(metadataText.includes(value), false);
    assert.equal(receivedKeys.length, 0);
    assert.equal(externalCalls, 0);
    const inventory = await app.request('/v1/connections', { headers });
    assert.equal(inventory.status, 200);
    const publicProfiles = (await inventory.json()).connections;
    assert.equal(publicProfiles.find((row: {id:string}) => row.id === active.id)?.revision, active.revision);
    const chat = { model: 'groq/fixture-chat', messages: [{ role: 'user', content: 'fixture' }] };
    const response = await request('/v1/chat/completions', chat);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(receivedKeys, ['fixture-active']);
    const selectedChat = { ...chat, model: 'fixture-chat', uptokey_account: active.id, uptokey_provider: 'groq', uptokey_require_model: true };
    const explicitAccount = await request('/v1/chat/completions', selectedChat);
    assert.equal(explicitAccount.status, 200, await explicitAccount.clone().text());
    assert.deepEqual(receivedKeys, ['fixture-active', 'fixture-active']);
    const alternate = await add('Alternate fixture', true, 'fixture-alternate');
    const alternateResponse = await request('/v1/chat/completions', { ...selectedChat, uptokey_account: alternate.id });
    assert.equal(alternateResponse.status, 200, await alternateResponse.clone().text());
    assert.deepEqual(receivedKeys, ['fixture-active', 'fixture-active', 'fixture-alternate']);
    for (const forwarded of forwardedRequests) {
      assert.equal(Object.hasOwn(forwarded, 'uptokey_account'), false);
      assert.equal(Object.hasOwn(forwarded, 'uptokey_provider'), false);
    }
    for (const invalid of [null, 1, {}, '', '../account', 'a'.repeat(101)]) {
      assert.equal((await request('/v1/chat/completions', { ...selectedChat, uptokey_account: invalid })).status, 400);
    }
    assert.equal((await request('/v1/chat/completions', { ...selectedChat, uptokey_account: 'unknown-account' })).status, 403);
    assert.equal((await request('/v1/chat/completions', { ...selectedChat, uptokey_provider: 'gemini' })).status, 403);
    assert.equal(receivedKeys.length, 3, 'invalid or mismatched selection never dispatches');
    const disabled = await request(`/local/connections/${active.id}`, { revision: active.revision, enabled: false }, 'PATCH');
    assert.equal(disabled.status, 200);
    assert.equal((await request('/v1/chat/completions', selectedChat)).status, 403);
    assert.equal(receivedKeys.length, 3, 'disabled selection must not fall back to another account or legacy credential');
    const updated = await disabled.json();
    assert.equal((await request(`/local/connections/${active.id}`, { revision: updated.revision, enabled: true }, 'PATCH')).status, 200);
    await secrets.delete(connectionSecretRef(active.id));
    assert.notEqual((await request('/v1/chat/completions', selectedChat)).status, 200);
    assert.equal(receivedKeys.length, 3, 'a selected profile with a missing credential must not use another account');
    assert.equal(externalCalls, 0);
  } finally {
    await app?.closeWorkspace();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
