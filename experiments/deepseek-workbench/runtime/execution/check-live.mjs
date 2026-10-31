import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync,readFileSync} from 'node:fs';
const require=createRequire('/opt/harness/package.json');
const load=async name=>{const m=await import(require.resolve('@deepseek-ai/'+name));return m.default??m;};
const {Context}=await import(require.resolve('@deepseek-ai/cordis'));
const ctx=new Context(),fibers=[],checks=[];
async function plugin(implementation,config={}){const f=ctx.plugin(implementation,config);fibers.push(f);await f;}
try{
 await plugin(await load('dsh-session-projection'));
 await plugin(await load('dsh-sandbox-policy'),{mode:'workspace-write',workspaceRoot:'/workspace/demo'});
 await plugin((await import('/opt/harness/execution/connection.mjs')).default);
 await plugin((await import('/opt/harness/execution/filesystem.mjs')).default);
 await plugin(await load('dsh-subprocess-ssh'));
 await plugin(await load('dsh-attachment-local'));
 const files=[['executor-note.md','# Synthetic attachment\n'],['executor-data.csv','name,value\na,7\n'],['executor-config.json','{"synthetic":true}\n']];
 let sample;
 for(const [name,text] of files){
  const ref=await ctx.attachments.saveFile({data:Buffer.from(text),name});
  const host=ctx.attachments.fileHostPath(ref);const path=ctx.fs.processPathFromHostPath(host);
  assert.ok(path);assert.equal(await ctx.fs.readText(await ctx.fs.resolve(path)),text);sample=path;
 }
 checks.push('native-attachments-readable-in-executor');
 assert.equal(ctx.fs.processPathFromHostPath('/home/node/.dsh/credentials.encrypted.json'),undefined);
 assert.equal(ctx.fs.processPathFromHostPath('/run/secrets/uptokey-workbench-vault-key'),undefined);
 checks.push('private-host-paths-not-mapped');
 const handle=ctx.subprocess.spawn({argv:['node','-e','const fs=require("fs");let readonly=false,chmodDenied=false;try{fs.chmodSync(process.argv[1],384)}catch(e){chmodDenied=e.code==="EROFS"}try{fs.appendFileSync(process.argv[1],"forbidden")}catch(e){readonly=e.code==="EROFS"||e.code==="EACCES"}console.log(JSON.stringify({uid:process.getuid(),readonly,chmodDenied,key:fs.existsSync("/run/secrets/uptokey-workbench-vault-key"),vault:fs.existsSync("/home/node/.dsh/credentials.encrypted.json")}));',sample],cwd:'/workspace/demo',env:{PATH:'/usr/local/bin:/usr/bin:/bin'},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:8192},stderr:{maxBytes:8192}}});
 assert.equal((await handle.done).exitCode,0);assert.equal(await handle.waitForExit(),true);
 assert.deepEqual(JSON.parse(handle.collected.stdout.readFrom(0).text),{uid:1000,readonly:true,chmodDenied:true,key:false,vault:false});
 checks.push('attachments-readonly-even-with-unconfined-process');
 const target=await ctx.fs.resolve('/workspace/demo/remote-ui-proof.txt');await ctx.fs.writeText(target,'Written through the native SSH filesystem.\n');
 assert.equal(readFileSync('/workspace/demo/remote-ui-proof.txt','utf8'),'Written through the native SSH filesystem.\n');checks.push('shared-workspace-visible-to-web');
 await plugin(await load('dsh-system-prompt'));await plugin(await load('dsh-tools'));
 await plugin(await load('dsh-mcp-client'),{serverName:'weather',transport:'stdio',command:'/usr/bin/ssh',args:['-T','-o','BatchMode=yes','workbench-executor','HTTPS_PROXY=http://127.0.0.1:43190 /usr/local/bin/node /opt/integrations/weather.mjs'],failOnStartupError:true});
 const tool=ctx.tools.schemas().find(t=>t.name==='mcp__weather__weather-forecast');assert.ok(tool);
 const result=await ctx.tools.execute({signal:AbortSignal.timeout(30000),callId:'isolated-executor-weather',name:tool.name,arguments:{latitude:0,longitude:0,current:'temperature_2m',forecast_days:1}});
 assert.ok(!result.isError);assert.match(JSON.stringify(result.content),/temperature_2m/);checks.push('public-api-mcp-executed-in-executor-through-proxy');
 const resultData={recordedAt:new Date().toISOString(),passed:checks.length,checks,realModelInference:false};
 writeFileSync('/tmp/workbench-execution-live.json',JSON.stringify(resultData,null,2));console.log(JSON.stringify(resultData));
}finally{for(const f of fibers.reverse())await f.dispose();}
