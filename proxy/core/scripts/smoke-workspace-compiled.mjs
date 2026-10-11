// Local compiled-CLI smoke. The keyring module is replaced only in this child
// process; this verifies bundling/HTTP/storage, not native credential security.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Script} from 'node:vm';

const port=21435;
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});
await new Promise(resolve=>probe.close(resolve));
const outputRoot=fileURLToPath(new URL("../../../quimera/uptokey/output/quimera-smoke/",import.meta.url));
await mkdir(outputRoot,{recursive:true});
const root=await mkdtemp(join(outputRoot,'compiled-'));
const recoverySentinel = '{"quimeraRecoverySentinel":true}';
await writeFile(join(root,'update-transaction.json'), recoverySentinel);
const token=`utk_local_${randomBytes(24).toString('base64url')}`;
const mockSource=`const values=new Map([['local:api-token',${JSON.stringify(token)}]]);export class Entry {constructor(service,account){if(service!=='com.uptokey.quimera.proxy')throw new Error('legacy_vault_access_blocked');this.account=account;}getPassword(){return values.get(this.account)||null;}setPassword(value){values.set(this.account,value);}deletePassword(){values.delete(this.account);}}`;
const loader=join(root,'keyring-fixture-loader.mjs');
await writeFile(loader,`export async function resolve(specifier,context,next){if(specifier==='@napi-rs/keyring')return {url:${JSON.stringify('data:text/javascript,'+encodeURIComponent(mockSource))},shortCircuit:true};return next(specifier,context);}`);
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['systemroot','windir','path','pathext','temp','tmp'].includes(key.toLowerCase())));
const child=spawn(process.execPath,['--experimental-loader',pathToFileURL(loader).href,cli,'start','--no-tailnet'],{
  env:{...cleanEnv,UPTOKEY_QUIMERA_DATA_DIR:root,HOME:root,USERPROFILE:root},stdio:['ignore','pipe','pipe'],windowsHide:true,
});
let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
const done=new Promise(resolve=>child.once('exit',resolve));
child.on('error',()=>{});
const request=(path,body,method=body?'POST':'GET')=>fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});
try {
  let health;
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline) {
    if(child.exitCode!==null)throw new Error(`compiled_daemon_exited_${child.exitCode}`);
    try {const response=await request('/health');if(response.ok){health=await response.json();break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(health?.status,'ok','compiled daemon becomes healthy');
  const setup = await request('/ui');
  assert.equal(setup.status, 200);
  const setupHtml = await setup.text();
  const setupScript = setupHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(setupScript, 'compiled setup includes its CSP script');
  assert.doesNotThrow(() => new Script(setupScript, {filename:'compiled-setup.js'}));
  assert.equal(setupHtml.includes(token), false, 'administrative bearer is never embedded in setup');
  assert.equal(await readFile(join(root,'update-transaction.json'),'utf8'), recoverySentinel, 'development startup does not consume inherited update journals');
  const created=await request('/v1/workspace/projects/create',{name:'Compiled isolated smoke',goal:''});
  assert.equal(created.status,201,await created.clone().text());
  const view=await created.json();
  assert.equal(view.project.name,'Compiled isolated smoke');assert.equal(view.run,null);assert.equal(view.plan,null);
  const loaded=await request(`/v1/workspace/projects/${view.projectId}`);
  assert.equal(loaded.status,200);assert.equal((await loaded.json()).projectId,view.projectId);
  const anonymous=await fetch(`http://127.0.0.1:${port}/v1/workspace/projects`,{signal:AbortSignal.timeout(3000)});
  assert.equal(anonymous.status,401);
  const files=await readdir(root,{recursive:true});
  assert.ok(files.some(path=>path.endsWith('snapshot.json')),'encrypted workspace snapshot persisted');
  const snapshot=await readFile(join(root,files.find(path=>path.endsWith('snapshot.json'))),'utf8');
  assert.equal(snapshot.includes('Compiled isolated smoke'),false);
  assert.equal(JSON.parse(snapshot).alg,'aes-256-gcm');
  const invalidProxy=await request('/local/egress/proxies',{id:'__proto__',label:'fixture',kind:'http',endpointUrl:'http://127.0.0.1:12345'});
  assert.equal(invalidProxy.status,400);assert.equal((await invalidProxy.json()).error.type,'egress_proxy_id_invalid');
  const invalidPool=await request('/local/egress/pools',{});assert.equal(invalidPool.status,400);await invalidPool.arrayBuffer();
  const egressCreated=await request('/local/egress/proxies',{label:'Compiled egress fixture',kind:'http',endpointUrl:'http://127.0.0.1:12345',credentialRef:'egress-proxy:synthetic-unresolved'});
  assert.equal(egressCreated.status,201);const egress=(await egressCreated.json()).proxy;
  assert.equal(egress.hasCredential,true);assert.equal(Object.hasOwn(egress,'credentialRef'),false);
  const changed=await request(`/local/egress/proxies/${egress.id}`,{expectedRevision:1,label:'Committed egress fixture'},'PATCH');
  assert.equal(changed.status,200);assert.equal((await changed.json()).proxy.revision,2);
  const stale=await request(`/local/egress/proxies/${egress.id}`,{expectedRevision:1,label:'Stale fixture'},'PATCH');
  assert.equal(stale.status,409);await stale.arrayBuffer();
  const inventory=await request('/local/egress/proxies');const inventoryText=await inventory.text();
  assert.equal(JSON.parse(inventoryText).proxies[0].label,'Committed egress fixture');assert.equal(inventoryText.includes('synthetic-unresolved'),false);
  console.log(JSON.stringify({passed:true,version:health.version,cliSha256:createHash('sha256').update(await readFile(cli)).digest('hex'),checks:['compiled daemon health','compiled setup script valid without admin bearer','update recovery journal ignored','authenticated workspace create/read','anonymous denied','encrypted snapshot persisted','egress invalid contracts rejected','egress create/update and revision conflict','egress credential reference omitted'],nativeVault:'simulated in isolated child',externalCalls:'none requested'},null,2));
} catch(error) {
  // No tokens or keyring contents are emitted on failure.
  console.error(String(error));
  console.error(output.replaceAll(token,'[redacted]').slice(-1500));
  process.exitCode=1;
} finally {
  if(child.exitCode===null)child.kill('SIGTERM');
  await done;
}
