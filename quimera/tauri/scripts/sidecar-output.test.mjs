import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parsePreparationArgs,validateOutputTarget,createStagingOutput,publishStagingOutput} from './sidecar-output.mjs';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'uptokey-prepare-output-'));
  t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  return root;
}
test('--check is read-only intent; unknown switches are not output paths',()=>{
  const base=resolve('quimera/tauri');
  assert.deepEqual(parsePreparationArgs(['--check'],{tauriDir:base}),{check:true,directory:join(base,'resources','sidecar')});
  for(const args of [['--unknown'],['--output'],['--output','--check'],['first','second']])assert.throws(()=>parsePreparationArgs(args,{tauriDir:base}));
  assert.equal(parsePreparationArgs(['--check','--output','prepared'],{cwd:base,tauriDir:base}).directory,join(base,'prepared'));
});
test('root/source paths and unrelated existing directories cannot be replaced',t=>{
  const root=fixture(t), source=join(root,'source');mkdirSync(source);
  assert.throws(()=>validateOutputTarget(root,[source]),/protected/);
  assert.throws(()=>validateOutputTarget(source,[source]),/protected/);
  const unrelated=join(root,'user-files');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep.txt'),'keep');
  assert.throws(()=>validateOutputTarget(unrelated,[source]),/not_prepared/);
  assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'keep');
});
test('staging leaves previous sidecar intact and publishing retains a recovery copy',t=>{
  const root=fixture(t), target=join(root,'sidecar');mkdirSync(target);
  writeFileSync(join(target,'manifest.json'),JSON.stringify({schema_version:2,binary_name:'uptokey-windows.exe'}));
  writeFileSync(join(target,'cli.js'),'old');
  const staging=createStagingOutput(target,[]);writeFileSync(join(staging,'cli.js'),'new');
  assert.equal(readFileSync(join(target,'cli.js'),'utf8'),'old');
  const backup=publishStagingOutput(staging,target,[]);
  assert.equal(readFileSync(join(target,'cli.js'),'utf8'),'new');
  assert.equal(readFileSync(join(backup,'cli.js'),'utf8'),'old');
  assert.equal(existsSync(staging),false);
});

test('recognizes only the canonical prepared macOS bundle for replacement',t=>{
  const root=fixture(t), target=join(root,'sidecar');mkdirSync(target);
  const manifest={schema_version:2,runtime:'node',target:'darwin',binary_name:'UptokeyCore.app/Contents/MacOS/uptokey'};
  const save=value=>writeFileSync(join(target,'manifest.json'),JSON.stringify(value));
  save(manifest);assert.equal(validateOutputTarget(target,[]),target);
  for(const change of [{schema_version:1},{runtime:'other'},{target:'linux'},{binary_name:'Other.app/Contents/MacOS/uptokey'}]){
    save({...manifest,...change});assert.throws(()=>validateOutputTarget(target,[]),/not_prepared/);
  }
});