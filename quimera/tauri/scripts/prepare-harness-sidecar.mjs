// Assemble accepted artifacts into one private schema-2 sidecar. No build,
// installation, core start, image import or personal state access occurs here.
import {closeSync,copyFileSync,constants,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,readSync,unlinkSync,writeFileSync,writeSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep,toNamespacedPath} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {collectHarnessPortableFiles} from './harness-portable-files.mjs';
import {sha256File,verifySidecar} from './verify-sidecar.mjs';
import {validateAcceptedOutput} from './accepted-sidecar-artifacts.mjs';
import {createStagingOutput,publishStagingOutput} from './sidecar-output.mjs';
import {verifyComputerResource} from '../computer-use/resource-launcher.mjs';
import {stageComputerResource} from './computer-resource.mjs';
import {verifyHarnessPayload} from './frontend-hook.mjs';
import {verifyMacosPreparedSidecar} from './verify-macos-sidecar.mjs';
import {assertNoPersonalBuildPaths} from './release-cargo.mjs';
import {PROMOTED_CORE_FILES,readWindowsCorePromotion} from './harness-windows-promotion.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const LAB='experiments/deepseek-workbench';
const SIDECARS=Object.freeze({
 'win32-x64':{directory:`${LAB}/output/canonical-sidecar-beta22-20261027`,receipt:'ACCEPTANCE.json',sha256:'4aaadc648180ab95f6140ddf36c7e022f0c1575f2affa29cb860798b80071a77',state:'private_beta22_sidecar_with_exact_node_license_accepted',candidate:'candidate-1'},
 'linux-x64':{directory:`${LAB}/output/computer-linux-native-20261027`,receipt:'SIDECAR-ACCEPTANCE.json',sha256:'9870b972d0425f6eaaf1f015cfd17c231abd1883435b2fd455ef34b74d91d8bb',state:'private_linux_x64_sidecar_verified',candidate:'linux-sidecar'},
});
const LINUX_REFRESHED_SIDECAR=Object.freeze({
 directory:`${LAB}/output/linux-sidecar-refresh-20261028`,receipt:'ACCEPTANCE.json',
 sha256:'102c9d96f83f785420cdc1e4760213b57002b1c90d7d5e41cd1ac043f780f7c3',
 candidate:'linux-sidecar-refresh-20261028/candidate-1',computerManifestSha256:'c124597f33d61d8656a9bf5e5d828ea202908db9c203a10b792aef727beba892',
});
const RUNTIME=`${LAB}/output/native-focus-runtime-20261028/candidate-1`;
const RUNTIME_RECEIPT='c60ee4a676362b79664545b5b6eb8d5d73c2d1fe1deb5916a774eacf72a129c5';
const WINDOWS_RUNTIME=`${LAB}/output/initial-prefetch-runtime-20261030/candidate-1`;
const WINDOWS_RUNTIME_RECEIPT='1924a5b4a7795390c1aa1fc8aa9b319e4e30b22116a7ae65ae12e258cc96b08c';
const WINDOWS_RUNTIME_IMAGE='c4ca47a4595e480ac6ed8471e247b34ffa1bd0356df465f0d5219cca30dbfaa3';
const WINDOWS_RUNTIME_SOURCE='cc561b992801adf86f4174ff36e4cc4c2397651cf7a5502fa6d6163302eb0cd7';
const WINDOWS_RUNTIME_ARCHIVE=Object.freeze({bytes:774653952,sha256:'84152bd1574cdb73a3d1c6cf6179d3e5fb584c8471fe40d29e1503fe25c12f14'});
const COMPUTER_RECEIPT=`${LAB}/output/native-computer-remap-20261028/FINAL.json`;
const COMPUTER_RECEIPT_SHA256='1686e5e2aebe859e567b8250061752605ab064ace86d3540a68fbbd767116204';

