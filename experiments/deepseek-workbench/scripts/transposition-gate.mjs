import {spawnSync} from 'node:child_process';

export function verifyTauriTransposition(root,env=process.env) {
  const result=spawnSync(process.execPath,['scripts/check-tauri-transposition.mjs'],{
    cwd:root,env,encoding:'utf8',stdio:'inherit',windowsHide:true,timeout:30_000,
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error('Tauri transposition gate failed; the build was not started.');
}
