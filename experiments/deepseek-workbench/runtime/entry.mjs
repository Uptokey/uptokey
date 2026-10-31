import { networkInterfaces } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openEncryptedWorkspace } from './extensions/encrypted-workspace.mjs';

const { Server } = createRequire('/opt/integrations/package.json')('proxy-chain');
let child, ssh;
const workspace = await openEncryptedWorkspace({onFailure: () => {
  process.exitCode = 1; child?.kill('SIGTERM'); ssh?.kill('SIGTERM');
  if (!child) setImmediate(() => { if (!child) process.exit(1); });
}});
// Transport stays on the device. HTTPS is tunneled; no TLS interception,
// credential/body logging, analytics endpoint, or remote proxy is configured.
const proxy = new Server({ host: '127.0.0.1', port: 43190, verbose: false });
proxy.on('requestFailed', () => console.error('Local proxy request failed'));
await proxy.listen();
const childEnv = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:43190', HTTPS_PROXY: 'http://127.0.0.1:43190', NO_PROXY: 'localhost,127.0.0.1,::1' };
const executionPatch=[];
if(process.env.UPTOKEY_SEPARATE_EXECUTOR==='1'){
 const deadline=Date.now()+60000;
 while(!existsSync('/tmp/uptokey-executor-ready')){
  if(Date.now()>deadline)throw Error('Executor provisioning unavailable; refusing local fallback');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 executionPatch.push('--patch','/opt/harness/execution/overlay.yml');
}

// Harness rejects wildcard binds. Publish this concrete container interface
// only through the launcher's loopback-only port mapping.
const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address;
if (!address) throw new Error('No private container interface available');
mkdirSync('/tmp/lab-ssh',{mode:0o700});
execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f','/tmp/lab-ssh/host_ed25519'],{stdio:'ignore'});
ssh = spawn('/usr/sbin/sshd',['-D','-e','-f','/opt/harness/sshd_config','-o',`ListenAddress=${address}`],{stdio:['ignore','ignore','inherit']});
ssh.on('error',()=>{console.error('Local model bridge failed');process.exitCode=1});
child = spawn(process.execPath, [
  '/opt/harness/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web',
  '--patch', '/opt/harness/browse-picker.yml',
  ...executionPatch,
  '--host', address, '--port', '43180', '--no-open',
  '--public-url', 'http://127.0.0.1:43180', '--trusted-host', '127.0.0.1:43180',
], { stdio: 'inherit', env: childEnv, cwd: '/workspace/demo' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {child.kill(signal);ssh.kill(signal)});
let closing;
const close = () => closing ??= (async () => { ssh.kill(); await workspace.close(); await proxy.close(true); })();
child.on('error', async () => { console.error('Harness process failed to start'); try { await close(); } catch {} process.exitCode = 1; });
child.on('exit', async code => { try { await close(); process.exitCode = process.exitCode || code || 0; } catch { process.exitCode = 1; } });
