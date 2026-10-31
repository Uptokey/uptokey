import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../canonical.js';
import {inspectMp3,parseTranscriptionRequest,transcriptionProviderFields,parseTranscriptionWireRequest,normalizeTranscriptionResponse,parseTranscriptionResult} from '../transcription.js';
import {parseEmbeddingsRequest,embeddingsProviderBody,parseEmbeddingsWireRequest,normalizeEmbeddingsResponse,parseEmbeddingsManifest,assertComparableEmbeddings,embeddingSimilarityMatrix} from '../embeddings.js';
import {parseMediaProfileDescriptor,parseMediaInputRef,MEDIA_OPERATIONS} from '../media-profile.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Synthetic MPEG-1 Layer III frame: 128 kbit/s, 44.1 kHz, no padding -> 417 bytes. Silence, not speech.
export function syntheticMp3(frames = 3) {const frame = new Uint8Array(417);frame.set([0xff,0xfb,0x90,0x00]);const out = new Uint8Array(417 * frames);for (let i = 0; i < frames; i++) out.set(frame, i * 417);return out;}
const mp3 = syntheticMp3();
const audio = {artifactId:'upload_1', sha256:sha(mp3), byteLength:mp3.byteLength, mediaType:'audio/mpeg'};
const stt = {schemaVersion:1, model:'openai/whisper-1', audio, timestamps:true, language:'pt'};
const sttWire = {schemaVersion:1, driver:'9router', driverRevision:'a'.repeat(40), provider:'openai-compatible-local', model:stt.model,
  url:'http://127.0.0.1:1/v1/audio/transcriptions', method:'POST', encoding:'multipart/form-data',
  fields:transcriptionProviderFields(stt).map(pair => [...pair]), file:{field:'file', filename:'audio.mp3', mediaType:'audio/mpeg', sha256:audio.sha256, byteLength:audio.byteLength}};

test('MP3 structure: valid frames pass; truncation, foreign bytes and fake MIME fail', () => {
  const info = inspectMp3(mp3);
  assert.equal(info.frames, 3);assert.equal(info.durationSeconds, 0.078);
  const id3 = new Uint8Array([0x49,0x44,0x33,4,0,0,0,0,0,2,0,0,...mp3]);
  assert.equal(inspectMp3(id3).frames, 3);
  const tagged = new Uint8Array(mp3.byteLength + 128);tagged.set(mp3);tagged.set([0x54,0x41,0x47], mp3.byteLength);
  assert.equal(inspectMp3(tagged).frames, 3);
  for (const bad of [mp3.subarray(0, mp3.byteLength - 1), new Uint8Array([0x49,0x44,0x33,4,0,0,0,0,0,0]), new TextEncoder().encode('RIFF....WAVEfmt '),
    new Uint8Array([137,80,78,71,13,10,26,10]), new Uint8Array([...mp3, 1, 2, 3])]) assert.throws(() => inspectMp3(bad), /transcription_audio_invalid/);
});

test('transcription request binds artifact hash and exact multipart fields; wire changes are refused', () => {
  assert.deepEqual(transcriptionProviderFields(stt), [['model','whisper-1'],['language','pt'],['response_format','verbose_json']]);
  assert.deepEqual(transcriptionProviderFields({schemaVersion:1, model:stt.model, audio, timestamps:false}).map(p => p[0]), ['model','response_format']);
  assert.equal(parseTranscriptionWireRequest(sttWire, stt).file.sha256, audio.sha256);
  for (const wire of [{...sttWire, fields:[['model','whisper-1'],['response_format','verbose_json']]}, {...sttWire, file:{...sttWire.file, sha256:'b'.repeat(64)}},
    {...sttWire, url:'http://127.0.0.1:1/v1/audio/translations'}, {...sttWire, url:'http://example.com/v1/audio/transcriptions'},
    {...sttWire, fields:[...sttWire.fields, ['prompt','x']]}]) assert.throws(() => parseTranscriptionWireRequest(wire, stt), /transcription_wire_invalid/);
  for (const request of [{...stt, audio:{...audio, mediaType:'audio/flac'}}, {...stt, language:'portuguese'}, {...stt, audio:{...audio, artifactId:'../x'}}, {...stt, path:'C:/x.mp3'}])
    assert.throws(() => parseTranscriptionRequest(request), /transcription_request_invalid/);
  // E2-10: common speech containers are admitted; the artifact identity is still hash-bound.
  assert.equal(parseTranscriptionRequest({...stt, audio:{...audio, mediaType:'audio/wav'}}).audio.mediaType,'audio/wav');
  assert.equal(parseTranscriptionRequest({...stt, audio:{...audio, mediaType:'audio/ogg'}}).audio.mediaType,'audio/ogg');
});

