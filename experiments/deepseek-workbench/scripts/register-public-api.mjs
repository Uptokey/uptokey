import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {hostEnvironment} from './host-environment.mjs';
import {publicApiConfig} from './public-api-config.mjs';
import {publicApiSourcePath} from './public-api-selection.mjs';
const [id,baseUrl,file,...extra]=process.argv.slice(2);
if(!id||!baseUrl||!file||extra.length)throw Error('Usage: npm run api:add -- name https://api.example.com runtime/apis/spec.json');
const root=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
const source=publicApiSourcePath(root,file);
const spec=JSON.parse(readFileSync(source,'utf8'));
const hash=createHash('sha256').update(JSON.stringify(spec)).digest('hex');
const specPath=`/home/node/.dsh/attachments/.uptokey-public-apis/${hash}.json`;
const plugin=publicApiConfig({id,baseUrl,spec,specPath});
const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
const call=(args,options={})=>execFileSync('podman',[...connection,...args],{env:hostEnvironment(),encoding:'utf8',windowsHide:true,...options});
const container='uptokey-deepseek-workbench';
const item=JSON.parse(call(['inspect',container]))[0];
if(item.Config.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!item.State.Running)throw Error('Laboratory runtime unavailable');
const program=String.raw`
const fs=require('node:fs'),YAML=require('/opt/harness/node_modules/yaml');
const {plugin,spec,specPath}=JSON.parse(fs.readFileSync(0,'utf8'));
const dir='/home/node/.dsh/attachments/.uptokey-public-apis';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
if(fs.lstatSync(dir).isSymbolicLink())throw Error('Schema directory must not be a symlink');
try{fs.writeFileSync(specPath,JSON.stringify(spec),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e;if(fs.lstatSync(specPath).isSymbolicLink()||fs.readFileSync(specPath,'utf8')!==JSON.stringify(spec))throw Error('Existing schema identity mismatch')}
const path='/home/node/.dsh/profiles/web/cordis.patch.yml';
const before=fs.readFileSync(path,'utf8'),doc=YAML.parse(before);
if(!Array.isArray(doc))throw Error('Profile unavailable');
const existing=doc.flatMap(p=>p.insert??[]).find(p=>p.id===plugin.id);
if(existing){existing.name=plugin.name;existing.config=plugin.config;existing.disabled=false}
else {
 const legacy=doc.findIndex(p=>p.id===plugin.id);
 if(legacy>=0)doc.splice(legacy,1);
 doc.push({insert:[plugin]});
}
let fileTool=doc.find(p=>p.id==='uptokey-api-file');
if(!fileTool){fileTool={id:'uptokey-api-file',config:{servers:['mcp__weather__']}};doc.push(fileTool)}
fileTool.config={...fileTool.config,servers:[...new Set([...(fileTool.config?.servers??[]),'mcp__'+plugin.config.serverName+'__'])]};
const after=YAML.stringify(doc);
if(after!==before){const backup=path+'.before-'+plugin.id;if(!fs.existsSync(backup))fs.writeFileSync(backup,before,{mode:0o600});if(fs.readFileSync(path,'utf8')!==before)throw Error('Configuration changed; retry');fs.writeFileSync(path,after)}
console.log(JSON.stringify({registered:plugin.id,apiId:plugin.config.serverName,schemaSha256:specPath.split('/').at(-1).slice(0,-5),executor:'workbench-executor',schema:specPath,profileChanged:after!==before,readiness:'pending'}));
`;
process.stdout.write(call(['exec','-i',container,'node','-e',program],{input:JSON.stringify({plugin,spec,specPath})}));
