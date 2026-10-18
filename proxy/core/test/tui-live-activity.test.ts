// Initialize an isolated profile before loading any application modules.
import './isolated-gateway-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiClient, type StreamEvent } from '../src/tui/client.ts';
import { TuiStore, REASONING_KEEP } from '../src/tui/state.ts';
import { liveToolActivity, liveTurnItems } from '../src/tui/live-activity.ts';

const origin = 'http://127.0.0.1:21435';
const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const delta = (value: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`;

test('the client reads reasoning under the three provider field names and keeps it apart from the answer', async t => {
  const body = [
    delta({ reasoning_content: 'DeepSeek style. ' }),
    delta({ reasoning: 'Ollama style. ' }),
    delta({ reasoning_text: 'Other style.' }),
    delta({ reasoning: { encrypted: 'opaque' } }),
    delta({ content: 'Answer.' }),
    'data: [DONE]\n\n',
  ].join('');
  t.mock.method(globalThis, 'fetch', async () => sse(body));
  const client = new TuiClient({ baseUrl: origin }); t.after(() => client.destroy());
  const seen: StreamEvent[] = [];
  for await (const event of client.chatStream('auto', [])) seen.push(event);
  assert.deepEqual(seen.filter((event) => event.type === 'reasoning').map((event) => event.data), ['DeepSeek style. ', 'Ollama style. ', 'Other style.']);
  assert.deepEqual(seen.filter((event) => event.type === 'text').map((event) => event.data), ['Answer.']);
});

test('tool calls are running from the moment their name is known until their result, across rounds', () => {
  const store = new TuiStore();
  const activity = liveToolActivity((event) => store.dispatch(event));
  activity.call(JSON.stringify([{ index: 0, id: 'call-a', function: { name: 'read_', arguments: '{"pa' } }]));
  activity.call(JSON.stringify([{ index: 0, function: { name: 'file', arguments: 'th":"a.js"}' } }]));
  assert.equal(store.state.streamingToolCalls.length, 1);
  assert.deepEqual({ name: store.state.streamingToolCalls[0]!.name, args: store.state.streamingToolCalls[0]!.args, status: store.state.streamingToolCalls[0]!.status }, { name: 'read_file', args: '{"path":"a.js"}', status: 'running' });
  activity.result(JSON.stringify({ callId: 'call-a', name: 'read_file', output: { path: 'a.js', content: 'x' } }));
  assert.equal(store.state.streamingToolCalls[0]!.status, 'done');
  // Next round: index 0 again is a new call, not an update of the finished one.
  activity.call(JSON.stringify([{ index: 0, id: 'call-b', function: { name: 'search_in_files', arguments: '{}' } }]));
  assert.equal(store.state.streamingToolCalls.length, 2);
  activity.result(JSON.stringify({ callId: 'call-b', name: 'search_in_files', output: { status: 'not_completed', reason: 'user_declined' } }));
  assert.deepEqual(store.state.streamingToolCalls.map((call) => call.status), ['done', 'rejected']);
  // The turn phase is not changed by tool activity (busy checks and undo guards key on it).
  assert.equal(store.state.turn, 'idle');
  // Malformed input is ignored without inventing a call.
  activity.call('not json'); activity.result('{"callId":"unknown"}');
  assert.equal(store.state.streamingToolCalls.length, 2);
});

test('live items show reasoning first, closed once a tool call or the answer follows, then the tools', () => {
  const store = new TuiStore();
  store.dispatch({ type: 'stream_reasoning', text: 'I should read the file.' });
  let items = liveTurnItems(store.state);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, 'reasoning');
  assert.equal(items[0]!.kind === 'reasoning' && items[0]!.done, false);
  liveToolActivity((event) => store.dispatch(event)).call(JSON.stringify([{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }]));
  items = liveTurnItems(store.state);
  assert.deepEqual(items.map((item) => item.kind), ['reasoning', 'tool']);
  const reasoning = items[0]!;
  assert.ok(reasoning.kind === 'reasoning' && reasoning.done && reasoning.endedAt! >= reasoning.startedAt!);
  assert.equal(items[1]!.kind === 'tool' && items[1]!.status, 'running');
});

test('reasoning is bounded, cleared with the turn and never mixed into the answer buffer', () => {
  const store = new TuiStore();
  store.dispatch({ type: 'stream_reasoning', text: 'x'.repeat(REASONING_KEEP + 500) });
  store.dispatch({ type: 'stream_reasoning', text: 'END' });
  assert.equal(store.state.streamReasoning.length, REASONING_KEEP);
  assert.ok(store.state.streamReasoning.endsWith('END'));
  assert.equal(store.state.streamBuffer, '');
  store.dispatch({ type: 'stream_delta', text: 'answer' });
  assert.ok(store.state.streamReasoningTime?.end !== undefined);
  store.dispatch({ type: 'stream_complete', messageId: 'm1' });
  assert.equal(store.state.streamReasoning, '');
  assert.equal(store.state.streamReasoningTime, null);
  assert.deepEqual(liveTurnItems(store.state), []);
  assert.equal(store.state.messages.at(-1)?.content, 'answer');
});
