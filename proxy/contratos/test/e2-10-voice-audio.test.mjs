import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_SESSION_MAX_DURATION_MS,
  VOICE_EVENT_TYPES,
  parseVoiceSession,
  canonicalVoiceSessionPayload,
  parseVoiceEvent,
  canonicalVoiceEventPayload,
  assertMonotonicVoiceEvents,
} from '../voice-session.js';
import {parseAudioChatPart, canonicalAudioChatPartPayload} from '../audio-chat.js';
import {parseModalityAdaptationPlan, canonicalModalityAdaptationPayload} from '../modality-adaptation.js';
import {detectAudioContainer, inspectAudioContainer, AUDIO_CONTAINER_TYPES} from '../audio-container.js';
import {parseGatewayChatRequest, GATEWAY_AUDIO_PART_MAX_BYTES} from '../gateway.js';

const session = {profileRevision:1,transport:'websocket',codec:'pcm16',sampleRate:16000,maxDurationMs:120000,allowedTools:['web_search'],turnPolicy:'server_vad'};
const artifactRef = {artifactId:'artifact_audio_1',sha256:'a'.repeat(64),byteLength:417,mediaType:'audio/mpeg'};

test('E2-10 VoiceSession validates transport, codec, sample rate, duration and the realtime session surface', () => {
  assert.equal(parseVoiceSession(session).transport,'websocket');
  assert.equal(canonicalVoiceSessionPayload(session),canonicalVoiceSessionPayload({...session,allowedTools:['web_search']}));
  const sota={...session,modalities:['text','audio'],voice:'alloy',inputAudioFormat:'pcm16',outputAudioFormat:'opus',
    instructions:'Be concise.',interruptResponse:true,temperature:0.8,toolChoice:'auto',maxResponseOutputTokens:4096};
  assert.deepEqual(parseVoiceSession(sota).modalities,['text','audio']);
  assert.equal(parseVoiceSession(sota).interruptResponse,true);
  for (const invalid of [
    {...session,transport:'carrier-pigeon'},
    {...session,codec:'mp3'},
    {...session,sampleRate:4000},
    {...session,maxDurationMs:VOICE_SESSION_MAX_DURATION_MS+1},
    {...session,turnPolicy:'interrupt'},
    {...session,allowedTools:['tool','tool']},
    {...session,allowedTools:['bad tool']},
    {...session,profileRevision:0},
    {...session,modalities:[]},
    {...session,modalities:['video']},
    {...session,voice:'bad voice'},
    {...session,inputAudioFormat:'mp3'},
    {...session,instructions:'x'.repeat(4001)},
    {...session,temperature:3},
    {...session,toolChoice:'always'},
    {...session,maxResponseOutputTokens:0},
  ]) assert.throws(() => parseVoiceSession(invalid),/voice_session_request_invalid/);
});

