import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readJson,writeJsonAtomic} from '../atomic-json.ts';
import {withConfigFileLock} from '../config-file-lock.ts';
import type {RemoteTool} from './remote-mcp.ts';

export interface ServiceRecord {
 revision:number;enabled:boolean;removed:boolean;label?:string;
 connectionId?:string;connectionRevision?:number;tools?:RemoteTool[];
 bindingDigest?:string;
}
export interface ServiceAccessStorage {
 read(principal:string,id:string):Promise<ServiceRecord|undefined>;
 change<T>(principal:string,id:string,expected:number,operation:(current:ServiceRecord|undefined)=>Promise<{record:ServiceRecord;value:T}>):Promise<T>;
 transaction<T>(principal:string,id:string,expected:number,operation:(current:ServiceRecord|undefined,commit:(record:ServiceRecord,admit:()=>Promise<void>)=>Promise<void>)=>Promise<T>):Promise<T>;
}
/** Only bounded configuration/schema metadata is written here. Secrets retain the conn:<id> owner. */
export function fileServiceAccessStorage(root:string):ServiceAccessStorage {
 const path=(principal:string,id:string)=>join(root,createHash('sha256').update(principal).digest('hex'),`${id}.json`);
 const read=async(principal:string,id:string)=>{
  const value=await readJson<ServiceRecord|null|undefined>(path(principal,id),undefined,4*1024*1024);
  if(value&&(!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.enabled!=='boolean'||typeof value.removed!=='boolean'))throw new Error('service_state_invalid');
  return value??undefined;
 };
 const transaction:ServiceAccessStorage['transaction']=async(principal,id,expected,operation)=>withConfigFileLock(path(principal,id),async()=>{
  const current=await read(principal,id);if((current?.revision??0)!==expected)throw new Error('service_revision_conflict');
  let published:ServiceRecord|undefined;
  try{return await operation(current,async(record,admit)=>{
   if(published||record.revision!==expected+1)throw new Error('service_state_invalid');published=record;
   await admit();await writeJsonAtomic(path(principal,id),record,{maximum:4*1024*1024,beforeCommit:admit});await admit();
  });}catch(error){
   if(published&&JSON.stringify(await read(principal,id))===JSON.stringify(published))await writeJsonAtomic(path(principal,id),current??null,{maximum:4*1024*1024});
   throw error;
  }
 });
 return {read,transaction,change:(principal,id,expected,operation)=>transaction(principal,id,expected,async(current,commit)=>{const next=await operation(current);await commit(next.record,async()=>{});return next.value;})};
}
