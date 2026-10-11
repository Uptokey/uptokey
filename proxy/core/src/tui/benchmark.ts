/**
 * Uptokey TUI — Performance benchmarks.
 * Measures startup time, rendering latency, memory usage.
 */

export interface BenchmarkResult {
  name: string;
  iterations: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  memoryMB: number;
}

/**
 * Measure execution time of a function over N iterations.
 */
export async function benchmark(
  name: string,
  fn: () => unknown | Promise<unknown>,
  iterations = 100,
): Promise<BenchmarkResult> {
  const times: number[] = [];
  const startMem = process.memoryUsage().heapUsed;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  const endMem = process.memoryUsage().heapUsed;
  times.sort((a, b) => a - b);

  return {
    name,
    iterations,
    p50: times[Math.floor(times.length * 0.5)]!,
    p95: times[Math.floor(times.length * 0.95)]!,
    p99: times[Math.floor(times.length * 0.99)]!,
    min: times[0]!,
    max: times[times.length - 1]!,
    memoryMB: Math.round((endMem - startMem) / 1024 / 1024 * 100) / 100,
  };
}

/**
 * Format benchmark results as a table.
 */
export function formatBenchmarks(results: BenchmarkResult[]): string {
  const header = "| Benchmark | Iterations | p50 (ms) | p95 (ms) | p99 (ms) | Memory (MB) |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const rows = results.map((r) =>
    `| ${r.name} | ${r.iterations} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.memoryMB} |`
  );
  return [header, sep, ...rows].join("\n");
}
