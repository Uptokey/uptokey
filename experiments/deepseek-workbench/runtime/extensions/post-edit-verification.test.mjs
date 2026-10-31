import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReadback,
  createPostEditVerificationHandler,
  logicalLines,
  mutationValue,
} from './post-edit-verification-core.mjs';

function messageFactory(input) {
  return { id: 'notice-id', role: 'user', ...structuredClone(input) };
}

function execution(name = 'edit') {
  return {
    callId: 'call-1',
    rootCallId: 'root-1',
    name,
    arguments: {},
    agent: { id: 'agent-1' },
    token: Symbol('parent'),
    signal: new AbortController().signal,
  };
}

function success(value) {
  return { isError: false, value, content: [] };
}

function readResult(text, extra = {}) {
  const lines = logicalLines(text).map((line, index) => ({ number: index + 1, text: line }));
  return success({ path: '/workspace/demo.txt', offset: 1, lines, totalLines: lines.length, ...extra });
}

test('logical lines match tool-fs CRLF and terminal-newline semantics', () => {
  assert.deepEqual(logicalLines(''), []);
  assert.deepEqual(logicalLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(logicalLines('\n'), ['']);
  assert.deepEqual(logicalLines('a\n\n'), ['a', '']);
});

test('readback distinguishes exact, bounded, mismatch and malformed values', () => {
  assert.equal(classifyReadback('/workspace/demo.txt', 'a\nb\n', readResult('a\nb\n').value), 'exact');
  assert.equal(classifyReadback('/workspace/demo.txt', 'a\nb\n', { path: '/workspace/demo.txt', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 2 }), 'bounded');
  assert.equal(classifyReadback('/workspace/demo.txt', 'abcdef', { path: '/workspace/demo.txt', offset: 1, lines: [{ number: 1, text: 'abc... (line truncated to 3 chars)' }], totalLines: 1 }), 'bounded');
  assert.equal(classifyReadback('/workspace/demo.txt', 'a\nb', readResult('a\nc').value), 'mismatch');
  assert.equal(classifyReadback('/workspace/demo.txt', 'a', { ...readResult('a').value, path: '/workspace/other.txt' }), 'mismatch');
  assert.equal(classifyReadback('/workspace/demo.txt', 'a', { nope: true }), 'unavailable');
});

test('mutation values require canonical path and complete after text', () => {
  assert.deepEqual(mutationValue({ path: '/workspace/a', after: '' }), { path: '/workspace/a', after: '' });
  assert.equal(mutationValue({ path: '', after: 'a' }), undefined);
  assert.equal(mutationValue({ path: '/workspace/a' }), undefined);
});

test('successful edit performs one parented reread and appends exact notice', async () => {
  const calls = [];
  const tools = { execute: async input => { calls.push(input); return readResult('saved\r\n'); } };
  const handler = createPostEditVerificationHandler(tools, messageFactory);
  const exec = execution();
  const prior = { id: 'prior', role: 'user', content: [], source: { kind: 'test' } };
  const decision = await handler(exec, success({ path: '/workspace/demo.txt', before: 'old', after: 'saved\r\n' }), async () => ({ kind: 'accept', additionalContexts: [prior] }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { file_path: '/workspace/demo.txt' });
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].rootCallId, exec.rootCallId);
  assert.equal(calls[0].parent, exec.token);
  assert.equal(calls[0].agent, exec.agent);
  assert.equal(calls[0].signal, exec.signal);
  assert.equal(decision.additionalContexts[0], prior);
  assert.equal(decision.additionalContexts[1].source.summary, 'Saved file reread and verified');
});

test('nested contexts survive before the verification notice', async () => {
  const nested = { id: 'nested', role: 'user', content: [], source: { kind: 'nested' } };
  const handler = createPostEditVerificationHandler({ execute: async () => ({ ...readResult('saved'), additionalContexts: [nested] }) }, messageFactory);
  const decision = await handler(execution('write'), success({ path: '/workspace/demo.txt', operation: 'update', before: null, after: 'saved' }), async () => ({ kind: 'accept' }));
  assert.equal(decision.additionalContexts[0], nested);
  assert.equal(decision.additionalContexts[1].source.summary, 'Saved file reread and verified');
});

test('mismatch and failed reread keep the committed mutation accepted', async () => {
  const mismatch = createPostEditVerificationHandler({ execute: async () => readResult('other') }, messageFactory);
  const mismatchDecision = await mismatch(execution(), success({ path: '/workspace/demo.txt', before: '', after: 'saved' }), async () => ({ kind: 'accept' }));
  assert.equal(mismatchDecision.kind, 'accept');
  assert.equal(mismatchDecision.additionalContexts[0].source.summary, 'Saved file reread: mismatch');

  const unavailable = createPostEditVerificationHandler({ execute: async () => { throw new Error('offline'); } }, messageFactory);
  const unavailableDecision = await unavailable(execution(), success({ path: '/workspace/demo.txt', before: '', after: 'saved' }), async () => ({ kind: 'accept' }));
  assert.equal(unavailableDecision.kind, 'accept');
  assert.equal(unavailableDecision.additionalContexts[0].source.summary, 'Saved file reread: unavailable');
});

test('failed, malformed, unrelated and downstream-blocked calls do not reread', async () => {
  let calls = 0;
  const handler = createPostEditVerificationHandler({ execute: async () => { calls += 1; return readResult('x'); } }, messageFactory);
  const failed = { isError: true, error: { message: 'failed' }, content: [] };
  assert.deepEqual(await handler(execution(), failed, async () => ({ kind: 'accept' })), { kind: 'accept' });
  assert.deepEqual(await handler(execution(), success({ nope: true }), async () => ({ kind: 'accept' })), { kind: 'accept' });
  assert.deepEqual(await handler(execution('read'), readResult('x'), async () => ({ kind: 'accept' })), { kind: 'accept' });
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] };
  assert.equal(await handler(execution(), success({ path: '/workspace/x', after: 'x' }), async () => blocked), blocked);
  assert.equal(calls, 0);
});
