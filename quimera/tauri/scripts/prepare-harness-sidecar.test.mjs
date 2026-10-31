import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {stageComputerResource} from './computer-resource.mjs';
import {admitRefreshedLinuxSidecar,assertWindowsRuntimeAcceptance,copyAcceptedFile,selectHarnessComputerResource,verifyHarnessAssemblyInputs} from './prepare-harness-sidecar.mjs';
import {HARNESS_PORTABLE_FILES,collectHarnessPortableFiles} from './harness-portable-files.mjs';
import {COMPUTER_TOOLS,computerNativeTarget} from './computer-runtime-contract.mjs';
import {sha256File} from './verify-sidecar.mjs';

const output=resolve(dirname(fileURLToPath(import.meta.url)),'../../../output');
// Synthetic declaration of the sealed pins; tests never open the OCI archive
// or require a private output directory to exist on another host.
const prefetchRuntime={schema:'uptokey.harness.runtime-package.v1',
 image:'c4ca47a4595e480ac6ed8471e247b34ffa1bd0356df465f0d5219cca30dbfaa3',
 sourceAcceptanceSha256:'cc561b992801adf86f4174ff36e4cc4c2397651cf7a5502fa6d6163302eb0cd7',
 sourceAcceptance:{path:'output/initial-prefetch-20261030/CANDIDATE.json',kind:'model-catalog-initial-prefetch',interactiveUiAccepted:false},
 archive:{file:'runtime.oci.tar',bytes:774653952,sha256:'84152bd1574cdb73a3d1c6cf6179d3e5fb584c8471fe40d29e1503fe25c12f14'},
 verified:{schema:'uptokey.harness.oci.verified.v1',imageId:'sha256:c4ca47a4595e480ac6ed8471e247b34ffa1bd0356df465f0d5219cca30dbfaa3',os:'linux',architecture:'amd64'},
 sourceImageUnchanged:true,
 scope:{immutableImageOnly:true,personalVolumesIncluded:false,credentialsIncluded:false,containerActivation:false,installedBootstrapIntegrated:false,loadAcceptance:false,completeInstaller:false}};

test('Windows runtime accepts only the sealed prefetch package chain without claiming installed UI',()=>{
 assert.equal(assertWindowsRuntimeAcceptance(prefetchRuntime),'c4ca47a4595e480ac6ed8471e247b34ffa1bd0356df465f0d5219cca30dbfaa3');
 assert.equal(prefetchRuntime.sourceAcceptance.interactiveUiAccepted,false);
});

test('Windows runtime refuses another source acceptance, mutable image or changed archive',()=>{
 for(const change of [
  r=>{r.sourceAcceptance.kind='toolset128';},r=>{r.sourceAcceptance.path='output/other/CANDIDATE.json';},
  r=>{r.sourceAcceptanceSha256='0'.repeat(64);},r=>{r.sourceAcceptance.interactiveUiAccepted=true;},
  r=>{r.image='f715592d16fc39d1cfe21e0edf5890c541f1fe972ea7d2b33d12f774017db4d3';},
  r=>{r.image='localhost/runtime:latest';},r=>{r.verified.imageId='sha256:'+'0'.repeat(64);},
  r=>{r.archive.file='../runtime.oci.tar';},r=>{r.archive.sha256='0'.repeat(64);},r=>{r.archive.bytes++;},
  r=>{r.verified.architecture='arm64';},r=>{r.verified.os='windows';},r=>{r.sourceImageUnchanged=false;},
 ]){const value=structuredClone(prefetchRuntime);change(value);assert.throws(()=>assertWindowsRuntimeAcceptance(value),/harness_package_runtime_unaccepted/);}
});

test('Windows runtime refuses privacy, activation and installer assertions beyond immutable export',()=>{
 for(const field of ['personalVolumesIncluded','credentialsIncluded','containerActivation','installedBootstrapIntegrated','loadAcceptance','completeInstaller']){
  const value=structuredClone(prefetchRuntime);value.scope[field]=true;assert.throws(()=>assertWindowsRuntimeAcceptance(value),/harness_package_runtime_unaccepted/);
 }
 const extra=structuredClone(prefetchRuntime);extra.scope.personalStateIncluded=false;
 assert.throws(()=>assertWindowsRuntimeAcceptance(extra),/harness_package_runtime_unaccepted/);
 for(const value of [undefined,{}, {...prefetchRuntime,scope:null},{...prefetchRuntime,scope:{...prefetchRuntime.scope,immutableImageOnly:false}}])assert.throws(()=>assertWindowsRuntimeAcceptance(value),/harness_package_runtime_unaccepted/);
});

