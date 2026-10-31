import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {importWorkspaceBytes} from './import-workspace.mjs';

export const MAX_ARCHIVE_BYTES=34*1024*1024;

// Keep the selected snapshot in memory through the existing finite importer.
// No temporary ZIP path, text decoding, or caller-controlled command argument.
export async function readWorkspaceArchive(input){
 let archive=Buffer.alloc(64*1024);
 let length=0;
 for await(const chunk of input){
  if(!(chunk instanceof Uint8Array)||chunk.byteLength>MAX_ARCHIVE_BYTES-length)throw Error('workspace-zip-invalid');
  const nextLength=length+chunk.byteLength;
  if(nextLength>archive.length){
   const grown=Buffer.alloc(Math.max(nextLength,Math.min(MAX_ARCHIVE_BYTES,archive.length*2)));
   grown.set(archive.subarray(0,length));
   archive=grown;
  }
  archive.set(chunk,length);
  length=nextLength;
 }
 if(length===0)throw Error('workspace-zip-invalid');
 return archive.subarray(0,length);
}

export async function importWorkspaceInput(input,{importer=importWorkspaceBytes}={}){
 const archive=await readWorkspaceArchive(input);
 const value=await importer(archive);
 if(value?.imported!==true||typeof value.project!=='string'||!/^\/workspace\/import-[a-f0-9]{32}$/.test(value.project)
  ||!Number.isSafeInteger(value.files)||value.files<0||value.files>5000
  ||!Number.isSafeInteger(value.contentBytes)||value.contentBytes<0||value.contentBytes>32*1024*1024
  ||!Number.isSafeInteger(value.excludedEntries)||value.excludedEntries<0||value.excludedEntries>10000
  ||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))throw Error('workspace-import-result-invalid');
 // Only the original importer's finite receipt fields can reach stdout.
 return {imported:true,project:value.project,files:value.files,contentBytes:value.contentBytes,excludedEntries:value.excludedEntries,sha256:value.sha256};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const result=process.argv.length===2?importWorkspaceInput(process.stdin):Promise.reject(Error('workspace-arguments-invalid'));
 result.then(value=>{
  console.log(JSON.stringify(value));
 }).catch(()=>{
  console.log(JSON.stringify({imported:false,error:'workspace-import-unavailable'}));
  process.exitCode=1;
 });
}
