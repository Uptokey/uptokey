import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,linkSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateWindowsCorePromotion,PROMOTED_CORE_FILES} from './harness-windows-promotion.mjs';
const output=fileURLToPath(new URL('../../../output/',import.meta.url));
function fixture(t){
 mkdirSync(output,{recursive:true});const root=mkdtempSync(join(output,'core-promotion-test-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(output));rmSync(root,{recursive:true,force:true});});
 const pin={directory:'candidate',version:'0.1.0-beta.25',receipt:'proof.json',sha256:'a'.repeat(64)};
 mkdirSync(join(root,'candidate'));
 const info={version:pin.version,target:'node',entry:'src/cli.ts',compositionWorker:'composition-worker.js',serviceSchemaWorker:'service-schema-worker.js',contextHelper:{entry:'workspace-context-helper.js'},thirdPartyNotices:'THIRD-PARTY-NOTICES.md'};
 const files=PROMOTED_CORE_FILES.map(name=>{const bytes=name==='BUILD_INFO.json'?JSON.stringify(info):'public synthetic artifact '+name;writeFileSync(join(root,pin.directory,name),bytes);return {name,sha256:createHash('sha256').update(bytes).digest('hex'),previouslyPresent:true};});
 const proof={state:'activated_beta25_health_verified',version:pin.version,gracefulStopRoute:'/local/update/authorize-stop',providerSecretsRead:false,credentialsExported:false,profileMoved:false,dependenciesChanged:false,rollbackAvailable:true,files,cliSha256:files.find(f=>f.name==='cli.js').sha256};
 return {root,pin,proof};
}
test('core promotion admits only exact artifact bytes and preserves health, rollback and dependency guarantees',t=>{
 const {root,pin,proof}=fixture(t);
 assert.equal(validateWindowsCorePromotion(root,proof,pin).version,pin.version);
 for(const patch of [{rollbackAvailable:false},{credentialsExported:true},{dependenciesChanged:true},{version:'0.1.0-beta.22'},{files:[...proof.files.slice(1),proof.files[1]]}])assert.throws(()=>validateWindowsCorePromotion(root,{...proof,...patch},pin),/promotion_unaccepted/);
 writeFileSync(join(root,pin.directory,'cli.js'),'corrupt replacement');
 assert.throws(()=>validateWindowsCorePromotion(root,proof,pin),/promotion_changed/);
});
test('a linked artifact cannot transfer later changes into a published candidate',t=>{
 const {root,pin,proof}=fixture(t),file=join(root,pin.directory,'cli.js');
 linkSync(file,join(root,'linked-cli.js'));
 assert.throws(()=>validateWindowsCorePromotion(root,proof,pin),/promotion_file_invalid/);
});
test('a correctly hashed BUILD_INFO for another version cannot masquerade as the accepted core',t=>{
 const {root,pin,proof}=fixture(t),file=join(root,pin.directory,'BUILD_INFO.json');
 const info=JSON.parse(readFileSync(file));info.version='0.1.0-beta.22';const bytes=JSON.stringify(info);writeFileSync(file,bytes);
 proof.files.find(f=>f.name==='BUILD_INFO.json').sha256=createHash('sha256').update(bytes).digest('hex');
 assert.throws(()=>validateWindowsCorePromotion(root,proof,pin),/promotion_unaccepted/);
});