function fixture(t,platform,arch='x64',label='baseline'){
 mkdirSync(output,{recursive:true});
 const root=mkdtempSync(join(output,'harness-computer-selection-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),output);rmSync(root,{recursive:true,force:true});});
 const executable=join(root,'fixture-binary');
 writeFileSync(executable,`${label}: ${platform}/${arch}; synthetic binary, never executed`);
 const directory=join(root,'resource');
 const result=stageComputerResource(directory,executable,{platform,arch});
 return {root,directory,...result};
}
function windowsAcceptance(resource){
 return {
  directory:resource.directory,
  accepted:{schema:'uptokey.native-computer-synchronize.v1',result:'accepted',processAccess:'PROCESS_SYNCHRONIZE',metadataQueryAccess:false,helperExitCode:0,activePointer:{manifestSha256:resource.manifestSha256},executableSha256:resource.manifest.files[resource.manifest.binary].sha256},
 };
}
const noWindowsReceipt=()=>{throw Error('Windows acceptance must not be read on another platform');};

test('accepted sidecar files copy across mounts when copy_file_range returns EPERM',t=>{
 mkdirSync(output,{recursive:true});
 const root=mkdtempSync(join(output,'harness-sidecar-copy-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),output);rmSync(root,{recursive:true,force:true});});
 const source=join(root,'source.bin'),destination=join(root,'nested','candidate.bin');
 const bytes=Buffer.alloc(1024*1024+19,0xa5);writeFileSync(source,bytes);mkdirSync(dirname(destination));
 let fastPathCalls=0;
 copyAcceptedFile(source,destination,{copy:()=>{fastPathCalls++;throw Object.assign(new Error('cross mount'),{code:'EPERM'});}});
 assert.equal(fastPathCalls,1);
 assert.deepEqual(readFileSync(destination),bytes);
 assert.throws(()=>copyAcceptedFile(source,destination,{copy:()=>{throw Object.assign(new Error('cross mount'),{code:'EPERM'});}}),/EEXIST/);
});

test('Linux cross-mount fallback invokes cp without a shell or reflinks',t=>{
 mkdirSync(output,{recursive:true});
 const root=mkdtempSync(join(output,'harness-sidecar-linux-copy-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),output);rmSync(root,{recursive:true,force:true});});
 const source=join(root,'source.bin'),destination=join(root,'candidate.bin'),bytes=Buffer.from('synthetic-sidecar-bytes');
 writeFileSync(source,bytes);
 let invocation;
 copyAcceptedFile(source,destination,{
  platform:'linux',
  copy:()=>{throw Object.assign(new Error('cross mount'),{code:'EPERM'});},
  run:(command,args,options)=>{invocation={command,args,options};writeFileSync(args[3],readFileSync(args[2]));return {status:0};},
 });
 assert.equal(invocation.command,'/bin/cp');
 assert.deepEqual(invocation.args,['--reflink=never','--',source,destination]);
 assert.equal(invocation.options.stdio,'ignore');
 assert.deepEqual(readFileSync(destination),bytes);
});

for(const [platform,arch] of [['linux','x64'],['darwin','x64'],['darwin','arm64']]){
 test(`${platform}/${arch} preserves its attested backend without reading Windows acceptance`,t=>{
  const source=fixture(t,platform,arch);
  const selected=selectHarnessComputerResource(source.directory,source.manifestSha256,{platform,arch,readWindowsAcceptance:noWindowsReceipt});
  assert.equal(selected.directory,source.directory);
  assert.equal(selected.manifestSha256,source.manifestSha256);
  const refreshed=stageComputerResource(join(source.root,'refreshed'),selected.executable,{platform,arch});
  assert.equal(refreshed.manifest.files[refreshed.manifest.binary].sha256,source.manifest.files[source.manifest.binary].sha256);
  assert.deepEqual(readFileSync(join(source.root,'refreshed',refreshed.manifest.binary)),readFileSync(selected.executable));
 });
}

test('Windows replaces only its verified baseline with the accepted PROCESS_SYNCHRONIZE binary',t=>{
 const source=fixture(t,'win32'),replacement=fixture(t,'win32','x64','synchronize');
 let reads=0;
 const selected=selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'win32',arch:'x64',readWindowsAcceptance:()=>{reads++;return windowsAcceptance(replacement);}});
 assert.equal(reads,1);
 assert.equal(selected.directory,replacement.directory);
 assert.notEqual(selected.manifestSha256,source.manifestSha256);
 const refreshed=stageComputerResource(join(source.root,'refreshed'),selected.executable,{platform:'win32',arch:'x64'});
 assert.equal(refreshed.manifest.files[refreshed.manifest.binary].sha256,replacement.manifest.files[replacement.manifest.binary].sha256);
});

test('Windows rejects a replacement for another platform or architecture',t=>{
 const source=fixture(t,'win32');
 for(const [platform,arch] of [['linux','x64'],['win32','arm64']]){
  const replacement=fixture(t,platform,arch);
  assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'win32',arch:'x64',readWindowsAcceptance:()=>windowsAcceptance(replacement)}),/computer_resource_manifest_invalid/);
 }
});

test('a valid Windows resource and functional receipt cannot admit embedded personal build paths',t=>{
 const source=fixture(t,'win32'),replacement=fixture(t,'win32','x64',homedir());
 assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'win32',arch:'x64',readWindowsAcceptance:()=>windowsAcceptance(replacement)}),/release_binary_contains_personal_build_path/);
});

