import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {terminalRuntimePackages} from './terminal-runtime-packages.mjs';

/** Exercise the packaged native addon with its shipped Node runtime before promotion. */
export function verifyTerminalRuntime(runtime, directory) {
  terminalRuntimePackages(join(directory, 'node_modules'));
  const safe = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec', 'home', 'userprofile']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => safe.has(key.toLowerCase())));
  const script = String.raw`
    const assert = require('node:assert/strict');
    const {spawn} = require('@lydell/node-pty');
    const {join} = require('node:path');
    const win = process.platform === 'win32';
    const shell = win ? join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
    const terminal = spawn(shell, win ? ['/d','/s','/c','echo uptokey-terminal-ready'] : ['-c','printf uptokey-terminal-ready'],
      {name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env});
    let output = '';
    const timer = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 15000);
    terminal.onData(data => { output += data; });
    terminal.onExit(({exitCode}) => {
      clearTimeout(timer);
      // ConPTY has an output worker in addition to the observed OS process.
      try { terminal.kill(); } catch {}
      assert.equal(exitCode, 0);
      assert.match(output, /uptokey-terminal-ready/);
      console.log('terminal-runtime-verified');
    });
  `;
  const result = spawnSync(resolve(runtime), ['--input-type=commonjs', '-e', script], {
    cwd: directory, env, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, 'terminal_runtime_process_failed');
  assert.equal(result.status, 0, 'terminal_runtime_verification_failed');
  assert.match(result.stdout, /^terminal-runtime-verified\r?$/m);
  return {status: 'passed', platform: process.platform, arch: process.arch, exitCode: result.status};
}
