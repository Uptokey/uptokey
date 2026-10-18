#!/usr/bin/env node
/**
 * B9 — derives proxy/core/vendor/sync-contract from the single source proxy/contratos.
 * The vendor is a byte copy, never an independent source: hand edits are reported as drift.
 * Derived set: top-level *.js, *.d.ts, package.json, operations-diagnostic.json and LICENSE,
 * plus test files the vendor already carries (kept for its package `test` script).
 * Excluded: docs, package-lock.json and the rest of test/ (they stay in the source only).
 *
 *   node scripts/derive-sync-contract-vendor.mjs            # --check (default): exit 1 on drift
 *   node scripts/derive-sync-contract-vendor.mjs --write    # copy source → vendor, remove orphans
 *   options: --source <dir> --vendor <dir> --json
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : fallback; };
const write = argv.includes('--write');
const json = argv.includes('--json');
const source = option('--source', resolve(here, '../../contratos'));
const vendor = option('--vendor', resolve(here, '../vendor/sync-contract'));
const ROOT_FILES = ['package.json', 'operations-diagnostic.json', 'LICENSE'];

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join('/')];
  });
}

export function derivedFileSet(sourceDir, vendorDir) {
  const top = readdirSync(sourceDir).filter((f) => (f.endsWith('.js') || f.endsWith('.d.ts')) && statSync(join(sourceDir, f)).isFile());
  const roots = ROOT_FILES.filter((f) => existsSync(join(sourceDir, f)));
  const carriedTests = walk(join(vendorDir, 'test')).map((f) => `test/${f}`).filter((f) => existsSync(join(sourceDir, f)));
  return [...new Set([...top, ...roots, ...carriedTests])].sort();
}

export function compareVendor(sourceDir, vendorDir) {
  const expected = derivedFileSet(sourceDir, vendorDir);
  const present = walk(vendorDir);
  const drift = [];
  for (const file of expected) {
    const target = join(vendorDir, file);
    if (!existsSync(target)) drift.push({ file, kind: 'missing' });
    else if (!readFileSync(target).equals(readFileSync(join(sourceDir, file)))) drift.push({ file, kind: 'differs' });
  }
  for (const file of present) if (!expected.includes(file)) drift.push({ file, kind: 'orphan' });
  return { source: sourceDir, vendor: vendorDir, files: expected.length, drift };
}

export function deriveVendor(sourceDir, vendorDir) {
  const before = compareVendor(sourceDir, vendorDir);
  for (const item of before.drift) {
    const target = join(vendorDir, item.file);
    if (item.kind === 'orphan') { rmSync(target); continue; }
    mkdirSync(dirname(target), { recursive: true });
    // Replace the directory entry instead of writing through it: vendor files may
    // share an inode (hardlink) with preserved evidence copies elsewhere.
    const staged = `${target}.derive-${process.pid}.tmp`;
    writeFileSync(staged, readFileSync(join(sourceDir, item.file)), { flag: 'wx' });
    renameSync(staged, target);
  }
  return before;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = write ? deriveVendor(source, vendor) : compareVendor(source, vendor);
  const after = write ? compareVendor(source, vendor) : result;
  if (json) process.stdout.write(`${JSON.stringify({ mode: write ? 'write' : 'check', ...result, remaining: after.drift }, null, 2)}\n`);
  else {
    process.stdout.write(`sync-contract vendor ${write ? 'derived' : 'check'}: ${result.files} files, ${result.drift.length} drift item(s)${write ? ` applied, ${after.drift.length} remaining` : ''}\n`);
    for (const d of result.drift) process.stdout.write(`  ${d.kind}: ${d.file}\n`);
  }
  process.exitCode = after.drift.length ? 1 : 0;
}
