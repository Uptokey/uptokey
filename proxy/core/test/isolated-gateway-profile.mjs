// Must be the first import of a directly executable integration test: app modules
// must never observe a developer's storage paths, tokens or product overrides.
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const osKeys=new Set(['systemroot','windir','path','pathext','temp','tmp','comspec','processor_architecture','number_of_processors','programfiles','programfiles(x86)','lang','lc_all']);
for(const key of Object.keys(process.env))if(!osKeys.has(key.toLowerCase()))delete process.env[key];
export const gatewayTestProfile=mkdtempSync(join(tmpdir(),'uptokey-gateway-profile-'));
for(const [key,directory] of Object.entries({UPTOKEY_QUIMERA_DATA_DIR:'data',UPTOKEY_SETTINGS_DIR:'settings',UPTOKEY_AUTOMATIONS_DIR:'automations'})){
  const target=join(gatewayTestProfile,directory);mkdirSync(target);process.env[key]=target;
}
