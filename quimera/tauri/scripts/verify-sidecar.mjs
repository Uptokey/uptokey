#!/usr/bin/env node
// Build-time verification of the prepared sidecar. The supervisor performs its own check.
// Supports manifest schema 1 (single compiled binary) and schema 2 (Node runtime with
// every file attested by sha256 + size).
import {readFileSync, lstatSync, openSync, readSync, closeSync, readdirSync} from 'node:fs';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateComputerAttestation} from './computer-runtime-contract.mjs';

const SEMVER=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEX64=/^[a-f0-9]{64}$/;

export function sha256File(path) {
  const hash=createHash('sha256'), buffer=Buffer.allocUnsafe(64*1024), fd=openSync(path,'r');
  try { for(let size;(size=readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,size)); }
  finally {closeSync(fd);}
  return hash.digest('hex');
}

function safeRelName(name){
  if(typeof name!=='string'||name.length===0||name.length>1024||name.includes('\0')||name.includes('\\'))return false;
  if(name.startsWith('/')||/^[A-Za-z]:/.test(name))return false;
  return name.split('/').every(seg=>seg.length>0&&seg!=='.'&&seg!=='..');
}

function verifyFile(outDir, rel, sha256, sizeBytes){
  const target=join(outDir, rel);
  let parent=outDir;
  for(const part of rel.split('/').slice(0,-1)) {
    parent=join(parent,part);
    let dir;try{dir=lstatSync(parent);}catch{throw Error(`file_missing:${rel}`);}
    if(!dir.isDirectory()||dir.isSymbolicLink())throw Error(`file_invalid:${rel}`);
  }
  let info;
  try{info=lstatSync(target);}catch{throw new Error(`file_missing:${rel}`);}
  if(!info.isFile()||info.isSymbolicLink())throw new Error(`file_invalid:${rel}`);
  if(info.size!==sizeBytes)throw new Error(`file_size_mismatch:${rel}`);
  const actual=sha256File(target);
  if(actual!==sha256)throw new Error(`file_hash_mismatch:${rel}`);
}

export function verifySidecar(directory, platform=process.platform, arch=process.arch) {
  const outDir=resolve(directory);
  const manifestPath=join(outDir,'manifest.json');
  let manifest;
  try {
    if(!lstatSync(outDir).isDirectory() || lstatSync(outDir).isSymbolicLink() || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink())throw Error();
    manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  } catch {throw new Error('manifest_unavailable');}
  if(!manifest || typeof manifest.schema_version!=='number')throw new Error('manifest_schema_invalid');
  const legacyName=platform==='win32'?'uptokey-windows.exe':'uptokey';
  const nestedPrefix='UptokeyCore.app/Contents/MacOS/';
  const nested=platform==='darwin'&&manifest.schema_version===2&&manifest.binary_name===nestedPrefix+'uptokey';
  const binaryName=nested?manifest.binary_name:legacyName;
  if(manifest.binary_name!==binaryName)throw new Error('manifest_schema_invalid');
  if(manifest.target!==platform)throw new Error('manifest_schema_invalid');
  if(typeof manifest.build_version!=='string'||!SEMVER.test(manifest.build_version))throw new Error('manifest_schema_invalid');
  if(manifest.schema_version===1){
    if(typeof manifest.sha256!=='string'||!HEX64.test(manifest.sha256)||!Number.isSafeInteger(manifest.size_bytes)||manifest.size_bytes<=0)throw new Error('manifest_schema_invalid');
    const target=join(outDir, manifest.binary_name);
    let info;
    try{info=lstatSync(target);}catch{throw new Error('binary_missing');}
    if(!info.isFile()||info.isSymbolicLink())throw new Error('binary_invalid');
    if(info.size!==manifest.size_bytes)throw new Error('binary_size_mismatch');
    const actual=sha256File(target);
    if(actual!==manifest.sha256)throw new Error('binary_hash_mismatch');
    return {binary:manifest.binary_name,bytes:manifest.size_bytes,version:manifest.build_version,sha256:manifest.sha256};
  }
  if(manifest.schema_version===2){
    if(manifest.runtime!=='node'||typeof manifest.entry!=='string'||!safeRelName(manifest.entry))throw new Error('manifest_schema_invalid');
    if(manifest.worker!==undefined&&(typeof manifest.worker!=='string'||!safeRelName(manifest.worker)))throw new Error('manifest_schema_invalid');
    if(manifest.serviceSchemaWorker!==undefined&&manifest.serviceSchemaWorker!==(nested?nestedPrefix+'service-schema-worker.js':'service-schema-worker.js'))throw new Error('manifest_schema_invalid');
    if(!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('manifest_schema_invalid');
    const names=Object.keys(manifest.files);
    if(names.length===0)throw new Error('manifest_schema_invalid');
    if(nested&&(manifest.entry!==nestedPrefix+'cli.js'||manifest.worker!==nestedPrefix+'composition-worker.js'
      ||manifest.serviceSchemaWorker!==nestedPrefix+'service-schema-worker.js'
      ||[nestedPrefix+'workspace-context-helper.js',nestedPrefix+'uptokey-macos-protected-keyring.node',
        'UptokeyCore.app/Contents/Info.plist','UptokeyCore.app/Contents/embedded.provisionprofile',
        'UptokeyCore.app/Contents/_CodeSignature/CodeResources'].some(name=>!names.includes(name))))throw new Error('manifest_schema_invalid');
    let runtimeBytes=0;
    for(const name of names){
      if(!safeRelName(name))throw new Error('manifest_schema_invalid');
      const entry=manifest.files[name];
      if(!entry||typeof entry.sha256!=='string'||!HEX64.test(entry.sha256)||!Number.isSafeInteger(entry.size_bytes)||entry.size_bytes<=0)throw new Error('manifest_schema_invalid');
      verifyFile(outDir, name, entry.sha256, entry.size_bytes);
      if(name===binaryName)runtimeBytes=entry.size_bytes;
    }
    if(!names.includes(manifest.entry))throw new Error('manifest_schema_invalid');
    if(!names.includes(binaryName))throw new Error('manifest_schema_invalid');
    if(manifest.worker!==undefined&&!names.includes(manifest.worker))throw new Error('manifest_schema_invalid');
    if(manifest.serviceSchemaWorker!==undefined&&!names.includes(manifest.serviceSchemaWorker))throw new Error('manifest_schema_invalid');
    validateComputerAttestation(manifest,platform,arch);
    const attested=new Set(names);
    function checkContents(dir,prefix='') {
      for(const item of readdirSync(dir,{withFileTypes:true})) {
        const name=prefix+item.name;
        if(item.isSymbolicLink())throw Error(`file_invalid:${name}`);
        if(item.isDirectory())checkContents(join(dir,item.name),name+'/');
        else if(!item.isFile()||(name!=='manifest.json'&&!attested.has(name)))throw Error(`file_unattested:${name}`);
      }
    }
    checkContents(outDir);
    return {binary:binaryName,bytes:runtimeBytes,version:manifest.build_version,sha256:manifest.files[binaryName].sha256,files:names.length,runtime:'node'};
  }
  throw new Error('manifest_schema_unsupported');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const directory=process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)),'..','resources','sidecar');
    const result=verifySidecar(directory);
    console.log(`Sidecar verification succeeded (${result.binary}, ${result.bytes} bytes)`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
