#!/usr/bin/env node
/** Promote verified local candidates and preserve the replaced artifact without traversing links. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const core=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const workspace=resolve(core,'../..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function inside(path){const tail=relative(workspace,path);if(!tail||isAbsolute(tail)||tail==='..'||tail.startsWith('..\\')||tail.startsWith('../'))throw new Error('promotion_path_outside_workspace');return path}
function tree(root){const entries=[];function visit(dir){for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(dir,item.name);const stat=lstatSync(file);if(stat.isSymbolicLink())throw new Error('promotion_link_refused');if(stat.isDirectory())visit(file);else if(stat.isFile())entries.push({path:relative(root,file).replaceAll('\\','/'),bytes:stat.size,sha256:hash(file)});else throw new Error('promotion_special_file_refused')}}visit(root);return entries}
function copyTree(from,to){mkdirSync(to,{recursive:true});for(const file of tree(from)){const dest=join(to,file.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(from,file.path),dest)}}
const args=process.argv.slice(2);
if(args.length!==2)throw new Error('usage: promote-tui-canonical.mjs <core-candidate> <frontend-candidate>');
const candidate=inside(resolve(args[0]));
const frontend=inside(resolve(args[1]));
const cliFiles=['cli.js','composition-worker.js','service-schema-worker.js','workspace-context-helper.js','BUILD_INFO.json','THIRD-PARTY-NOTICES.md'];
for(const file of cliFiles)if(!existsSync(join(candidate,file)))throw new Error('promotion_core_file_missing');
const manifest=JSON.parse(readFileSync(join(frontend,'BUILD_INFO.json'),'utf8'));
if(manifest.entry!=='main.js'||manifest.accessibleEntry!=='linear-entry.js'||manifest.accessibleRuntime!=='node')throw new Error('promotion_frontend_contract_invalid');
const files=tree(frontend);
if(files.some(file=>/fixture|\.test\./i.test(file.path)))throw new Error('promotion_fixture_refused');
const expected=new Map(manifest.files.map(file=>[file.path,file]));
for(const file of files){if(file.path==='BUILD_INFO.json')continue;const wanted=expected.get(file.path);if(!wanted||wanted.sha256!==file.sha256||wanted.bytes!==file.bytes)throw new Error('promotion_frontend_hash_mismatch');expected.delete(file.path)}
if(expected.size)throw new Error('promotion_frontend_missing_file');
const dist=inside(join(core,'dist'));
const stage=inside(join(core,`dist.install-${stamp}`));
const archive=inside(join(workspace,'arquivo','tui-substituida-20261002','executavel-substituido',stamp));
if(existsSync(stage)||existsSync(archive))throw new Error('promotion_destination_exists');
mkdirSync(stage);
// Preserve unrelated generated assets while replacing canonical core entries and the one terminal directory.
if(existsSync(dist))for(const item of readdirSync(dist,{withFileTypes:true})){if(item.name==='tui'||cliFiles.includes(item.name))continue;const from=join(dist,item.name),to=join(stage,item.name);if(lstatSync(from).isSymbolicLink())throw new Error('promotion_link_refused');if(item.isDirectory())copyTree(from,to);else copyFileSync(from,to)}
for(const file of cliFiles)copyFileSync(join(candidate,file),join(stage,file));
copyTree(frontend,join(stage,'tui'));
const staged=tree(stage);
const replaced=existsSync(dist)?tree(dist):[];
mkdirSync(dirname(archive),{recursive:true});
let archived=false;
try{if(existsSync(dist)){renameSync(dist,archive);archived=true}renameSync(stage,dist)}catch(error){if(archived&&!existsSync(dist))renameSync(archive,dist);throw error}
const installed=tree(dist);
if(JSON.stringify(installed)!==JSON.stringify(staged))throw new Error('promotion_installed_hash_mismatch');
if(archived&&JSON.stringify(tree(archive))!==JSON.stringify(replaced))throw new Error('promotion_archive_hash_mismatch');
const receipt={schema:'uptokey-canonical-terminal-promotion-v1',kind:'promotion',promotedAt:new Date().toISOString(),coreCandidate:candidate,frontendCandidate:frontend,installed:dist,archive:archived?archive:null,archiveMethod:'atomic directory rename; no link traversal',artifactManifestSha256:hash(join(dist,'tui','BUILD_INFO.json')),frontendManifestSha256:hash(join(dist,'tui','BUILD_INFO.json')),coreManifestSha256:hash(join(dist,'BUILD_INFO.json')),files:installed,replacedFiles:replaced,result:'passed',action:'promoted',serviceRestarted:false};
const evidence=inside(join(workspace,'output','tui-canonica',`promotion-${stamp}`));mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'promotion.json'),JSON.stringify(receipt,null,2)+'\n');
if(archived)writeFileSync(join(archive,'ARCHIVE-MANIFEST.json'),JSON.stringify({archivedAt:receipt.promotedAt,origin:dist,files:replaced},null,2)+'\n');
console.log(JSON.stringify({result:receipt.result,files:installed.length,evidence:join(evidence,'promotion.json'),archive:receipt.archive}));
