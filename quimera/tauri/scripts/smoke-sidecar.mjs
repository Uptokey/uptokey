#!/usr/bin/env node
// Isolated smoke for the packaged Tauri sidecar (schema 2, Node runtime):
//   1. manifest/attestation verification (verifySidecar)
//   2. CLI help runs on the packaged runtime
//   3. REAL composition worker: starts (SQLite + langgraph from packaged
//      node_modules), reports ready, closes cleanly — never a stub
//   4. daemon: start -> /health (IPC secret bearer) -> anonymous denied ->
//      SIGTERM stop -> port released (no orphan)
//
// The keyring module is replaced only inside the spawned child via a loader
// fixture (same pattern as proxy/core/scripts/smoke-workspace-compiled.mjs):
// it verifies bundling/HTTP/storage, never native credential security.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes, createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {verifySidecar} from './verify-sidecar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sidecarDir = resolve(process.argv[2] || join(here, '..', 'resources', 'sidecar'));
const binary = join(sidecarDir, process.platform === 'win32' ? 'uptokey-windows.exe' : 'uptokey');
const cli = join(sidecarDir, 'cli.js');
const worker = join(sidecarDir, 'composition-worker.js');
let port;
const ipcSecret = randomBytes(32).toString('hex');
function removeTestRoot(root){
  const target=resolve(root);assert.equal(dirname(target),resolve(tmpdir()));assert.match(basename(target),/^uptokey-sidecar-(worker|daemon)-/);
  rmSync(target,{recursive:true,force:true});
}

function ensurePortFree() {
  const probe = createServer();
  return new Promise((ok, fail) => {
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(ok); });
  }).catch(() => {
    throw new Error(`port_${port}_occupied_foreign_proxy_never_killed`);
  });
}

