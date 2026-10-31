import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,relative,resolve,sep,toNamespacedPath} from 'node:path';
import {publicApiConfig} from './public-api-config.mjs';
import {HARNESS_STATE_ENV,statePath} from './harness-paths.mjs';
export function publicApiSourcePath(root,file){
 const installed=process.env[HARNESS_STATE_ENV]!==undefined;
 const base=installed?statePath(root,'output','public-apis'):realpathSync(root);
 const source=realpathSync(resolve(root,file)),rel=relative(base,source);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('public_spec_path');
 // Installed mode accepts only the content-addressed selection produced by
 // the native chooser; it does not grant access to other application data.
 if(installed&&(!/^[a-f0-9]{64}\.json$/.test(rel)||toNamespacedPath(statePath(root,'output','public-apis',basename(rel)))!==toNamespacedPath(source)))throw Error('public_spec_path');
 const stat=lstatSync(source);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('public_spec_size');
 return source;
}
export function publicApiSelection(spec){
 if(!Array.isArray(spec?.servers)||spec.servers.length!==1||typeof spec.servers[0]?.url!=='string'||spec.servers[0].variables||/[{}]/.test(spec.servers[0].url))throw Error('Choose a specification with one explicit public server');
 const baseUrl=new URL(spec.servers[0].url).href;
 // api- (4) + hostname (19) + - (1) + URL hash (8) fits MCP's 32 chars.
 // Short existing IDs remain unchanged; the full URL hash keeps long hosts distinct.
 const host=new URL(baseUrl).hostname.replace(/[^a-z0-9]+/g,'-').slice(0,19);
 const id='api-'+host+'-'+createHash('sha256').update(baseUrl).digest('hex').slice(0,8);
 const serialized=JSON.stringify(spec),hash=createHash('sha256').update(serialized).digest('hex');
 const specPath='/home/node/.dsh/attachments/.uptokey-public-apis/'+hash+'.json';
 publicApiConfig({id,baseUrl,spec,specPath});
 return {id,baseUrl,hash,serialized,operations:Object.values(spec.paths).filter(item=>item.get).length};
}
