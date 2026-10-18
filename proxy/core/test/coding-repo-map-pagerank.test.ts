import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, utimes, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rankedRepoMap } from "../src/coding/repo-map-v2.ts";
import { pageRank } from "../src/coding/pagerank.ts";
import { buildRepoGraph, type RepoGraph } from "../src/coding/repo-graph.ts";

test("PageRank ranks a shared utility imported by eight files and honors @ focus", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-repo-map-"));
  await writeFile(join(root, "utils.ts"), "export function add(a: number, b: number) { return a + b; }\n", "utf8");
  for (let i = 0; i < 8; i += 1) await writeFile(join(root, `consumer-${i}.ts`), `import { add } from './utils'; export function use${i}() { return add(${i}, 1); }\n`, "utf8");
  for (let i = 0; i < 3; i += 1) await writeFile(join(root, `leaf-${i}.ts`), `export const leaf${i} = ${i};\n`, "utf8");
  const first = await rankedRepoMap(root, [], { projectId: "a10", rootBindingId: "fixture" });
  assert.ok(first.findIndex((entry) => entry.path === "utils.ts") < 3, first.map((entry) => entry.path).join(","));
  const focused = await rankedRepoMap(root, ["@leaf-2.ts"], { projectId: "a10", rootBindingId: "fixture" });
  assert.equal(focused[0]?.path, "leaf-2.ts");
  const started = performance.now();
  await rankedRepoMap(root, [], { projectId: "a10", rootBindingId: "fixture" });
  assert.ok(performance.now() - started < 100, "cached repo map exceeded 100ms");
});

test("a shared cache separates exact roots even when relative paths, sizes and mtimes match", async () => {
  const base = await mkdtemp(join(tmpdir(), "uptokey-root-cache-"));
  const left = join(base, "left"), right = join(base, "right"), dataDir = join(base, "cache");
  await mkdir(left); await mkdir(right);
  const leftFile = join(left, "source.ts"), rightFile = join(right, "source.ts"), stamp = new Date("2025-01-01T00:00:00Z");
  await writeFile(leftFile, "export function left() { return 1; }\n");
  await writeFile(rightFile, "export function rght() { return 1; }\n");
  await utimes(leftFile, stamp, stamp); await utimes(rightFile, stamp, stamp);
  const a = await rankedRepoMap(left, [], { dataDir }), b = await rankedRepoMap(right, [], { dataDir });
  assert.ok(a[0]?.symbols.some(symbol => symbol.name === "left"));
  assert.ok(b[0]?.symbols.some(symbol => symbol.name === "rght"));
  assert.ok(!b[0]?.symbols.some(symbol => symbol.name === "left"));
  await writeFile(leftFile, "export function newer() { return 2; }\n");
  const changed = await rankedRepoMap(left, [], { dataDir });
  assert.ok(changed[0]?.symbols.some(symbol => symbol.name === "newer"));
  assert.ok(!changed[0]?.symbols.some(symbol => symbol.name === "left"));
});

test("weighted reference edges preserve the transition probabilities of the complete multigraph", () => {
  const common = { files: ["a", "b", "c"].map(id => ({ id, path: id, sha256: "", loc: 0, size: 0, mtimeMs: 0 })), symbols: [], createdAt: "fixture" };
  const compact: RepoGraph = { ...common, edges: [{ from: "a", to: "b", kind: "references", weight: 300 }, { from: "a", to: "c", kind: "references", weight: 7 }, { from: "b", to: "a", kind: "references", weight: 11 }] };
  const expanded: RepoGraph = { ...common, edges: compact.edges.flatMap(edge => Array.from({ length: edge.weight! }, () => ({ from: edge.from, to: edge.to, kind: edge.kind }))) };
  const before = pageRank(expanded), after = pageRank(compact);
  for (const [id, value] of before) assert.ok(Math.abs(value - after.get(id)!) < 1e-12, `${id} changed probability`);
});

test("compact graph cache roundtrips exact edge order, weights, symbols and ranks while preserving old caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-compact-cache-")), dataDir = join(root, "data");
  await writeFile(join(root, "shared.ts"), "export function shared() { return 1; }\n");
  await writeFile(join(root, "consumer.ts"), "export function consumer() { return shared()+shared()+shared(); }\n");
  const cacheDir = join(dataDir, "repo-graph", "default");
  await mkdir(cacheDir, { recursive: true });
  const oldPath = join(cacheDir, "historical.v2.json"), oldBytes = "{\"historical\":true}\n";
  await writeFile(oldPath, oldBytes);
  const before = await buildRepoGraph(root, { dataDir });
  assert.ok(before.edges.some(edge => edge.kind === "references" && edge.weight === 3));
  const cacheName = (await readdir(cacheDir)).find(name => name.endsWith(".v3.json"));
  assert.ok(cacheName);
  const wire = JSON.parse(await readFile(join(cacheDir, cacheName), "utf8"));
  assert.equal(wire.version, 3);
  assert.equal(wire.edges.length, before.edges.length * 4);
  assert.ok(wire.edges.every((value: unknown) => typeof value === "number"));
  const after = await buildRepoGraph(root, { dataDir });
  assert.deepEqual(after, before);
  assert.deepEqual([...pageRank(after)], [...pageRank(before)]);
  assert.equal(await readFile(oldPath, "utf8"), oldBytes);
  assert.deepEqual((await readdir(cacheDir)).filter(name => name.endsWith(".tmp")), []);
});
