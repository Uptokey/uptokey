import test from 'node:test';
import assert from 'node:assert/strict';
import {Context, Service} from '@deepseek-ai/cordis';
import WorkbenchFileSystem from './filesystem.mjs';
import {materializationOwnership} from '../extensions/materialization-ownership.mjs';

class ControlledSsh extends Service {
  constructor(ctx) { super(ctx, 'ssh'); this.pending = new Map(); this.next = []; this.calls = []; }
  wait(method) { const gate = Promise.withResolvers(); this.pending.set(method, gate); return gate; }
  request(method) {
    this.calls.push(method);
    if (method === 'fs.stream') return Promise.resolve('stream-1');
    if (method === 'fs.next') return Promise.resolve(this.next.shift());
    if (method === 'fs.streamClose') return Promise.resolve(null);
    const gate = this.pending.get(method); if (!gate) throw Error(`unexpected_ssh_method:${method}`); return gate.promise;
  }
}

class ControlledPolicy extends Service {
  constructor(ctx) { super(ctx, 'sandboxPolicy'); this.defaultMode = 'workspace-write'; }
  resolve() { return {mode: this.defaultMode}; }
}

async function boot(t) {
  assert.equal(materializationOwnership.snapshot().active, 0);
  const ctx = new Context(), sshFiber = ctx.plugin(ControlledSsh); await sshFiber.await();
  const policyFiber = ctx.plugin(ControlledPolicy); await policyFiber.await();
  const fsFiber = ctx.plugin(WorkbenchFileSystem); await fsFiber.await();
  t.after(async () => { await fsFiber.dispose(); await policyFiber.dispose(); await sshFiber.dispose(); await ctx.fiber.dispose(); });
  return {filesystem: ctx.get('fs'), ssh: ctx.get('ssh')};
}

test('Cordis SSH scalar readers own resolve, lstat and stat until each remote call settles', async t => {
  const {filesystem, ssh} = await boot(t);
  for (const [method, invoke, value] of [
    ['fs.resolve', () => filesystem.resolve('/workspace/a'), {targetKey: '/workspace/a', displayPath: '/workspace/a'}],
    ['fs.lstat', () => filesystem.lstat('/workspace/a', {}), {type: 'file', size: 1}],
    ['fs.stat', () => filesystem.stat({targetKey: '/workspace/a'}), {type: 'file', size: 1}],
  ]) {
    const gate = ssh.wait(method), work = invoke();
    assert.equal(materializationOwnership.snapshot().kinds['filesystem-reader'], 1);
    gate.resolve(value); await work; assert.equal(materializationOwnership.snapshot().active, 0);
  }
});

test('Cordis SSH text stream remains owned through consumption and early close', async t => {
  const {filesystem, ssh} = await boot(t);
  ssh.next.push({done: false, value: 'first'}, {done: false, value: 'second'});
  const stream = await filesystem.streamText({targetKey: '/workspace/a'});
  assert.equal(materializationOwnership.snapshot().kinds['filesystem-reader'], 1);
  assert.deepEqual(await stream.next(), {done: false, value: 'first'});
  assert.equal(materializationOwnership.snapshot().kinds['filesystem-reader'], 1);
  await stream.return();
  assert.equal(materializationOwnership.snapshot().active, 0);
  assert.ok(ssh.calls.includes('fs.streamClose'));
});
