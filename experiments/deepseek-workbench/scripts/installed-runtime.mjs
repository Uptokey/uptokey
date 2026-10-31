// Consume the existing schema-2 native admission and accepted OCI receipt.
// This module never starts a container, changes a tag, or accesses a vault.
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,resolve,toNamespacedPath} from 'node:path';
import {installedSidecarManifest,sidecarManifestLocation} from './product-contract.mjs';
import {sha256File} from '../../../quimera/tauri/scripts/verify-sidecar.mjs';

const ARCHIVE='harness/runtime/harness.oci.tar';
const RECEIPT='harness/runtime/harness-runtime.json';
const HEX=/^[a-f0-9]{64}$/;
const fail=()=>{throw Error('installed_runtime_unverified')};

function admittedFile(root,name,entry,{hash=true}={}){
 if(!entry||!Number.isSafeInteger(entry.size_bytes)||!HEX.test(entry.sha256??''))fail();
 const path=resolve(root,name);
 for(let at=path;;at=dirname(at)){
  const meta=lstatSync(at);
  if(meta.isSymbolicLink()||toNamespacedPath(realpathSync.native(at))!==toNamespacedPath(at))fail();
  if(at===root)break;
  if(at===dirname(at))fail();
 }
 const meta=lstatSync(path);
 if(!meta.isFile()||meta.size!==entry.size_bytes||(hash&&sha256File(path)!==entry.sha256))fail();
 return path;
}

export function installedRuntime(nodePath=process.execPath,platform=process.platform){
 if(!['uptokey','uptokey-windows.exe'].includes(basename(nodePath)))return null;
 const manifestPath=installedSidecarManifest(sidecarManifestLocation(nodePath,platform),nodePath,platform);
 const root=dirname(manifestPath),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 const runtime=manifest.harness?.runtime;
 if(manifest.schema_version!==2||runtime?.archive!==ARCHIVE||runtime.receipt!==RECEIPT
   ||!HEX.test(runtime.imageId??'')||runtime.os!=='linux'||runtime.architecture!=='amd64')fail();
 const receiptPath=admittedFile(root,RECEIPT,manifest.files?.[RECEIPT]);
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8')),archive=manifest.files?.[ARCHIVE];
 if(receipt.schema!=='uptokey.harness.runtime-package.v1'||receipt.image!==runtime.imageId
   ||receipt.verified?.imageId!==`sha256:${runtime.imageId}`||receipt.verified.os!==runtime.os||receipt.verified.architecture!==runtime.architecture
   ||receipt.archive?.sha256!==archive?.sha256||receipt.archive?.bytes!==archive?.size_bytes
   ||manifest.files[RECEIPT].sha256!==runtime.receiptSha256)fail();
 const archivePath=admittedFile(root,ARCHIVE,archive,{hash:false});
 return {image:runtime.imageId,os:runtime.os,architecture:runtime.architecture,archivePath,
  verifyArchive:()=>admittedFile(root,ARCHIVE,archive)};
}

/** The caller supplies the existing Podman transport, never a second engine.
 * Missing image: verify the exact accepted archive immediately before load.
 * Existing image: inspect identity, skip archive scan and import entirely. */
export function ensureInstalledRuntime({exists,run,nodePath=process.execPath}){
 const runtime=installedRuntime(nodePath);if(!runtime)return null;
 let imported=false;
 if(!exists('image',runtime.image)){
  runtime.verifyArchive();
  run(['load','--input',runtime.archivePath]);imported=true;
 }
 const values=JSON.parse(run(['image','inspect',runtime.image]));
 if(values.length!==1||values[0].Id?.replace(/^sha256:/,'')!==runtime.image
   ||values[0].Os!==runtime.os||values[0].Architecture!==runtime.architecture)fail();
 return {image:runtime.image,imported};
}
