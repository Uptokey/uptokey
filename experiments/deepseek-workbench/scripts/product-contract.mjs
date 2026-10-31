import {request as httpRequest} from 'node:http';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve,isAbsolute,toNamespacedPath,basename,parse} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {nativeSecret} from './core-bridge-server.mjs';
import {requestAccount} from './account-client.mjs';
import {collectRuntimeHealth} from './runtime-health.mjs';

export const CAPABILITIES=Object.freeze([
 'account','subscription_catalog','local_models','hosted_models','byok',
 'files','projects','public_api','mcp_tools','approved_context_snapshot',
 'sessions','encrypted_workspace','encrypted_export','notifications','theme',
 'legacy_session_recovery','runtime_supervision','diagnostics',
]);

function count(value,key){return Array.isArray(value?.[key])?value[key].length:Array.isArray(value)?value.length:0}

// Location only: the native caller verifies the schema-2 sidecar before any
// helper executes. Never accept a WebView-selected manifest or an env override.
export function sidecarManifestLocation(nodePath=process.execPath,platform=process.platform){
 if(typeof nodePath!=='string'||!isAbsolute(nodePath)||!['uptokey','uptokey-windows.exe'].includes(basename(nodePath)))throw Error('packaging_sidecar_location_invalid');
 const executableDir=dirname(nodePath),contents=dirname(executableDir),bundle=dirname(contents);
 const nested=platform==='darwin'&&basename(nodePath)==='uptokey'&&basename(executableDir)==='MacOS'&&basename(contents)==='Contents'&&basename(bundle)==='UptokeyCore.app';
 return resolve(nested?dirname(bundle):executableDir,'manifest.json');
}
export function installedSidecarManifest(path,nodePath=process.execPath,platform=process.platform){
 if(typeof path!=='string'||!isAbsolute(path))throw Error('packaging_sidecar_location_invalid');
 const expected=sidecarManifestLocation(nodePath,platform);
 if([path,nodePath].some(file=>file.split(/[\\/]/).some(part=>part==='.'||part==='..')))throw Error('packaging_sidecar_location_invalid');
 if(toNamespacedPath(path)!==toNamespacedPath(expected))throw Error('packaging_sidecar_location_invalid');
 for(const file of [path,nodePath]){
  const root=parse(file).root;
  for(let current=file;;){
   // Node's Windows dirname/lstat can reduce a verbatim drive root to C:.
   // Check that same drive via its ordinary root spelling; retain canonical
   // equality and every ancestor check, and stop at the parsed absolute root.
   const metadataPath=current===root&&/^\\\\\?\\[A-Za-z]:\\$/.test(root)?root.slice(4):current;
   const stat=lstatSync(metadataPath);
   if(stat.isSymbolicLink()||(current===file?!stat.isFile():!stat.isDirectory())||toNamespacedPath(realpathSync.native(metadataPath))!==toNamespacedPath(metadataPath))throw Error('packaging_sidecar_location_invalid');
   if(current===root)break;
   const parent=dirname(current);
   current=parent.length<root.length?root:parent;
  }
 }
 return path;
}

export function readCanonicalPackaging({sidecarManifest,nodePath=process.execPath,tauri=resolve(dirname(fileURLToPath(import.meta.url)),'../../../quimera/tauri')}={}){
 const cargo=readFileSync(resolve(tauri,'Cargo.toml'),'utf8');
 const config=JSON.parse(readFileSync(resolve(tauri,'tauri.conf.json'),'utf8'));
 const manifestPath=sidecarManifest===undefined?resolve(tauri,'resources/sidecar/manifest.json'):installedSidecarManifest(sidecarManifest,nodePath);
 const sidecar=JSON.parse(readFileSync(manifestPath,'utf8'));
 const ci=readFileSync(resolve(tauri,'../../.github/workflows/ci.yml'),'utf8');
 const unix=ci.slice(ci.indexOf('\n  tauri-unix:\n'));
 return {owner:'quimera/tauri',bundleActive:config.bundle?.active===true,attestedSidecar:sidecar.schema_version===2&&sidecar.runtime==='node',windows:/\[target\."cfg\(windows\)"\.dependencies\]/.test(cargo)&&!!config.bundle?.windows?.nsis,linux:/\[target\."cfg\(unix\)"\.dependencies\]/.test(cargo)&&!!config.bundle?.linux?.deb,macos:Object.hasOwn(config.bundle??{},'macOS'),ciWindows:/\n  tauri-windows:\n/.test(ci)&&/node-version: "24\.21\.0"/.test(ci.slice(ci.indexOf('\n  tauri-windows:\n'),ci.indexOf('\n  tauri-unix:\n'))),ciLinux:/platform: Linux[\s\S]*os: ubuntu-24\.04/.test(unix),ciMacos:/platform: macOS[\s\S]*os: macos-14/.test(unix)};
}

