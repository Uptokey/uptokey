import {mkdirSync,lstatSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {collectRuntimeHealth} from './runtime-health.mjs';
import {statePath} from './harness-paths.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const report=await collectRuntimeHealth();
if(process.argv.includes('--export')){
  const directory=statePath(root,'output','diagnostics');
  for(const path of [statePath(root,'output'),directory]){
  mkdirSync(path,{recursive:true});
  if(lstatSync(path).isSymbolicLink())throw Error('Diagnostics directory must stay inside the laboratory');
 }
 const path=join(directory,'uptokey-runtime-'+Date.now()+'.json');
 writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({exported:true,path,report}));
}else console.log(JSON.stringify(report,null,2));
