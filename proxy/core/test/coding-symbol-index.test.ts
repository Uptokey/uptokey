import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSymbolIndex, createMemorySymbolIndex } from "../src/coding/symbol-index.ts";

test("indexes mixed Python, TypeScript and Go declarations with one WASM grammar per language", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-symbols-"));
  const index = await buildSymbolIndex(root);
  await index.add("add.py", "def add(a, b):\n    return a + b\n");
  await index.add("add.ts", "export function add(a: number, b: number) { return a + b; }\n");
  await index.add("add.go", "package main\nfunc add(a int, b int) int { return a + b }\n");
  const matches = index.query("add");
  assert.equal(matches.length, 3);
  assert.deepEqual(new Set(matches.map((item) => item.language)), new Set(["python", "typescript", "go"]));
});

test("refresh reparses a changed file and persists symbols in SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-symbols-"));
  const file = join(root, "main.py");
  await writeFile(file, "def old():\n    pass\n", "utf8");
  const index = await buildSymbolIndex(root);
  await index.refresh(file);
  assert.equal(index.query("old").length, 1);
  await writeFile(file, "def new_name():\n    pass\n", "utf8");
  const started = performance.now();
  await index.refresh(file);
  const elapsed = performance.now() - started;
  assert.equal(index.query("old").length, 0);
  assert.equal(index.query("new_name").length, 1);
  assert.ok(elapsed < 50, `refresh took ${elapsed.toFixed(2)}ms`);
  await index.save();
  const reopened = await buildSymbolIndex(root);
  assert.equal(reopened.query("new_name").length, 1);
});

test("references returns identifier occurrences without leaking declaration nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-symbols-"));
  const index = await buildSymbolIndex(root);
  await index.add("main.ts", "function add(a: number, b: number) { return a + b; }\nadd(1, 2);\n");
  const symbol = index.query("add")[0];
  assert.ok(symbol);
  const refs = index.references(symbol);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.line, 1);
});

test("loads every contracted grammar lazily", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-symbols-"));
  const index = await buildSymbolIndex(root);
  const fixtures: Record<string, string> = {
    js: "function add() { return 1; }",
    ts: "function add(): number { return 1; }",
    py: "def add():\n    return 1\n",
    go: "package main\nfunc add() int { return 1 }",
    rs: "fn add() -> i32 { 1 }",
    java: "class Add { int add() { return 1; } }",
    cs: "class Add { int AddOne() { return 1; } }",
    cpp: "int add() { return 1; }",
    rb: "def add\n  1\nend",
    php: "<?php function add() { return 1; }",
    swift: "func add() -> Int { return 1 }",
  };
  for (const [extension, source] of Object.entries(fixtures)) await index.add(`grammar.${extension}`, source);
});

test("bulk indexing resolves only requested reference names and observes replacement or removal", async () => {
  const index = createMemorySymbolIndex("/symbol-index-bulk-fixture");
  const original = (index as any).referenceGroups.bind(index);
  let resolutions = 0;
  (index as any).referenceGroups = (...args: unknown[]) => { resolutions++; return original(...args); };
  await index.add("shared.ts", "export function shared() { return 1; }\n");
  for (let i = 0; i < 80; i++) await index.add(`consumer-${i}.ts`, `export function use${i}() { return shared(); }\n`);
  assert.equal(resolutions, 0, "adding a file must not resolve every previous file's references");
  const shared = index.query("shared")[0]!;
  assert.equal(index.references(shared).length, 80);
  assert.equal(index.references(shared).length, 80);
  assert.equal(resolutions, 2);
  assert.equal(index.referenceFiles(shared).reduce((sum, group) => sum + group.count, 0), 80);
  await index.add("consumer-0.ts", "export function replaced() { return 0; }\n");
  assert.equal(index.query("use0").length, 0);
  assert.equal(index.query("replaced").length, 1);
  assert.equal(index.references(shared).length, 79);
  assert.equal(resolutions, 4);
  index.remove("consumer-1.ts");
  assert.equal(index.query("use1").length, 0);
  assert.equal(index.references(shared).length, 78);
  assert.equal(resolutions, 5);
});

test("indexed names preserve same-file and language-family reference resolution", async () => {
  const index = createMemorySymbolIndex("/symbol-index-family-fixture");
  await index.add("a.ts", "function same() { return 1; } same();\n");
  await index.add("b.js", "function same() { return 2; } same();\n");
  await index.add("c.py", "def same():\n    return 3\nsame()\n");
  const all = index.query("same");
  assert.equal(all.length, 3);
  for (const symbol of all) {
    const refs = index.references(symbol);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.file, symbol.file);
    assert.equal(index.query("same", { file: symbol.file }).length, 1);
  }
  all.length = 0;
  assert.equal(index.query("same").length, 3, "callers cannot mutate the internal name index");
});

test("ambiguous remote names stay compact and retain every occurrence and local shadow", async () => {
  const index = createMemorySymbolIndex("/symbol-index-ambiguous-fixture");
  for (let file = 0; file < 30; file++) await index.add(`definition-${file}.ts`, "export function shared() {}\n");
  await index.add("remote.ts", "shared();\n".repeat(1000));
  await index.add("local.ts", "function shared() {}\nshared();\nshared();\n");
  const all = index.query("shared");
  assert.equal(all.length, 31);
  for (const symbol of all) {
    const refs = index.references(symbol);
    const groups = index.referenceFiles(symbol);
    assert.equal(groups.length, symbol.file.endsWith("local.ts") ? 2 : 1);
    assert.equal(refs.length, symbol.file.endsWith("local.ts") ? 1002 : 1000);
    assert.equal(groups.reduce((sum, group) => sum + group.count, 0), refs.length);
  }
});

test("SQLite roundtrip preserves reference ranges and releases loaded references when a file is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-symbol-reference-roundtrip-"));
  const source = "export function shared() { return 1; }\nshared();\nshared();\n";
  const index = await buildSymbolIndex(root);
  await index.add("source.ts", source);
  const before = index.references(index.query("shared")[0]!);
  assert.equal(before.length, 2);
  await index.save();
  const loaded = await buildSymbolIndex(root);
  const previous = loaded.query("shared")[0]!;
  assert.deepEqual(loaded.references(previous), before);
  assert.deepEqual(loaded.referenceFiles(previous), [{ file: previous.file, count: 2 }]);
  assert.ok((loaded as any).refs.size > 0);
  await loaded.add("source.ts", "export function replacement() {}\nreplacement();\n");
  assert.equal((loaded as any).refs.size, 0, "loaded occurrence arrays must not remain retained after invalidation");
  assert.equal(loaded.query("shared").length, 0);
  assert.equal(loaded.query("replacement").length, 1);
  assert.equal(loaded.references(loaded.query("replacement")[0]!).length, 1);
  await loaded.save();
  const reopened = await buildSymbolIndex(root);
  assert.equal(reopened.query("shared").length, 0);
  assert.equal(reopened.references(reopened.query("replacement")[0]!).length, 1);
  reopened.remove("source.ts");
  assert.equal((reopened as any).refs.size, 0);
  assert.equal(reopened.definitions().length, 0);
});
