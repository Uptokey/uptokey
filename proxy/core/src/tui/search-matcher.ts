/** Regex runs only against already-authorized text. A worker bounds CPU even
 * for pathological expressions; no shell or filesystem authority is involved. */
import { Worker } from "node:worker_threads";

export interface SearchMatches { matches: Array<{ index: number; position: number; length: number }>; nextIndex: number }
export async function matchProjectLines(lines: string[], start: number, query: string, mode: "literal" | "regex", caseSensitive: boolean, signal?: AbortSignal): Promise<SearchMatches> {
  signal?.throwIfAborted();
  if (mode === "literal") {
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatches["matches"] = [];
    let index = start;
    for (; index < lines.length && matches.length < 51; index++) {
      const position = (caseSensitive ? lines[index]! : lines[index]!.toLowerCase()).indexOf(needle);
      if (position >= 0) matches.push({ index, position, length: query.length });
    }
    return { matches, nextIndex: index };
  }
  // Validate syntax before creating a worker; matching itself never runs here.
  try { new RegExp(query, caseSensitive ? "u" : "iu"); } catch { throw new Error("project_regex_invalid"); }
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const regex = new RegExp(workerData.query, workerData.caseSensitive ? 'u' : 'iu');
    const matches = []; let index = workerData.start;
    for (; index < workerData.lines.length && matches.length < 51; index++) {
      const match = regex.exec(workerData.lines[index]);
      if (match) matches.push({ index, position: match.index, length: match[0].length });
    }
    parentPort.postMessage({ matches, nextIndex: index });
  `, { eval: true, workerData: { lines, start, query, caseSensitive }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
  try {
    return await new Promise<SearchMatches>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("project_regex_timeout")), 750);
      const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      let settled = false;
      const finish = (error?: Error, result?: SearchMatches) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      worker.once("message", result => finish(undefined, result as SearchMatches));
      worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once("exit", () => finish(new Error("project_regex_worker_closed")));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally { await worker.terminate(); }
}
