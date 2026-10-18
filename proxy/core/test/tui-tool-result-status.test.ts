import './isolated-gateway-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveToolActivity, liveTurnItems } from '../src/tui/live-activity.ts';
import { messageItems } from '../src/tui/controller.ts';
import { TuiStore, type Message } from '../src/tui/state.ts';
import { toolResultStatus } from '../src/tui/tool-result-status.ts';
import { renderItem, type TranscriptItem } from '../src/tui/transcript.ts';
import { CHROME_LANGS, chromeText } from '../src/tui/ui-chrome.ts';
import { setLang } from '../src/tui/i18n.ts';

const timestamp = '2026-10-18T00:00:00.000Z';
const cases = [
  { output: { status: 'succeeded' }, expected: 'done' },
  { output: { status: 'failed', checks: [{ status: 'fail', exitCode: 1 }] }, expected: 'error' },
  { output: { status: 'not_executed', reason: 'runtime_unavailable' }, expected: 'rejected' },
  { output: { status: 'not_completed', runStatus: 'failed' }, expected: 'error' },
  { output: { status: 'not_executed', reason: 'user_declined' }, expected: 'rejected' },
  { output: { status: 'not_completed', reason: 'declined_by_person' }, expected: 'rejected' },
  { output: { status: 'not_completed', runStatus: 'cancelled' }, expected: 'rejected' },
  { output: { tool: 'shadow_bash_run', status: 'completed', exitCode: 0, runId: 'run', receiptId: 'receipt' }, expected: 'done' },
  { output: { tool: 'shadow_bash_run', status: 'timed_out', exitCode: null, runId: 'run', receiptId: 'receipt' }, expected: 'error' },
  { output: { tool: 'shadow_bash_run', status: 'aborted', exitCode: null, runId: 'run', receiptId: 'receipt' }, expected: 'rejected' },
  { output: { tool: 'shadow_bash_run', status: 'cancelled', exitCode: null, runId: 'run', receiptId: 'receipt' }, expected: 'rejected' },
] as const;

for (const { output, expected } of cases) test(`canonical ${JSON.stringify(output)} has the same live and reopened tool state`, () => {
  const store = new TuiStore();
  const activity = liveToolActivity(event => store.dispatch(event));
  activity.call(JSON.stringify([{ index: 0, id: 'call', function: { name: 'execute_command', arguments: '{}' } }]));
  activity.result(JSON.stringify({ callId: 'call', output }));
  assert.equal(store.state.streamingToolCalls[0]!.status, expected);
  assert.equal(liveTurnItems(store.state).find(item => item.kind === 'tool')?.status, expected);
  const result = { callId: 'call', receiptId: 'receipt', output: JSON.stringify(output) };
  for (const role of ['assistant', 'tool'] as const) {
    const message: Message = { id: 'm', role, content: '', timestamp, toolCalls: role === 'assistant' ? [{ id: 'call', name: 'execute_command', arguments: '{}' }] : undefined, toolResults: [result] };
    for (const restored of [message, JSON.parse(JSON.stringify(message)) as Message]) {
      const item = messageItems(restored).find(item => item.kind === 'tool');
      assert.equal(item?.status, expected, role);
      assert.equal(item?.detail, result.output);
      assert.equal(item?.receipt, 'receipt');
    }
  }
  const legacyCall: Message = { id: 'legacy', role: 'assistant', content: '', timestamp, toolCalls: [{ id: 'call', name: 'execute_command', arguments: '{}', result: result.output }] };
  assert.equal(messageItems(legacyCall).find(item => item.kind === 'tool')?.status, expected);
});

test('legacy results remain readable, explicit non-execution wins over a diagnostic, and cached outcomes follow changed output', () => {
  assert.equal(toolResultStatus('legacy plain output'), 'done');
  assert.equal(toolResultStatus({ content: 'file contents' }), 'done');
  assert.equal(toolResultStatus({ error: 'read_failed' }), 'error');
  assert.equal(toolResultStatus({ status: 'not_executed', error: 'runtime_unavailable' }), 'rejected');
  const result = { callId: 'c', receiptId: '', output: '{"status":"succeeded"}' };
  const message: Message = { id: 'm', role: 'tool', content: '', timestamp, toolResults: [result] };
  assert.equal(messageItems(message).find(item => item.kind === 'tool')?.status, 'done');
  result.output = '{"status":"failed"}';
  assert.equal(messageItems(message).find(item => item.kind === 'tool')?.status, 'error');
});

test('neutral non-execution has a short muted label in all ten locales, without a success or failure glyph', () => {
  const item: TranscriptItem = { kind: 'tool', id: 'c', name: 'execute_command', summary: '', status: 'rejected' };
  try {
    for (const lang of CHROME_LANGS) {
      setLang(lang);
      const lines = renderItem(item, { width: 100, expanded: false, linear: true });
      const text = lines.flatMap(line => line.spans.map(span => span.text)).join('');
      assert.ok(text.includes(chromeText('tool_not_run')), lang);
      assert.ok(text.includes('⊘'), lang);
      assert.ok(!/[✓✗]/.test(text), lang);
      assert.ok(lines.flatMap(line => line.spans).every(span => span.tone !== 'success' && span.tone !== 'danger'), lang);
    }
  } finally { setLang('en'); }
  assert.equal(chromeText('tool_not_run'), 'Not run');
});
