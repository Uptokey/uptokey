import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
const harness = createRequire('/opt/harness/package.json');
const load = name => import(harness.resolve(name));
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: Tools } = await load('@deepseek-ai/dsh-tools');
const Mcp = await load('@deepseek-ai/dsh-mcp-client');
const { installProxyFromEnvironment, proxyRouteFor } = await load('@deepseek-ai/dsh-http-proxy');

const { Server } = createRequire('/opt/integrations/package.json')('proxy-chain');
const address = Object.values(networkInterfaces()).flat().find(n=>n?.family==='IPv4'&&!n.internal)?.address;
assert.ok(address);
const server = createServer((req,res)=>{
  if(req.url==='/models') {
    assert.equal(req.headers.authorization,'Bearer synthetic-proxy-canary');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:[{id:'fixture-local-model'}]}));
  } else {
    res.setHeader('content-type','text/event-stream');
    res.write('data: {"delta":"first"}\n\n');
    setTimeout(()=>res.end('data: [DONE]\n\n'),40);
  }
});
await new Promise(r=>server.listen(0,address,r));
let routed=0;
const proxy=new Server({host:'127.0.0.1',port:43190,verbose:false,prepareRequestFunction:()=>{routed++;return {}}});
await proxy.listen();
const values={HTTP_PROXY:`http://127.0.0.1:${proxy.port}`,HTTPS_PROXY:`http://127.0.0.1:${proxy.port}`,NO_PROXY:'localhost,127.0.0.1,::1'};
const restore=await installProxyFromEnvironment({get:key=>values[key]?{value:values[key]}:undefined},()=>{throw Error('Unexpected proxy diagnostic')});
try {
  const base=`http://${address}:${server.address().port}`;
  const models=await fetch(base+'/models',{headers:{authorization:'Bearer synthetic-proxy-canary'}});
  assert.deepEqual(await models.json(),{data:[{id:'fixture-local-model'}]});
  const response=await fetch(base+'/stream');const reader=response.body.getReader();
  const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);
  let rest='';for(;;){const next=await reader.read();if(next.done)break;rest+=new TextDecoder().decode(next.value)}
  assert.match(rest,/DONE/);assert.equal(routed,2);
  assert.equal(proxyRouteFor(new URL('http://127.0.0.1:43180')).proxied,false);
} finally {
  server.closeAllConnections();await new Promise(r=>server.close(r));
}

const ctx=new Context();const fibers=[];
try {
  fibers.push(ctx.plugin(SystemPrompt));await fibers.at(-1);
  fibers.push(ctx.plugin(Tools));await fibers.at(-1);
  fibers.push(ctx.plugin(Mcp,{
    serverName:'weather',transport:'stdio',command:process.execPath,
    args:['/opt/integrations/weather.mjs'],
    env:{HTTP_PROXY:'http://127.0.0.1:43190',HTTPS_PROXY:'http://127.0.0.1:43190',NO_PROXY:'localhost,127.0.0.1,::1'},
    failOnStartupError:true,
  }));await fibers.at(-1);
  const tools=ctx.tools.schemas();
  assert.equal(tools.length,1);
  const tool=tools[0];
  console.log(JSON.stringify({proxy:{modelCatalogFixture:true,authorizationPreserved:true,ssePreserved:true,requests:routed},mcpTool:tool}));
  if(process.argv.includes('--live-public-api')) {
    const result=await ctx.tools.execute({signal:AbortSignal.timeout(30000),callId:'lab-weather-check',name:tool.name,arguments:{latitude:0,longitude:0,current:'temperature_2m',forecast_days:1}});
    if(result.isError) throw Error('Public API tool failed: '+JSON.stringify(result.content));
    const text=JSON.stringify(result.content);
    assert.match(text,/temperature_2m/);
    console.log(JSON.stringify({nativeHarnessToolExecution:true,publicApi:'Open-Meteo',explicitSyntheticCoordinates:[0,0],temperatureFieldPresent:true,modelInference:false}));
  }
} finally {
  for(const fiber of fibers.reverse()) await fiber.dispose();
  await proxy.close(true);
  await restore();
}
