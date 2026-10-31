import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseBuildPlan, releaseSourceCommit, releaseIdentityOptions, releaseFrontendInputs, assertReleaseFrontendUnchanged, releaseCanonicalInputs, assertReleaseCanonicalInputsUnchanged } from './release-build-plan.mjs';
import { releaseBuildArgs } from './release-cargo.mjs';
import { validateNativeBuildIdentity } from '../../../proxy/core/scripts/native-artifact-version-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-release.mjs');
const commit = 'a'.repeat(40), digest = 'b'.repeat(64);
const spawn = args => spawnSync(process.execPath, [script, ...args], {encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,UPTOKEY_RELEASE_SOURCE_COMMIT:'',PATH:''}});

test('default release selects Harness and plans without a source pin, resources or tools', () => {
  const run = spawn(['--print-plan']); assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.interfaceMode, 'harness'); assert.equal(plan.frontend, 'prepared-harness-assets');
  assert.equal(plan.sidecar, 'verify-prepared-harness'); assert.equal(plan.nativeIdentityRequired, true);
  assert.deepEqual(plan.args, releaseBuildArgs('harness'));
  assert.equal(existsSync(plan.outputDirectory), false);
});
test('legacy shell is explicit and preserves the sidecar entry command', () => {
  const run = spawn(['--print-plan','--interface=shell','--skip-pwa-build']); assert.equal(run.status, 0, run.stderr);
  const plan=JSON.parse(run.stdout); assert.equal(plan.interfaceMode,'shell'); assert.equal(plan.frontend,'existing-pwa');
  assert.deepEqual(plan.args,releaseBuildArgs()); assert.equal(plan.nativeIdentityRequired,false);
  assert.equal(releaseSourceCommit(plan,{}),null);
});
test('ambiguous, unsupported and incomplete reuse flags are refused before execution', () => {
  for(const args of [ ['--interface=harness','--interface=shell'], ['--print-plan','--print-plan'], ['--interface=other'],
    ['--interface'], ['--unknown'], ['--skip-pwa-build'], ['--reuse-app-sha256='+digest],
    ['--reuse-app-sha256='+digest,'--reuse-sidecar-sha256=bad'],
    ['--reuse-app-sha256='+digest,'--reuse-sidecar-sha256='+digest,'--reuse-app-sha256='+digest] ]) {
    const run=spawn([...args,'--print-plan']);assert.equal(run.status,2,JSON.stringify(args));assert.equal(run.stdout,'');
  }
});
test('a real Harness execution requires an exact new source pin before touching resources or running tools', () => {
  const run=spawn([]);assert.equal(run.status,2);assert.match(run.stderr,/release_source_commit_required/);assert.equal(run.stdout,'');
  const plan=createReleaseBuildPlan([]);
  for(const sourceCommit of ['', 'a'.repeat(39),'A'.repeat(40),'a'.repeat(40)+'\n']) assert.throws(()=>releaseSourceCommit(plan,{UPTOKEY_RELEASE_SOURCE_COMMIT:sourceCommit}),/source_commit_required/);
  assert.equal(releaseSourceCommit(plan,{UPTOKEY_RELEASE_SOURCE_COMMIT:commit}),commit);
  const override=spawnSync(process.execPath,[script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,UPTOKEY_RELEASE_SOURCE_COMMIT:commit,TAURI_CONFIG:'{}',PATH:''}});
  assert.equal(override.status,2);assert.match(override.stderr,/release_untracked_build_override/);assert.equal(override.stdout,'');
});
test('explicit hashes still require a Harness native identity for the pinned source and native target', () => {
  const plan=createReleaseBuildPlan(['--reuse-app-sha256='+digest,'--reuse-sidecar-sha256='+digest]);
  assert.equal(plan.cargoBuild,'reused_explicit_sha256');assert.equal(plan.nativeIdentityRequired,true);
  for(const [platform,arch,targetOs,targetArch] of [['win32','x64','windows','x86_64'],['linux','x64','linux','x86_64'],['darwin','arm64','macos','aarch64']]) {
    const expected=releaseIdentityOptions({plan,sourceCommit:commit,artifactPath:'app',outputPath:'receipt',sha256:digest,version:'0.2.0',platform,arch});
    assert.equal(expected.defaultInterface,'Harness');assert.equal(expected.sourceCommit,commit);assert.equal(expected.targetOs,targetOs);assert.equal(expected.targetArch,targetArch);
    const identity={schema:'uptokey-native-build-identity-v1',product:'uptokey-tauri',version:'0.2.0',defaultInterface:'shell',sourceCommit:commit,target:{os:targetOs,arch:targetArch}};
    assert.deepEqual(validateNativeBuildIdentity(identity,expected),['native_identity_defaultInterface_mismatch']);
  }
});

