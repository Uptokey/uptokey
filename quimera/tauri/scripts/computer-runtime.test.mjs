import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareComputerRuntime } from './computer-runtime.mjs';
import { COMPUTER_TOOLS, computerBinaryName, computerNativeTarget } from './computer-runtime-contract.mjs';
import { verifySidecar } from './verify-sidecar.mjs';

function fixture(t, platform = 'win32', arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'uptokey-computer-package-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true }); });
  const out = join(root, 'sidecar'), source = join(root, 'source'), targetDir = join(root, 'target');
  mkdirSync(out); mkdirSync(source);
  const target = computerNativeTarget(platform, arch), name = computerBinaryName(platform);
  const executable = join(targetDir, target, 'release', name), bytes = Buffer.from('synthetic native package bytes; never executed');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'rustc') return { status: 0, stdout: `rustc fixture\nhost: ${target}\nrelease: 1.98.1\n` };
    if (command === 'cargo') {
      mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, bytes);
      return { status: 0, stdout: '' };
    }
    assert.equal(command, executable);
    assert.deepEqual(args, ['--tools-json']);
    return { status: 0, stdout: JSON.stringify({ tools: COMPUTER_TOOLS.map(name => ({ name })) }) };
  };
  const options = { platform, arch, source, targetDir, run, signNative: () => {}, env: { PATH: process.env.PATH, PROVIDER_API_KEY: 'not-a-real-key', NODE_OPTIONS: '--untrusted-loader' } };
  return { root, out, source, targetDir, target, name, executable, bytes, calls, options, run };
}

function manifestFor(dir, platform, computerMcp) {
  const binary = platform === 'win32' ? 'uptokey-windows.exe' : 'uptokey';
  writeFileSync(join(dir, binary), 'synthetic unchanged Node runtime');
  writeFileSync(join(dir, 'cli.js'), 'synthetic canonical core');
  const walk = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(join(directory, item.name), `${prefix}${item.name}/`) : [`${prefix}${item.name}`]);
  const names = walk(dir);
  const files = Object.fromEntries(names.map(name => {
    const bytes = readFileSync(join(dir, name));
    return [name, { sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length }];
  }));
  const manifest = { schema_version: 2, runtime: 'node', binary_name: binary, entry: 'cli.js', build_version: '0.1.0', target: platform, files, computerMcp };
  const save = () => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  save(); return { manifest, save };
}

test('packages the exact native OS/architecture helper and attests its bytes with the existing sidecar', t => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
    const f = fixture(t, platform, arch), record = prepareComputerRuntime(f.out, f.options);
    assert.deepEqual(readFileSync(join(f.out, f.name)), f.bytes);
    const { manifest, save } = manifestFor(f.out, platform, record);
    assert.equal(verifySidecar(f.out, platform, arch).files, 9);
    manifest.computerMcp.arch = arch === 'x64' ? 'arm64' : 'x64'; save();
    assert.throws(() => verifySidecar(f.out, platform, arch), /computer_runtime_attestation_invalid/);
    manifest.computerMcp.arch = arch; save();
    const changed = Buffer.from(f.bytes); changed[0] ^= 1; writeFileSync(join(f.out, f.name), changed);
    assert.throws(() => verifySidecar(f.out, platform, arch), /file_hash_mismatch/);
  }
});

test('uses the locked canonical release crate and probes only static tools with a cleared credential environment', t => {
  const f = fixture(t); prepareComputerRuntime(f.out, f.options);
  assert.deepEqual(f.calls[0].args, ['-vV']);
  assert.deepEqual(f.calls[1].args, ['build', '--release', '--locked', '--manifest-path', join(f.source, 'Cargo.toml'), '--target', f.target, '-j', '1']);
  assert.equal(f.calls[1].options.env.CARGO_TARGET_DIR, f.targetDir);
  assert.match(f.calls[1].options.env.CARGO_ENCODED_RUSTFLAGS, /--remap-path-prefix=/);
  assert.equal(f.calls[2].options.env.PROVIDER_API_KEY, undefined);
  assert.equal(f.calls[2].options.env.NODE_OPTIONS, undefined);
  assert.deepEqual(f.calls[2].args, ['--tools-json']);
});

test('personal paths in compiler output fail before the native probe or resource publication', t => {
  for (const encoding of ['utf8', 'utf16le']) {
    const f = fixture(t), run = (command, args, options) => {
      const result = f.run(command, args, options);
      if (command === 'cargo') writeFileSync(f.executable, Buffer.from(`${homedir()}/private-source/main.rs`, encoding));
      return result;
    };
    assert.throws(() => prepareComputerRuntime(f.out, { ...f.options, run }), /release_binary_contains_personal_build_path/);
    assert.deepEqual(f.calls.map(call => call.command), ['rustc', 'cargo']);
    assert.deepEqual(readdirSync(f.out), []);
  }
});

