// Real SSH acceptance of the upstream providers, adapted from its artifact driver.
// Synthetic workspace data only. Never reads the real laboratory credential store.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire('/opt/harness/package.json');
const load=async name=>(await import(require.resolve('@deepseek-ai/'+name))).default;
const {Context}=await import(require.resolve('@deepseek-ai/cordis'));
const helper=require.resolve('@deepseek-ai/dsh-ssh/helper');
const bootstrap='/opt/harness/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
// This file exists only in the controller. Even danger-full-access in the
// separate executor must not make it visible to tools.
mkdirSync('/home/node/.dsh',{recursive:true});
writeFileSync('/home/node/.dsh/controller-only-canary','synthetic-controller-only-no-real-key',{mode:0o600});
const ctx=new Context(),fibers=[],checks=[];
async function plugin(name,config={}){const fiber=ctx.plugin(await load(name),config);fibers.push(fiber);await fiber;}
async function completed(handle){const outcome=await handle.done;assert.equal(await handle.waitForExit(),true);assert.equal(outcome.exitCode,0);return handle.collected.stdout?.readFrom(0).text??'';}
try {
 await plugin('dsh-session-projection');
 await plugin('dsh-sandbox-policy',{mode:'workspace-write',workspaceRoot:'/workspace/demo'});
 await plugin('dsh-ssh',{host:'workbench-executor',helper,helperHash:hash(helper),workspace:'/workspace/demo',launch:{kind:'node-script',node:'/usr/local/bin/node',bootstrapPath:bootstrap,bootstrapHash:hash(bootstrap)}});
 await ctx.ssh.ready;checks.push('verified-helper-handshake');
 await plugin('dsh-fs-ssh');await plugin('dsh-subprocess-ssh');await plugin('dsh-sandbox-ssh');
 const target=await ctx.fs.resolve('/workspace/demo/executor-proof.txt');
 await ctx.fs.writeText(target,'first\n');await ctx.fs.editText(target,{oldString:'first',newString:'second',replaceAll:false});
 assert.equal(await ctx.fs.readText(target),'second\n');checks.push('remote-read-edit');
 await assert.rejects(ctx.fs.writeText(target,'denied',undefined,undefined,{mode:'read-only',workspaceRoot:'/workspace/demo'}));checks.push('read-only-write-denied');
 for(const path of ['/run/secrets/uptokey-workbench-vault-key','/home/node/.dsh/credentials.encrypted.json','/home/node/.dsh/controller-only-canary']) {
   await assert.rejects(async()=>ctx.fs.readText(await ctx.fs.resolve(path)));
 }
 checks.push('controller-secrets-absent-from-filesystem');
 const options={cwd:'/workspace/demo',env:{PATH:'/usr/local/bin:/usr/bin:/bin'},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:8192},stderr:{maxBytes:8192}}};
 const result=await completed(ctx.subprocess.spawn({...options,argv:['/bin/sh','-c','test ! -e /run/secrets/uptokey-workbench-vault-key && test ! -e /home/node/.dsh/credentials.encrypted.json && test ! -e /home/node/.dsh/controller-only-canary && printf isolated-executor']}));
 assert.equal(result,'isolated-executor');checks.push('unconfined-process-cannot-see-controller-files');
 const identity=await completed(ctx.subprocess.spawn({...options,argv:['/usr/local/bin/node','-e','const fs=require("fs");console.log(JSON.stringify({uid:process.getuid(),caps:fs.readFileSync("/proc/self/status","utf8").match(/CapEff:\\s*(\\w+)/)[1]}))']}));
 assert.deepEqual(JSON.parse(identity),{uid:1000,caps:'0000000000000000'});checks.push('tool-user-has-no-effective-capabilities');
 const terminal=await ctx.subprocess.spawnTerminal({argv:['/bin/sh'],cwd:'/workspace/demo',env:{},terminalType:'xterm',cols:80,rows:24,graceMs:1000});
 let text='';const reading=(async()=>{for await(const bytes of terminal.output)text+=Buffer.from(bytes).toString()})();
 try{await terminal.resize(100,35);await terminal.write("stty size; printf 'pty-result:%s\\n' 42; exit\n");assert.equal((await terminal.done).exitCode,0);await reading;assert.match(text,/pty-result:42/);assert.match(text,/35 100/);}finally{await terminal.terminate();await reading;}
 checks.push('native-pty-resize-output');
 await plugin('dsh-ptc-runtime-node',{launch:ctx.ssh.ptcLaunch});
 const runtime=ctx.ptcRuntime;
 const ptc=await runtime.run(runtime.resolve({program:'const fs=await import("node:fs"); return {secretVisible:fs.existsSync("/home/node/.dsh/controller-only-canary"),cwd:process.cwd(),value:await tools.echo("native-bridge")};',bindings:[{global:'tools',functions:{echo:async input=>String(input)}}],cwd:'/workspace/demo',sandboxPolicy:{mode:'workspace-write',workspaceRoot:'/workspace/demo'}}));
 assert.equal(ptc.error,undefined,JSON.stringify(ptc));assert.deepEqual(ptc.value,{secretVisible:false,cwd:'/workspace/demo',value:'native-bridge'});checks.push('confined-ptc-tool-bridge');
 console.log(JSON.stringify({passed:checks.length,checks,modelInference:false,liveHarnessSwitched:false}));
} catch(error) {console.error(JSON.stringify({completedChecks:checks}));throw error;}
finally {for(const fiber of fibers.reverse())await fiber.dispose();}
