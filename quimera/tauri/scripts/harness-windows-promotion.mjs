import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,toNamespacedPath} from 'node:path';
import {sha256File} from './verify-sidecar.mjs';
import {assertNoPersonalBuildPaths} from './release-cargo.mjs';

export const WINDOWS_CORE_PROMOTION=Object.freeze({
 receipt:'output/native-toolset-20261029/CORE-ACTIVATION.json',
 sha256:'a97ccbbd6b71e1d5c7d87738fa3bbce264d0f0c1a6d25de107a37d7a005573b9',
 directory:'output/native-toolset-20261029/core-beta25-build',version:'0.1.0-beta.25',
});
export const PROMOTED_CORE_FILES=Object.freeze(['BUILD_INFO.json','cli.js','composition-worker.js','service-schema-worker.js','THIRD-PARTY-NOTICES.md','workspace-context-helper.js']);
function plainFile(file,max=32*1024*1024){
 for(let at=file;;at=dirname(at)){
  if(lstatSync(at).isSymbolicLink()||toNamespacedPath(realpathSync.native(at))!==toNamespacedPath(at))throw Error('harness_core_promotion_redirected');
  if(dirname(at)===at)break;
 }
 const stat=lstatSync(file);
 if(!stat.isFile()||stat.nlink!==1||stat.size<=0||stat.size>max)throw Error('harness_core_promotion_file_invalid');
 return stat;
}
export function validateWindowsCorePromotion(root,proof,pin=WINDOWS_CORE_PROMOTION){
 if(proof?.state!=='activated_beta25_health_verified'||proof.version!==pin.version
   ||proof.gracefulStopRoute!=='/local/update/authorize-stop'||proof.providerSecretsRead!==false
   ||proof.credentialsExported!==false||proof.profileMoved!==false||proof.dependenciesChanged!==false
   ||proof.rollbackAvailable!==true||!Array.isArray(proof.files)||proof.files.length!==PROMOTED_CORE_FILES.length
   ||JSON.stringify(proof.files.map(f=>f.name).sort())!==JSON.stringify([...PROMOTED_CORE_FILES].sort()))throw Error('harness_core_promotion_unaccepted');
 const files={};
 for(const row of proof.files){
  if(!/^[a-f0-9]{64}$/.test(row.sha256??'')||row.previouslyPresent!==true)throw Error('harness_core_promotion_unaccepted');
  const source=join(root,pin.directory,row.name),stat=plainFile(source);
  if(sha256File(source)!==row.sha256)throw Error('harness_core_promotion_changed');
  assertNoPersonalBuildPaths(readFileSync(source));
  files[row.name]={source,record:{size_bytes:stat.size,sha256:row.sha256}};
 }
 const info=JSON.parse(readFileSync(files['BUILD_INFO.json'].source,'utf8'));
 if(info.version!==pin.version||info.target!=='node'||info.entry!=='src/cli.ts'
   ||info.compositionWorker!=='composition-worker.js'||info.serviceSchemaWorker!=='service-schema-worker.js'
   ||info.contextHelper?.entry!=='workspace-context-helper.js'||info.thirdPartyNotices!=='THIRD-PARTY-NOTICES.md'
   ||files['cli.js'].record.sha256!==proof.cliSha256)throw Error('harness_core_promotion_unaccepted');
 return {version:pin.version,files,sourceReceipt:{path:pin.receipt,sha256:pin.sha256}};
}
export function readWindowsCorePromotion(root){
 const file=join(root,WINDOWS_CORE_PROMOTION.receipt);plainFile(file,64*1024);
 if(sha256File(file)!==WINDOWS_CORE_PROMOTION.sha256)throw Error('harness_core_promotion_receipt_changed');
 return validateWindowsCorePromotion(root,JSON.parse(readFileSync(file,'utf8')));
}
