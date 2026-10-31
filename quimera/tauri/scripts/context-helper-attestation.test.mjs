import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { contextHelperPackages, contextHelperAttestation } from './context-helper-attestation.mjs';

const code = 'import("@napi-rs/keyring"); import("node:fs"); import("undici");';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uptokey-helper-attestation-'));
  t.after(() => { const tail = relative(resolve(tmpdir()), root); assert.ok(tail && !tail.startsWith(`..${sep}`)); rmSync(root,{recursive:true,force:true}); });
  const nm = join(root,'node_modules');
  const pkg = (name, metadata, files) => {
    const dir = join(nm, ...name.split('/')); mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'package.json'),JSON.stringify({name,...metadata}));
    for (const [name,content] of Object.entries(files)) writeFileSync(join(dir,name),content);
  };
  pkg('@napi-rs/keyring',{optionalDependencies:{'@napi-rs/keyring-win32-x64-msvc':'1.3.0','@napi-rs/keyring-darwin-arm64':'1.3.0'}},{'index.js':'module.exports = require("@napi-rs/keyring-win32-x64-msvc");','LICENSE':'MIT'});
  pkg('@napi-rs/keyring-win32-x64-msvc',{}, {'keyring.node':'synthetic native bytes'});
  pkg('undici',{version:'7.30.0',main:'index.js'},{'index.js':'exports.getGlobalDispatcher = () => {};'});
  const packages = contextHelperPackages(nm,code);
  const files = {'uptokey-windows.exe':{},'workspace-context-helper.js':{},'package.json':{}};
  for (const dir of packages) for (const name of readdirSync(dir)) files[`node_modules/${relative(nm,dir).replaceAll('\\','/')}/${name}`]={};
  return {nm,packages,files,pkg};
}
test('helper attests platform optional native package and resolution files, without the full daemon closure', t => {
  const f = fixture(t); const a = contextHelperAttestation({...f.files,'cli.js':{},'node_modules/hono/index.js':{}},'uptokey-windows.exe',f.packages,f.nm,code,'win32');
  assert.equal(f.packages.length,3); assert.equal(a.files.length,10);
  assert.deepEqual(a.externalSpecifiers,['@napi-rs/keyring','undici']);
  assert.ok(a.files.some(name=>name.endsWith('keyring.node'))); assert.ok(!a.files.includes('cli.js')); assert.ok(!a.files.some(name=>name.includes('/hono/')));
});
test('new imports fail packaging rather than widening native executable authority silently', t => {
  const f=fixture(t); assert.throws(()=>contextHelperPackages(f.nm,code+'import("eventsource-parser");'),/dependency_drift/);
});
test('macOS context closure requires and attests the protected keyring binding and entry bundles', t => {
  const f = fixture(t);
  const required = ['cli.js', 'composition-worker.js', 'service-schema-worker.js', 'uptokey-macos-protected-keyring.node'];
  const files = {...f.files, uptokey:{}};
  for (const name of required) files[name] = {};
  const attestation = contextHelperAttestation(files, 'uptokey', f.packages, f.nm, code, 'darwin');
  for (const name of required) {
    assert.ok(attestation.files.includes(name));
    const incomplete = {...files}; delete incomplete[name];
    assert.throws(() => contextHelperAttestation(incomplete, 'uptokey', f.packages, f.nm, code, 'darwin'), /closure_incomplete/);
  }
});
test('missing native platform payload fails before any helper executes', t => {
  const f=fixture(t); for(const name of Object.keys(f.files)) if(name.endsWith('.node')) delete f.files[name];
  assert.throws(()=>contextHelperAttestation(f.files,'uptokey-windows.exe',f.packages,f.nm,code,'win32'),/closure_incomplete/);
});
test('required entry and package resolution cannot be omitted from the manifest subset', t => {
  const f=fixture(t); for(const key of ['workspace-context-helper.js','package.json','node_modules/@napi-rs/keyring/index.js','node_modules/undici/index.js','node_modules/undici/package.json']) {
    const files={...f.files};delete files[key];assert.throws(()=>contextHelperAttestation(files,'uptokey-windows.exe',f.packages,f.nm,code,'win32'),/closure_incomplete/);
  }
});
test('reviewed Undici version and dependency-free closure cannot drift', t => {
  const f=fixture(t);
  for(const metadata of [{version:'7.31.0',main:'index.js'},{version:'7.30.0',main:'other.js'},{version:'7.30.0',main:'index.js',dependencies:{'@napi-rs/keyring':'1'}}]) {
    f.pkg('undici',metadata,{'index.js':'fixture'});
    assert.throws(()=>contextHelperPackages(f.nm,code),/dependency_drift/);
  }
});
test('a caller cannot silently omit Undici from the attested package list', t => {
  const f=fixture(t);
  assert.throws(()=>contextHelperAttestation(f.files,'uptokey-windows.exe',f.packages.filter(path=>!path.endsWith('undici')),f.nm,code,'win32'),/closure_incomplete/);
});
test('required dependency changes are rejected rather than skipped as optional', t => {
  const f=fixture(t); f.pkg('@napi-rs/keyring',{dependencies:{'untrusted-module':'1'}},{'index.js':'exports.Entry = class {};'});
  assert.throws(()=>contextHelperPackages(f.nm,code),/dependency_drift/);
});

test('nested macOS helper attests only the adjacent fixed bundle closure', t => {
  const f = fixture(t), base = 'UptokeyCore.app/Contents/MacOS/';
  const files = {};
  for (const name of Object.keys(f.files)) if (name !== 'uptokey-windows.exe') files[base + name] = {};
  for (const name of ['uptokey','cli.js','composition-worker.js','service-schema-worker.js','uptokey-macos-protected-keyring.node']) files[base + name] = {};
  const a = contextHelperAttestation(files, base + 'uptokey', f.packages, f.nm, code, 'darwin');
  assert.equal(a.entry, base + 'workspace-context-helper.js');
  assert.ok(a.files.every(name => name.startsWith(base)));
  const missing = {...files}; delete missing[base + 'uptokey-macos-protected-keyring.node'];
  assert.throws(() => contextHelperAttestation(missing, base + 'uptokey', f.packages, f.nm, code, 'darwin'), /closure_incomplete/);
});