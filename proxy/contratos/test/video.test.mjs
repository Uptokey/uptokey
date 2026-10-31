import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '../canonical.js';
import {parseArtifact,WORKFLOW_LIMITS} from '../workflow.js';
import {parseVideoRequest,canonicalVideoPayload,videoRequestOperation,videoProviderBody,parseVideoWireRequest,parseVideoJob,parseVideoStatus,videoJobUrl,detectVideoMediaType,parseVideoDelivery,canonicalVideoDelivery} from '../video.js';
const request={schemaVersion:1,model:'openrouter/vendor/model',prompt:'Vídeo literal',duration:8,aspectRatio:'16:9',resolution:'720p',generateAudio:false};
const wire=()=>({schemaVersion:1,driver:'9router',driverRevision:'a'.repeat(40),provider:'openai-compatible-video',model:request.model,url:'https://example.test/api/v1/videos',method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:canonicalJson(videoProviderBody(request))});
const job=()=>({schemaVersion:1,jobId:'job_1',status:'pending',model:request.model,provider:'openai-compatible-video',endpoint:wire().url,requestDigest:'1'.repeat(64),wireDigest:'2'.repeat(64),observedAt:'2026-09-18T00:00:00.000Z'});

const frameRef={artifactId:'frame_1',bytes:10,mediaType:'image/png',role:'image',sha256:'c'.repeat(64)};
test('public first frame preserves exact URL and frame type in the approved creation wire',()=>{
 const requestWithFrame={...request,firstFrameUrl:'https://cdn.example.com/frame.png'};
 assert.equal(videoRequestOperation(requestWithFrame),'image_to_video');
 const captured={...wire(),body:canonicalJson(videoProviderBody(requestWithFrame))};assert.doesNotThrow(()=>parseVideoWireRequest(captured,requestWithFrame));
 assert.deepEqual(JSON.parse(captured.body).frame_images,[{type:'image_url',image_url:{url:requestWithFrame.firstFrameUrl},frame_type:'first_frame'}]);
 for(const firstFrameUrl of ['http://cdn.example.com/frame.png','https://127.0.0.1/a','https://[::1]/a','https://intranet/a','https://host.local/a','https://host.internal/a','https://u:p@cdn.example.com/a','https://cdn.example.com/a#fragment'])assert.throws(()=>parseVideoRequest({...request,firstFrameUrl}));
 assert.throws(()=>parseVideoRequest({...requestWithFrame,inputRefs:[frameRef]}));
 assert.throws(()=>parseVideoWireRequest({...captured,body:canonicalJson({...JSON.parse(captured.body),frame_images:[{type:'image_url',image_url:{url:requestWithFrame.firstFrameUrl},frame_type:'last_frame'}]})},requestWithFrame));
});
test('video intent preserves exact parameters and rejects authority, missing fields and unbounded values',()=>{
  // E2-09 normalization: absent inputRefs stay an empty array.
  assert.deepEqual(parseVideoRequest(request),{...request,inputRefs:[]});assert.equal(canonicalVideoPayload(request),canonicalJson({...request,inputRefs:[]}));
  assert.deepEqual(videoProviderBody(request),{model:'vendor/model',prompt:'Vídeo literal',duration:8,aspect_ratio:'16:9',resolution:'720p',generate_audio:false});
  for(const patch of [{model:'openai/video'},{prompt:'\ud800'},{prompt:'x'.repeat(12001)},{duration:0},{duration:121},{duration:1.5},{resolution:'1080'},{resolution:'9999p'},{aspectRatio:'16:0'},{generateAudio:undefined},{callback_url:'https://example.test/callback'},{seed:-1},{seed:2**32},{inputRefs:[frameRef,frameRef]},{inputRefs:[{...frameRef,role:'video'}]},{inputRefs:[{...frameRef,bytes:0}]}])assert.throws(()=>parseVideoRequest({...request,...patch}));
  assert.doesNotThrow(()=>parseVideoRequest({...request,seed:0}));
});
test('E2-09: image_to_video binds one authorized frame and the pinned creation wire stays text-only',()=>{
  const imageToVideo=parseVideoRequest({...request,inputRefs:[frameRef]});
  assert.equal(videoRequestOperation(imageToVideo),'image_to_video');assert.equal(videoRequestOperation(request),'text_to_video');
  assert.deepEqual(imageToVideo.inputRefs,[frameRef]);
  assert.throws(()=>videoProviderBody(imageToVideo),/video_operation_invalid/);
  const creation=wire();
  assert.throws(()=>parseVideoWireRequest(creation,imageToVideo),/video_wire_invalid/);
  assert.doesNotThrow(()=>parseVideoWireRequest(creation,parseVideoRequest(request)));
});
test('E2-09: VideoDelivery ingress event validates identity, replay fields and signature shape',()=>{
  const delivery={schemaVersion:1,jobId:'job_1',workspaceId:'ws_1',destinationRef:'custom',eventId:'event_1',status:'completed',contentDigest:'d'.repeat(64),issuedAt:'2026-09-20T00:00:00.000Z',signature:'sig_1234567890ABCDEF._-'};
  assert.deepEqual(parseVideoDelivery(delivery),delivery);
  assert.equal(canonicalVideoDelivery(delivery),canonicalJson(delivery));
  assert.doesNotThrow(()=>parseVideoDelivery({...delivery,contentDigest:null}));
  for(const patch of [{schemaVersion:2},{jobId:'..'},{workspaceId:''},{status:'invented'},{contentDigest:'x'},{issuedAt:'2026-02-30T00:00:00.000Z'},{signature:'short'},{signature:'x'.repeat(513)},{signature:'a b'},{extra:'ignored'}])
   assert.throws(()=>parseVideoDelivery({...delivery,...patch}),/video_delivery_invalid/);
});
test('captured creation request binds every option and contains no credential or alternative destination',()=>{
 assert.deepEqual(parseVideoWireRequest(wire(),request),wire());
 for(const patch of [{model:'openrouter/other/model'},{url:'https://example.test/api/v1/videos?key=x'},{url:'http://example.test/api/v1/videos'},{url:'https://u:p@example.test/api/v1/videos'},{url:'https://example.test/v1/images/generations'},{headers:{...wire().headers,authorization:'Bearer synthetic'}},{body:JSON.stringify(videoProviderBody(request))}])assert.throws(()=>parseVideoWireRequest({...wire(),...patch},request));
 for(const [key,value] of [['duration',9],['generate_audio',true],['resolution','1080p'],['aspect_ratio','9:16'],['model','different'],['prompt','changed']])assert.throws(()=>parseVideoWireRequest({...wire(),body:canonicalJson({...videoProviderBody(request),[key]:value})},request));
 assert.throws(()=>parseVideoWireRequest({...wire(),body:canonicalJson({...videoProviderBody(request),provider:{order:['other']}})},request));
});
test('durable job rejects returned URLs and invalid dates; content is always constructed under its endpoint',()=>{
 assert.deepEqual(parseVideoJob(job()),job());
 for(const patch of [{polling_url:'https://other.test'},{unsigned_urls:['https://other.test']},{observedAt:'2026-02-30T00:00:00.000Z'},{jobId:'..'},{jobId:'\ud800'},{requestDigest:'invalid'},{status:'invented'}])assert.throws(()=>parseVideoJob({...job(),...patch}));
 assert.deepEqual(parseVideoStatus({jobId:'job',status:'completed'}),{jobId:'job',status:'completed'});
 assert.throws(()=>parseVideoStatus({jobId:'job',status:'completed',error:'raw body'}));
 assert.equal(videoJobUrl(job().endpoint,'x/y ?#','content'),job().endpoint+'/x%2Fy%20%3F%23/content?index=0');
 assert.throws(()=>videoJobUrl(job().endpoint,'..','poll'));
});
test('video media allowance is specific to MP4 and signature classification does not admit images or HTML',()=>{
 const bytes=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,109,112,52,50]);
 assert.equal(detectVideoMediaType(bytes),'video/mp4');
 for(const bad of [new TextEncoder().encode('<html>not a video</html>'),bytes.subarray(0,15),Uint8Array.from(bytes,(v,i)=>i===3?99:v),Uint8Array.from(bytes,(v,i)=>i===8||i===16?120:v)])assert.throws(()=>detectVideoMediaType(bad));
 const a={schemaVersion:1,id:'video',createdAt:'2026-09-18T00:00:00.000Z',projectId:'project',runId:'run',version:1,mediaType:'video/mp4',filename:'video.mp4',byteLength:WORKFLOW_LIMITS.videoArtifactBytes,sha256:'1'.repeat(64),receiptRefs:[],sourceRefs:[]};
 assert.doesNotThrow(()=>parseArtifact(a));assert.throws(()=>parseArtifact({...a,byteLength:a.byteLength+1}));
 for(const mediaType of ['text/plain','application/json','audio/mpeg','image/png'])assert.throws(()=>parseArtifact({...a,mediaType}));
});
