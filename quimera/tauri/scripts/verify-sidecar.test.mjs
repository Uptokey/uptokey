import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifySidecar} from './verify-sidecar.mjs';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'uptokey-sidecar-manifest-'));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});});
  const bytes=Buffer.from('synthetic payload, never executable');
  const manifest={schema_version:1,binary_name:'uptokey-windows.exe',target:'win32',build_version:'0.1.0-beta.7',package_version:'0.2.0',sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length};
  writeFileSync(join(dir,manifest.binary_name),bytes);
  const write=m=>writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));write(manifest);
  return {dir,manifest,write,bytes};
}
test('verifies the exact prepared platform, name, size and content',t=>{
  const {dir,manifest}=fixture(t);assert.equal(verifySidecar(dir,'win32').sha256,manifest.sha256);
});
test('rejects changed bytes even if length is unchanged',t=>{
  const {dir,bytes}=fixture(t);bytes[0]^=1;writeFileSync(join(dir,'uptokey-windows.exe'),bytes);
  assert.throws(()=>verifySidecar(dir,'win32'),/binary_hash_mismatch/);
});
test('rejects traversal, absolute names, wrong platform and malformed metadata before reading another file',t=>{
  const {dir,manifest,write}=fixture(t);
  for(const change of [{binary_name:'../uptokey-windows.exe'},{binary_name:'C:/other.exe'},{target:'linux'},{sha256:manifest.sha256.toUpperCase()},{size_bytes:0},{build_version:'garbage'}]){
    write({...manifest,...change});assert.throws(()=>verifySidecar(dir,'win32'),/manifest_schema_invalid/);
  }
});

function v2Fixture(t, mutate=()=>{}){
  const dir=mkdtempSync(join(tmpdir(),'uptokey-sidecar-v2-'));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});});
  const runtime=Buffer.from('synthetic node runtime');
  const cli=Buffer.from('synthetic cli entry');
  const worker=Buffer.from('synthetic worker entry');
  const addon=Buffer.from('synthetic native addon');
  writeFileSync(join(dir,'uptokey-windows.exe'),runtime);
  writeFileSync(join(dir,'cli.js'),cli);
  writeFileSync(join(dir,'composition-worker.js'),worker);
  mkdirSync(join(dir,'node_modules','@napi-rs','keyring'),{recursive:true});
  writeFileSync(join(dir,'node_modules','@napi-rs','keyring','keyring.node'),addon);
  const files={
    'uptokey-windows.exe':{sha256:createHash('sha256').update(runtime).digest('hex'),size_bytes:runtime.length},
    'cli.js':{sha256:createHash('sha256').update(cli).digest('hex'),size_bytes:cli.length},
    'composition-worker.js':{sha256:createHash('sha256').update(worker).digest('hex'),size_bytes:worker.length},
    'node_modules/@napi-rs/keyring/keyring.node':{sha256:createHash('sha256').update(addon).digest('hex'),size_bytes:addon.length},
  };
  const manifest={schema_version:2,runtime:'node',binary_name:'uptokey-windows.exe',entry:'cli.js',worker:'composition-worker.js',build_version:'0.1.0-beta.7',package_version:'0.2.0',target:'win32',files};
  mutate(manifest,files);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
  return {dir,manifest};
}
test('schema 2 verifies every attested file of the node runtime layout',t=>{
  const {dir,manifest}=v2Fixture(t);
  assert.equal(verifySidecar(dir,'win32').version,manifest.build_version);
});
test('schema 2 rejects a tampered native addon even when runtime matches',t=>{
  const {dir}=v2Fixture(t);
  writeFileSync(join(dir,'node_modules','@napi-rs','keyring','keyring.node'),Buffer.from('evil'));
  assert.throws(()=>verifySidecar(dir,'win32'),/file_hash_mismatch|file_size_mismatch/);
});
test('schema 2 rejects traversal and absolute attested names',t=>{
  const {dir,manifest}=v2Fixture(t);
  const extra={'../escape.js':{sha256:'a'.repeat(64),size_bytes:10}};
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({...manifest,files:{...manifest.files,...extra}}));
  assert.throws(()=>verifySidecar(dir,'win32'),/manifest_schema_invalid/);
});
test('schema 2 rejects a missing attested file',t=>{
  const {dir,manifest}=v2Fixture(t);
  rmSync(join(dir,'composition-worker.js'));
  writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>verifySidecar(dir,'win32'),/file_missing:composition-worker\.js/);
});
test('schema 2 rejects entries not covered by attestation',t=>{
  const {dir}=v2Fixture(t,(manifest,files)=>{
    delete files['cli.js'];
  });
  assert.throws(()=>verifySidecar(dir,'win32'),/manifest_schema_invalid/);
});

