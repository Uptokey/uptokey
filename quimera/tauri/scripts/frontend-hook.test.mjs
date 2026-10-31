import test from 'node:test';
import assert from 'node:assert/strict';
import { runFrontendHook } from './frontend-hook.mjs';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('frontend failure stops packaging and preserves the failing exit code', () => {
  const calls=[];
  assert.equal(runFrontendHook('build',{run:(...call)=>{calls.push(call);return {status:7};}}),7);
  assert.equal(calls.length,1);
});
test('launch errors and signals cannot be reported as successful builds', () => {
  assert.throws(()=>runFrontendHook('build',{run:()=>({error:Error('spawn failure')})}),/spawn failure/);
  assert.equal(runFrontendHook('build',{run:()=>({status:null,signal:'SIGTERM'})}),1);
});
test('build and dev use canonical directories independent of the launch cwd', () => {
  for(const platform of ['win32','linux']) {
    const calls=[];
    assert.equal(runFrontendHook('build',{platform,run:(...call)=>{calls.push(call);return {status:0};}}),0);
    assert.equal(calls.length,2);
    assert.match(calls[0][2].cwd.replaceAll('\\','/'),/quimera\/uptokey\/uptokey-pwa$/);
    assert.match(calls[1][1][0].replaceAll('\\','/'),/tauri\/scripts\/prepare-sidecar.mjs$/);
    assert.ok(calls.every(call=>!call[2].shell));
    const dev=[];
    runFrontendHook('dev',{platform,run:(...call)=>{dev.push(call);return {status:0};}});
    assert.equal(dev.length,1);
    assert.match(dev[0][1].join(' '),/--port 5273 --strictPort/);
  }
});
test('config uses explicit hook cwd and preserves the canonical design entry', () => {
  const config=JSON.parse(readFileSync(new URL('../tauri.conf.json',import.meta.url),'utf8'));
  assert.deepEqual(config.build.beforeDevCommand,{script:'node scripts/frontend-hook.mjs dev',cwd:'.',wait:false});
  assert.deepEqual(config.build.beforeBuildCommand,{script:'node scripts/frontend-hook.mjs build',cwd:'.'});
  assert.equal(config.build.devUrl,'http://127.0.0.1:5273');
  assert.equal(config.app.windows[0].url,'/design/#work');
});

test('Harness packaging rejects a legacy or stale payload without rebuilding core', t => {
  const directory = mkdtempSync(join(tmpdir(), 'uptokey-harness-hook-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = () => { throw Error('must not execute a frontend or core build'); };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 2, runtime: 'node' }));
  assert.throws(() => runFrontendHook('harness', { sidecarDirectory: directory, run }), /harness_bundle_payload_required/);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 2, runtime: 'node',
    harness: { schema_version: 1, lab: 'harness/experiments/deepseek-workbench', scope: { personalStateIncluded: false } },
    files: { 'harness/quimera/tauri/Cargo.toml': { sha256: '0'.repeat(64) } } }));
  assert.throws(() => runFrontendHook('harness', { sidecarDirectory: directory, run }), /harness_bundle_source_changed/);
});