function checked(path,directory=false){
 if(!isAbsolute(path))throw Error('harness_package_path_invalid');
 for(let current=path;;current=dirname(current)){
  const meta=lstatSync(current);
  if(meta.isSymbolicLink()||((current!==path||directory)?!meta.isDirectory():!meta.isFile())||toNamespacedPath(realpathSync.native(current))!==toNamespacedPath(current))throw Error('harness_package_path_invalid');
  if(current===dirname(current))break;
 }
 return path;
}
function receipt(path,expected){
 checked(path);if(lstatSync(path).size>1024*1024||sha256File(path)!==expected)throw Error('harness_package_receipt_changed');
 return JSON.parse(readFileSync(path,'utf8'));
}
function validName(name){return typeof name==='string'&&!isAbsolute(name)&&!name.includes('\\')&&!name.includes(':')&&!name.includes('\0')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');}

// Some supported package builders expose the accepted source as a read-only
// bind mount and the fresh candidate on a separate writable mount. Node's
// copy_file_range-backed copyFileSync can return EPERM across that boundary.
// Keep the fast path, then fall back to bounded synchronous copying without
// following links or overwriting a staged destination.
export function copyAcceptedFile(from,to,{copy=copyFileSync,platform=process.platform,run=spawnSync}={}){
 try{copy(from,to,constants.COPYFILE_EXCL);return;}catch(error){if(!['EPERM','EXDEV'].includes(error?.code))throw error;}
 const metadata=lstatSync(from);if(!metadata.isFile()||metadata.isSymbolicLink())throw Error('harness_package_source_invalid');
 if(platform==='linux'){
  const result=run('/bin/cp',['--reflink=never','--',from,to],{encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:4096,stdio:'ignore'});
  if(result.error||result.status!==0){if(existsSync(to)&&!lstatSync(to).isSymbolicLink())unlinkSync(to);throw Error('harness_package_copy_failed');}
  return;
 }
 let sourceFd,destinationFd,created=false;
 try{
  sourceFd=openSync(from,'r');destinationFd=openSync(to,'wx',metadata.mode&0o777);created=true;
  const buffer=Buffer.allocUnsafe(1024*1024);
  for(;;){const count=readSync(sourceFd,buffer,0,buffer.length,null);if(count===0)break;let offset=0;while(offset<count)offset+=writeSync(destinationFd,buffer,offset,count-offset);}
  // openSync applies source mode under the builder's umask. Avoid chmod here:
  // Windows-backed writable binds can reject chmod even though file creation
  // and byte writes succeed.
  fsyncSync(destinationFd);
 }catch(error){if(created)try{unlinkSync(to);}catch{}throw error;
 }finally{if(destinationFd!==undefined)closeSync(destinationFd);if(sourceFd!==undefined)closeSync(sourceFd);}
}

function readWindowsComputerAcceptance(){
 const accepted=receipt(join(ROOT,COMPUTER_RECEIPT),COMPUTER_RECEIPT_SHA256);
 return {accepted,directory:join(ROOT,LAB,'.local','computer-resources',accepted.activePointer.directory)};
}
export function selectHarnessComputerResource(source,expectedHash,{platform=process.platform,arch=process.arch,readWindowsAcceptance=readWindowsComputerAcceptance}={}){
 if(!['win32-x64','linux-x64','darwin-x64','darwin-arm64'].includes(`${platform}-${arch}`))throw Error('harness_package_computer_unaccepted');
 const baseline=verifyComputerResource(source,expectedHash,platform,arch);
 // Linux/macOS already carry their platform's accepted backend. In particular,
 // keep the signed macOS binary instead of consulting the Windows-only receipt.
 if(platform!=='win32')return baseline;
 const {accepted,directory}=readWindowsAcceptance();
 if(accepted.schema!=='uptokey.native-computer-synchronize.v1'||accepted.result!=='accepted'||accepted.processAccess!=='PROCESS_SYNCHRONIZE'||accepted.metadataQueryAccess!==false||accepted.helperExitCode!==0)throw Error('harness_package_computer_unaccepted');
 const resource=verifyComputerResource(directory,accepted.activePointer.manifestSha256,platform,arch);
 if(resource.manifest.files[resource.manifest.binary].sha256!==accepted.executableSha256)throw Error('harness_package_computer_unaccepted');
 assertNoPersonalBuildPaths(readFileSync(resource.executable));
 return resource;
}

export function admitRefreshedLinuxSidecar(accepted, sidecar=LINUX_REFRESHED_SIDECAR){
 const candidatePath=`${sidecar.directory}/${sidecar.candidate}`;
 if(accepted?.schema!=='uptokey.harness-linux-sidecar-refresh.v1'||accepted.result!=='accepted_private_sidecar'
   ||accepted.platform!=='linux-x64'||accepted.candidatePath!==candidatePath
   ||! /^[a-f0-9]{64}$/.test(accepted.manifestSha256||'')
   ||accepted.core?.version!=='0.1.0-beta.22'||accepted.node?.version!=='24.21.0'||accepted.node?.abi!==137
   ||accepted.computer?.resourceManifestSha256!==sidecar.computerManifestSha256
   ||accepted.verification?.prepareExitCode!==0||accepted.verification?.preparedSidecarCheck!=='passed'
   ||accepted.scope?.tauriDesktopPackageBuilt!==false||accepted.scope?.installed!==false
   ||accepted.scope?.runtimeStarted!==false||accepted.scope?.personalCoreTouched!==false
   ||accepted.scope?.vaultTouched!==false||accepted.scope?.productionChanged!==false){
  throw Error('harness_linux_sidecar_receipt_invalid');
 }
 return Object.freeze({path:candidatePath,manifestSha256:accepted.manifestSha256});
}

/** Called only after the exact RUNTIME.json bytes pass WINDOWS_RUNTIME_RECEIPT.
 * That sealed package was produced through the original strict prefetch reader;
 * this assertion retains its exact source/image/archive chain, with no override.
 */
export function assertWindowsRuntimeAcceptance(runtime){
 const scope=runtime?.scope,privateFlags=['personalVolumesIncluded','credentialsIncluded','containerActivation','installedBootstrapIntegrated','loadAcceptance','completeInstaller'];
 if(runtime?.schema!=='uptokey.harness.runtime-package.v1'||runtime.image!==WINDOWS_RUNTIME_IMAGE
  ||runtime.sourceAcceptanceSha256!==WINDOWS_RUNTIME_SOURCE
  ||runtime.sourceAcceptance?.path!=='output/initial-prefetch-20261030/CANDIDATE.json'
  ||runtime.sourceAcceptance.kind!=='model-catalog-initial-prefetch'||runtime.sourceAcceptance.interactiveUiAccepted!==false
  ||runtime.sourceImageUnchanged!==true||runtime.archive?.file!=='runtime.oci.tar'
  ||runtime.archive.bytes!==WINDOWS_RUNTIME_ARCHIVE.bytes||runtime.archive.sha256!==WINDOWS_RUNTIME_ARCHIVE.sha256
  ||runtime.verified?.schema!=='uptokey.harness.oci.verified.v1'||runtime.verified.imageId!==`sha256:${WINDOWS_RUNTIME_IMAGE}`
  ||runtime.verified.os!=='linux'||runtime.verified.architecture!=='amd64'
  ||!scope||Object.keys(scope).length!==privateFlags.length+1||scope.immutableImageOnly!==true||privateFlags.some(field=>scope[field]!==false)){
  throw Error('harness_package_runtime_unaccepted');
 }
 return runtime.image;
}

function freezeInputs(value){
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezeInputs(child);Object.freeze(value);}
 return value;
}
function sourceRecord(path){checked(path);return {size_bytes:lstatSync(path).size,sha256:sha256File(path)};}
function insideRoot(root,path,directory=false){
 checked(path,directory);const rel=relative(root,path);
 if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw Error('harness_package_component_path_invalid');
 return path;
}
function verifyRecord(root,path,record){
 insideRoot(root,path);
 if(!record||!Number.isSafeInteger(record.size_bytes)||record.size_bytes<=0||!/^[a-f0-9]{64}$/.test(record.sha256??'')
  ||lstatSync(path).size!==record.size_bytes||sha256File(path)!==record.sha256)throw Error('harness_package_component_changed');
}

