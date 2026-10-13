import { randomBytes } from "node:crypto";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Measure actual cumulative input echo in its seeded row, never characters already present in a response. */
export async function echoLatency(term, text, gapMs = 60, options = {}) {
  const marker = options.marker ?? `uk_${randomBytes(6).toString("hex")}_`;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!/^[a-zA-Z0-9_]+$/.test(marker) || marker.length + text.length > 90) throw new Error("echo_marker_invalid");
  term.child.write(marker);
  await term.until(() => term.screen().split("\n").some((line) => line.includes(marker)), "echo marker did not appear", timeoutMs);
  const row = term.screen().split("\n").findIndex((line) => line.includes(marker));
  if (row < 0) throw new Error("echo_marker_missing");
  const samples = [];
  let expected = marker;
  for (const character of text) {
    expected += character;
    if (options.beforeSample) options.beforeSample();
    const started = now();
    let matchingFrame;
    const unsubscribe = term.observeScreen?.((timing) => {
      if (!matchingFrame && timing.receivedAt >= started && (term.screen().split("\n")[row] ?? "").includes(expected)) matchingFrame = timing;
    });
    try {
      term.child.write(character);
      for (;;) {
        await term.until(() => true, "parsed", 1000);
        if ((term.screen().split("\n")[row] ?? "").includes(expected)) break;
        if (now() - started > timeoutMs) throw new Error(`echo_input_timeout:${expected}`);
        await sleep(2);
      }
      const observedMs = now() - started;
      samples.push(matchingFrame ? matchingFrame.parsedAt - started : observedMs);
      if (matchingFrame) options.onSample?.({
        inputToOutputMs: matchingFrame.receivedAt - started,
        harnessQueueMs: matchingFrame.parseStartedAt - matchingFrame.receivedAt,
        harnessParseMs: matchingFrame.parsedAt - matchingFrame.parseStartedAt,
        inputToParsedMs: matchingFrame.parsedAt - started,
        observedMs,
        bytes: matchingFrame.bytes,
      });
    } finally {
      unsubscribe?.();
    }
    await sleep(gapMs);
  }
  return samples;
}