test('E2-10 VoiceEvent requires monotonic sequence and deduplicates final transcript, tool args and response', () => {
  const base = {sessionId:'session_1',runId:'run_1',turnId:'turn_1'};
  assert.equal(parseVoiceEvent({...base,sequence:0,type:'session_ready'}).type,'session_ready');
  assert.equal(parseVoiceEvent({...base,sequence:1,type:'audio_chunk',direction:'server',responseId:'resp_1',itemId:'item_1',usage:{audioMs:20}}).responseId,'resp_1');
  assert.equal(canonicalVoiceEventPayload({...base,sequence:1,type:'audio_chunk',usage:{audioMs:20}}),canonicalVoiceEventPayload({...base,sequence:1,type:'audio_chunk',usage:{audioMs:20}}));
  for (const invalid of [
    {...base,sequence:0,type:'unknown_type'},
    {...base,sequence:-1,type:'session_ready'},
    {...base,sequence:0,type:'session_ready',extra:true},
    {...base,sequence:0,type:'session_ready',usage:{inputTokens:-1}},
    {...base,sequence:0,type:'session_ready',direction:'sideways'},
    {...base,sequence:0,type:'session_ready',responseId:'bad id'},
    {sessionId:'session_1',runId:'run_1',turnId:'turn_1',type:'session_ready'},
  ]) assert.throws(() => parseVoiceEvent(invalid),/voice_session_event_invalid/);
  assert.ok(VOICE_EVENT_TYPES.includes('speech_started') && VOICE_EVENT_TYPES.includes('rate_limits') && VOICE_EVENT_TYPES.includes('function_arguments_done'));

  const ordered = [
    {...base,sequence:0,type:'session_ready'},
    {...base,sequence:1,type:'speech_started'},
    {...base,sequence:2,type:'transcript_final'},
    {...base,sequence:3,type:'response_done'},
  ];
  assert.equal(assertMonotonicVoiceEvents(ordered).length,4);
  // A tool loop legitimately produces a second response in the same turn; distinct responseIds are allowed.
  assert.equal(assertMonotonicVoiceEvents([...ordered,{...base,sequence:4,type:'response_done',responseId:'resp_2'}]).length,5);
  assert.throws(() => assertMonotonicVoiceEvents([ordered[1],ordered[0]]),/voice_session_sequence_invalid/);
  assert.throws(() => assertMonotonicVoiceEvents([...ordered,{...base,sequence:4,type:'transcript_final'}]),/voice_session_sequence_invalid/);
  assert.throws(() => assertMonotonicVoiceEvents([...ordered,{...base,sequence:4,type:'response_done'}]),/voice_session_sequence_invalid/);
  assert.throws(() => assertMonotonicVoiceEvents([{...base,sequence:0,type:'session_ready'},{...base,sequence:0,type:'input_committed'}]),/voice_session_sequence_invalid/);
});

test('E2-10 AudioChatPart binds an authorized artifact and refuses a mismatched format', () => {
  assert.equal(parseAudioChatPart({artifactRef,direction:'input',durationMs:1000,format:'mp3'}).artifactRef.mediaType,'audio/mpeg');
  assert.equal(parseAudioChatPart({artifactRef,direction:'output',durationMs:1000,format:'mp3',transcript:'olá',sampleRate:24000,channels:1}).transcript,'olá');
  assert.equal(canonicalAudioChatPartPayload({artifactRef,direction:'output',durationMs:0,format:'mp3'}),
    canonicalAudioChatPartPayload({artifactRef,direction:'output',durationMs:0,format:'mp3'}));
  for (const invalid of [
    {artifactRef,direction:'sideways',durationMs:1000,format:'mp3'},
    {artifactRef:{...artifactRef,mediaType:'audio/wav'},direction:'input',durationMs:1000,format:'mp3'},
    {artifactRef,direction:'input',durationMs:-1,format:'mp3'},
    {artifactRef,direction:'input',durationMs:1000,format:'flac'},
    {artifactRef:{...artifactRef,sha256:'nope'},direction:'input',durationMs:1000,format:'mp3'},
    {artifactRef,direction:'input',durationMs:1000,format:'mp3',url:'https://example.test/a.mp3'},
    {artifactRef,direction:'input',durationMs:1000,format:'mp3',sampleRate:1000},
    {artifactRef,direction:'input',durationMs:1000,format:'mp3',channels:3},
  ]) assert.throws(() => parseAudioChatPart(invalid),/audio_chat_part_invalid/);
});

test('E2-10 gateway chat admits a bounded input_audio part and refuses foreign or oversized parts', () => {
  const audio='A'.repeat(20_000);
  const chat={model:'openai/x',stream:false,max_tokens:64,messages:[{role:'user',content:[{type:'text',text:'Descreva.'},{type:'input_audio',input_audio:{data:audio,format:'wav'}}]}]};
  const parsed=parseGatewayChatRequest(chat);
  assert.equal(parsed.messages[0].content[1].input_audio.format,'wav');
  // The multimodal bound admits a chat above the 12 KB text-only limit.
  assert.ok(audio.length>12_000&&audio.length<GATEWAY_AUDIO_PART_MAX_BYTES);
  for(const bad of [
    {...chat,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:audio,format:'flac'}}]}]},
    {...chat,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'',format:'wav'}}]}]},
    {...chat,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://x/y.png'}}]}]},
    {...chat,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:audio,format:'wav'},extra:1}]}]},
    {...chat,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'!not-base64!',format:'wav'}}]}]},
  ]) assert.throws(()=>parseGatewayChatRequest(bad),/gateway_chat_invalid/);
  assert.throws(()=>parseGatewayChatRequest({...chat,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'A'.repeat(GATEWAY_AUDIO_PART_MAX_BYTES+4),format:'wav'}}]}]}),/gateway_chat_invalid/);
});