/** Byte consistency only, NOT provenance/functional admission. This read-only
 * verifier cannot stage a candidate or authorize arbitrary receipts. Only the
 * private wrapper below currently supplies admitted inputs to the assembler.
 */
export function verifyHarnessAssemblyInputs(inputs){
 const fields=['root','platform','arch','base','runtime','computer','publicFiles','corePromotion','admissionEvidence'];
 if(!inputs||Object.keys(inputs).sort().join(',')!==fields.sort().join(',')
  ||inputs.platform!==process.platform||inputs.arch!==process.arch
  ||!['win32-x64','linux-x64','darwin-x64','darwin-arm64'].includes(`${inputs.platform}-${inputs.arch}`))throw Error('harness_package_components_invalid');
 const root=checked(inputs.root,true),source=insideRoot(root,inputs.base.directory,true),sourceManifest=join(source,'manifest.json');
 if(!/^[a-f0-9]{64}$/.test(inputs.base.manifestSha256??'')||sha256File(checked(sourceManifest))!==inputs.base.manifestSha256)throw Error('harness_package_sidecar_changed');
 const manifest=JSON.parse(readFileSync(sourceManifest,'utf8'));
 if(manifest.schema_version!==2||manifest.runtime!=='node'||manifest.build_version!=='0.1.0-beta.22'||manifest.target!==inputs.platform||manifest.harness)throw Error('harness_package_sidecar_invalid');
 verifySidecar(source,inputs.platform,inputs.arch);
 const computerDirectory=insideRoot(root,inputs.computer.directory,true);
 const computer=verifyComputerResource(computerDirectory,inputs.computer.manifestSha256,inputs.platform,inputs.arch);
 if(computer.manifest.files[computer.manifest.binary].sha256!==inputs.computer.binarySha256)throw Error('harness_package_computer_binary_changed');
 if(inputs.platform==='win32')assertNoPersonalBuildPaths(readFileSync(computer.executable));
 const runtimeDirectory=insideRoot(root,inputs.runtime.directory,true),runtimeReceipt=join(runtimeDirectory,'RUNTIME.json');
 const runtime=receipt(runtimeReceipt,inputs.runtime.receiptSha256);
 if(runtime?.schema!=='uptokey.harness.runtime-package.v1'||!/^[a-f0-9]{64}$/.test(runtime.image??'')
  ||runtime.archive?.file!=='runtime.oci.tar'||runtime.verified?.imageId!==`sha256:${runtime.image}`
  ||runtime.verified.os!=='linux'||runtime.verified.architecture!=='amd64'
  ||runtime.scope?.immutableImageOnly!==true||runtime.scope.personalVolumesIncluded!==false
  ||['credentialsIncluded','containerActivation','installedBootstrapIntegrated','loadAcceptance','completeInstaller'].some(name=>runtime.scope[name]===true))throw Error('harness_package_runtime_unaccepted');
 verifyRecord(root,join(runtimeDirectory,runtime.archive.file),{size_bytes:runtime.archive.bytes,sha256:runtime.archive.sha256});
 const canonicalPublic=collectHarnessPortableFiles(root,{installedSidecar:true});
 if(!Array.isArray(inputs.publicFiles)||inputs.publicFiles.length!==canonicalPublic.length
  ||JSON.stringify(inputs.publicFiles.map(f=>f.path).sort())!==JSON.stringify(canonicalPublic.map(f=>f.path).sort()))throw Error('harness_package_public_sources_changed');
 const publicByName=new Map(canonicalPublic.map(f=>[f.path,f.source]));
 for(const entry of inputs.publicFiles){
  if(entry.source!==publicByName.get(entry.path))throw Error('harness_package_public_sources_changed');
  verifyRecord(root,entry.source,entry.record);
 }
 if(!Array.isArray(inputs.admissionEvidence)||!inputs.admissionEvidence.length)throw Error('harness_package_components_invalid');
 for(const evidence of inputs.admissionEvidence)verifyRecord(root,evidence.path,evidence.record);
 if(inputs.corePromotion){
  if(inputs.platform!=='win32'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(inputs.corePromotion.version??'')
   ||JSON.stringify(Object.keys(inputs.corePromotion.files??{}).sort())!==JSON.stringify([...PROMOTED_CORE_FILES].sort()))throw Error('harness_package_core_files_missing');
  for(const [name,entry] of Object.entries(inputs.corePromotion.files??{})){
   if(!validName(name)||!manifest.files[name])throw Error('harness_package_core_files_missing');
   verifyRecord(root,entry.source,entry.record);assertNoPersonalBuildPaths(readFileSync(entry.source));
  }
 }
 return {manifest,computer,runtime,provenanceAdmitted:false};
}