test('Windows rejects missing acceptance guarantees and a receipt for different executable bytes',t=>{
 const source=fixture(t,'win32'),replacement=fixture(t,'win32','x64','synchronize');
 for(const patch of [{schema:'other'},{result:'unverified'},{processAccess:'PROCESS_QUERY_LIMITED_INFORMATION'},{metadataQueryAccess:true},{helperExitCode:1},{executableSha256:'0'.repeat(64)}]){
  const proof=windowsAcceptance(replacement);Object.assign(proof.accepted,patch);
  assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'win32',arch:'x64',readWindowsAcceptance:()=>proof}),/harness_package_computer_unaccepted/);
 }
});

test('a corrupt source cannot be hidden by the Windows replacement',t=>{
 const source=fixture(t,'win32');
 writeFileSync(join(source.directory,source.manifest.binary),'changed');
 assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'win32',arch:'x64',readWindowsAcceptance:noWindowsReceipt}),/computer_resource_file_changed/);
});

test('unsupported targets and platform mismatches fail before consulting Windows acceptance',t=>{
 const source=fixture(t,'linux');
 assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'linux',arch:'arm64',readWindowsAcceptance:noWindowsReceipt}),/harness_package_computer_unaccepted/);
 assert.throws(()=>selectHarnessComputerResource(source.directory,source.manifestSha256,{platform:'darwin',arch:'x64',readWindowsAcceptance:noWindowsReceipt}),/computer_resource_manifest_invalid/);
});

test('Linux refresh admits only the pinned private beta.22 sidecar receipt',()=>{
 const sidecar={directory:'output/linux-refresh',candidate:'candidate-1',computerManifestSha256:'c'.repeat(64)};
 const receipt={schema:'uptokey.harness-linux-sidecar-refresh.v1',result:'accepted_private_sidecar',platform:'linux-x64',
  candidatePath:'output/linux-refresh/candidate-1',manifestSha256:'d'.repeat(64),
  core:{version:'0.1.0-beta.22'},node:{version:'24.21.0',abi:137},computer:{resourceManifestSha256:'c'.repeat(64)},
  verification:{prepareExitCode:0,preparedSidecarCheck:'passed'},
  scope:{tauriDesktopPackageBuilt:false,installed:false,runtimeStarted:false,personalCoreTouched:false,vaultTouched:false,productionChanged:false}};
 assert.deepEqual(admitRefreshedLinuxSidecar(receipt,sidecar),{path:'output/linux-refresh/candidate-1',manifestSha256:'d'.repeat(64)});
});