test('schema 2 rejects a worker not covered by the manifest',t=>{
  const {dir}=v2Fixture(t,manifest=>{manifest.worker='other-worker.js';});
  assert.throws(()=>verifySidecar(dir,'win32'),/manifest_schema_invalid/);
});

test('schema worker cannot name an arbitrary file or omit attestation', t => {
  for (const serviceSchemaWorker of ['../escape.js', 'cli.js', 'service-schema-worker.js']) {
    const {dir} = v2Fixture(t, manifest => { manifest.serviceSchemaWorker = serviceSchemaWorker; });
    assert.throws(() => verifySidecar(dir, 'win32'), /manifest_schema_invalid/);
  }
});
test('schema 2 rejects extra executable content outside the manifest',t=>{
  const {dir}=v2Fixture(t);writeFileSync(join(dir,'unexpected.js'),'unattested');
  assert.throws(()=>verifySidecar(dir,'win32'),/file_unattested:unexpected.js/);
});

test('macOS nested bundle requires the exact attested executable and signed-layout files',t=>{
 const dir=mkdtempSync(join(tmpdir(),'uptokey-macos-manifest-'));
 t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true});});
 const prefix='UptokeyCore.app/Contents/MacOS/';
 const names=[prefix+'uptokey',prefix+'cli.js',prefix+'composition-worker.js',prefix+'service-schema-worker.js',prefix+'workspace-context-helper.js',prefix+'uptokey-macos-protected-keyring.node','UptokeyCore.app/Contents/Info.plist','UptokeyCore.app/Contents/embedded.provisionprofile','UptokeyCore.app/Contents/_CodeSignature/CodeResources'];
 const files={};
 for(const name of names){const data=Buffer.from('synthetic '+name);mkdirSync(dirname(join(dir,name)),{recursive:true});writeFileSync(join(dir,name),data);files[name]={sha256:createHash('sha256').update(data).digest('hex'),size_bytes:data.length};}
 const manifest={schema_version:2,runtime:'node',binary_name:prefix+'uptokey',entry:prefix+'cli.js',worker:prefix+'composition-worker.js',serviceSchemaWorker:prefix+'service-schema-worker.js',target:'darwin',build_version:'0.1.0',files};
 const write=value=>writeFileSync(join(dir,'manifest.json'),JSON.stringify(value));
 write(manifest);assert.equal(verifySidecar(dir,'darwin').binary,manifest.binary_name);
 assert.throws(()=>verifySidecar(dir,'linux'),/manifest_schema_invalid/);
 const omitted={...files};delete omitted['UptokeyCore.app/Contents/embedded.provisionprofile'];
 write({...manifest,files:omitted});assert.throws(()=>verifySidecar(dir,'darwin'),/manifest_schema_invalid/);
 write({...manifest,entry:'cli.js'});assert.throws(()=>verifySidecar(dir,'darwin'),/manifest_schema_invalid/);
 write(manifest);writeFileSync(join(dir,prefix+'uptokey'),'altered');
 assert.throws(()=>verifySidecar(dir,'darwin'),/file_size_mismatch|file_hash_mismatch/);
});