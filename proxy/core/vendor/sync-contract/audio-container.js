/** PROPOSED E2-10: structural container detection for speech-to-text input beyond MP3. Does not decode audio. */
import {WORKFLOW_LIMITS} from './workflow.js';

export const AUDIO_CONTAINER_CONTRACT_VERSION = 1;
export const AUDIO_CONTAINER_TYPES = Object.freeze(['audio/wav','audio/ogg','audio/webm','audio/mp4']);
const fail = () => {throw new Error('audio_container_invalid');};

/**
 * Detect a container from its leading bytes only. MP3 is handled by the transcription contract's `inspectMp3`;
 * this module adds the common speech containers the OpenAI-compatible upload endpoint also accepts.
 */
export function detectAudioContainer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12) return undefined;
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'audio/wav';
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'audio/mp4';
  return undefined;
}

/** Validate that the declared media type matches the detected container and the RIFF size is not truncated. */
export function inspectAudioContainer(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 12 || bytes.byteLength > WORKFLOW_LIMITS.artifactBytes) fail();
  if (!AUDIO_CONTAINER_TYPES.includes(mediaType) || detectAudioContainer(bytes) !== mediaType) fail();
  if (mediaType === 'audio/wav') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 > bytes.byteLength) fail();
  }
  return Object.freeze({mediaType, byteLength:bytes.byteLength});
}
