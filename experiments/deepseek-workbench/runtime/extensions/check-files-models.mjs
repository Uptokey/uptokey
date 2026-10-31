import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const require = createRequire('/opt/harness/package.json');
const load = name => import(require.resolve(name));
const { Context } = await load('@deepseek-ai/cordis');
const { default: Attachment } = await load('@deepseek-ai/dsh-attachment-local');
const { default: Llm } = await load('@deepseek-ai/dsh-llm');
const PiAi = await load('@deepseek-ai/dsh-llm-pi-ai');
const home = await mkdtemp(join(tmpdir(),'lab-attachments-'));
const ctx = new Context();
let requests=0;
const server=createServer((req,res)=>{
  requests++;
  assert.equal(req.url,'/v1/models');
  assert.equal(req.headers.authorization,'Bearer synthetic-model-catalog-key');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({data:[{id:'fixture/local-model',name:'Fixture local model',context_length:8192}]}));
});
try {
  const attachments = new Attachment(ctx,{dshHome:home});
  const files=[['notes.md','# Synthetic notes\n'],['data.csv','name,value\na,1\n'],['config.json','{"synthetic":true}'],['app.js','console.log("synthetic");\n']];
  for(const [name,content] of files) {
    const data=Buffer.from(content);
    const ref=await attachments.saveFile({data,name});
    const chunks=[];for await(const chunk of attachments.readFileStream(ref)) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks),data);
    assert.deepEqual(await readFile(attachments.fileHostPath(ref)),data);
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC','base64');
  const image=await attachments.saveImage({data:png,mediaType:'image/png',name:'synthetic.png'});
  assert.deepEqual(Buffer.from((await attachments.readImage(image)).data),png);
  const request=await attachments.readImageRequest(image,{width:1,height:1,maxBytes:1024});
  assert.ok(request);
  await ctx.plugin(Llm);await ctx.plugin(PiAi,{});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const models=await ctx.llm.discoverModels('llm-pi-ai',{baseURL:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'synthetic-model-catalog-key'});
  assert.equal(models.length,1);assert.equal(models[0].id,'fixture/local-model');
  assert.equal(models[0].contextWindow,8192);assert.equal(requests,1);
  console.log(JSON.stringify({nativeAttachmentRoundTrip:files.map(([name])=>name),nativeImageRoundTrip:true,modelImageProjection:true,nativeModelDiscovery:{fixture:true,idsPreserved:true,capacitiesPreserved:true,authorizationPreserved:true},realInference:false}));
} finally {
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});
}
