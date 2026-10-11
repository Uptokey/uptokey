import {canonicalJson} from "../../../proxy/contratos/canonical.js";
import {parseImageRequest,parseImageWireRequest,imageProviderBody,imageEditBody} from "../../../proxy/contratos/image.js";
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
export function validateImageProfile(input) {
 const request=parseImageRequest({schemaVersion:1,model:input.model,prompt:'profile validation',n:1,size:'auto'});
 parseImageWireRequest({schemaVersion:1,driver:'9router',driverRevision:revision,provider:'openai-compatible-quimera-custom',model:request.model,url:input.endpoint,method:'POST',headers:{'content-type':'application/json'},body:canonicalJson(imageProviderBody(request))},request);
 if(input.editEndpoint!==undefined){
  const editRequest={...request,operation:'edit',inputRefs:[{artifactId:'profile-validation',sha256:'a'.repeat(64),bytes:8,mediaType:'image/png',role:'image'}]};
  parseImageWireRequest({schemaVersion:1,driver:'9router',driverRevision:revision,provider:'openai-compatible-quimera-custom',model:request.model,url:input.editEndpoint,method:'POST',headers:{'content-type':'multipart/form-data'},body:canonicalJson(imageEditBody(editRequest))},editRequest);
  if(new URL(input.editEndpoint).origin!==new URL(input.endpoint).origin)throw Error('image_profile_invalid');
 }
 return {model:request.model,endpoint:input.endpoint,...(input.editEndpoint!==undefined?{editEndpoint:input.editEndpoint}:{})};
}
export function parseImageCliArguments(args){
 const selected=args.filter(arg=>/^--image/i.test(arg));if(!selected.length)return;
 const edits=selected.filter(arg=>arg.startsWith('--image-edit-endpoint='));
 if(!(args[0]==='start'||args[0]==='proxy'&&args[1]==='start')||selected.length!==2+edits.length||edits.length>1||selected.filter(arg=>arg.startsWith('--image-model=')).length!==1||selected.filter(arg=>arg.startsWith('--image-endpoint=')).length!==1)throw new Error('image_profile_invalid');
 return validateImageProfile({model:selected.find(arg=>arg.startsWith('--image-model=')).slice(14),endpoint:selected.find(arg=>arg.startsWith('--image-endpoint=')).slice(17),...(edits.length?{editEndpoint:edits[0].slice('--image-edit-endpoint='.length)}:{})});
}
