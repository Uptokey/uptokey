/**
 * Live activity of a turn: what the model is reasoning and which tools it is running, shown while the turn runs.
 * Canonical history is unchanged; after the turn the persisted tool calls/results replace these live items.
 */
import type { StateEvent, StreamToolCall, TuiState } from "./state.ts";
import type { TranscriptItem } from "./transcript.ts";
import { toolResultStatus } from "./tool-result-status.ts";

const SUMMARY_MAX = 120;
const DETAIL_MAX = 2_000;

type CallDelta = { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };

/**
 * Follows streamed tool-call deltas (accumulated per index, as providers send them) and the results the turn loop
 * reports after running each call. A call is "running" from the moment its name is known until its result arrives.
 */
export function liveToolActivity(dispatch: (event: StateEvent) => void) {
  let round = 0;
  let resultsSinceCalls = false;
  const calls = new Map<number, { liveId: string; callId: string; name: string; args: string; startedAt: number }>();
  const byCallId = new Map<string, string>();
  const publish = (call: { liveId: string; name: string; args: string; startedAt: number }) => {
    if (!call.name) return;
    const toolCall: StreamToolCall = { id: call.liveId, name: call.name, args: call.args.length > SUMMARY_MAX ? `${call.args.slice(0, SUMMARY_MAX)}…` : call.args, status: "running", startedAt: call.startedAt };
    dispatch({ type: "stream_tool_call", toolCall });
  };
  return {
    call(data: string) {
      let deltas: unknown;
      try { deltas = JSON.parse(data); } catch { return; }
      if (!Array.isArray(deltas)) return;
      // Indices restart every round: a call after results opens the next round.
      if (resultsSinceCalls) { round++; calls.clear(); resultsSinceCalls = false; }
      for (const delta of deltas as CallDelta[]) {
        if (typeof delta?.index !== "number" || !Number.isSafeInteger(delta.index) || delta.index < 0) continue;
        const call = calls.get(delta.index) ?? { liveId: `live-tool-${round}-${delta.index}`, callId: "", name: "", args: "", startedAt: Date.now() };
        if (typeof delta.id === "string" && delta.id) { call.callId = delta.id; byCallId.set(delta.id, call.liveId); }
        if (typeof delta.function?.name === "string") call.name += delta.function.name;
        if (typeof delta.function?.arguments === "string") call.args += delta.function.arguments;
        calls.set(delta.index, call);
        publish(call);
      }
    },
    result(data: string) {
      let value: { callId?: unknown; output?: unknown };
      try { value = JSON.parse(data) as typeof value; } catch { return; }
      if (typeof value?.callId !== "string") return;
      const liveId = byCallId.get(value.callId);
      if (!liveId) return;
      resultsSinceCalls = true;
      const output = value.output;
      const status = toolResultStatus(output);
      const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
      dispatch({ type: "stream_tool_result", id: liveId, result: text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text, status, isError: status === "error" });
    },
  };
}

/** Transcript items for the turn in progress: reasoning first, then the tools in call order. */
export function liveTurnItems(state: Pick<TuiState, "streamReasoning" | "streamReasoningTime" | "streamingToolCalls">): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const time = state.streamReasoningTime;
  if (state.streamReasoning.trim() && time) items.push({ kind: "reasoning", id: "live-reasoning", text: state.streamReasoning, done: time.end !== undefined, startedAt: time.start, ...(time.end !== undefined ? { endedAt: time.end } : {}) });
  for (const call of state.streamingToolCalls) {
    items.push({ kind: "tool", id: call.id, name: call.name, summary: call.args, status: call.status === "error" ? "error" : call.status === "done" ? "done" : call.status === "rejected" ? "rejected" : "running", ...(call.result !== undefined ? { detail: call.result } : {}) });
  }
  return items;
}
