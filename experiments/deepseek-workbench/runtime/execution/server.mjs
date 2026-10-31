import { mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
mkdirSync('/tmp/executor',{mode:0o700});
// OpenSSH's Unix-socket forwarding requires privilege separation. Only the
// daemon starts as root; authentication launches the helper as unprivileged node.
execFileSync(process.execPath,['-e','require("fs").mkdirSync("/home/node/.ssh",{mode:448,recursive:true})'],{uid:1000,gid:1000,stdio:'ignore'});
execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f','/tmp/executor/host_ed25519'],{stdio:'ignore'});
const child=spawn('/usr/sbin/sshd',['-D','-e','-f','/opt/harness/execution/sshd_config'],{stdio:['ignore','ignore','inherit']});
const proxy=spawn(process.execPath,['/opt/harness/execution/proxy.mjs'],{uid:1000,gid:1000,stdio:['pipe','ignore','inherit']});
// Close the private control pipe rather than granting the root supervisor
// CAP_KILL to signal a child that has deliberately dropped to uid 1000.
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill(signal);proxy.stdin?.end()});
proxy.on('error',()=>{console.error('Executor proxy failed');child.kill();process.exitCode=1});
child.on('error',()=>{console.error('Executor SSH failed');process.exitCode=1});
child.on('exit',code=>{proxy.stdin?.end();process.exitCode=code??1});
