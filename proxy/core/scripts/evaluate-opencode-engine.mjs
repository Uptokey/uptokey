// Isolated compatibility evaluation. Uses the full upstream binary and official ACP
// SDK; its deterministic local model is explicitly not an inference benchmark.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = join(root, 'output/product-renewal-20261106');
const runtime = join(output, 'opencode2-runtime');
const executable = join(runtime, 'node_modules/@opencode/cli-windows-x64/bin/opencode.exe');
const profileArgument = process.argv.find(argument => argument.startsWith('--profile-parent='));
const managedProfile = process.argv.includes('--managed-profile');
const externalProfileParent = profileArgument ? resolve(profileArgument.slice('--profile-parent='.length)) : tmpdir();
const osEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => ['systemroot', 'windir', 'path', 'pathext', 'comspec'].includes(name.toLowerCase())));
if (!process.argv.includes('--isolated-child')) {
  // Bootstrap before importing product code: inherited provider credentials and
  // runtime overrides never enter the core evaluation process.
  const isolated = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--isolated-child', ...(profileArgument ? [profileArgument] : []), ...(managedProfile ? ['--managed-profile'] : [])], { cwd: root, env: osEnvironment(), windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { isolated.once('error', reject); isolated.once('exit', code => resolve(code)); });
  process.exit(code ?? 1);
}
// The internal flag is not an isolation bypass when the script is invoked manually.
const isolatedOs = osEnvironment();
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, isolatedOs);
const run = await mkdtemp(join(output, 'opencode2-evaluation-'));
const workspace = join(run, 'workspace');
await mkdir(workspace);
await mkdir(join(run, 'tmp'));
Object.assign(process.env, {
  USERPROFILE: run, HOME: run, APPDATA: join(run, 'appdata'), LOCALAPPDATA: join(run, 'localappdata'),
  TEMP: join(run, 'tmp'), TMP: join(run, 'tmp'),
  UPTOKEY_QUIMERA_DATA_DIR: join(run, 'core-profile'),
  UPTOKEY_SETTINGS_DIR: join(run, 'core-settings'), UPTOKEY_AUTOMATIONS_DIR: join(run, 'core-automations'),
});
const acp = await import(pathToFileURL(join(runtime, 'node_modules/@agentclientprotocol/sdk/dist/acp.js')).href);
await writeFile(join(workspace, 'input.txt'), 'uptokey fixture: 42\n');
const requests = [];
const updates = [];
const permissions = [];
let fixtureReadObserved = false;
let taskRuntime;
let taskHost;
let taskScope;
let taskSessionAllowed = true;
let denyCalls = 0;
let engineIdentity;
let inferenceServer;
let owner;
let parkTaskRoot = false;
let scenario = 'workflow';
const stalled = Promise.withResolvers();
const cancelledStream = Promise.withResolvers();
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
  finally { clearTimeout(timer); }
}
const providerSecret = 'synthetic-provider-key-never-given-to-engine';
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${providerSecret}`);
    assert.equal(req.url, '/v1/chat/completions');
    let bytes = '';
    for await (const chunk of req) {
      bytes += chunk;
      if (bytes.length > 2_000_000) throw new Error('fixture_request_too_large');
    }
    const body = JSON.parse(bytes);
    requests.push({ model: body.model, stream: body.stream, tools: body.tools?.map(t => t.function?.name), roles: body.messages?.map(m => m.role) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (body.tools?.length && scenario === 'stall') {
      res.on('close', () => cancelledStream.resolve());
      stalled.resolve();
      return;
    }
    const tools = body.messages?.filter(m => m.role === 'tool') ?? [];
    if (tools.some(m => JSON.stringify(m.content).includes('receiptIds'))) fixtureReadObserved = true;
    let call;
    const taskTool = name => {
      const found = body.tools.find(tool => tool.function?.name.endsWith(name));
      assert.ok(found, `missing_bound_tool_${name}`); return found.function.name;
    };
    if (body.tools?.length) {
      assert.equal(body.tools.length, 4, 'only task MCP tools may reach the model');
      for (const tool of body.tools) assert.ok(['task_status','task_resume','task_cancel','task_output'].some(name => tool.function.name.endsWith(name)));
      if (scenario === 'workflow' && tools.length === 0) call = {name:taskTool('task_resume'),arguments:{}};
      if (scenario === 'workflow' && tools.length === 1) {
        await within((async()=>{while ((await taskRuntime.getProjectTask(owner, taskScope.projectId, taskScope.taskId)).status !== 'succeeded') await new Promise(resolve=>setTimeout(resolve,20));})(), 'bound_task_did_not_complete');
        call = {name:taskTool('task_output'),arguments:{childIndex:0}};
      }
      if (scenario === 'deny' && denyCalls++ === 0) call = {name:taskTool('task_resume'),arguments:{projectId:'another-project'}};
    }
    if (call) {
      chunk({ tool_calls: [{ index: 0, id: `call_${tools.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ content: 'UPTOKEY_ENGINE_OK' });
      chunk({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}})}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.writeHead(400); res.end(JSON.stringify({ error: String(error) }));
  }
});
let app;
let proxyServer;
let child;
try {
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const originalFetch = globalThis.fetch;
const deniedNetwork = [];
const noNetwork = async () => { deniedNetwork.push('unexpected_external_fetch'); throw new Error('evaluation_external_network_forbidden'); };
// Default service clients are denied network. Only the explicit fixture adapter
// and the evaluation's local HTTP probes retain a transport to known loopback URLs.
globalThis.fetch = noNetwork;
const [{ createApp, ensureLocalToken, ALLOWED_HOSTS }, { Router }, { defaultConfig }, { MemorySecretStore }, { QuotaLedger }, { createClientKey, revokeClientKey }, { memoryConnectionStorage }, { memoryJobsStorage }, { memoryInstallJobsStorage }, { serve }, {resolveLocalPrincipal}, {createAgentEngineIdentity}] = await Promise.all([
  import('../src/app.ts'), import('../src/router.ts'), import('../src/config.ts'), import('../src/secret-store.ts'), import('../src/quota-ledger.ts'), import('../src/client-keys.ts'),
  import('../src/connection-profiles.ts'), import('../src/connection-tests.ts'), import('../src/model-install-jobs.ts'), import('@hono/node-server'),
  import('../src/workspace/principal.ts'),import('../src/agent-engine-identity.ts'),
]);
const coreConfig = structuredClone(defaultConfig);
for (const provider of Object.values(coreConfig.providers)) provider.enabled = false;
Object.assign(coreConfig.providers.groq, { enabled: true, configured: true, models: ['fixture'], defaultModel: 'fixture' });
coreConfig.providers.groq.budget = { ...coreConfig.providers.groq.budget, rpm: 1000, tpm: 1_000_000 };
coreConfig.fallbackOrder = ['groq'];
const secrets = new MemorySecretStore();
await secrets.set('provider:groq', providerSecret);
const issued = await createClientKey(secrets, { label: 'Isolated OpenCode ACP evaluation', scopes: ['inference:chat'], providerIds: ['groq'], modelIds: ['fixture'], retentionMode: 'ephemeral', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), limits: { requestsPerMinute: 100, maxConcurrent: 2 }, operationId: randomUUID() });
const token = issued.token;
const hostToken = await ensureLocalToken(secrets);
owner = await resolveLocalPrincipal(`Bearer ${hostToken}`,secrets,undefined);
assert.ok(owner);
const ledger = new QuotaLedger(join(run, 'core-profile', 'quota-ledger.json'));
await ledger.initialize();
let coreDispatches = 0;
const router = new Router(coreConfig, new Map([['groq', { name: 'groq', async dispatch(request, key, signal) {
  assert.equal(key, providerSecret);
  coreDispatches++;
  return originalFetch(upstreamUrl, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
} }]]), secrets, ledger);
const appArgs = [coreConfig, router, secrets, async () => {if(parkTaskRoot){parkTaskRoot=false;process.env.UPTOKEY_WORKSPACE_RUNS_DISABLED='1';}return { allowed: true };}];
appArgs[8] = async () => structuredClone(coreConfig);
appArgs[13] = new (await import('../src/workspace/store.ts')).WorkspaceStore(secrets,join(run,'workspace-store'));
appArgs[25] = noNetwork;
appArgs[26] = { profiles: memoryConnectionStorage(), testJobs: memoryJobsStorage(), installJobs: memoryInstallJobsStorage(), fetchImpl: noNetwork };
app = createApp(...appArgs);
await app.workspaceReady;
proxyServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => proxyServer.listening ? resolve() : proxyServer.once('listening', resolve));
const coreHost = `127.0.0.1:${proxyServer.address().port}`;
ALLOWED_HOSTS.clear(); ALLOWED_HOSTS.add(coreHost);
const coreBaseUrl = `http://${coreHost}/v1`;
const localRequest = (path, body) => originalFetch(`${coreBaseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const [{createProjectTaskMcpHost},{createAgentEngineConfig}] = await Promise.all([
  import('../src/workspace/project-task-mcp-host.ts'),import('../src/agent-engine-config.ts'),
]);
await mkdir(join(workspace,'web')); await mkdir(join(workspace,'docs'));
await writeFile(join(workspace,'web/index.html'),'<html><body>Governed engine fixture</body></html>');
await writeFile(join(workspace,'docs/README.md'),'Governed engine fixture documentation');
taskRuntime = app.workspaceRuntime;
assert.ok(taskRuntime,'use the same core-owned runtime and journal');
const project=await taskRuntime.createProject(owner,{name:'Bound engine evaluation',goal:''});
const boundRoot=await taskRuntime.projectRoot.registerRootWithStore({projectId:project.projectId,principalId:owner,localAbsolutePath:workspace,displayName:'Fixture',nonce:randomUUID()},taskRuntime.store);
const manifest=await taskRuntime.getProjectManifest(owner,project.projectId,boundRoot.id);
const childPlans=[];
for(const actionId of ['check_html','check_assets']) childPlans.push((await taskRuntime.createProjectRunPlan(owner,project.projectId,{expectedRevision:project.revision,rootBindingId:boundRoot.id,request:{taskId:'bound-engine-task',manifestDigest:manifest.snapshotDigest,runtimeProfileId:'static-web',actionId,relativeWorkingDirectory:'.',artifactInputRefs:[],timeoutMs:30000,outputLimitBytes:4096}})).plan);
const prepared=await taskRuntime.prepareProjectTask(owner,project.projectId,{expectedRevision:project.revision,rootBindingId:boundRoot.id,objective:'Verify the already authorized static project',childPlanIds:childPlans.map(plan=>plan.id)});
parkTaskRoot=true;
await taskRuntime.startRun(owner,project.projectId,{planId:prepared.plan.id,planDigest:prepared.plan.digest,requestId:randomUUID()},true);
const task=await within((async()=>{for(;;){const candidate=(await taskRuntime.listProjectTasks(owner,project.projectId)).tasks[0];if(candidate?.status==='ready')return candidate;await new Promise(resolve=>setTimeout(resolve,20));}})(),'root_task_not_ready');
taskScope={principalId:owner,projectId:project.projectId,taskId:task.id,rootBindingId:boundRoot.id,rootRunId:task.rootRunId,specDigest:task.digest};
taskHost=await createProjectTaskMcpHost(taskRuntime,taskScope,{authorize:async()=>taskSessionAllowed});
const conversation=await app.conversationStore.createConversation(owner,{title:'Bound engine task',projectId:project.projectId,storagePolicy:'local',processingPolicy:'external_allowed'});
const personal=await app.governanceService.ensurePersonal(owner);
for(const [scope,subjectId] of [['workspace',null],['project',project.projectId],['conversation',conversation.id]])await app.governanceStore.putBudget(owner,personal.id,{id:`engine-${scope}`,workspaceId:personal.id,scope,subjectId,enabled:true,unit:'request',amount:'20',period:'total',timezone:'UTC',includeByokUsage:true});
engineIdentity=await createAgentEngineIdentity({dispatch:request=>{const headers=new Headers(request.headers);headers.set('host',coreHost);return app.fetch(new Request(request,{headers}));},resolveHostContext:async()=>taskSessionAllowed?{authorization:`Bearer ${hostToken}`,headers:{'x-uptokey-project-id':project.projectId,'x-uptokey-conversation-id':conversation.id}}:undefined,model:'fixture',provider:'groq',ttlMs:60_000,maxTokens:2048});
let inferenceHost='';
inferenceServer=serve({hostname:'127.0.0.1',port:0,fetch:request=>request.headers.get('host')===inferenceHost?engineIdentity.fetch(request):new Response(null,{status:403})});
await new Promise(resolve=>inferenceServer.listening?resolve():inferenceServer.once('listening',resolve));
inferenceHost=`127.0.0.1:${inferenceServer.address().port}`;
const engineProfileParent = managedProfile ? join(run,'engine-profile') : externalProfileParent;
if (managedProfile) await mkdir(engineProfileParent);
const launch=await createAgentEngineConfig({engineVersion:'2.2.5',interface:'harness',inferenceUrl:`http://${inferenceHost}/v1`,model:'fixture',declaredModels:['fixture'],mcpUrl:taskHost.url,profileParent:engineProfileParent,...(managedProfile?{managedProfileRoot:engineProfileParent}:{}),repositoryRoots:[root],environment:osEnvironment()});
const env={...launch.env,[launch.credentialEnvironment.inference]:engineIdentity.token,[launch.credentialEnvironment.mcp]:taskHost.token};
const taskTokens=[taskHost.token];
delete process.env.UPTOKEY_WORKSPACE_RUNS_DISABLED;
let stderr = '';
function startAgent() {
  const process = spawn(executable, launch.args, { cwd: launch.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stderr.on('data', chunk => { if (stderr.length < 32000) stderr += chunk; });
  return process;
}
child = startAgent();
async function stopAgent() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.destroy();
  child.kill();
  await within(exited, 'agent_did_not_exit');
}
const started = performance.now();
const deadline = setTimeout(() => child.kill(), 45_000);
let result;
function connectAgent(action) {
  return acp.client({ name: 'uptokey-engine-evaluation' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const tool = params.toolCall;
      const allowed = ['task_status','task_resume','task_cancel','task_output'].some(name=>tool.name?.endsWith(name));
      const option = allowed && params.options.find(o => o.kind === 'allow_once');
      permissions.push({ title: tool.title, name: tool.name, input: tool.rawInput, allowed: Boolean(option) });
      return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .connectWith(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), action);
}
try {
  const scopeDenied = await localRequest('/responses', { model: 'fixture', input: 'scope probe' });
  assert.equal(scopeDenied.status, 403);
  await scopeDenied.text();
  const modelDenied = await localRequest('/chat/completions', { model: 'outside-fixture', messages: [{ role: 'user', content: 'model scope probe' }] });
  assert.equal(modelDenied.status, 403);
  await modelDenied.text();
  assert.equal(coreDispatches, 0, 'scope/model denial must precede upstream dispatch');
  result = await connectAgent(async ctx => {
      const initialized = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await ctx.request(acp.methods.agent.session.new, { cwd: launch.cwd, mcpServers: [] });
      const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Resume the host-bound Uptokey task, inspect the first child output, and return UPTOKEY_ENGINE_OK.' }] });
      assert.equal(response.stopReason, 'end_turn');
      assert.ok(updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes('UPTOKEY_ENGINE_OK')));
      assert.equal(fixtureReadObserved, true, 'canonical task receipts must reach the model transport');
      const completed=await taskRuntime.getProjectTask(owner,taskScope.projectId,taskScope.taskId);
      assert.equal(completed.status,'succeeded');
      assert.ok(completed.children.every(child=>child.receiptIds.length===1&&child.artifactIds.length===1));
      const executed=await taskRuntime.store.getBundle(owner,taskScope.projectId);
      assert.equal(executed.approvals.length,1,'engine must never create an approval');
      assert.equal(executed.runs.length,3,'one approved root and two canonical child runs');
      scenario = 'deny';
      const denied = await ctx.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Attempt to select another project through the bound tool.' }] });
      assert.equal(denied.stopReason, 'end_turn');
      assert.equal((await taskRuntime.store.getBundle(owner,taskScope.projectId)).runs.length,3,'extra tool arguments cannot dispatch another run');
      scenario = 'stall';
      const pending = ctx.request(acp.methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait for cancellation.' }] });
      await within(stalled.promise, 'model_stream_did_not_start');
      const cancelStarted = performance.now();
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      const cancelled = await within(pending, 'cancel_did_not_complete');
      assert.equal(cancelled.stopReason, 'cancelled');
      await within(cancelledStream.promise, 'upstream_stream_not_closed');
      return { initialized, sessionId: session.sessionId, response, denied, cancelled, cancelMs: performance.now() - cancelStarted, elapsedMs: performance.now() - started };
    });
  await stopAgent();
  env[launch.credentialEnvironment.mcp]=await taskHost.renew();
  taskTokens.push(taskHost.token);
  child = startAgent();
  scenario = 'resume';
  const beforeReplay = updates.length;
  result.restart = await connectAgent(async ctx => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await ctx.request(acp.methods.agent.session.load, { sessionId: result.sessionId, cwd: launch.cwd, mcpServers: [] });
    const replay = updates.slice(beforeReplay);
    const replayed = replay.length;
    assert.ok(replay.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes('UPTOKEY_ENGINE_OK')), 'persisted assistant output must replay after process restart');
    assert.ok(replay.some(u => ['tool_call', 'tool_call_update'].includes(u.sessionUpdate) && u.toolCallId === 'call_1' && u.status === 'completed'), 'persisted task output must replay after process restart');
    const response = await ctx.request(acp.methods.agent.session.prompt, { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'Confirm the resumed session with UPTOKEY_ENGINE_OK.' }] });
    assert.equal(response.stopReason, 'end_turn');
    assert.equal((await taskRuntime.store.getBundle(owner,taskScope.projectId)).runs.length,3,'engine restart must not replay child effects');
    return { replayed, response };
  });
  const beforeRevocation = coreDispatches;
  await revokeClientKey(secrets, issued.policy.id, issued.policy.revision, randomUUID());
  const revoked = await localRequest('/chat/completions', { model: 'fixture', messages: [{ role: 'user', content: 'revoked token probe' }] });
  assert.equal(revoked.status, 401);
  await revoked.text();
  assert.equal(coreDispatches, beforeRevocation, 'revocation must reject before upstream dispatch');
  assert.equal(deniedNetwork.length, 0, 'no default service may request outside network');
  taskSessionAllowed=false;
  await engineIdentity.close();
  const taskRevoked=await originalFetch(taskHost.url,{method:'POST',headers:{authorization:`Bearer ${taskHost.token}`,'content-type':'application/json'},body:'{}'});
  assert.equal(taskRevoked.status,401);await taskRevoked.text();
  result.task={implementation:'WorkspaceRuntime + project task authority + W5 executor + SDK MCP',status:'succeeded',approvedRoots:1,children:2,runsAfterRestart:3,sessionRevocationStatus:taskRevoked.status,nativeEngineTools:0,profile:launch.profile,profilePlacement:launch.profilePlacement};
  result.identity={hostTokenGivenToEngine:false,canonicalOwner:true,sameRuntime:true,budgetUsage:(await app.governanceStore.listBudgetUsage(owner,personal.id)).filter(row=>row.budgetId.startsWith('engine-')).map(row=>({id:row.budgetId,reserved:row.reserved,settled:row.settled}))};
  assert.equal(result.identity.budgetUsage.length,3);
  assert.ok(result.identity.budgetUsage.every(row=>BigInt(row.settled)>0n),'all owner budgets must account for the actual engine');
  result.core = { implementation: 'createApp + Router + createClientKey + MemorySecretStore', scopes: issued.policy.scopes, providerIds: issued.policy.providerIds, modelIds: issued.policy.modelIds, providerSecretGivenToEngine: false, dispatches: coreDispatches, upstreamRequests: requests.length, deniedScopeStatus: scopeDenied.status, deniedModelStatus: modelDenied.status, revokedStatus: revoked.status, dispatchesAfterRevocation: coreDispatches - beforeRevocation, performance: router.performanceMetrics(), externalNetworkAttempts: deniedNetwork.length };
  result.totalElapsedMs = performance.now() - started;
} catch (error) {
  result = { ...result, error: String(error), elapsedMs: performance.now() - started };
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { await stopAgent(); }
  catch (error) { result.cleanupError = String(error); process.exitCode = 1; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  proxyServer.closeAllConnections();
  await new Promise(resolve => proxyServer.close(resolve));
  await engineIdentity.close();
  inferenceServer.closeAllConnections();await new Promise(resolve=>inferenceServer.close(resolve));
  await taskHost.close();
  await app.closeWorkspace();
  globalThis.fetch = originalFetch;
  const receipt = JSON.stringify({ ...result, fixtureReadObserved, requests, permissions, updates, limits: ['real upstream binary and SDK MCP through real local core; deterministic local model', 'own core/engine profiles and in-memory secrets; not an operating-system sandbox', 'one synthetic root approval; sealed static verification plans only, no dynamic coding or promotion', 'offline entitlement guard explicitly allowed for this synthetic evaluation', 'synthetic provider usage is test data, not actual AI token consumption'] }, null, 2);
  assert.ok(![token,hostToken,engineIdentity.token,providerSecret,...taskTokens].some(secret=>receipt.includes(secret)||stderr.includes(secret)), 'credentials must not enter receipt or stderr');
  await writeFile(join(run, 'RESULT.json'), receipt);
  await writeFile(join(run, 'stderr.txt'), stderr);
  console.log(JSON.stringify({ run, ok: !result.error, error: result.error, requests: requests.length, elapsedMs: result.elapsedMs }));
}
} catch (error) {
  // Setup failures also own and close the servers/profile they already created.
  child?.kill();
  await engineIdentity?.close().catch(()=>undefined);
  for (const ownedServer of [server, proxyServer,inferenceServer]) if (ownedServer?.listening) {
    ownedServer.closeAllConnections();
    await new Promise(resolve => ownedServer.close(resolve));
  }
  await taskHost?.close().catch(() => undefined);
  await app?.closeWorkspace().catch(() => undefined);
  const reason = String(error).replaceAll(providerSecret, '[redacted]').replace(/utk_local_[A-Za-z0-9._-]+/g, '[redacted]');
  await writeFile(join(run, 'SETUP-OR-CLEANUP-ERROR.json'), JSON.stringify({ error: reason }));
  console.error(JSON.stringify({ run, ok: false, error: reason }));
  process.exitCode = 1;
}
