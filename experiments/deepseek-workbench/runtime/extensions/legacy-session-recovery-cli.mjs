import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {EncryptedSessionStore} from './encrypted-sessions-store.mjs';
import {verifyLegacySessionParity} from './encrypted-sessions.mjs';
import {createLegacyRecoveryPlan,restoreLegacyRecovery,stageLegacyRecovery} from './legacy-session-recovery.mjs';

const defaults=Object.freeze({
 legacyRoot:'/home/node/.dsh/sessions',
 encryptedRoot:'/home/node/.dsh/sessions-encrypted/v1',
 quarantineRoot:'/home/node/.dsh/sessions-legacy-recovery',
 keyPath:'/run/secrets/uptokey-workbench-vault-key',
});

async function withStores(config,operation){
 const ctx=new Context();
 const encrypted=new EncryptedSessionStore({root:config.encryptedRoot,keyPath:config.keyPath});
 try{
  await ctx.plugin(SessionStore);
  const fiber=ctx.plugin(Jsonl,{root:config.legacyRoot});await fiber.await();
  await encrypted.ready();
  const legacy=ctx.get('sessionPersistence');if(!legacy)throw Error('legacy_recovery_store_unavailable');
  return await operation(legacy,encrypted);
 }finally{await Promise.allSettled([ctx.fiber.dispose(),encrypted.close()]);}
}

export async function executeLegacyRecovery(action,{planPath,planBase64,...overrides}={}){
 const config={...defaults,...overrides};
 if(action==='stage')return withStores(config,async(legacy,encrypted)=>{
  const parity=await verifyLegacySessionParity(legacy,encrypted);
  const plan=await createLegacyRecoveryPlan({legacyRoot:config.legacyRoot,quarantineRoot:config.quarantineRoot,parity});
  const result=await stageLegacyRecovery({legacyRoot:config.legacyRoot,quarantineRoot:config.quarantineRoot,parity,plan,expectedPlanSha256:plan.planSha256});
  return Object.freeze({plan,result});
 });
 if(action==='restore'){
  if(!planPath&&!planBase64)throw Error('legacy_recovery_plan_required');
  const plan=planBase64?JSON.parse(Buffer.from(planBase64,'base64url').toString('utf8')):JSON.parse(await readFile(planPath,'utf8'));
  const result=await restoreLegacyRecovery({legacyRoot:config.legacyRoot,quarantineRoot:config.quarantineRoot,plan,expectedPlanSha256:plan.planSha256});
  return Object.freeze({plan,result});
 }
 throw Error('legacy_recovery_action_invalid');
}

async function main(){
 const [action,...args]=process.argv.slice(2);
 const planArg=args.find(value=>value.startsWith('--plan='));
 const planBase64Arg=args.find(value=>value.startsWith('--plan-base64='));
 const result=await executeLegacyRecovery(action,{planPath:planArg?.slice('--plan='.length),planBase64:planBase64Arg?.slice('--plan-base64='.length)});
 console.log(JSON.stringify(result));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
