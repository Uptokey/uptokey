export const AUDIO_CONTAINER_CONTRACT_VERSION:1;
export type AudioContainerType='audio/wav'|'audio/ogg'|'audio/webm'|'audio/mp4';
export const AUDIO_CONTAINER_TYPES:readonly AudioContainerType[];
export function detectAudioContainer(bytes:Uint8Array):AudioContainerType|undefined;
export function inspectAudioContainer(bytes:Uint8Array,mediaType:AudioContainerType):Readonly<{mediaType:AudioContainerType;byteLength:number}>;
