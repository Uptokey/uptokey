import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import type {ProxyConfig,TariffSnapshotEntry} from './types.ts';
import {VoiceSessionError} from './voice-session-service.ts';

export interface VoiceBudgetLimits {maxPostInstructionsTokens:number;maxOutputTokens:number;}
/** Reserve protocol overhead separately from the explicit conversation retention ceiling. */
export const VOICE_INSTRUCTION_ENVELOPE_TOKENS=4096;
export function parseVoiceBudgetLimits(value:unknown):VoiceBudgetLimits {
 if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='maxOutputTokens,maxPostInstructionsTokens'
  ||!Number.isSafeInteger(value.maxPostInstructionsTokens)||Number(value.maxPostInstructionsTokens)<1||Number(value.maxPostInstructionsTokens)>1_000_000
  ||!Number.isSafeInteger(value.maxOutputTokens)||Number(value.maxOutputTokens)<1||Number(value.maxOutputTokens)>4096)throw new VoiceSessionError('voice_budget_limits_invalid');
 return {maxPostInstructionsTokens:Number(value.maxPostInstructionsTokens),maxOutputTokens:Number(value.maxOutputTokens)};
}
const amount=(value:unknown):value is string=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const ceil=(value:bigint)=>(value+999_999n)/1_000_000n;
export function realtimeTariff(config:ProxyConfig,provider:string,model:string,now=Date.now()):TariffSnapshotEntry {
 const tariff=(config.tariffSnapshot??[]).filter(row=>row.provider===provider&&row.model===model&&row.accessMode==='byok'&&row.unit==='million_tokens'
  &&Date.parse(row.validFrom)<=now&&(row.validUntil===null||Date.parse(row.validUntil)>now)).sort((a,b)=>b.version-a.version)[0];
 if(!tariff||tariff.currency!=='USD'||!isDataRecord(tariff.realtimeAudioRates)||Object.keys(tariff.realtimeAudioRates).sort().join(',')!=='cachedInputMicrosPerMillion,inputMicrosPerMillion,outputMicrosPerMillion'
  ||!amount(tariff.inputMicrosPerMillion)||!amount(tariff.outputMicrosPerMillion)||!amount(tariff.cachedInputMicrosPerMillion)
  ||!amount(tariff.realtimeAudioRates.inputMicrosPerMillion)||!amount(tariff.realtimeAudioRates.outputMicrosPerMillion)||!amount(tariff.realtimeAudioRates.cachedInputMicrosPerMillion)
  ||!tariff.sourceUrl.startsWith('https://')||!Number.isFinite(Date.parse(tariff.checkedAt)))throw new VoiceSessionError('budget_cost_unknown');
 return structuredClone(tariff);
}
export function realtimeReservation(tariff:TariffSnapshotEntry,limits:VoiceBudgetLimits,instructions='') {
 const audio=tariff.realtimeAudioRates!;
 const inputTokens=limits.maxPostInstructionsTokens+Buffer.byteLength(instructions,'utf8')+VOICE_INSTRUCTION_ENVELOPE_TOKENS;
 const outputTokens=limits.maxOutputTokens;
 const max=(values:string[])=>values.map(BigInt).reduce((a,b)=>a>b?a:b);
 const inputRate=max([tariff.inputMicrosPerMillion,tariff.cachedInputMicrosPerMillion!,audio.inputMicrosPerMillion,audio.cachedInputMicrosPerMillion]);
 const outputRate=max([tariff.outputMicrosPerMillion,audio.outputMicrosPerMillion]);
 const costMicros=ceil(BigInt(inputTokens)*inputRate+BigInt(outputTokens)*outputRate).toString();
 if(costMicros.length>30)throw new VoiceSessionError('budget_cost_unknown');
 return {inputTokens,outputTokens,costMicros};
}
/** Cache is a subset of each input modality. Missing/contradictory use never means zero. */
export function realtimeUsageCost(value:unknown,tariff:TariffSnapshotEntry,limits:{inputTokens:number;outputTokens:number}):string {
 const fail=()=>{throw new VoiceSessionError('voice_usage_invalid','unknown');};
 if(!isDataRecord(value)||!isDataRecord(value.input_token_details)||!isDataRecord(value.output_token_details))return fail();
 const input=value.input_token_details,output=value.output_token_details;
 for(const n of [value.input_tokens,value.output_tokens,value.total_tokens,input.text_tokens,input.audio_tokens,input.cached_tokens,output.text_tokens,output.audio_tokens])if(!count(n))return fail();
 if((input.image_tokens!==undefined&&input.image_tokens!==0)||(output.image_tokens!==undefined&&output.image_tokens!==0))return fail();
 const cache=isDataRecord(input.cached_tokens_details)?input.cached_tokens_details:input.cached_tokens===0?{text_tokens:0,audio_tokens:0}:undefined;
 if(!cache||!count(cache.text_tokens)||!count(cache.audio_tokens)||(cache.image_tokens!==undefined&&cache.image_tokens!==0))return fail();
 const ti=Number(input.text_tokens),ai=Number(input.audio_tokens),tc=Number(cache.text_tokens),ac=Number(cache.audio_tokens),to=Number(output.text_tokens),ao=Number(output.audio_tokens);
 if(ti+ai!==value.input_tokens||to+ao!==value.output_tokens||Number(value.input_tokens)+Number(value.output_tokens)!==value.total_tokens
  ||tc+ac!==input.cached_tokens||tc>ti||ac>ai||Number(value.input_tokens)>limits.inputTokens||Number(value.output_tokens)>limits.outputTokens)return fail();
 const audio=tariff.realtimeAudioRates!;
 return ceil(BigInt(ti-tc)*BigInt(tariff.inputMicrosPerMillion)+BigInt(tc)*BigInt(tariff.cachedInputMicrosPerMillion!)
  +BigInt(ai-ac)*BigInt(audio.inputMicrosPerMillion)+BigInt(ac)*BigInt(audio.cachedInputMicrosPerMillion)
  +BigInt(to)*BigInt(tariff.outputMicrosPerMillion)+BigInt(ao)*BigInt(audio.outputMicrosPerMillion)).toString();
}
