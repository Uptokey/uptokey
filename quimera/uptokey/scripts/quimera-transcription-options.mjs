import {parseTranscriptionRequest,parseTranscriptionWireRequest} from "../../../proxy/contratos/transcription.js";
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
const invalid=()=>new Error('transcription_profile_invalid');
/** Pure validation, deliberately callable before native secret-store initialization. */
export function parseTranscriptionCliArguments(args) {
 const selected=args.filter(value=>/^--transcription/i.test(value));if(!selected.length)return;
 const start=args[0]==='start'||args[0]==='proxy'&&args[1]==='start';
 if(!start||selected.length!==2||selected.filter(v=>v.startsWith('--transcription-model=')).length!==1||selected.filter(v=>v.startsWith('--transcription-endpoint=')).length!==1)throw invalid();
 return validateTranscriptionProfile({model:selected.find(v=>v.startsWith('--transcription-model=')).slice(22),endpoint:selected.find(v=>v.startsWith('--transcription-endpoint=')).slice(25)});
}
export function validateTranscriptionProfile(input) {
 const request=parseTranscriptionRequest({schemaVersion:1,model:input.model,
   audio:{artifactId:'profile_validation',sha256:'0'.repeat(64),byteLength:1,mediaType:'audio/mpeg'},timestamps:true});
 const url=new URL(input.endpoint);if(url.href!==input.endpoint||url.pathname!=='/v1/audio/transcriptions')throw invalid();
 parseTranscriptionWireRequest({schemaVersion:1,driver:'9router',driverRevision:revision,provider:'openai-compatible-quimera-custom',model:request.model,
   url:input.endpoint,method:'POST',encoding:'multipart/form-data',
   fields:[['model',request.model.slice('openai/'.length)],['response_format','verbose_json']],
   file:{field:'file',filename:'audio.mp3',mediaType:'audio/mpeg',sha256:'0'.repeat(64),byteLength:1}},request);
 return {model:request.model,endpoint:input.endpoint};
}