test('transcript normalization never invents language, timestamps or text', () => {
  assert.deepEqual(normalizeTranscriptionResponse({text:''}, stt), {text:'', language:null, durationSeconds:null, segments:null});
  const verbose = normalizeTranscriptionResponse({text:'Olá', language:'portuguese', duration:1.5, segments:[{id:0, start:0, end:1.5, text:'Olá', tokens:[1]}]}, stt);
  assert.deepEqual(verbose.segments, [{start:0, end:1.5, text:'Olá'}]);assert.equal(verbose.language, 'portuguese');
  assert.equal(normalizeTranscriptionResponse({text:'x', segments:[{start:0, end:1, text:'x'}]}, {...stt, timestamps:false}).segments, null);
  for (const body of [{}, {text:1}, {text:'x', segments:[{start:2, end:1, text:'x'}]}, {text:'x', segments:[{start:Number.NaN, end:1, text:'x'}]}])
    assert.throws(() => normalizeTranscriptionResponse(body, stt), /transcription_(response|result)_invalid/);
  const result = {schemaVersion:1, text:'', language:null, durationSeconds:null, segments:null, timestampsRequested:true, source:{artifactId:'upload_1', sha256:audio.sha256},
    model:stt.model, provider:'openai-compatible-local', endpoint:sttWire.url, requestDigest:'c'.repeat(64), wireDigest:'d'.repeat(64), observedAt:'2026-09-18T00:00:00.000Z'};
  assert.equal(parseTranscriptionResult(result).segments, null);
  assert.throws(() => parseTranscriptionResult({...result, language:'<script>'}), /transcription_result_invalid/);
});

const embed = {schemaVersion:1, model:'openai/text-embedding-3-small', inputs:[{kind:'text', text:'alfa'}, {kind:'artifact', artifactId:'note_1', sha256:'e'.repeat(64)}], dimensions:3};
const embedWire = {schemaVersion:1, driver:'9router', driverRevision:'a'.repeat(40), provider:'openai-compatible-local', model:embed.model,
  url:'http://127.0.0.1:1/v1/embeddings', method:'POST', headers:{'content-type':'application/json'}, body:canonicalJson(embeddingsProviderBody(embed, ['alfa','beta nota']))};
test('embeddings wire binds resolved texts, order, model and dimensions', () => {
  assert.deepEqual(JSON.parse(embedWire.body), {dimensions:3, encoding_format:'float', input:['alfa','beta nota'], model:'text-embedding-3-small'});
  assert.equal(parseEmbeddingsWireRequest(embedWire, embed).model, embed.model);
  assert.throws(() => embeddingsProviderBody(embed, ['beta nota','alfa']), /embeddings_request_invalid/);
  assert.throws(() => embeddingsProviderBody(embed, ['alfa']), /embeddings_request_invalid/);
  assert.throws(() => parseEmbeddingsWireRequest({...embedWire, body:canonicalJson({...JSON.parse(embedWire.body), dimensions:4})}, embed), /embeddings_wire_invalid/);
  assert.throws(() => parseEmbeddingsWireRequest({...embedWire, body:JSON.stringify(JSON.parse(embedWire.body), null, 1)}, embed), /embeddings_wire_invalid/);
  for (const request of [{...embed, inputs:[]}, {...embed, dimensions:0}, {...embed, inputs:[{kind:'text', text:' '}]}, {...embed, inputs:[embed.inputs[1], embed.inputs[1]]}])
    assert.throws(() => parseEmbeddingsRequest(request), /embeddings_request_invalid/);
});

