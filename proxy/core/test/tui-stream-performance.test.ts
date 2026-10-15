import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { createStreamCoalescer, STREAM_COALESCE_MS, type CoalescedStreamEvent } from "../src/tui/stream-coalescing.ts";
import { messageItems, TuiController } from "../src/tui/controller.ts";
import type { Message } from "../src/tui/state.ts";

test("leading text reaches the consumer immediately; later text still batches", async () => {
  const events: CoalescedStreamEvent[] = [];
  const coalescer = createStreamCoalescer({ leading: true, onFlush: event => events.push(event) });
  assert.equal(STREAM_COALESCE_MS, 60);
  coalescer.push({ type: "text", data: "" });
  coalescer.push({ type: "text", data: "First" });
  assert.deepEqual(events, [{ type: "text", data: "First" }]);
  coalescer.push({ type: "text", data: " second" });
  coalescer.push({ type: "text", data: " third" });
  assert.equal(events.length, 1);
  await delay(20);
  assert.equal(events.length, 1);
  await delay(70);
  assert.deepEqual(events, [{ type: "text", data: "First" }, { type: "text", data: " second third" }]);
  coalescer.discard();
});

test("default consumers retain one combined batch and explicit flush cancels the timer", async () => {
  const events: CoalescedStreamEvent[] = [];
  const coalescer = createStreamCoalescer({ windowMs: 15, onFlush: event => events.push(event) });
  coalescer.push({ type: "text", data: "first" });
  coalescer.push({ type: "text", data: " second" });
  assert.deepEqual(events, []);
  coalescer.flushNow();
  assert.deepEqual(events, [{ type: "text", data: "first second" }]);
  await delay(30);
  assert.equal(events.length, 1);
});

test("leading text, buffered text and terminal events preserve ordering without replay", async () => {
  for (const end of [{ type: "done" }, { type: "error", data: "interrupted" }] as CoalescedStreamEvent[]) {
    const events: CoalescedStreamEvent[] = [];
    const coalescer = createStreamCoalescer({ leading: true, windowMs: 15, onFlush: event => events.push(event) });
    coalescer.push({ type: "text", data: "one" });
    coalescer.push({ type: "text", data: "two" });
    coalescer.push(end);
    assert.deepEqual(events, [{ type: "text", data: "one" }, { type: "text", data: "two" }, end]);
    await delay(30);
    assert.equal(events.length, 3);
  }
});

test("discard cancels only pending text and cannot remove the first delivered text", async () => {
  const events: CoalescedStreamEvent[] = [];
  const coalescer = createStreamCoalescer({ leading: true, windowMs: 15, onFlush: event => events.push(event) });
  coalescer.push({ type: "text", data: "accepted partial" });
  coalescer.push({ type: "text", data: "pending" });
  coalescer.discard();
  coalescer.flushNow();
  await delay(30);
  assert.deepEqual(events, [{ type: "text", data: "accepted partial" }]);
});

test("real controller delivers first text before requesting another chunk and cancels buffered tail", async t => {
  const controller = new TuiController({ cwd: process.cwd(), baseUrl: "http://127.0.0.1:9" });
  t.after(() => controller.dispose());
  t.mock.method(controller.client, "fetchAuth", async () => { throw Error("unexpected_network"); });
  controller.store.dispatch({ type: "connection_changed", phase: "authenticated" });
  controller.store.dispatch({ type: "conversation_selected", conversation: { id: "fixture-conversation" } });
  controller.view.mode = "plan";
  t.mock.method(controller.conversations, "loadMessages", async () => controller.state.messages);
  let reachedPending!: () => void;
  const pending = new Promise<void>(resolve => { reachedPending = resolve; });
  const deltas: string[] = [];
  controller.on("delta", text => deltas.push(text));
  t.mock.method(controller.conversations, "sendTurn", async function* (options: Parameters<typeof controller.conversations.sendTurn>[0]) {
    yield { type: "text" as const, data: "first" };
    assert.equal(controller.state.streamBuffer, "first");
    yield { type: "text" as const, data: " pending" };
    assert.equal(controller.state.streamBuffer, "first");
    reachedPending();
    await new Promise<void>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const submitted = controller.submit("fixture question");
  await pending;
  assert.equal(controller.cancel(), true);
  await submitted;
  await delay(80);
  assert.deepEqual(deltas, ["first"]);
  assert.ok(controller.state.messages.some(message => message.interrupted === "cancelled" && message.content === "first"));
});

function toolMessage(output: string, id = "tool"): Message {
  return { id, role: "assistant", content: "answer", timestamp: "2026-10-15T00:00:00Z",
    toolCalls: [{ id, name: "read_file", arguments: '{"path":"fixture.txt"}' }],
    toolResults: [{ callId: id, receiptId: `receipt-${id}`, output }] };
}

test("18 history recomposes preserve large outputs without parsing completed results again", () => {
  const messages = Array.from({ length: 100 }, (_, index) => toolMessage(JSON.stringify({ status: "completed", payload: `${index}:` + "x".repeat(256 * 1024) }), String(index)));
  const expected = messages.flatMap(messageItems);
  const parse = JSON.parse;
  let outputParses = 0;
  JSON.parse = ((value: string, ...rest: Parameters<typeof JSON.parse> extends [unknown, ...infer Tail] ? Tail : never) => {
    if (value.startsWith('{"status":"completed","payload":')) outputParses++;
    return parse(value, ...rest);
  }) as typeof JSON.parse;
  try {
    for (let index = 0; index < 18; index++) assert.deepEqual(messages.flatMap(messageItems), expected);
    assert.equal(outputParses, 0);
  } finally { JSON.parse = parse; }
});

test("result output mutations invalidate classification while receipt and detail stay current", () => {
  const message = toolMessage('{"status":"completed","value":1}');
  const result = message.toolResults![0]!;
  for (const [output, status] of [
    ['{"status":"completed","value":1}', "done"],
    ['{"status":"not_completed"}', "error"],
    ['{"error":"permission_required"}', "error"],
    ['legacy plain output', "done"],
    ['null', "done"],
    ['{"status":"completed","value":2}', "done"],
  ]) {
    result.output = output!;
    result.receiptId += "-new";
    const item = messageItems(message)[1]!;
    assert.ok(item.kind === "tool");
    assert.equal(item.status, status);
    assert.equal(item.detail, output);
    assert.equal(item.receipt, result.receiptId);
  }
  message.toolResults = [{ ...result, output: '{"error":"new-object"}' }];
  const changed = messageItems(message)[1]!;
  assert.ok(changed.kind === "tool");
  assert.equal(changed.status, "error");
});

test("cached classification does not keep a released result object alive", () => {
  const controllerUrl = new URL("../src/tui/controller.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", `
    import { messageItems } from ${JSON.stringify(controllerUrl)};
    import { setImmediate as turn } from 'node:timers/promises';
    let result = { callId: 'call', receiptId: 'receipt', output: '{"status":"completed","large":"' + 'x'.repeat(1024*1024) + '"}' };
    const weak = new WeakRef(result);
    messageItems({id:'m',role:'assistant',content:'',timestamp:'2026-10-15',toolCalls:[{id:'call',name:'read',arguments:'{}'}],toolResults:[result]});
    result = null;
    for(let index=0;index<20;index++){await turn();globalThis.gc();if(weak.deref()===undefined){process.stdout.write('collected');process.exit(0);}}
    throw new Error('released_result_retained');
  `], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.equal(child.stdout, "collected");
});
