import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {IpcWorkspaceSpeech,type SpeechOptions} from './speech-service.ts';
/** Explicit DEV opt-in only. Does not alter production startup or load credentials in the worker. */
export async function launchWorkspaceSpeech(appRoot:string,options:Omit<SpeechOptions,'child'>):Promise<IpcWorkspaceSpeech>{
 for(let cursor=path.resolve(appRoot);;cursor=path.dirname(cursor)){if(lstatSync(cursor).isSymbolicLink())throw new Error('speech_linked_path');if(path.dirname(cursor)===cursor)break;}
 const profilePath=path.join(appRoot,'quimera-profile.cjs');if(lstatSync(profilePath).isSymbolicLink())throw new Error('speech_linked_path');const require=createRequire(import.meta.url),profile=require(profilePath);
 profile.appRoot(appRoot);profile.assertUnlinked(path.join(appRoot,'quimera-speech-child.mjs'));
 const manifestPath=path.join(appRoot,'..','source-manifest.json');profile.assertUnlinked(manifestPath);if(statSync(manifestPath).size>10485760)throw new Error('speech_manifest_limit');const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(manifest.commit!==options.driverRevision||options.driverRevision!=='17c4cc76877bd1755030a8414f8d0083f48dcccf')throw new Error('speech_revision_invalid');
 const child=spawn(process.execPath,[path.join(appRoot,'quimera-speech-child.mjs')],{cwd:appRoot,env:profile.childEnvironment(process.env,appRoot),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('speech_start_timeout')),10000);const message=(m:any)=>{if(m?.type==='speech-ready')done(m.error?new Error('speech_start_failed'):undefined);};const done=(error?:Error)=>{clearTimeout(timer);child.off('message',message);child.off('error',done);child.off('exit',exit);error?reject(error):resolve();};const exit=()=>done(new Error('speech_child_closed'));child.on('message',message);child.on('error',done);child.on('exit',exit);child.send({type:'speech-configure',configuration:{provider:options.provider,baseUrl:new URL(options.providerUrl).origin,driverRevision:options.driverRevision}});});const service=new IpcWorkspaceSpeech({...options,child});const dispose=service.dispose.bind(service);service.dispose=()=>{dispose();child.kill();};service.close=async()=>{dispose();if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill();});};return service;}catch(error){child.kill();throw error;}
}


