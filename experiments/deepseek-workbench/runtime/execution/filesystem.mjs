import {realpathSync} from 'node:fs';
import {isAbsolute,relative} from 'node:path';
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh';
import {IMAGE_PATH,createImagePathResolver} from './image-path.mjs';
import {materializationOwnership, trackLeaseAsyncIterable, trackPromise} from '../extensions/materialization-ownership.mjs';
// Only these volumes are shared at identical paths. Never map controller home,
// credentials, session history or arbitrary host paths into the executor.
export default class WorkbenchFileSystem extends SshFileSystem {
 futureImagePath=createImagePathResolver();
 resolve(path,options){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.resolve(path,options));}
 lstat(path,options,signal){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.lstat(path,options,signal));}
 stat(target,signal){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.stat(target,signal));}
 readText(target,signal){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.readText(target,signal));}
 readBytes(target,signal,maxBytes){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.readBytes(target,signal,maxBytes));}
 readByteRange(target,range,signal){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.readByteRange(target,range,signal));}
 listDir(target,signal){return trackPromise(materializationOwnership,'filesystem-reader',()=>super.listDir(target,signal));}
 async streamText(target,signal){
  const lease=materializationOwnership.acquire('filesystem-reader');
  try{return trackLeaseAsyncIterable(lease,await super.streamText(target,signal));}
  catch(error){lease.release();throw error;}
 }
 async watch(target,changed,signal){
  const lease=materializationOwnership.acquire('filesystem-reader');
  try{const close=await super.watch(target,changed,signal);let closed=false;return async()=>{if(closed)return;closed=true;try{await close();}finally{lease.release();}};}
  catch(error){lease.release();throw error;}
 }
 processPathFromHostPath(path){
  if(typeof path!=='string'||!isAbsolute(path))return undefined;
  // This one namespace is shared by topology before its bounded async
  // materialization. Invalid pool paths must never reach the generic fallback.
  if(path===IMAGE_PATH||path.startsWith(IMAGE_PATH+'/'))return this.futureImagePath(path);
  let canonical;try{canonical=realpathSync(path)}catch{return undefined}
  for(const root of ['/workspace','/home/node/.dsh/attachments']){
   const tail=relative(root,canonical);
   if(tail===''||(!tail.startsWith('../')&&tail!=='..'&&!isAbsolute(tail)))return canonical;
  }
  return undefined;
 }
}
