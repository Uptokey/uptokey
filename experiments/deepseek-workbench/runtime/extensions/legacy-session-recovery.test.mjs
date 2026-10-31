import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLegacyRecoveryPlan,restoreLegacyRecovery,stageLegacyRecovery} from './legacy-session-recovery.mjs';

const parity=Object.freeze({verified:true,sessionCount:1,digest:'a'.repeat(64)});
async function fixture(t){
 const testBase=process.platform==='win32'?join(process.cwd(),'output'):tmpdir();
 const root=await mkdtemp(join(testBase,'uptokey-legacy-recovery-')),legacy=join(root,'legacy'),quarantine=join(root,'quarantine');
 await mkdir(join(legacy,'session'),{recursive:true,mode:0o700});
 await chmod(legacy,0o700);await chmod(join(legacy,'session'),0o700);
 await writeFile(join(legacy,'session','session.lock'),'',{mode:0o600});
 await writeFile(join(legacy,'session','session.v4.jsonl.zstd'),'synthetic legacy recovery',{mode:0o600});
 t.after(()=>rm(root,{recursive:true,force:true}));
 return{root,legacy,quarantine};
}

test('stages an exact private recovery tree atomically and restores it byte-for-byte',async t=>{
 const f=await fixture(t),before=await readFile(join(f.legacy,'session','session.v4.jsonl.zstd'));
 const plan=await createLegacyRecoveryPlan({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity});
 assert.equal(plan.destructiveDeletionAuthorized,false);
 const staged=await stageLegacyRecovery({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity,plan,expectedPlanSha256:plan.planSha256});
 assert.equal(staged.state,'staged_reversible_plaintext_recovery');
 await assert.rejects(readFile(join(f.legacy,'session','session.v4.jsonl.zstd')),error=>error.code==='ENOENT');
 assert.deepEqual(await readFile(join(f.quarantine,'session','session.v4.jsonl.zstd')),before);
 const restored=await restoreLegacyRecovery({legacyRoot:f.legacy,quarantineRoot:f.quarantine,plan,expectedPlanSha256:plan.planSha256});
 assert.equal(restored.state,'restored_plaintext_recovery');
 assert.deepEqual(await readFile(join(f.legacy,'session','session.v4.jsonl.zstd')),before);
});

test('refuses stale inventory and wrong explicit confirmation without moving bytes',async t=>{
 const f=await fixture(t),plan=await createLegacyRecoveryPlan({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity});
 await assert.rejects(stageLegacyRecovery({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity,plan,expectedPlanSha256:'b'.repeat(64)}),/confirmation_required/);
 await writeFile(join(f.legacy,'session','session.v4.jsonl.zstd'),'changed',{mode:0o600});
 await assert.rejects(stageLegacyRecovery({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity,plan,expectedPlanSha256:plan.planSha256}),/inventory_changed/);
 assert.equal(String(await readFile(join(f.legacy,'session','session.v4.jsonl.zstd'))),'changed');
});

test('refuses permissive recovery bytes before producing a retirement plan',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await chmod(join(f.legacy,'session','session.v4.jsonl.zstd'),0o644);
 await assert.rejects(createLegacyRecoveryPlan({legacyRoot:f.legacy,quarantineRoot:f.quarantine,parity}),/file_permissions/);
});
