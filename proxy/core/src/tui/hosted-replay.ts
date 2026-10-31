import {parseHostedProviderReplay,type HostedProviderReplay} from '@uptokey/sync-contract/hosted-provider-replay';
import type {TuiHostedDestination} from './hosted.ts';
/** Keep the small metering receipt independent of opaque provider replay. */
export function hostedReceiptParts(raw:string,destination:TuiHostedDestination|undefined){
 if(Buffer.byteLength(raw)>132000)throw Error('hosted_replay_invalid');
 const {providerReplay,...receipt}=JSON.parse(raw);
 const parts=[{type:'status',text:'hosted:v1 '+JSON.stringify({...receipt,destination})}];
 if(providerReplay!==undefined&&receipt.state==='completed'&&destination)parts.push({type:'status',text:'hosted-replay:v1 '+JSON.stringify({modelId:destination.modelId,providerReplay})});
 return parts;
}
/** Replay lives in the canonical message, never a separate conversation store. */
export function hostedReplayForHistory(parts:readonly {type?:unknown;text?:unknown}[],content:string,calls?:readonly {id:string;name:string;arguments:string}[]):{providerReplay?:HostedProviderReplay;providerReplayModelId?:string}{
 for(const part of [...parts].reverse()){
  if(part.type!=='status'||typeof part.text!=='string'||!part.text.startsWith('hosted-replay:v1 '))continue;
  if(Buffer.byteLength(part.text)>132000)throw Error('hosted_replay_invalid');
  let value;try{value=JSON.parse(part.text.slice(17));}catch{throw Error('hosted_replay_invalid');}
  if(typeof value?.modelId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.modelId))throw Error('hosted_replay_invalid');
  const replay=parseHostedProviderReplay(value.providerReplay,content,calls,true);
  if(!replay)throw Error('hosted_replay_invalid');
  return {providerReplay:replay,providerReplayModelId:value.modelId};
 }
 return {};
}