test('E2-10 audio containers are detected structurally and refuse a mismatched or truncated header', () => {
  const wav=new Uint8Array([0x52,0x49,0x46,0x46,0x08,0,0,0,0x57,0x41,0x56,0x45,0,0,0,0]);
  const ogg=new Uint8Array([0x4f,0x67,0x67,0x53,0,0,0,0,0,0,0,0]);
  const webm=new Uint8Array([0x1a,0x45,0xdf,0xa3,0,0,0,0,0,0,0,0]);
  const mp4=new Uint8Array([0,0,0,0x18,0x66,0x74,0x79,0x70,0,0,0,0]);
  assert.deepEqual(AUDIO_CONTAINER_TYPES,['audio/wav','audio/ogg','audio/webm','audio/mp4']);
  assert.equal(detectAudioContainer(wav),'audio/wav');
  assert.equal(detectAudioContainer(ogg),'audio/ogg');
  assert.equal(detectAudioContainer(webm),'audio/webm');
  assert.equal(detectAudioContainer(mp4),'audio/mp4');
  assert.equal(inspectAudioContainer(ogg,'audio/ogg').byteLength,ogg.byteLength);
  assert.throws(()=>inspectAudioContainer(wav,'audio/ogg'),/audio_container_invalid/);
  assert.throws(()=>inspectAudioContainer(ogg,'audio/wav'),/audio_container_invalid/);
  assert.throws(()=>inspectAudioContainer(new Uint8Array(8),'audio/ogg'),/audio_container_invalid/);
  const truncatedWav=new Uint8Array(wav);truncatedWav[4]=0xff;truncatedWav[5]=0xff;
  assert.throws(()=>inspectAudioContainer(truncatedWav,'audio/wav'),/audio_container_invalid/);
});

test('E2-10 ModalityAdaptationPlan requires per-transform lossiness/cost and bounds the chain', () => {
  const plan = {sourceRefs:[{artifactId:'artifact_audio_1',sha256:'a'.repeat(64),mediaType:'audio/mpeg'}],
    targetModelRevision:3,transforms:[{kind:'transcribe',lossiness:'high',costClass:'low',model:'openai/whisper-1'}],
    intermediateDestinations:['provider:custom'],lossNotice:['entonação perdida']};
  assert.deepEqual(parseModalityAdaptationPlan(plan).transforms[0],{kind:'transcribe',lossiness:'high',costClass:'low',model:'openai/whisper-1'});
  assert.equal(canonicalModalityAdaptationPayload(plan),canonicalModalityAdaptationPayload(plan));
  for (const invalid of [
    {...plan,transforms:[{kind:'transcribe',lossiness:'high',costClass:'low'},{kind:'ocr',lossiness:'low',costClass:'low'},{kind:'describe_image',lossiness:'low',costClass:'low'}]},
    {...plan,transforms:[{kind:'transcribe',lossiness:'high',costClass:'low'},{kind:'transcribe',lossiness:'low',costClass:'low'}]},
    {...plan,transforms:[]},
    {...plan,transforms:[{kind:'transcribe'}]},
    {...plan,transforms:[{kind:'transcribe',lossiness:'huge',costClass:'low'}]},
    {...plan,sourceRefs:[]},
    {...plan,intermediateDestinations:[]},
    {...plan,intermediateDestinations:['bad destination']},
    {...plan,lossNotice:['x'.repeat(281)]},
    {...plan,targetModelRevision:0},
  ]) assert.throws(() => parseModalityAdaptationPlan(invalid),/modality_adaptation_invalid/);
});