test('Linux refresh refuses wrong candidate, platform, backend, or runtime scope',()=>{
 const sidecar={directory:'output/linux-refresh',candidate:'candidate-1',computerManifestSha256:'c'.repeat(64)};
 const base={schema:'uptokey.harness-linux-sidecar-refresh.v1',result:'accepted_private_sidecar',platform:'linux-x64',
  candidatePath:'output/linux-refresh/candidate-1',manifestSha256:'d'.repeat(64),core:{version:'0.1.0-beta.22'},
  node:{version:'24.21.0',abi:137},computer:{resourceManifestSha256:'c'.repeat(64)},
  verification:{prepareExitCode:0,preparedSidecarCheck:'passed'},
  scope:{tauriDesktopPackageBuilt:false,installed:false,runtimeStarted:false,personalCoreTouched:false,vaultTouched:false,productionChanged:false}};
 for(const patch of [
  {candidatePath:'output/linux-refresh/other'}, {platform:'linux-arm64'},
  {computer:{resourceManifestSha256:'0'.repeat(64)}}, {node:{version:'24.21.0',abi:136}},
  {scope:{...base.scope,runtimeStarted:true}}, {verification:{...base.verification,preparedSidecarCheck:'failed'}},
 ]) assert.throws(()=>admitRefreshedLinuxSidecar({...base,...patch},sidecar),/harness_linux_sidecar_receipt_invalid/);
});