export function buildProductContract({health,models,connections,account,packaging=readCanonicalPackaging()}){
 return {
  schemaVersion:1,product:'uptokey',
  nativeHost:{runtime:'rust',framework:'tauri',platforms:['windows','linux','macos']},
  packaging,
  proxy:{owner:'uptokey-core',endpoint:'http://127.0.0.1:21435',loopback:true,keyResolution:'core-only'},
  secrets:{custody:'operating-system-native-vault',visibleToHarness:false,persistedByHarness:false,exportedByHarness:false},
  privacy:{localKeyKnowledge:'core-only',controlPlaneKeyRetention:false,remoteProviderReceivesInferenceContent:true,globalZeroKnowledge:false},
  capabilities:[...CAPABILITIES],
  platformStatus:{windows:'acceptance-pending',linux:'acceptance-pending',macos:'acceptance-pending'},
  live:{coreReachable:health?.listeners?.core?.state==='reachable',bridgeReachable:health?.listeners?.broker?.state==='reachable',controllerRunning:health?.containers?.controller?.state==='running',executorRunning:health?.containers?.executor?.state==='running',modelCount:count(models,'data')||count(models,'models'),connectionCount:count(connections,'connections')||count(connections,'data'),accountState:account?.state},
 };
}

async function bridgeJson(path,gate){
 return await new Promise((resolve,reject)=>{
  const request=httpRequest({host:'127.0.0.1',port:43193,path,method:'GET',headers:{host:'127.0.0.1:43194',authorization:`Bearer ${gate}`,accept:'application/json'},timeout:5000},response=>{
   let size=0;const chunks=[];
   response.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){request.destroy(Error('product_contract_response_too_large'));return}chunks.push(chunk)});
   response.on('end',()=>{if(response.statusCode!==200)return reject(Error('product_contract_proxy_unavailable'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(Error('product_contract_response_invalid'))}});
  });
  request.on('timeout',()=>request.destroy(Error('product_contract_timeout')));
  request.on('error',reject);request.end();
 });
}

export async function readProductContract({healthReader=collectRuntimeHealth,secretReader=nativeSecret,accountReader=requestAccount,bridgeReader=bridgeJson,packagingReader=readCanonicalPackaging}={}){
 const gate=secretReader('bridge-gate');const token=secretReader('client-token');
 if(!gate||!token)throw Error('product_contract_identity_unavailable');
 const [health,models,connections,account]=await Promise.all([healthReader(),bridgeReader('/v1/models',gate),bridgeReader('/v1/connections',gate),accountReader('status',{token})]);
 return buildProductContract({health,models,connections,account,packaging:packagingReader()});
}

export function packagingArguments(args){
 let sidecarManifest,packagingOnly=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--sidecar-manifest'&&sidecarManifest===undefined&&args[i+1]&&!args[i+1].startsWith('--'))sidecarManifest=args[++i];
  else if(args[i]==='--packaging-only'&&!packagingOnly)packagingOnly=true;
  else throw Error('packaging_arguments_invalid');
 }
 return {sidecarManifest,packagingOnly};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const {sidecarManifest,packagingOnly}=packagingArguments(process.argv.slice(2));
  const packaging=readCanonicalPackaging({sidecarManifest});
  process.stdout.write(JSON.stringify(packagingOnly?packaging:await readProductContract({packagingReader:()=>packaging}))+'\n');
 }
 catch{process.stderr.write('product_contract_unavailable\n');process.exitCode=1}
}
