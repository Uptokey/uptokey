import assert from "node:assert/strict";
import test from "node:test";
import { echoLatency, type EchoLatencySample, type EchoScreenTiming } from "../scripts/lib/tui-echo-latency.mjs";

test("benchmark ignores response redraws containing the typed character until input itself appears", async () => {
  let clock = 0;
  let composer = "";
  let body = "reply already contains a and b";
  let pending = "";
  const term = {
    child: { write: (value: string) => { if (value.startsWith("marker_")) composer = value; else pending += value; } },
    screen: () => `${body}\n${composer}\nfooter`,
    until: async (predicate: () => boolean) => { assert.equal(predicate(), true); }
  };
  const samples = await echoLatency(term, "ab", 0, {
    marker: "marker_", now: () => clock,
    sleep: async (ms: number) => { clock += ms; body += "a"; if (ms === 2 && clock % 6 === 0) { composer += pending; pending = ""; } }
  });
  assert.deepEqual(samples, [6, 6]);
  assert.equal(composer, "marker_ab");
});

test("benchmark never counts missing input as a successful timeout sample", async () => {
  let clock = 0;
  let composer = "";
  const term = {
    child: { write: (value: string) => { if (value === "marker_") composer = value; } },
    screen: () => `model response contains x\n${composer}`,
    until: async (predicate: () => boolean) => { assert.equal(predicate(), true); }
  };
  await assert.rejects(echoLatency(term, "x", 0, { marker: "marker_", timeoutMs: 10, now: () => clock, sleep: async (ms: number) => { clock += ms; } }), /echo_input_timeout/);
});

test("benchmark bounds input marker length before writing to the 120-column terminal", async () => {
  const term = {
    child: { write: () => { throw new Error("must not write"); } },
    screen: () => { throw new Error("must not read screen"); },
    until: async () => { throw new Error("must not wait"); },
  };
  await assert.rejects(echoLatency(term, "a".repeat(90), 0, { marker: "marker_" }), /echo_marker_invalid/);
});

test("benchmark separates output receipt from parser delay and ignores unrelated frames", async () => {
  let clock = 0;
  let composer = "";
  let observer: ((value: EchoScreenTiming) => void) | undefined;
  const breakdown: EchoLatencySample[] = [];
  let disposed = 0;
  const term = {
    child: { write: (value: string) => {
      if (value === "marker_") { composer = value; return; }
      clock = 10;
      observer?.({ receivedAt: 2, parseStartedAt: 3, parsedAt: 10, bytes: 50 });
      composer += value;
      clock = 35;
      observer?.({ receivedAt: 12, parseStartedAt: 20, parsedAt: 35, bytes: 100 });
    } },
    screen: () => `response\n${composer}`,
    observeScreen: (callback: (value: EchoScreenTiming) => void) => { observer = callback; return () => { observer = undefined; disposed++; }; },
    until: async (predicate: () => boolean) => { assert.equal(predicate(), true); clock += 5; }
  };
  const samples = await echoLatency(term, "a", 0, { marker: "marker_", now: () => clock, sleep: async () => {}, onSample: (sample) => breakdown.push(sample) });
  assert.deepEqual(samples, [30]);
  assert.deepEqual(breakdown, [{ inputToOutputMs: 7, harnessQueueMs: 8, harnessParseMs: 15, inputToParsedMs: 30, observedMs: 35, bytes: 100 }]);
  assert.equal(disposed, 1);
});

test("benchmark stops sampling when its requested phase has ended", async () => {
  const term = {
    child: { write: (value: string) => { assert.equal(value, "marker_"); } },
    screen: () => "marker_",
    until: async () => {},
  };
  await assert.rejects(echoLatency(term, "a", 0, { marker: "marker_", beforeSample: () => { throw new Error("stream ended"); } }), /stream ended/);
});
