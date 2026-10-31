import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImageRequest,canonicalImagePayload,imageProviderBody,imageEditBody,parseImageWireRequest,canonicalImageWirePayload,detectImageMediaType,IMAGE_PROMPT_MAX_BYTES,IMAGE_BATCH_MAX} from '../image.js';
import {canonicalJson} from '../canonical.js';
import {WORKFLOW_LIMITS} from '../workflow.js';

const request = {schemaVersion:1,model:'openai/provider/model-v2',prompt:'Um céu azul 🌤️',n:3,size:'1536x1024',quality:'high',style:'natural'};
const wire = (intent=request) => ({schemaVersion:1,driver:'9router',driverRevision:'17c4cc76877bd1755030a8414f8d0083f48dcccf',provider:'openai-compatible-quimera-custom',model:intent.model,url:'https://example.test/v1/images/generations',method:'POST',headers:{'content-type':'application/json'},body:canonicalJson(imageProviderBody(intent))});

test('strict image intent preserves batch, Unicode and optional provider options', () => {
  // E2-09 normalization: absent operation/inputRefs become generate + empty refs.
  assert.deepEqual(parseImageRequest(request),{...request,operation:'generate',inputRefs:[]});
  assert.ok(Object.isFrozen(parseImageRequest(request)));
  assert.equal(parseImageRequest({...request,n:IMAGE_BATCH_MAX,size:'auto'}).n,10);
  assert.equal(parseImageRequest({...request,size:'16384x1'}).size,'16384x1');
  assert.equal(canonicalImagePayload(request),canonicalJson({...request,operation:'generate',inputRefs:[]}));
  assert.equal(new TextEncoder().encode(parseImageRequest({...request,prompt:'é'.repeat(IMAGE_PROMPT_MAX_BYTES/2)}).prompt).length,IMAGE_PROMPT_MAX_BYTES);
  for(const patch of [{schemaVersion:2},{model:'gemini/model'},{model:'openai/'},{prompt:''},{prompt:'  '},{prompt:'a\0b'},{prompt:'\ud800'},{prompt:'é'.repeat(6001)},{n:0},{n:11},{n:1.5},{size:'0x12'},{size:'16385x1'},{size:'01024x1024'},{size:'1024 X 1024'},{quality:undefined},{quality:'a b'},{style:42},{extra:'ignored'}]) {
    assert.throws(()=>parseImageRequest({...request,...patch}),/image_request_invalid/);
  }
  assert.throws(()=>parseImageRequest(Object.defineProperty({...request},'prompt',{get(){throw Error('getter called');},enumerable:true})),/image_request_invalid/);
});

test('image wire binds all approved fields and keeps only explicit secret-free headers', () => {
  const outbound=wire();
  assert.deepEqual(parseImageWireRequest(outbound,request),outbound);
  assert.equal(canonicalImageWirePayload(outbound,request),canonicalJson(outbound));
  assert.ok(Object.isFrozen(parseImageWireRequest(outbound).headers));
  assert.equal(JSON.parse(outbound.body).model,'provider/model-v2');
  assert.equal(JSON.parse(outbound.body).response_format,'b64_json');
  for(const patch of [{prompt:'different'},{n:2},{size:'auto'},{quality:'low'},{style:'vivid'},{model:'openai/other'}]) {
    assert.throws(()=>parseImageWireRequest(wire({...request,...patch}),request),/image_wire_invalid/);
  }
  const noOption={schemaVersion:1,model:'openai/model',prompt:'x',n:1,size:'auto'};
  assert.equal(parseImageWireRequest(wire(noOption),noOption).body,canonicalJson({model:'model',prompt:'x',n:1,size:'auto',response_format:'b64_json'}));
  assert.throws(()=>parseImageWireRequest(wire({...noOption,quality:'auto'}),noOption),/image_wire_invalid/);
  for(const patch of [{method:'GET'},{driverRevision:'main'},{model:'openai/different'},{headers:{'content-type':'application/json',authorization:'Bearer example'}},{headers:{'content-type':'application/json',accept:undefined}},{provider:'custom'}]) {
    assert.throws(()=>parseImageWireRequest({...outbound,...patch}),/image_wire_invalid/);
  }
});

test('image wire rejects duplicate/noncanonical JSON, unknown fields and URL downloads', () => {
  const outbound=wire();
  for(const body of [outbound.body.replace('"n":3','"n":2,"n":3'),JSON.stringify(imageProviderBody(request),null,2),canonicalJson({...imageProviderBody(request),response_format:'url'}),canonicalJson({...imageProviderBody(request),output_format:'webp'}),canonicalJson({...imageProviderBody(request),model:'another'}),'x'.repeat(WORKFLOW_LIMITS.commandBytes+1)]) {
    assert.throws(()=>parseImageWireRequest({...outbound,body}),/image_wire_invalid/);
  }
  for(const url of ['http://example.test/v1/images/generations','https://example.test/other/v1/images/generations','https://example.test/v1/images/generations?key=x','https://user@example.test/v1/images/generations','https://example.test/v1/images/generations#x','https://example.test/v1/images/../images/generations']) {
    assert.throws(()=>parseImageWireRequest({...outbound,url}),/image_wire_invalid/);
  }
  assert.equal(parseImageWireRequest({...outbound,url:'http://127.0.0.1:1234/v1/images/generations'}).url,'http://127.0.0.1:1234/v1/images/generations');
});