function assemblyFixture(t){
 mkdirSync(output,{recursive:true});const root=mkdtempSync(join(output,'harness-component-inputs-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),output);rmSync(root,{recursive:true,force:true});});
 const put=(name,bytes)=>{const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return path;};
 const record=path=>({size_bytes:readFileSync(path).length,sha256:sha256File(path)});
 for(const path of HARNESS_PORTABLE_FILES.filter(name=>name!=='quimera/tauri/resources/sidecar/manifest.json'))put(path,path.endsWith('.json')?'{}\n':'// synthetic public source\n');
 const executable=put('backend-binary','synthetic backend, never executed'),source=join(root,'base');
 const computer=stageComputerResource(source,executable);
 const binary=process.platform==='win32'?'uptokey-windows.exe':'uptokey';
 const files={};
 for(const [name,row] of Object.entries(computer.manifest.files))files[name]={size_bytes:row.size,sha256:row.sha256};
 files['computer-resource.json']=record(join(source,'computer-resource.json'));
 for(const name of [binary,'cli.js','composition-worker.js','service-schema-worker.js'])files[name]=record(put('base/'+name,'synthetic '+name));
 const manifest={schema_version:2,runtime:'node',binary_name:binary,entry:'cli.js',worker:'composition-worker.js',serviceSchemaWorker:'service-schema-worker.js',build_version:'0.1.0-beta.22',target:process.platform,files,
  computerMcp:{schema_version:1,binary:computer.manifest.binary,platform:process.platform,arch:process.arch,target:computerNativeTarget(process.platform,process.arch),tools:COMPUTER_TOOLS,resourceManifestSha256:computer.manifestSha256}};
 const sourceManifest=put('base/manifest.json',JSON.stringify(manifest));
 const archive=put('runtime/runtime.oci.tar','synthetic OCI bytes, never imported');
 const runtime={schema:'uptokey.harness.runtime-package.v1',image:'c'.repeat(64),archive:{file:'runtime.oci.tar',bytes:readFileSync(archive).length,sha256:sha256File(archive)},verified:{imageId:'sha256:'+'c'.repeat(64),os:'linux',architecture:'amd64'},scope:{immutableImageOnly:true,personalVolumesIncluded:false}};
 const runtimeReceipt=put('runtime/RUNTIME.json',JSON.stringify(runtime)),evidence=put('evidence.json','synthetic private admission evidence');
 const inputs={root,platform:process.platform,arch:process.arch,
  base:{directory:source,manifestSha256:sha256File(sourceManifest),sourceReceipt:{path:'evidence.json',sha256:sha256File(evidence)}},
  runtime:{directory:join(root,'runtime'),receiptSha256:sha256File(runtimeReceipt)},
  computer:{directory:source,manifestSha256:computer.manifestSha256,binarySha256:computer.manifest.files[computer.manifest.binary].sha256},
  publicFiles:collectHarnessPortableFiles(root,{installedSidecar:true}).map(row=>({...row,record:record(row.source)})),corePromotion:null,admissionEvidence:[{path:evidence,record:record(evidence)}]};
 const updateRuntime=change=>{change(runtime);writeFileSync(runtimeReceipt,JSON.stringify(runtime));inputs.runtime.receiptSha256=sha256File(runtimeReceipt);};
 return {root,inputs,manifest,runtime,sourceManifest,runtimeReceipt,archive,put,record,updateRuntime};
}

test('component byte verification is read-only and never admits a synthetic runtime or publishes output',t=>{
 const f=assemblyFixture(t),result=verifyHarnessAssemblyInputs(f.inputs);
 assert.equal(result.provenanceAdmitted,false);assert.equal(result.manifest.build_version,'0.1.0-beta.22');
 assert.equal(result.runtime.image,f.runtime.image);assert.equal(result.computer.manifestSha256,f.inputs.computer.manifestSha256);
});
test('component verification refuses fake acceptance flags and another native target',t=>{
 const {inputs}=assemblyFixture(t);
 assert.throws(()=>verifyHarnessAssemblyInputs({...inputs,accepted:true}),/components_invalid/);
 assert.throws(()=>verifyHarnessAssemblyInputs({...inputs,platform:process.platform==='win32'?'linux':'win32'}),/components_invalid/);
 assert.throws(()=>verifyHarnessAssemblyInputs({...inputs,arch:'unsupported'}),/components_invalid/);
});
test('component verification detects base manifest or source byte changes before assembly',t=>{
 const f=assemblyFixture(t),before=readFileSync(f.sourceManifest);
 writeFileSync(f.sourceManifest,Buffer.concat([before,Buffer.from('\n')]));
 assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/sidecar_changed/);writeFileSync(f.sourceManifest,before);
 writeFileSync(join(f.inputs.base.directory,'cli.js'),'changed');
 assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/file_size_mismatch|file_hash_mismatch/);
});
test('component verification binds the runtime receipt and exact archive bytes',t=>{
 const f=assemblyFixture(t),before=readFileSync(f.runtimeReceipt);
 writeFileSync(f.runtimeReceipt,Buffer.concat([before,Buffer.from('\n')]));
 assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/receipt_changed/);writeFileSync(f.runtimeReceipt,before);
 writeFileSync(f.archive,'different OCI bytes');
 assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/component_changed/);
});
test('component verification refuses runtime target, privacy and unsafe archive metadata even with matching receipt hash',t=>{
 for(const change of [r=>{r.archive.file='../outside';},r=>{r.verified.architecture='arm64';},r=>{r.verified.imageId='sha256:'+'0'.repeat(64);},r=>{r.scope.personalVolumesIncluded=true;},r=>{r.scope.credentialsIncluded=true;}]){
  const f=assemblyFixture(t);f.updateRuntime(change);assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/runtime_unaccepted/);
 }
});
test('component verification binds canonical public sources, computer bytes and admission evidence',t=>{
 const f=assemblyFixture(t),first=f.inputs.publicFiles[0],before=readFileSync(first.source);
 writeFileSync(first.source,'changed canonical public source');assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/component_changed/);writeFileSync(first.source,before);
 const wrong=structuredClone(f.inputs);wrong.publicFiles[0].source=f.put('unlisted.mjs','not an allowed source');
 assert.throws(()=>verifyHarnessAssemblyInputs(wrong),/public_sources_changed/);
 const computer=structuredClone(f.inputs);computer.computer.binarySha256='0'.repeat(64);assert.throws(()=>verifyHarnessAssemblyInputs(computer),/computer_binary_changed/);
 writeFileSync(f.inputs.admissionEvidence[0].path,'changed admission');assert.throws(()=>verifyHarnessAssemblyInputs(f.inputs),/component_changed/);
});