test('an explicitly selected installed toolchain must retain the exact compiler release and target', t => {
  const f = fixture(t);
  prepareComputerRuntime(f.out, {...f.options, toolchain:'stable'});
  assert.equal(f.calls[0].args[0], '+stable');
  assert.equal(f.calls[1].args[0], '+stable');
  const rejected = fixture(t);
  assert.throws(() => prepareComputerRuntime(rejected.out, {...rejected.options, toolchain:'stable', run:() => ({status:0,stdout:`host: ${rejected.target}\nrelease: 1.99.0\n`})}), /compiler_version_invalid/);
  assert.deepEqual(readdirSync(rejected.out), []);
  assert.throws(() => prepareComputerRuntime(rejected.out, {...rejected.options, toolchain:'stable --flag'}), /toolchain_invalid/);
});

test('the laboratory desktop builds its computer resource through the canonical gated builder', () => {
  const desktop = readFileSync(new URL('../../../experiments/deepseek-workbench/scripts/desktop.mjs', import.meta.url), 'utf8');
  assert.match(desktop, /if\(command==='build'\|\|command==='test'\)\s*\{\s*verifyTauriTransposition\(root,env\);[\s\S]*?const \{prepareComputerRuntime\}=await import\(['"]\.\.\/\.\.\/\.\.\/quimera\/tauri\/scripts\/computer-runtime\.mjs['"]\)/);
  assert.doesNotMatch(desktop, /import\s*\{prepareComputerRuntime\}\s*from/);
  assert.match(desktop, /const computer=prepareComputerRuntime\(computerStage,[^;]+;\s*publishComputerResource\(local,resolve\(computerStage,computer\.binary\)\)/);
  assert.doesNotMatch(desktop, /computer-use\/Cargo\.toml|computer-target\/debug/);
});

test('rejects a cross-target host before compilation or copying', t => {
  const f = fixture(t);
  assert.throws(() => prepareComputerRuntime(f.out, { ...f.options, run: () => ({ status: 0, stdout: 'host: aarch64-apple-darwin\n' }) }), /requires_native_target/);
  assert.equal(existsSync(join(f.out, f.name)), false);
});

test('compiler failure and unexpected static tool declarations cannot produce a packaged helper', t => {
  for (const stage of ['cargo', 'probe']) {
    const f = fixture(t), run = (command, args, options) => {
      if (stage === 'cargo' && command === 'cargo') return { status: 1 };
      if (stage === 'probe' && command === f.executable) return { status: 0, stdout: '{"tools":[{"name":"arbitrary_shell"}]}' };
      return f.run(command, args, options);
    };
    assert.throws(() => prepareComputerRuntime(f.out, { ...f.options, run }), /computer_runtime_build_or_probe_failed|computer_runtime_tools_invalid/);
    assert.equal(existsSync(join(f.out, f.name)), false);
  }
});

test('detects a binary replaced while its static tool probe runs', t => {
  const f = fixture(t), run = (command, args, options) => {
    const result = f.run(command, args, options);
    if (command === f.executable) writeFileSync(f.executable, 'replacement');
    return result;
  };
  assert.throws(() => prepareComputerRuntime(f.out, { ...f.options, run }), /changed_during_packaging/);
});

test('a native helper cannot be accepted without its exact computer metadata and tool contract', t => {
  const f = fixture(t), record = prepareComputerRuntime(f.out, f.options);
  const { manifest, save } = manifestFor(f.out, 'win32', record);
  delete manifest.computerMcp; save();
  assert.throws(() => verifySidecar(f.out, 'win32', 'x64'), /computer_runtime_attestation_invalid/);
  manifest.computerMcp = { ...record, tools: ['arbitrary_shell'] }; save();
  assert.throws(() => verifySidecar(f.out, 'win32', 'x64'), /computer_runtime_attestation_invalid/);
});

test('macOS resource manifest hashes bytes after the signing step', t => {
  const f = fixture(t, 'darwin', 'arm64'), signed = Buffer.from('synthetic signed payload');
  const record = prepareComputerRuntime(f.out, {...f.options, signNative: ({executable}) => writeFileSync(executable, signed)});
  const manifest = JSON.parse(readFileSync(join(f.out, 'computer-resource.json'), 'utf8'));
  assert.equal(manifest.files[record.binary].sha256, createHash('sha256').update(signed).digest('hex'));
  assert.deepEqual(readFileSync(join(f.out, record.binary)), signed);
});
