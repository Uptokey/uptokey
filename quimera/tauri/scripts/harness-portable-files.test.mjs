import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectHarnessPortableFiles, HARNESS_PORTABLE_FILES, HARNESS_PORTABLE_EXTERNALS } from './harness-portable-files.mjs';

test('installed closure excludes stale nested sidecar authority while keeping standalone metadata',()=>{
 // Use a filesystem URL for Windows drive handling, just like the collector.
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 const installed=collectHarnessPortableFiles(repo,{installedSidecar:true});
 assert.equal(installed.length,HARNESS_PORTABLE_FILES.length-1);
 assert.ok(!installed.some(entry=>entry.path==='quimera/tauri/resources/sidecar/manifest.json'));
 assert.ok(HARNESS_PORTABLE_FILES.includes('quimera/tauri/resources/sidecar/manifest.json'));
});
import {fileURLToPath} from 'node:url';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uptokey portable closure '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of HARNESS_PORTABLE_FILES) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), '// public fixture\n'); }
  return root;
}

test('collects only the exact public closure, preserving relative paths and ignoring private siblings', t => {
  const root = fixture(t);
  const privatePaths = [
    'experiments/deepseek-workbench/.local/desktop-profile/state.json',
    'experiments/deepseek-workbench/.env',
    'experiments/deepseek-workbench/node_modules/unrelated/index.js',
    'experiments/deepseek-workbench/output/private.json',
    'experiments/deepseek-workbench/runtime/credentials.json',
    'proxy/core/.env',
  ];
  for (const path of privatePaths) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'do not package'); }
  const entries = collectHarnessPortableFiles(root);
  assert.deepEqual(entries.map(entry => entry.path), HARNESS_PORTABLE_FILES);
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
  assert.ok(entries.every(entry => entry.source === join(root, entry.path)));
  assert.ok(entries.every(entry => !privatePaths.includes(entry.path)));
  assert.deepEqual(HARNESS_PORTABLE_EXTERNALS, ['@napi-rs/keyring']);
});

test('requires literal imports to stay in the public closure and approved native dependency', t => {
  const root = fixture(t), file = join(root, 'experiments/deepseek-workbench/scripts/diagnostics.mjs');
  writeFileSync(file, "import {x} from './runtime-health.mjs';\nimport {Entry} from '@napi-rs/keyring';\n");
  assert.doesNotThrow(() => collectHarnessPortableFiles(root));
  writeFileSync(file, "import {x} from './not-packaged.mjs';\n");
  assert.throws(() => collectHarnessPortableFiles(root), /harness_portable_import_unlisted/);
  writeFileSync(file, "import x from 'unapproved-package';\n");
  assert.throws(() => collectHarnessPortableFiles(root), /harness_portable_external_unlisted/);
  writeFileSync(file, "import x from '../.local/profile.mjs';\n");
  assert.throws(() => collectHarnessPortableFiles(root), /harness_portable_path_invalid/);
});

test('fails closed for missing source, non-file source and redirected source ancestor', t => {
  const root = fixture(t), file = join(root, 'experiments/deepseek-workbench/scripts/diagnostics.mjs');
  rmSync(file);
  assert.throws(() => collectHarnessPortableFiles(root), /ENOENT/);
  mkdirSync(file);
  assert.throws(() => collectHarnessPortableFiles(root), /harness_portable_file_invalid/);
  rmSync(file, { recursive: true }); writeFileSync(file, '// restored public fixture\n');
  const ancestor = join(root, 'proxy'), other = mkdtempSync(join(tmpdir(), 'uptokey public redirect '));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  rmSync(ancestor, { recursive: true });
  symlinkSync(other, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => collectHarnessPortableFiles(root), /harness_portable_link_forbidden/);
});
