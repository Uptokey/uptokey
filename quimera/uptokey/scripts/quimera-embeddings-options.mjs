import {canonicalJson} from "../../../proxy/contratos/canonical.js";
import {parseEmbeddingsRequest,parseEmbeddingsWireRequest,embeddingsProviderBody} from "../../../proxy/contratos/embeddings.js";
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
export function validateEmbeddingsProfile(input){
 const request=parseEmbeddingsRequest({schemaVersion:1,model:input.model,inputs:[{kind:'text',text:'profile validation'}]});
 parseEmbeddingsWireRequest({schemaVersion:1,driver:'9router',driverRevision:revision,provider:'openai-compatible-quimera-custom',model:request.model,url:input.endpoint,method:'POST',headers:{'content-type':'application/json'},body:canonicalJson(embeddingsProviderBody(request,['profile validation']))},request);
 return {model:request.model,endpoint:input.endpoint};
}
export function parseEmbeddingsCliArguments(args){
 const selected=args.filter(arg=>/^--embeddings/i.test(arg));if(!selected.length)return;
 if(!(args[0]==='start'||args[0]==='proxy'&&args[1]==='start')||selected.length!==2||selected.filter(arg=>arg.startsWith('--embeddings-model=')).length!==1||selected.filter(arg=>arg.startsWith('--embeddings-endpoint=')).length!==1)throw Error('embeddings_profile_invalid');
 return validateEmbeddingsProfile({model:selected.find(arg=>arg.startsWith('--embeddings-model=')).slice('--embeddings-model='.length),endpoint:selected.find(arg=>arg.startsWith('--embeddings-endpoint=')).slice('--embeddings-endpoint='.length)});
}
