import type {ManagedMediaKind,MediaProviderChoice} from '@uptokey/sync-contract/media-profile';
import {PROVIDER_SETUP_PRESETS} from './tui/provider-setup.ts';

/** Wire-compatible choices, independent from the chat catalog. A declared model
 * is not an account entitlement or an inference verification. */
export const MEDIA_PATHS:Readonly<Record<ManagedMediaKind,string>>=Object.freeze({image:'/v1/images/generations',speech:'/v1/audio/speech',transcription:'/v1/audio/transcriptions',video:'/api/v1/videos'});
const openaiModels:Partial<Record<ManagedMediaKind,readonly string[]>>={
 image:['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2','gpt-image-1.5','gpt-image-1','gpt-image-1-mini'],
 speech:['gpt-4o-mini-tts','tts-1','tts-1-hd'],
 // The current transcription driver also supports timestamped verbose_json.
 transcription:['whisper-1'],
};
const documentation:Partial<Record<ManagedMediaKind,string>>={image:'https://developers.openai.com/api/reference/resources/images/methods/generate',speech:'https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create',transcription:'https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create'};
const speechVoices=['alloy','ash','coral','echo','fable','onyx','nova','sage','shimmer'];
const miniSpeechVoices=[...speechVoices,'ballad','verse','marin','cedar'];
export function mediaProviders(kind:ManagedMediaKind):MediaProviderChoice[]{
 const ids=openaiModels[kind];
 return ids?[{id:'custom-openai',label:'OpenAI',endpoint:'https://api.openai.com'+MEDIA_PATHS[kind],models:ids.flatMap(id=>kind==='speech'?(id==='gpt-4o-mini-tts'?miniSpeechVoices:speechVoices).map(voice=>({id:`openai/${id}/${voice}`,label:`${id} · ${voice}`})):[{id:`openai/${id}`,label:id}]),modelSource:'catalog',documentationUrl:documentation[kind]!,getKeyUrl:'https://platform.openai.com/api-keys',...(kind==='image'?{editEndpoint:'https://api.openai.com/v1/images/edits'}:{})}]:[];
}
export function mediaConnectionSupport(kind:ManagedMediaKind,providerId:string,endpointUrl:string|null|undefined):MediaProviderChoice|undefined{
 if(providerId.startsWith('service-')||!endpointUrl)return;
 let url:URL;try{url=new URL(endpointUrl);}catch{return;}
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))return;
 const known=mediaProviders(kind).find(provider=>provider.id===providerId);
 if(known)return url.origin===new URL(known.endpoint).origin?known:undefined;
 // Only explicitly compatible destinations remain manual; known chat presets
 // never acquire media support merely because they use a Bearer key.
 if(providerId!=='custom'&&(!providerId.startsWith('custom-')||PROVIDER_SETUP_PRESETS.some(preset=>preset.id===providerId)))return;
 return {id:providerId,label:'Compatible endpoint',endpoint:url.origin+MEDIA_PATHS[kind],models:[],modelSource:'manual',documentationUrl:null};
}