export function prepareHarnessSidecar(destination){
 destination=resolve(destination);validateAcceptedOutput(destination,ROOT);
 let source, sourceManifest, accepted, sidecar;
 if(process.platform==='darwin' && ['x64','arm64'].includes(process.arch)){
  const directory=`${LAB}/output/macos-sidecar-20261027/${process.arch}`;
  source=checked(join(ROOT,directory),true);
  sourceManifest=join(source,'manifest.json');
  const proof=verifyMacosPreparedSidecar(source,ROOT,process.env.UPTOKEY_APPLE_TEAM_ID);
  accepted={candidate:{manifestSha256:proof.manifestSha256}};
  sidecar={directory,receipt:'manifest.json',sha256:proof.manifestSha256};
 }else if(process.platform==='linux'&&process.arch==='x64'){
  sidecar=LINUX_REFRESHED_SIDECAR;
  const proof=receipt(join(ROOT,sidecar.directory,sidecar.receipt),sidecar.sha256);
  const admitted=admitRefreshedLinuxSidecar(proof,sidecar);
  accepted={candidate:admitted};
  source=checked(join(ROOT,admitted.path),true);sourceManifest=join(source,'manifest.json');
 }else{
  sidecar=SIDECARS[`${process.platform}-${process.arch}`];
  if(!sidecar)throw Error('harness_package_sidecar_unaccepted');
  accepted=receipt(join(ROOT,sidecar.directory,sidecar.receipt),sidecar.sha256);
  if(accepted.state!==sidecar.state||accepted.candidate.path!==`${sidecar.directory}/${sidecar.candidate}`)throw Error('harness_package_sidecar_unaccepted');
  source=checked(join(ROOT,accepted.candidate.path),true);sourceManifest=join(source,'manifest.json');
 }
 if(sha256File(sourceManifest)!==accepted.candidate.manifestSha256)throw Error('harness_package_sidecar_changed');
 const manifest=JSON.parse(readFileSync(sourceManifest,'utf8'));
 if(manifest.schema_version!==2||manifest.runtime!=='node'||manifest.build_version!=='0.1.0-beta.22'||manifest.target!==process.platform||!['x64','arm64'].includes(process.arch)||(process.platform!=='darwin'&&process.arch!=='x64')||manifest.harness)throw Error('harness_package_sidecar_invalid');
 const corePromotion=process.platform==='win32'?readWindowsCorePromotion(ROOT):null;
 const runtimeDirectory=corePromotion?WINDOWS_RUNTIME:RUNTIME,runtimeReceiptSha=corePromotion?WINDOWS_RUNTIME_RECEIPT:RUNTIME_RECEIPT;
 const runtime=receipt(join(ROOT,runtimeDirectory,'RUNTIME.json'),runtimeReceiptSha);
 if(runtime.schema!=='uptokey.harness.runtime-package.v1'||runtime.archive.file!=='runtime.oci.tar'||runtime.verified.imageId!==`sha256:${runtime.image}`||runtime.verified.os!=='linux'||runtime.verified.architecture!=='amd64'||runtime.scope.immutableImageOnly!==true||runtime.scope.personalVolumesIncluded!==false)throw Error('harness_package_runtime_unaccepted');
 if(corePromotion)assertWindowsRuntimeAcceptance(runtime);
 const acceptedComputer=selectHarnessComputerResource(source,manifest.computerMcp.resourceManifestSha256);
 const publicFiles=collectHarnessPortableFiles(ROOT,{installedSidecar:true});
 const evidence=[{path:join(ROOT,sidecar.directory,sidecar.receipt),record:sourceRecord(join(ROOT,sidecar.directory,sidecar.receipt))}];
 if(corePromotion)evidence.push({path:join(ROOT,corePromotion.sourceReceipt.path),record:sourceRecord(join(ROOT,corePromotion.sourceReceipt.path))});
 const components=freezeInputs({root:ROOT,platform:process.platform,arch:process.arch,
  base:{directory:source,manifestSha256:accepted.candidate.manifestSha256,sourceReceipt:{path:`${sidecar.directory}/${sidecar.receipt}`,sha256:sidecar.sha256}},
  runtime:{directory:join(ROOT,runtimeDirectory),receiptSha256:runtimeReceiptSha},
  computer:{directory:acceptedComputer.directory,manifestSha256:acceptedComputer.manifestSha256,binarySha256:acceptedComputer.manifest.files[acceptedComputer.manifest.binary].sha256},
  publicFiles:publicFiles.map(entry=>({...entry,record:sourceRecord(entry.source)})),corePromotion,admissionEvidence:evidence});
 // The selection and authority remain here; byte checks in the assembler do
 // not replace any pinned receipt, macOS signature, or functional admission.
 return assembleHarnessComponents(destination,components,()=>{if(corePromotion)readWindowsCorePromotion(ROOT);});
}