function runHelp() {
  const result = spawnSync(binary, [cli, '--help'], {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  assert.equal(result.status, 0, `help exit ${result.status}: ${result.stderr}`);
  assert.ok(String(result.stdout).includes('uptokey'), 'help prints CLI usage');
}

function runWorker(databasePath) {
  const testRuntime = join(databasePath, process.platform === 'win32' ? 'uptokey-runtime.exe' : 'uptokey-runtime');
  cpSync(binary, testRuntime);
  assert.equal(createHash('sha256').update(readFileSync(testRuntime)).digest('hex'), createHash('sha256').update(readFileSync(binary)).digest('hex'));
  const driver = join(databasePath, 'worker-driver.mjs');
  writeFileSync(driver, `
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
const worker = new Worker(new URL(pathToFileURL(process.argv[2]).href), {
  workerData: { databasePath: process.argv[3] },
  env: { LANGCHAIN_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
  stdout: true, stderr: true,
});
let closed = false;
const timer = setTimeout(() => { console.error('worker_timeout'); process.exit(3); }, 20_000);
worker.stdout.resume(); worker.stderr.resume();
worker.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'startup_error') { console.error('worker_startup_error:' + message.code); process.exit(6); }
  if (message.type === 'ready') worker.postMessage({ type: 'close' });
  else if (message.type === 'closed' && !closed) { closed = true; clearTimeout(timer); console.log('worker_closed_clean'); process.exit(0); }
});
worker.on('error', (error) => { console.error('worker_error:' + error.message); clearTimeout(timer); process.exit(4); });
worker.on('exit', (code) => { if (!closed) { console.error('worker_exit_before_closed:' + code); clearTimeout(timer); process.exit(5); } });
`);
  const result = spawnSync(testRuntime, [driver, worker, join(databasePath, 'composition.sqlite')], {encoding: 'utf8', windowsHide: true, timeout: 60_000, cwd: sidecarDir});
  assert.equal(result.status, 0, `worker smoke failed: ${result.stdout} ${result.stderr}`);
  assert.ok(String(result.stdout).includes('worker_closed_clean'));
}

async function runDaemon(root) {
  const testRuntime = join(root, process.platform === 'win32' ? 'uptokey-runtime.exe' : 'uptokey-runtime');
  cpSync(binary, testRuntime);
  assert.equal(createHash('sha256').update(readFileSync(testRuntime)).digest('hex'), createHash('sha256').update(readFileSync(binary)).digest('hex'));
  const token = `utk_local_${randomBytes(24).toString('base64url')}`;
  const mockSource = `const values=new Map([['local:api-token',${JSON.stringify(token)}]]);export class Entry {constructor(service,account){if(service!=='com.uptokey.quimera.proxy')throw new Error('legacy_vault_access_blocked');this.account=account;}getPassword(){return values.get(this.account)||null;}setPassword(value){values.set(this.account,value);}deletePassword(){values.delete(this.account);}}`;
  const loader = join(root, 'keyring-fixture-loader.mjs');
  writeFileSync(loader, `export async function resolve(specifier,context,next){if(specifier==='@napi-rs/keyring')return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(mockSource))},shortCircuit:true};return next(specifier,context);}`);
  // Only the isolated test child remaps the fixed transport port. The packaged
  // app's Host validation stays intact; no installed runtime or bundle is edited.
  const transport = join(root, 'isolated-transport.mjs');
  writeFileSync(transport, `import {Server} from 'node:net';
const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){if(typeof args[0]==='object'&&args[0]?.port===21435)args[0]={...args[0],port:${port}};else if(args[0]===21435)args[0]=${port};return listen.apply(this,args);};`);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp'].includes(key.toLowerCase())));
  const child = spawn(testRuntime, ['--import', pathToFileURL(transport).href, '--experimental-loader', pathToFileURL(loader).href, cli, 'start', '--no-tailnet'], {
    cwd: sidecarDir,
    env: {...cleanEnv, UPTOKEY_QUIMERA_DATA_DIR: root, HOME: root, USERPROFILE: root, UPTOKEY_IPC_SECRET: ipcSecret},
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise(resolve => child.once('exit', resolve));
  const request = (path, body, method = body ? 'POST' : 'GET',authenticated=true) => new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{host:'127.0.0.1:21435',...(authenticated?{authorization:`Bearer ${ipcSecret}`} : {}),...(body?{'content-type':'application/json'}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',reject);
    });req.setTimeout(3000,()=>req.destroy(Error('smoke_request_timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try {
    let health,lastFailure;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon_exited_${child.exitCode}: ${output.replaceAll(token, '[redacted]').slice(-600)}`);
      try { const response = await request('/health'); if (response.ok) { health = await response.json(); break; } lastFailure=`HTTP ${response.status}`; } catch(error) {lastFailure=error.code??error.message;}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(health?.status, 'ok', 'daemon health ok with IPC secret; '+lastFailure+'; '+output.replaceAll(token,'[redacted]').replaceAll(ipcSecret,'[redacted]').slice(-1500));
    assert.equal(health?.data_plane, 'local');
    const anonymous = await request('/v1/workspace/projects',undefined,'GET',false);
    assert.equal(anonymous.status, 401, 'anonymous workspace request denied');
    const tokenLogged = String(output).includes(token);
    assert.equal(tokenLogged, false, 'administrative bearer never logged');
    return { token, health };
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await done;
    // Confirm the port is released: a stopped daemon leaves no orphan.
    const released = createServer();
    await new Promise((resolve, reject) => {
      released.once('error', reject);
      released.listen(port, '127.0.0.1', () => released.close(resolve));
    });
  }
}

const result = {};
try {
  await ensurePortFree();
  const verified = verifySidecar(sidecarDir);
  result.manifest = { version: verified.version, files: verified.files ?? 1, sha256: verified.sha256 };
  runHelp();
  result.help = 'passed';
  const workerRoot = mkdtempSync(join(tmpdir(), 'uptokey-sidecar-worker-'));
  try { runWorker(workerRoot); result.worker = 'passed'; } finally { removeTestRoot(workerRoot); }
  const daemonRoot = mkdtempSync(join(tmpdir(), 'uptokey-sidecar-daemon-'));
  try {
    const { health } = await runDaemon(daemonRoot);
    result.daemon = { started: true, stopped: true, orphanFree: true, version: health.version };
  } finally { removeTestRoot(daemonRoot); }
  result.passed = true;
  result.sidecarDir = sidecarDir;
  result.runtime = process.execPath;
  result.transport = {port,remappedOnlyInTestChild:true,canonicalHost:'127.0.0.1:21435'};
  result.checks = ['manifest attested', 'packaged runtime help', 'real composition worker ready+close', 'daemon health with IPC secret', 'anonymous denied', 'SIGTERM stop releases port'];
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