const imageRef = {artifactId:'artifact_1',bytes:10,mediaType:'image/png',role:'image',sha256:'a'.repeat(64)};
const maskRef = {artifactId:'artifact_2',bytes:10,mediaType:'image/png',role:'mask',sha256:'b'.repeat(64)};
test('multipart edit wire binds source refs and fields, and rejects swapped source, endpoint or injected options',()=>{
 const edit={schemaVersion:1,model:'openai/gpt-image-1',operation:'edit',prompt:'edit',n:1,size:'auto',inputRefs:[imageRef]};
 const outbound={...wire({schemaVersion:1,model:edit.model,prompt:'edit',n:1,size:'auto'}),url:'https://example.test/v1/images/edits',headers:{'content-type':'multipart/form-data'},body:canonicalJson(imageEditBody(edit))};
 assert.deepEqual(parseImageWireRequest(outbound,edit),outbound);
 assert.equal(imageProviderBody({schemaVersion:1,model:edit.model,prompt:'x',n:1,size:'auto'}).response_format,undefined);
 const swapped={...edit,inputRefs:[{...imageRef,sha256:'f'.repeat(64)}]};assert.throws(()=>parseImageWireRequest({...outbound,body:canonicalJson(imageEditBody(swapped))},edit));
 const extra=imageEditBody(edit);assert.throws(()=>parseImageWireRequest({...outbound,body:canonicalJson({...extra,fields:{...extra.fields,user:'injected'}})},edit));
 assert.throws(()=>parseImageWireRequest({...outbound,url:'https://example.test/v1/images/generations'},edit));
 assert.throws(()=>imageEditBody({...edit,style:'vivid'}));
});
test('E2-09: edit and variation bind authorized input artifacts and a mask, generate rejects them', () => {
  const edit = parseImageRequest({...request,operation:'edit',inputRefs:[imageRef],maskRef});
  assert.deepEqual(edit.inputRefs,[imageRef]);assert.deepEqual(edit.maskRef,maskRef);assert.equal(edit.operation,'edit');
  const variation = parseImageRequest({schemaVersion:1,model:request.model,n:2,size:'auto',operation:'variation',inputRefs:[imageRef]});
  assert.equal(variation.operation,'variation');assert.equal('prompt' in variation,false);assert.equal(variation.inputRefs.length,1);
  for(const bad of [
    {...request,operation:'invented'},
    {...request,operation:'edit'},
    {...request,operation:'edit',inputRefs:[imageRef],extra:'ignored'},
    {...request,operation:'variation'},
    {...request,operation:'variation',inputRefs:[]},
    {...request,operation:'variation',inputRefs:[imageRef,imageRef]},
    {...request,operation:'variation',maskRef},
    {...request,operation:'generate',inputRefs:[imageRef]},
    {...request,maskRef},
    {...request,operation:'edit',inputRefs:[imageRef],maskRef:{...maskRef,role:'image'}},
    {...request,operation:'edit',inputRefs:[imageRef,{...imageRef,role:'mask'}]},
    {...request,operation:'edit',inputRefs:[imageRef,{...imageRef,artifactId:'artifact_1'}]},
    {...request,operation:'edit',inputRefs:[{...imageRef,bytes:0}]},
    {...request,operation:'edit',inputRefs:[{...imageRef,mediaType:'video/mp4'}]},
    {...request,operation:'edit',inputRefs:[{...imageRef,artifactId:'../escape'}]},
  ]) assert.throws(()=>parseImageRequest(bad),/image_(request|input|mask|operation)_invalid|media_input_invalid/);
  assert.throws(()=>imageProviderBody({...request,operation:'edit',inputRefs:[imageRef]}),/image_operation_unsupported/);
  // The pinned generation wire cannot carry edit inputs: intent binding fails before any effect.
  const editBody = canonicalJson({model:'provider/model-v2',prompt:'Um céu azul 🌤️',n:3,size:'1536x1024',quality:'high',style:'natural',response_format:'b64_json'});
  assert.throws(()=>parseImageWireRequest({...wire(),body:editBody},{...request,operation:'edit',inputRefs:[imageRef]}),/image_wire_invalid/);
  assert.doesNotThrow(()=>parseImageWireRequest(wire(request),{...request,operation:'generate',inputRefs:[]}));
});

test('image signatures cover PNG JPEG WebP and enforce the shared artifact byte bound', () => {
  const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const jpeg=Uint8Array.from([255,216,255]);
  const webp=Uint8Array.from([82,73,70,70,4,0,0,0,87,69,66,80]);
  assert.equal(detectImageMediaType(png),'image/png');
  assert.equal(detectImageMediaType(jpeg),'image/jpeg');
  assert.equal(detectImageMediaType(webp),'image/webp');
  const bounded=new Uint8Array(WORKFLOW_LIMITS.artifactBytes);bounded.set(png);
  assert.equal(detectImageMediaType(bounded),'image/png');
  const oversized=new Uint8Array(WORKFLOW_LIMITS.artifactBytes+1);oversized.set(png);
  for(const bytes of [[],new Uint8Array(),png.slice(0,7),jpeg.slice(0,2),webp.slice(0,11),new TextEncoder().encode('<svg/>'),oversized]) {
    assert.throws(()=>detectImageMediaType(bytes),/image_bytes_invalid/);
  }
  // Signatures are intentionally not advertised as complete-file validation.
});