test('embeddings normalization keeps input order and refuses NaN, divergent dimension and base64', () => {
  const out = normalizeEmbeddingsResponse({data:[{index:1, embedding:[0,1,0]}, {index:0, embedding:[1,0,0]}], usage:{prompt_tokens:5}}, embed);
  assert.deepEqual(out.vectors, [[1,0,0],[0,1,0]]);assert.equal(out.inputTokens, 5);assert.equal(out.dimension, 3);
  assert.equal(normalizeEmbeddingsResponse({data:[{index:0, embedding:[1,0,0]}, {index:1, embedding:[0,1,0]}]}, embed).inputTokens, null);
  for (const data of [[{index:0, embedding:[1,0,0]}], [{index:0, embedding:[1,0,Number.NaN]}, {index:1, embedding:[0,1,0]}],
    [{index:0, embedding:[1,0,0]}, {index:1, embedding:[0,1]}], [{index:0, embedding:'AAAA'}, {index:1, embedding:[0,1,0]}],
    [{index:0, embedding:[1,0,0]}, {index:0, embedding:[0,1,0]}], [{index:0, embedding:[1,0,0,0]}, {index:1, embedding:[0,1,0,0]}]])
    assert.throws(() => normalizeEmbeddingsResponse({data}, embed), /embeddings_response_invalid/);
});

test('manifests from different model or revision are not compared', () => {
  const manifest = {schemaVersion:1, model:embed.model, modelRevision:'2026-09-18', provider:'openai-compatible-local', endpoint:embedWire.url, dimension:3,
    inputs:[{index:0, sha256:'1'.repeat(64), byteLength:4, source:{kind:'text'}}, {index:1, sha256:'2'.repeat(64), byteLength:9, source:{kind:'artifact', artifactId:'note_1', sha256:'e'.repeat(64)}}],
    vectors:[[1,0,0],[0,1,0]], inputTokens:null, requestDigest:'3'.repeat(64), wireDigest:'4'.repeat(64), observedAt:'2026-09-18T00:00:00.000Z'};
  assert.deepEqual(embeddingSimilarityMatrix(manifest), [[1,0],[0,1]]);
  assert.throws(() => assertComparableEmbeddings(manifest, {...manifest, modelRevision:'2026-10-01'}), /embeddings_space_mismatch/);
  assert.throws(() => assertComparableEmbeddings(manifest, {...manifest, model:'openai/other'}), /embeddings_space_mismatch/);
  assert.throws(() => parseEmbeddingsManifest({...manifest, vectors:[[1,0,0],[0,Infinity,0]]}), /embeddings_manifest_invalid/);
  assert.deepEqual(embeddingSimilarityMatrix({...manifest, vectors:[[0,0,0],[0,1,0]]})[0], [null, null]);
});

test('profile descriptor cannot declare native support without commercial verification', () => {
  const profile = {schemaVersion:1, modality:'transcription', supportLevel:'custom_openai_compatible', driver:'9router', driverRevision:'a'.repeat(40),
    endpoint:'http://127.0.0.1:1/v1/audio/transcriptions', destination:'custom', models:['openai/whisper-1'], mode:'sync', cancellation:'local_abort_only',
    input:{mediaTypes:['audio/mpeg'], maxBytes:5242880, maxItems:1}, output:{mediaTypes:['application/json'], maxBytes:5242880, maxItems:1},
    credential:'local_vault:provider:custom', commercialVerification:'not_verified', termsCheckedAt:null};
  assert.equal(parseMediaProfileDescriptor(profile).supportLevel, 'custom_openai_compatible');
  for (const bad of [{...profile, supportLevel:'native'}, {...profile, endpoint:'http://127.0.0.1:1/v1/embeddings'}, {...profile, mode:'job'}, {...profile, credential:'sk-live'}])
    assert.throws(() => parseMediaProfileDescriptor(bad), /media_profile_invalid/);
});

