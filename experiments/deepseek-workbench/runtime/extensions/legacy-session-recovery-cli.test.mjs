import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,lstat,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Encrypted from './encrypted-sessions.mjs';
import {executeLegacyRecovery} from './legacy-session-recovery-cli.mjs';

async function boot(config,plugin){
 const ctx=new Context();await ctx.plugin(SessionStore);
 const fiber=ctx.plugin(plugin,plugin===Jsonl?{root:config.legacyRoot}:config);await fiber.await();
 return {ctx,fiber};
}
async function privatize(root){
 await chmod(root,0o700);
 for(const entry of await readdir(root,{withFileTypes:true})){
  const child=join(root,entry.name);
  if(entry.isDirectory()){await privatize(child);}else await chmod(child,0o600);
 }
}

test('CLI stages verified legacy bytes, encrypted-only boot keeps the root absent, and restore is exact',async t=>{
 const root=await mkdtemp(join(tmpdir(),'uptokey-legacy-cli-'));
 const config={legacyRoot:join(root,'legacy'),encryptedRoot:join(root,'encrypted'),quarantineRoot:join(root,'quarantine'),keyPath:join(root,'key')};
 await writeFile(config.keyPath,randomBytes(32).toString('hex'),{mode:0o400});
 t.after(()=>rm(root,{recursive:true,force:true}));
 const old=await boot(config,Jsonl),session=old.ctx.sessions.create(SessionId('legacy-cli'),{meta:{cwd:'/workspace/demo'}});
 const writer=await old.ctx.sessionPersistence.create(session.header);session.append('session/title',{title:'synthetic cli',messageSeqs:[],source:{kind:'user'}});await old.ctx.sessions.flush(session);await writer.close();await old.ctx.fiber.dispose();
 const migrated=await boot({...config,root:config.encryptedRoot},Encrypted);await migrated.ctx.fiber.dispose();
 await privatize(config.legacyRoot);
 const staged=await executeLegacyRecovery('stage',config);
 assert.equal(staged.result.state,'staged_reversible_plaintext_recovery');
 await assert.rejects(lstat(config.legacyRoot),error=>error.code==='ENOENT');
 const encryptedOnly=await boot({...config,root:config.encryptedRoot},Encrypted);
 const read=await encryptedOnly.ctx.sessionPersistence.open(SessionId('legacy-cli'),'read');assert.equal((await read.read()).events[0].data.title,'synthetic cli');await read.close();await encryptedOnly.ctx.fiber.dispose();
 await assert.rejects(lstat(config.legacyRoot),error=>error.code==='ENOENT');
 const restored=await executeLegacyRecovery('restore',{...config,planBase64:Buffer.from(JSON.stringify(staged.plan)).toString('base64url')});
 assert.equal(restored.result.state,'restored_plaintext_recovery');assert.equal((await lstat(config.legacyRoot)).isDirectory(),true);
});
