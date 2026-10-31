import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {Context, Service} from '@deepseek-ai/cordis';
import WorkbenchSubprocessRuntime from './subprocess.mjs';
import {materializationOwnership} from '../extensions/materialization-ownership.mjs';

class ControlledSsh extends Service {
  constructor(ctx) {
    super(ctx, 'ssh');
    this.direct = Promise.withResolvers();
    this.range = Promise.withResolvers();
    this.terminalPrepare = Promise.withResolvers();
    this.waitCalls = 0;
  }
  request(method, input) {
    if (method === 'process.prepare' && input?.terminal) return this.terminalPrepare.promise;
    if (method === 'process.prepare') return Promise.resolve({id: 'owned-process', streams: {}});
    if (method === 'process.start') return Promise.resolve(input?.id === 'owned-terminal' ? {pid: 41} : {});
    if (method === 'process.done') return this.direct.promise;
    if (method === 'process.wait') { this.waitCalls++; return this.range.promise; }
    if (method === 'process.terminate') return Promise.resolve(null);
    throw Error(`unexpected_ssh_method:${method}`);
  }
  connectStream() { return Promise.resolve(new PassThrough()); }
  dispose() { return Promise.resolve(); }
}

const spec = signal => ({
  argv: ['/usr/bin/true'],
  cwd: '/workspace',
  stdio: {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'},
  graceMs: 1,
  ...(signal === undefined ? {} : {signal}),
});

test('Cordis SSH provider retains ownership after direct completion until the managed range is empty', async t => {
  assert.equal(materializationOwnership.snapshot().active, 0);
  const ctx = new Context();
  const sshFiber = ctx.plugin(ControlledSsh); await sshFiber.await();
  const subprocessFiber = ctx.plugin(WorkbenchSubprocessRuntime); await subprocessFiber.await();
  t.after(async () => { await subprocessFiber.dispose(); await sshFiber.dispose(); await ctx.fiber.dispose(); });
  const ssh = ctx.get('ssh'), runtime = ctx.get('subprocess'), handle = runtime.spawn(spec());
  assert.equal(materializationOwnership.snapshot().kinds['process-range'], 1);
  ssh.direct.resolve({outcome: {exitCode: 0}, spills: {}, collected: {}});
  await handle.done;
  assert.equal(materializationOwnership.snapshot().kinds['process-range'], 1);
  let entered = false; const exclusive = materializationOwnership.runExclusive(async () => { entered = true; });
  await new Promise(done => setImmediate(done)); assert.equal(entered, false); assert.ok(ssh.waitCalls >= 1);
  ssh.range.resolve(true); await exclusive;
  assert.equal(materializationOwnership.snapshot().active, 0);
});

test('a rejected synchronous spawn releases its pre-admission ownership', async t => {
  assert.equal(materializationOwnership.snapshot().active, 0);
  const ctx = new Context();
  const sshFiber = ctx.plugin(ControlledSsh); await sshFiber.await();
  const subprocessFiber = ctx.plugin(WorkbenchSubprocessRuntime); await subprocessFiber.await();
  t.after(async () => { await subprocessFiber.dispose(); await sshFiber.dispose(); await ctx.fiber.dispose(); });
  const controller = new AbortController(); controller.abort(Error('synthetic cancellation'));
  assert.throws(() => ctx.get('subprocess').spawn(spec(controller.signal)), /synthetic cancellation/);
  assert.equal(materializationOwnership.snapshot().active, 0);
});

test('terminal allocation owns the range before its first asynchronous remote step', async t => {
  assert.equal(materializationOwnership.snapshot().active, 0);
  const ctx = new Context();
  const sshFiber = ctx.plugin(ControlledSsh); await sshFiber.await();
  const subprocessFiber = ctx.plugin(WorkbenchSubprocessRuntime); await subprocessFiber.await();
  t.after(async () => { await subprocessFiber.dispose(); await sshFiber.dispose(); await ctx.fiber.dispose(); });
  const ssh = ctx.get('ssh'), runtime = ctx.get('subprocess');
  const allocation = runtime.spawnTerminal({
    argv: ['/bin/sh'], cwd: '/workspace', env: {}, terminalType: 'xterm', cols: 80, rows: 24, graceMs: 1,
  });
  assert.equal(materializationOwnership.snapshot().kinds['terminal-range'], 1);
  let entered = false;
  const exclusive = materializationOwnership.runExclusive(async () => { entered = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(entered, false);
  ssh.terminalPrepare.resolve({
    id: 'owned-terminal',
    streams: {terminal: {path: '/tmp/owned-terminal', capability: 'a'.repeat(64)}},
  });
  const handle = await allocation;
  ssh.direct.resolve({outcome: {exitCode: 0}, spills: {}, collected: {}});
  await handle.done;
  await exclusive;
  assert.equal(entered, true);
  assert.equal(materializationOwnership.snapshot().active, 0);
});
