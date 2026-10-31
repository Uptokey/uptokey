import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,rename,stat} from 'node:fs/promises';
import {dirname,isAbsolute,parse,relative,resolve,sep} from 'node:path';

export const LEGACY_RECOVERY_PLAN_SCHEMA='uptokey-legacy-session-recovery-plan-v1';
const sha=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value);
const inside=(parent,child)=>{const rel=relative(parent,child);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
const normalized=path=>path.split(sep).join('/');

async function syncDirectory(path){
 if(process.platform==='win32')return;
 const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);
 try{await handle.sync();}finally{await handle.close();}
}

async function scan(root){
 const base=resolve(root),rootStat=await lstat(base);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('legacy_recovery_root_invalid');
 const entries=[];
 async function visit(path){
  const directory=await readdir(path,{withFileTypes:true});
  for(const entry of directory){
   const child=resolve(path,entry.name),rel=normalized(relative(base,child));
   if(!inside(base,child)||!rel)throw Error('legacy_recovery_path_escape');
   const info=await lstat(child);
   if(info.isSymbolicLink())throw Error('legacy_recovery_symlink_refused');
   if(info.isDirectory()){
    if(process.platform!=='win32'&&(info.mode&0o077))throw Error('legacy_recovery_directory_permissions');
    entries.push({kind:'directory',path:rel,mode:info.mode&0o777});
    await visit(child);
   }else if(info.isFile()){
    if(process.platform!=='win32'&&(info.mode&0o077))throw Error('legacy_recovery_file_permissions');
    const handle=await open(child,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
     const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);
     let position=0;
     for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
     entries.push({kind:'file',path:rel,mode:info.mode&0o777,size:info.size,sha256:hash.digest('hex')});
    }finally{await handle.close();}
   }else throw Error('legacy_recovery_special_file_refused');
  }
 }
 await visit(base);
 entries.sort((a,b)=>a.path.localeCompare(b.path)||a.kind.localeCompare(b.kind));
 return {entries,digest:sha(stable(entries)),device:String(rootStat.dev)};
}

function validateParity(parity){
 if(!parity||parity.verified!==true||!Number.isSafeInteger(parity.sessionCount)||parity.sessionCount<0||!/^[a-f0-9]{64}$/.test(parity.digest))throw Error('legacy_recovery_parity_required');
 return {verified:true,sessionCount:parity.sessionCount,digest:parity.digest};
}

function planDigest(plan){
 const {planSha256:_,...unsigned}=plan;
 return sha(stable(unsigned));
}

export async function createLegacyRecoveryPlan({legacyRoot,quarantineRoot,parity}){
 const source=resolve(legacyRoot),target=resolve(quarantineRoot);
 if(source===parse(source).root||target===parse(target).root||inside(source,target)||inside(target,source))throw Error('legacy_recovery_roots_overlap');
 const inventory=await scan(source),parent=await stat(dirname(target));
 if(String(parent.dev)!==inventory.device)throw Error('legacy_recovery_cross_device_refused');
 const plan={
  schema:LEGACY_RECOVERY_PLAN_SCHEMA,
  sourceRootSha256:sha(source),
  quarantineRootSha256:sha(target),
  parity:validateParity(parity),
  inventory:{entryCount:inventory.entries.length,digest:inventory.digest},
  action:'atomic_stage_plaintext_recovery_for_explicit_retirement',
  destructiveDeletionAuthorized:false,
 };
 return Object.freeze({...plan,planSha256:planDigest(plan)});
}

async function absent(path){try{await lstat(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function assertPlan(plan,source,target,parity){
 if(plan?.schema!==LEGACY_RECOVERY_PLAN_SCHEMA||plan.planSha256!==planDigest(plan))throw Error('legacy_recovery_plan_invalid');
 if(plan.sourceRootSha256!==sha(source)||plan.quarantineRootSha256!==sha(target))throw Error('legacy_recovery_plan_path_mismatch');
 if(stable(plan.parity)!==stable(validateParity(parity)))throw Error('legacy_recovery_parity_changed');
 const inventory=await scan(source);
 if(plan.inventory.entryCount!==inventory.entries.length||plan.inventory.digest!==inventory.digest)throw Error('legacy_recovery_inventory_changed');
 return inventory;
}

export async function stageLegacyRecovery({legacyRoot,quarantineRoot,parity,plan,expectedPlanSha256}){
 const source=resolve(legacyRoot),target=resolve(quarantineRoot);
 if(expectedPlanSha256!==plan?.planSha256)throw Error('legacy_recovery_confirmation_required');
 if(!await absent(target))throw Error('legacy_recovery_quarantine_exists');
 const before=await assertPlan(plan,source,target,parity);
 await rename(source,target);await syncDirectory(dirname(source));if(dirname(target)!==dirname(source))await syncDirectory(dirname(target));
 try{
  const after=await scan(target);
  if(after.digest!==before.digest||after.entries.length!==before.entries.length)throw Error('legacy_recovery_stage_mismatch');
  return Object.freeze({state:'staged_reversible_plaintext_recovery',planSha256:plan.planSha256,inventory:plan.inventory});
 }catch(error){await rename(target,source);await syncDirectory(dirname(source));throw error;}
}

export async function restoreLegacyRecovery({legacyRoot,quarantineRoot,plan,expectedPlanSha256}){
 const source=resolve(legacyRoot),target=resolve(quarantineRoot);
 if(expectedPlanSha256!==plan?.planSha256||plan?.planSha256!==planDigest(plan))throw Error('legacy_recovery_confirmation_required');
 if(!await absent(source))throw Error('legacy_recovery_source_exists');
 const inventory=await scan(target);
 if(plan.inventory.entryCount!==inventory.entries.length||plan.inventory.digest!==inventory.digest)throw Error('legacy_recovery_quarantine_changed');
 await rename(target,source);await syncDirectory(dirname(source));if(dirname(target)!==dirname(source))await syncDirectory(dirname(target));
 const restored=await scan(source);
 if(restored.digest!==inventory.digest)throw Error('legacy_recovery_restore_mismatch');
 return Object.freeze({state:'restored_plaintext_recovery',planSha256:plan.planSha256,inventory:plan.inventory});
}
