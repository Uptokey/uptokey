import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSpeechRequest,canonicalSpeechPayload,parseSpeechWireRequest,canonicalSpeechWirePayload,SPEECH_INPUT_MAX_BYTES} from '../speech.js';
const request={schemaVersion:1,model:'openai/tts-1/alloy',input:'  Olá, mundo!\n'};
test('captured speech wire binds destination and rejects credentials or ignored JSON',()=>{
  const wire={schemaVersion:1,driver:'9router',driverRevision:'a'.repeat(40),provider:'openai-compatible-fixture',
    model:request.model,url:'http://127.0.0.1:1234/v1/audio/speech',method:'POST',headers:{'content-type':'application/json'},
    body:'{"input":"Hello","model":"tts-1","voice":"alloy"}'};
  assert.ok(Object.isFrozen(parseSpeechWireRequest(wire).headers));
  let coerced=0;
  assert.throws(()=>parseSpeechWireRequest({...wire,url:{toString(){coerced++;return wire.url;}}}),/speech_wire_invalid/);
  assert.equal(coerced,0,'invalid URL objects must not execute coercion hooks');
  assert.notEqual(canonicalSpeechWirePayload(wire),canonicalSpeechWirePayload({...wire,url:'http://127.0.0.1:1235/v1/audio/speech'}));
  for(const url of ['http://example.com/v1/audio/speech','https://key@example.com/v1/audio/speech','https://example.com/v1/audio/speech?key=x'])
    assert.throws(()=>parseSpeechWireRequest({...wire,url}));
  assert.throws(()=>parseSpeechWireRequest({...wire,headers:{...wire.headers,authorization:'secret'}}));
  assert.throws(()=>parseSpeechWireRequest({...wire,body:'{"input":"first","input":"second","model":"tts-1","voice":"alloy"}'}));
  assert.throws(()=>parseSpeechWireRequest({...wire,body:'{"input":"Hello","model":"tts-1","speed":2,"voice":"alloy"}'}));
});

test('speech intent preserves literal text and binds model/voice catalog ID',()=>{
  const parsed=parseSpeechRequest(request);assert.equal(parsed.input,request.input);assert.ok(Object.isFrozen(parsed));
  assert.equal(canonicalSpeechPayload(request),canonicalSpeechPayload({input:request.input,model:request.model,schemaVersion:1}));
  assert.notEqual(canonicalSpeechPayload(request),canonicalSpeechPayload({...request,model:'openai/tts-1/nova'}));
  assert.notEqual(canonicalSpeechPayload(request),canonicalSpeechPayload({...request,input:request.input.trim()}));
});
test('speech rejects ignored options, destinations and secrets instead of discarding them',()=>{
  for(const key of ['speed','voice','response_format','url','apiKey','headers','signal'])
    assert.throws(()=>parseSpeechRequest({...request,[key]:'unapproved'}),/speech_request_invalid/);
  for(const input of ['', ' \n', '\0', '\ud800'])assert.throws(()=>parseSpeechRequest({...request,input}));
  assert.throws(()=>parseSpeechRequest({...request,schemaVersion:2}));
});
test('speech uses a UTF8 byte limit and refuses accessors without invoking them',()=>{
  parseSpeechRequest({...request,input:'a'.repeat(SPEECH_INPUT_MAX_BYTES)});
  assert.throws(()=>parseSpeechRequest({...request,input:'é'.repeat(SPEECH_INPUT_MAX_BYTES/2+1)}));
  let invoked=0;const hostile={...request};Object.defineProperty(hostile,'input',{enumerable:true,get(){invoked++;return 'bad';}});
  assert.throws(()=>parseSpeechRequest(hostile));assert.equal(invoked,0);
});
