import {canonicalJson} from "../../../proxy/contratos/canonical.js";
import {parseVideoRequest,parseVideoWireRequest,videoProviderBody,parseVideoFrameUrl} from "../../../proxy/contratos/video.js";
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
export function validateVideoProfile(input) {
 const request=parseVideoRequest({schemaVersion:1,model:input.model,prompt:'profile validation',duration:5,aspectRatio:'16:9',resolution:'720p',generateAudio:false});
 parseVideoWireRequest({schemaVersion:1,driver:'9router',driverRevision:revision,provider:'openai-compatible-quimera-custom',model:request.model,url:input.endpoint,method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:canonicalJson(videoProviderBody(request))},request);
 if(input.imageOrigins!==undefined&&(!Array.isArray(input.imageOrigins)||input.imageOrigins.length<1||input.imageOrigins.length>8||new Set(input.imageOrigins).size!==input.imageOrigins.length||input.imageOrigins.some(origin=>{try{return new URL(parseVideoFrameUrl(origin+'/frame.png')).origin!==origin;}catch{return true;}})))throw Error('video_profile_invalid');
 return {model:request.model,endpoint:input.endpoint,...(input.imageOrigins?{imageOrigins:[...input.imageOrigins]}:{})};
}
export function parseVideoCliArguments(args){
 const selected=args.filter(arg=>/^--video/i.test(arg));if(!selected.length)return;
 const origins=selected.filter(arg=>arg.startsWith('--video-image-origin='));
 if(!(args[0]==='start'||args[0]==='proxy'&&args[1]==='start')||selected.length!==2+origins.length||selected.filter(arg=>arg.startsWith('--video-model=')).length!==1||selected.filter(arg=>arg.startsWith('--video-endpoint=')).length!==1)throw new Error('video_profile_invalid');
 return validateVideoProfile({model:selected.find(arg=>arg.startsWith('--video-model=')).slice(14),endpoint:selected.find(arg=>arg.startsWith('--video-endpoint=')).slice(17),...(origins.length?{imageOrigins:origins.map(arg=>arg.slice('--video-image-origin='.length))}:{})});
}

