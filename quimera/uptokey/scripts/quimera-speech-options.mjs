import {canonicalJson} from "../../../proxy/contratos/canonical.js";
import {parseSpeechRequest,parseSpeechWireRequest} from "../../../proxy/contratos/speech.js";
const invalid=()=>new Error('speech_profile_invalid');
/** Pure validation, deliberately callable before native secret-store initialization. */
export function parseSpeechCliArguments(args) {
 const selected=args.filter(value=>/^--speech/i.test(value));if(!selected.length)return;
 const start=args[0]==='start'||args[0]==='proxy'&&args[1]==='start';
 if(!start||selected.length!==2||selected.filter(v=>v.startsWith('--speech-model=')).length!==1||selected.filter(v=>v.startsWith('--speech-endpoint=')).length!==1)throw invalid();
 return validateSpeechProfile({model:selected.find(v=>v.startsWith('--speech-model=')).slice(15),endpoint:selected.find(v=>v.startsWith('--speech-endpoint=')).slice(18)});
}
export function validateSpeechProfile(input) {
 const request=parseSpeechRequest({schemaVersion:1,model:input.model,input:'profile validation'}),parts=request.model.split('/');
 if(parts.length!==3||parts[0]!=='openai'||parts.slice(1).some(p=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p)))throw invalid();
 const url=new URL(input.endpoint);if(url.href!==input.endpoint||url.pathname!=='/v1/audio/speech')throw invalid();
 parseSpeechWireRequest({schemaVersion:1,driver:'9router',driverRevision:'17c4cc76877bd1755030a8414f8d0083f48dcccf',provider:'openai-compatible-quimera-custom',model:request.model,url:input.endpoint,method:'POST',headers:{'content-type':'application/json'},body:canonicalJson({input:request.input,model:parts[1],voice:parts[2]})});
 return {model:request.model,endpoint:input.endpoint};
}