test('E2-09: media input refs are artifact identity only; profiles declare only their modality operations', () => {
  const imageRef = {artifactId:'artifact_1', bytes:8, mediaType:'image/png', role:'image', sha256:'e'.repeat(64)};
  assert.deepEqual(parseMediaInputRef(imageRef), imageRef);
  assert.ok(Object.isFrozen(parseMediaInputRef(imageRef)));
  for (const bad of [
    {...imageRef, artifactId:'../escape'},
    {...imageRef, sha256:'Z'.repeat(64)},
    {...imageRef, bytes:0},
    {...imageRef, bytes:Number.MAX_SAFE_INTEGER},
    {...imageRef, mediaType:'text/html'},
    {...imageRef, role:'invented'},
    {...imageRef, role:'mask', mediaType:'image/jpeg'},
    {...imageRef, role:'video', mediaType:'image/png'},
    {...imageRef, role:'frame', mediaType:'video/mp4'},
    {...imageRef, path:'C:/input.png'},
  ]) assert.throws(() => parseMediaInputRef(bad), /media_input_invalid/);
  const imageProfile = {schemaVersion:1, modality:'image', supportLevel:'experimental', driver:'9router', driverRevision:'a'.repeat(40),
    endpoint:'http://127.0.0.1:1/v1/images/generations', destination:'custom', models:['openai/model'], mode:'sync', cancellation:'local_abort_only',
    input:{mediaTypes:['text/plain'], maxBytes:4096, maxItems:1}, output:{mediaTypes:['image/png'], maxBytes:2097152, maxItems:10},
    credential:'local_vault:provider:custom', commercialVerification:'not_verified', termsCheckedAt:null};
  // Omitted operations keep the legacy single-operation posture; declared subsets are frozen.
  assert.deepEqual(parseMediaProfileDescriptor(imageProfile).operations, ['generate']);
  assert.deepEqual(parseMediaProfileDescriptor({...imageProfile, operations:['generate','edit']}).operations, ['generate','edit']);
  assert.deepEqual(parseMediaProfileDescriptor({...imageProfile, operations:MEDIA_OPERATIONS.image}).operations, MEDIA_OPERATIONS.image);
  for (const bad of [{...imageProfile, operations:[]}, {...imageProfile, operations:['generate','generate']}, {...imageProfile, operations:['text_to_video']},
    {...imageProfile, operations:['invented']}, {...imageProfile, operations:'generate'}])
    assert.throws(() => parseMediaProfileDescriptor(bad), /media_profile_invalid/);
  // Modalities without declared media operations refuse the field instead of inventing one.
  const transcriptionProfile = {schemaVersion:1, modality:'transcription', supportLevel:'custom_openai_compatible', driver:'9router', driverRevision:'a'.repeat(40),
    endpoint:'http://127.0.0.1:1/v1/audio/transcriptions', destination:'custom', models:['openai/whisper-1'], mode:'sync', cancellation:'local_abort_only',
    input:{mediaTypes:['audio/mpeg'], maxBytes:5242880, maxItems:1}, output:{mediaTypes:['application/json'], maxBytes:5242880, maxItems:1},
    credential:'local_vault:provider:custom', commercialVerification:'not_verified', termsCheckedAt:null};
  assert.throws(() => parseMediaProfileDescriptor({...transcriptionProfile, operations:['generate']}), /media_profile_invalid/);
});