function fixture(t) {
  const temp=realpathSync(tmpdir());const directory=mkdtempSync(join(temp,'uptokey-release-inputs-'));
  t.after(()=>{assert.equal(dirname(resolve(directory)),temp);assert.match(directory.slice(temp.length),/^[\\/]uptokey-release-inputs-/);rmSync(directory,{recursive:true,force:true});});
  const root=join(directory,'quimera','tauri'),harness=join(directory,'experiments','deepseek-workbench','desktop','assets'),pwa=join(directory,'quimera','uptokey','uptokey-pwa','dist');
  for(const d of [root,harness,pwa,join(root,'capabilities')]) mkdirSync(d,{recursive:true});
  writeFileSync(join(root,'tauri.harness.conf.json'),JSON.stringify({build:{frontendDist:'../../experiments/deepseek-workbench/desktop/assets'}}));
  writeFileSync(join(root,'tauri.conf.json'),JSON.stringify({build:{frontendDist:'../uptokey/uptokey-pwa/dist'}}));
  for(const name of ['Cargo.lock','Cargo.toml','capabilities/default.json','capabilities/harness-account.json','capabilities/harness-theme.json','capabilities/harness-public-api.json','capabilities/harness-notification.json','capabilities/harness-computer-focus.json']) writeFileSync(join(root,name),'fixture');
  writeFileSync(join(harness,'index.html'),'Harness');writeFileSync(join(pwa,'index.html'),'Old PWA');
  return {root,harness,pwa,directory};
}
test('inventory uses configured Harness bytes even when a legacy PWA dist also exists', t=>{
  const f=fixture(t),plan=createReleaseBuildPlan([]),first=releaseFrontendInputs(f.root,plan);
  assert.equal(first.prefix,'harness-assets');assert.deepEqual(Object.keys(first.files),['index.html']);assert.equal(first.directory,f.harness);
  const old=releaseFrontendInputs(f.root,createReleaseBuildPlan(['--interface=shell']));assert.equal(old.directory,f.pwa);assert.notDeepEqual(first.hashes,old.hashes);
  assert.doesNotThrow(()=>assertReleaseFrontendUnchanged(first,releaseFrontendInputs(f.root,plan)));
  writeFileSync(join(f.harness,'index.html'),'changed after Cargo started');assert.throws(()=>assertReleaseFrontendUnchanged(first,releaseFrontendInputs(f.root,plan)),/changed_during_build/);
});
test('added files and missing index cannot be silently attributed to the compiled frontend', t=>{
  const f=fixture(t),plan=createReleaseBuildPlan([]),first=releaseFrontendInputs(f.root,plan);
  writeFileSync(join(f.harness,'extra.js'),'new asset');assert.throws(()=>assertReleaseFrontendUnchanged(first,releaseFrontendInputs(f.root,plan)),/changed_during_build/);
  unlinkSync(join(f.harness,'index.html'));
  assert.throws(()=>releaseFrontendInputs(f.root,plan),/frontend_index_missing/);
});
test('frontend links are refused rather than copying files outside the selected source', t=>{
  const f=fixture(t);try{symlinkSync(join(f.pwa,'index.html'),join(f.harness,'secret.html'),'file');}
  catch(error){if(error.code==='EPERM'){t.skip('Host denies creating the test symlink; protection was not changed.');return;}throw error;}
  assert.throws(()=>releaseFrontendInputs(f.root,createReleaseBuildPlan([])),/assets_link_forbidden/);
});
test('Windows extended path root is bounded for frontend metadata', {skip:process.platform!=='win32'}, t=>{
  const f=fixture(t);assert.equal(releaseFrontendInputs(toNamespacedPath(f.root),createReleaseBuildPlan([])).prefix,'harness-assets');
});
test('frontend source selection rejects escapes, broad roots and private trees before inventory', t=>{
  const f=fixture(t);
  for(const interfaceMode of ['harness','shell']) {
    const config=join(f.root,interfaceMode==='harness'?'tauri.harness.conf.json':'tauri.conf.json');
    const plan=createReleaseBuildPlan(['--interface='+interfaceMode]);
    for(const frontendDist of ['../../../personal','../..','.','../../secrets','../../profiles','../../output','../../node_modules']) {
      writeFileSync(config,JSON.stringify({build:{frontendDist}}));
      assert.throws(()=>releaseFrontendInputs(f.root,plan),/frontend_layout_invalid/,frontendDist);
    }
  }
});
test('frontend inventory refuses nested credentials and private state within the correct assets directory', t=>{
  const f=fixture(t),plan=createReleaseBuildPlan([]);
  for(const name of ['.env','.env.production','.npmrc','profiles','credentials','node_modules','output']) {
    const path=join(f.harness,name);writeFileSync(path,'must not be read or copied');
    assert.throws(()=>releaseFrontendInputs(f.root,plan),/assets_sensitive_path_forbidden/);unlinkSync(path);
  }
});
test('canonical Cargo/config/capability input changes are rejected instead of being attributed after compilation', t=>{
  const f=fixture(t),plan=createReleaseBuildPlan([]),before=releaseCanonicalInputs(f.root,plan);
  assert.equal(Object.keys(before).length,9);
  assert.doesNotThrow(()=>assertReleaseCanonicalInputsUnchanged(before,releaseCanonicalInputs(f.root,plan)));
  for(const source of Object.keys(before)) {
    const file=join(f.directory,source),bytes=readFileSync(file);
    writeFileSync(file,Buffer.concat([bytes,Buffer.from('\nchanged during Cargo')]));
    assert.throws(()=>assertReleaseCanonicalInputsUnchanged(before,releaseCanonicalInputs(f.root,plan)),/source_inputs_changed_during_build/,source);
    writeFileSync(file,bytes);
  }
  assert.deepEqual(releaseCanonicalInputs(f.root,plan),before);
});
test('empty canonical inputs cannot produce a release inventory or partial SBOM', t=>{
  const f=fixture(t),plan=createReleaseBuildPlan([]);
  for(const name of ['Cargo.lock','Cargo.toml','tauri.harness.conf.json','capabilities/harness-account.json']) {
    const file=join(f.root,name),bytes=readFileSync(file);writeFileSync(file,'');
    assert.throws(()=>releaseCanonicalInputs(f.root,plan),/release_source_input_invalid/,name);
    writeFileSync(file,bytes);
  }
});