// One assembly implementation, deliberately not exported as a new admission
// surface. A future public producer still needs an independent trusted admission
// adapter; arbitrary caller-selected hashes/receipts are not that authority.
function assembleHarnessComponents(destination,components,revalidateAdmission){
 const {root,platform,base,runtime:runtimeInput,publicFiles,corePromotion}=components;
 destination=resolve(destination);validateAcceptedOutput(destination,root);
 const {manifest,computer:acceptedComputer,runtime}=verifyHarnessAssemblyInputs(components);
 const source=base.directory,runtimeDirectory=runtimeInput.directory,runtimeReceiptSha=runtimeInput.receiptSha256;
 const protectedDirectories=[root,source,runtimeDirectory,acceptedComputer.directory];
 const staging=createStagingOutput(destination,protectedDirectories),files={};
 if(platform==='linux'){
  // The accepted Linux sidecar is mounted read-only while the fresh candidate
  // lives on a separate writable volume. Copy it in one native operation to
  // avoid spawning a process per file and to avoid copy_file_range mount errors.
  const result=spawnSync('/bin/cp',['-a','--no-preserve=ownership','--reflink=never','--',`${source}/.`,staging],{encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:4096,stdio:'ignore'});
  if(result.error||result.status!==0)throw Error('harness_package_copy_failed');
  unlinkSync(join(staging,'manifest.json'));
 }
 const add=(from,name,record)=>{
  if(!validName(name)||files[name]||name==='manifest.json')throw Error('harness_package_file_invalid');
  const target=join(staging,...name.split('/'));mkdirSync(dirname(target),{recursive:true});
  let bytes;
  if(existsSync(target)){
   // Linux pre-copies the signed source tree in one operation. The final
   // manifest verifier below rehashes every byte, so avoid a second 10k-file
   // metadata walk over a remote/read-only bind mount here.
   const copied=lstatSync(target);if(!copied.isFile()||copied.isSymbolicLink())throw Error('harness_package_copy_changed');
   bytes=copied.size;if(record&&bytes!==record.size_bytes)throw Error('harness_package_copy_changed');
  }else{
   checked(from);bytes=lstatSync(from).size;
   if(record&&bytes!==record.size_bytes)throw Error('harness_package_source_changed');
   copyAcceptedFile(from,target);
  }
  files[name]=record??{size_bytes:bytes,sha256:sha256File(target)};
 };
 // Copy only attested source files. The existing verifier checks every copied
 // byte plus unexpected files before this candidate can be published.
 for(const [name,record] of Object.entries(manifest.files)){
  if(!validName(name)||!Number.isSafeInteger(record.size_bytes)||record.size_bytes<=0||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error('harness_package_manifest_invalid');
  const promoted=corePromotion?.files[name];
  add(promoted?.source??join(source,...name.split('/')),name,promoted?.record??record);
 }
 if(corePromotion&&Object.keys(corePromotion.files).some(name=>!files[name]))throw Error('harness_package_core_files_missing');
 // Reuse the accepted native backend, but attest today's canonical JS closure.
 // Otherwise a fresh package silently retains helpers from the old receipt.
 const refreshed=stageComputerResource(staging,acceptedComputer.executable);
 const resource=verifyComputerResource(staging,refreshed.manifestSha256);
 if(resource.manifest.files[resource.manifest.binary].sha256!==acceptedComputer.manifest.files[acceptedComputer.manifest.binary].sha256)throw Error('harness_package_computer_binary_changed');
 for(const name of [...Object.keys(resource.manifest.files),'computer-resource.json']){
  const path=join(staging,name);files[name]={size_bytes:lstatSync(path).size,sha256:sha256File(path)};
 }
 for(const entry of publicFiles)add(entry.source,`harness/${entry.path}`,entry.record);
 const computerDirectory=`computer-resource-${resource.manifestSha256}`;
 const local=`harness/${LAB}/.local`;
 for(const [name,record] of Object.entries(resource.manifest.files))add(join(resource.directory,name),`${local}/computer-resources/${computerDirectory}/${name}`,{sha256:record.sha256,size_bytes:record.size});
 add(join(resource.directory,'computer-resource.json'),`${local}/computer-resources/${computerDirectory}/computer-resource.json`);
 const pointer=`${local}/computer-resource-current.json`,pointerPath=join(staging,pointer);
 writeFileSync(pointerPath,JSON.stringify({schema:'uptokey.computer.resource.pointer.v1',directory:computerDirectory,manifestSha256:resource.manifestSha256})+'\n',{flag:'wx'});
 files[pointer]={size_bytes:lstatSync(pointerPath).size,sha256:sha256File(pointerPath)};
 const archive='harness/runtime/harness.oci.tar',runtimeReceipt='harness/runtime/harness-runtime.json';
 add(join(runtimeDirectory,runtime.archive.file),archive,{size_bytes:runtime.archive.bytes,sha256:runtime.archive.sha256});
 add(join(runtimeDirectory,'RUNTIME.json'),runtimeReceipt);
 const assembled={...manifest,build_version:corePromotion?.version??manifest.build_version,computerMcp:{...manifest.computerMcp,resourceManifestSha256:resource.manifestSha256},files,harness:{schema_version:1,resourceRoot:'harness',lab:`harness/${LAB}`,sidecarManifest:'manifest.json',publicSourceFiles:publicFiles.length,computerPointer:pointer,runtime:{archive,receipt:runtimeReceipt,receiptSha256:runtimeReceiptSha,imageId:runtime.image,os:'linux',architecture:'amd64'},scope:{installedEntry:false,imageImported:false,personalStateIncluded:false,secondNode:false,secondCore:false},sourceReceipt:base.sourceReceipt,...(corePromotion?{coreSourceReceipt:corePromotion.sourceReceipt}:{})}};
 writeFileSync(join(staging,'manifest.json'),JSON.stringify(assembled,null,2)+'\n',{flag:'wx'});
 console.log('Verifying the new assembled sidecar, including copied OCI bytes; no image import.');
 const verified=verifyHarnessPayload(staging);
 verifyHarnessAssemblyInputs(components);revalidateAdmission();
 validateAcceptedOutput(destination,root);publishStagingOutput(staging,destination,protectedDirectories);
 return {directory:destination,manifestSha256:sha256File(join(destination,'manifest.json')),fileCount:verified.files,bytes:Object.values(files).reduce((n,f)=>n+f.size_bytes,0),version:verified.version,harness:assembled.harness};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3)throw Error('harness_package_output_required');console.log(JSON.stringify(prepareHarnessSidecar(process.argv[2])));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
