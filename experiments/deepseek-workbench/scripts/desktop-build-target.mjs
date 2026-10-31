import {createHash} from 'node:crypto';
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

const GENERATION=/^tauri-target-generation-(\d{13})-(\d+)$/;
const binaryName=process.platform==='win32'?'uptokey-harness-desktop.exe':'uptokey-harness-desktop';
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

function safeDirectory(path){
 if(!existsSync(path))return false;
 const metadata=lstatSync(path);return metadata.isDirectory()&&!metadata.isSymbolicLink()&&realpathSync(path)===path;
}

function validGeneration(local,name){
 if(!GENERATION.test(name))return undefined;
 const target=join(local,name),marker=join(target,'desktop-build-ready.json'),binary=join(target,'debug',binaryName);
 if(!safeDirectory(target)||!existsSync(marker)||lstatSync(marker).isSymbolicLink()||!existsSync(binary)||lstatSync(binary).isSymbolicLink()||!lstatSync(binary).isFile())return undefined;
 try{
  const receipt=JSON.parse(readFileSync(marker,'utf8'));
  if(Object.keys(receipt).sort().join(',')!=='binarySha256,directoryName,schemaVersion'||receipt.schemaVersion!==1||receipt.directoryName!==name||receipt.binarySha256!==hash(binary))return undefined;
  return target;
 }catch{return undefined}
}

export function currentDesktopTarget(root){
 const local=resolve(root,'.local');mkdirSync(local,{recursive:true,mode:0o700});
 const generation=readdirSync(local,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&GENERATION.test(entry.name)).map(entry=>entry.name).sort().reverse().map(name=>validGeneration(local,name)).find(Boolean);
 if(generation)return generation;
 const legacy=resolve(local,'tauri-target-current');
 if(!safeDirectory(legacy))throw Error('desktop_build_target_unavailable');
 return legacy;
}

function checkedDirectoryTree(directory){
 for(let current=directory;;current=dirname(current)){
  if(existsSync(current)&&!safeDirectory(current))throw Error('desktop_preview_directory_invalid');
  if(current===dirname(current))break;
 }
}

/** Publish accepted Windows bytes as a private user application. A build tree
 * may carry a Low mandatory label, which Windows also applies on manual launch.
 * Copy normally to the application directory; never edit labels, ACLs or tokens.
 * The original build, profile, helpers, engine and rollback remain untouched. */
export function desktopPreviewExecutable(root,{platform=process.platform,applicationRoot=process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Uptokey','HarnessPreview')}={}){
 const target=currentDesktopTarget(root),source=join(target,'debug',binaryName);
 if(platform!=='win32')return source;
 if(validGeneration(resolve(root,'.local'),basename(target))!==target)throw Error('desktop_preview_build_unverified');
 if(typeof applicationRoot!=='string'||!isAbsolute(applicationRoot))throw Error('desktop_preview_directory_invalid');
 const base=resolve(applicationRoot),inside=relative(resolve(root),base);
 if(!inside||!(inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside)))throw Error('desktop_preview_must_leave_build_tree');
 checkedDirectoryTree(base);
 const digest=hash(source),directory=join(base,digest),executable=join(directory,binaryName);
 checkedDirectoryTree(directory);mkdirSync(directory,{recursive:true,mode:0o700});checkedDirectoryTree(directory);
 if(!existsSync(executable))copyFileSync(source,executable,constants.COPYFILE_EXCL);
 const metadata=lstatSync(executable);
 if(metadata.isSymbolicLink()||!metadata.isFile()||realpathSync(executable)!==executable||hash(executable)!==digest||hash(source)!==digest)throw Error('desktop_preview_binary_changed');
 return executable;
}

export function newDesktopTarget(root,{now=Date.now(),pid=process.pid}={}){
 const local=resolve(root,'.local');mkdirSync(local,{recursive:true,mode:0o700});
 const name=`tauri-target-generation-${now}-${pid}`;
 if(!GENERATION.test(name))throw Error('desktop_build_target_invalid');
 const target=resolve(local,name);if(existsSync(target))throw Error('desktop_build_target_exists');
 return target;
}

export function publishDesktopTarget(target){
 const name=basename(target);if(!GENERATION.test(name)||!safeDirectory(target))throw Error('desktop_build_target_invalid');
 const binary=join(target,'debug',binaryName);if(!existsSync(binary)||lstatSync(binary).isSymbolicLink()||!lstatSync(binary).isFile())throw Error('desktop_build_binary_missing');
 const marker=join(target,'desktop-build-ready.json');
 writeFileSync(marker,JSON.stringify({schemaVersion:1,directoryName:name,binarySha256:hash(binary)})+'\n',{mode:0o600,flag:'wx'});
 return target;
}
