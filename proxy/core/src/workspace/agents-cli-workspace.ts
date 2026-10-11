import {createHash,randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {computeProjectChangeSetDigest,parseProjectChangeSet} from '@uptokey/sync-contract/project-agent';
import {buildSkillManifest} from '../skill-install.ts';
import {createInstallPlan,type InstallPlan} from '../install-plan.ts';
import type {WorkspaceRuntime} from './runtime.ts';

const fail=(code:string,status=400)=>Object.assign(new Error(code),{code,status});
type PackageFile={path:string;content:string};

/** Bind every staged package to the authenticated principal and project. The
 * registry can contain legacy packages, but these cannot acquire new authority. */
export const installOwnerPrefix=(principal:string,projectId:string)=>`owned_${createHash('sha256').update(JSON.stringify([principal,projectId])).digest('hex').slice(0,32)}_`;

async function prepareFiles(runtime:WorkspaceRuntime,principal:string,projectId:string,input:{targetRootRef:string;expectedRevision:number;files:PackageFile[];objective:string}){
 const root=(await runtime.listProjectRoots(principal,projectId)).find(root=>root.id===input.targetRootRef&&!root.revokedAt&&root.accessMode==='read_write'&&Date.parse(root.expiresAt)>Date.now());
 if(!root)throw fail('project_root_unauthorized',403);
 const manifest=await runtime.getProjectManifest(principal,projectId,root.id);
 if(manifest.entries.some(file=>input.files.some(next=>next.path===file.relativePath)))throw fail('install_conflict',409);
 const directories=new Set<string>();
 for(const file of input.files){const parts=file.path.split('/');for(let end=1;end<parts.length;end++)directories.add(parts.slice(0,end).join('/'));}
 const raw={id:`install-${randomUUID()}`,taskId:`install-${randomUUID()}`,revision:1,baseManifestDigest:manifest.snapshotDigest,operations:[...Array.from(directories).sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b)).map(path=>({type:'mkdir' as const,path})),...input.files.map(file=>({type:'create' as const,path:file.path,content:file.content,newSha256:createHash('sha256').update(file.content).digest('hex')}))]};
 const changeSet=parseProjectChangeSet({...raw,digest:computeProjectChangeSetDigest(raw)});
 const preview=await runtime.preflightProjectChangeSet(principal,projectId,{rootBindingId:root.id,changeSet});
 if(!preview.ok)throw fail('install_conflict',409);
 return runtime.createProjectTaskPlan(principal,projectId,{expectedRevision:input.expectedRevision,rootBindingId:root.id,changeSet,objective:input.objective});
}

/** Stage a verified file package in W5. This is not an npm/pip process: all
 * actual file effects belong to the project writer and its signed consent. */
export async function prepareInstallProjectPlan(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,files,plan'||!Number.isSafeInteger(input.expectedRevision)||!isDataRecord(input.plan)||!Array.isArray(input.files)||input.files.length<1||input.files.length>32)throw fail('client_config_invalid');
 const plan=input.plan as unknown as InstallPlan;
 if(typeof plan.id!=='string'||!plan.id.startsWith(installOwnerPrefix(principal,projectId)))throw fail('project_root_unauthorized',403);
 if(typeof plan.packageOrigin!=='string'||!plan.packageOrigin.trim()||plan.packageOrigin.length>500||typeof plan.exactVersion!=='string'||!plan.exactVersion.trim()||plan.exactVersion.length>100||typeof plan.targetRootRef!=='string'||plan.lifecyclePolicy!=='scripts_denied')throw fail('client_config_invalid');
 let size=0;const seen=new Set<string>();
 const files=input.files.map(value=>{
  if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='content,path'||typeof value.path!=='string'||typeof value.content!=='string'||!value.path||value.path.includes('\\')||value.path.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(value.path.toLowerCase()))throw fail('install_target_denied');
  seen.add(value.path.toLowerCase());size+=Buffer.byteLength(value.content);if(size>262_144)throw fail('client_config_invalid');return {path:value.path,content:value.content};
 });
 const checked=createInstallPlan({...plan,files});
 if(JSON.stringify(checked.expectedFiles)!==JSON.stringify(plan.expectedFiles))throw fail('package_integrity_failed');
 const manifestPath=`install-manifests/${plan.id}.json`;
 if(seen.has(manifestPath.toLowerCase()))throw fail('install_target_denied');
 return prepareFiles(runtime,principal,projectId,{targetRootRef:plan.targetRootRef,expectedRevision:input.expectedRevision as number,files:[...files,{path:manifestPath,content:JSON.stringify({...plan,execution:'files_only',grantsExecution:false},null,2)+'\n'}],objective:`Adicionar pacote ${plan.packageOrigin} ${plan.exactVersion} (${files.length} arquivos; sem executar scripts)`});
}

/** A skill is inert project data. The existing project writer owns every write,
 * hash precondition, signed consent, receipt and recovery; no installer executes
 * instructions, lifecycle scripts, dependency managers or downloaded content. */
export async function prepareSkillProjectPlan(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='content,expectedRevision,id,license,revision,sourceUrl,targetRootRef'||typeof input.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,59}$/.test(input.id)||typeof input.content!=='string'||!input.content.trim()||Buffer.byteLength(input.content)>65_536||typeof input.license!=='string'||!input.license.trim()||input.license.length>100||typeof input.revision!=='string'||!input.revision.trim()||input.revision.length>100||typeof input.sourceUrl!=='string'||typeof input.targetRootRef!=='string'||!Number.isSafeInteger(input.expectedRevision))throw fail('skill_package_invalid');
 let source:URL;try{source=new URL(input.sourceUrl);}catch{throw fail('skill_source_invalid');}
 if(source.protocol!=='https:'||source.username||source.password||source.search||source.hash)throw fail('skill_source_invalid');
 const directory=`skills/${input.id}`,skillPath=`${directory}/SKILL.md`,manifestPath=`${directory}/uptokey-skill-manifest.json`;
 const packageManifest=buildSkillManifest({id:input.id,revision:input.revision,license:input.license,sourceUrl:source.href,entrypoint:skillPath,files:[{path:skillPath,content:input.content}],dependencies:[],allowedCapabilities:[]});
 const metadata=JSON.stringify({...packageManifest,state:'installed'},null,2)+'\n';
 const files=[{path:skillPath,content:input.content},{path:manifestPath,content:metadata}];
 return prepareFiles(runtime,principal,projectId,{targetRootRef:input.targetRootRef,expectedRevision:input.expectedRevision as number,files,objective:`Adicionar skill ${input.id} em ${skillPath}`});
}
