import {
  MEDIA_MODALITIES,
  MEDIA_SUPPORT_LEVELS,
  parseMediaProfileDescriptor,
  type MediaModality,
  type MediaProfileDescriptor,
  type MediaSupportLevel,
  type MediaBounds,
} from '@uptokey/sync-contract/media-profile';
import { MEDIA_DRIVER_REVISION } from './media-dispatch.ts';

export {
  MEDIA_MODALITIES,
  MEDIA_SUPPORT_LEVELS,
  parseMediaProfileDescriptor,
  type MediaModality,
  type MediaProfileDescriptor,
  type MediaSupportLevel,
  type MediaBounds,
};

export const DEFAULT_MEDIA_MODELS: Readonly<Record<MediaModality, string>> = Object.freeze({
  speech: 'openai/tts-1',
  image: 'openai/dall-e-3',
  video: 'openai/video-gen-1',
  transcription: 'openai/whisper-1',
  embeddings: 'openai/text-embedding-3-small',
});

export const DEFAULT_MEDIA_BOUNDS: Readonly<Record<MediaModality, { input: MediaBounds; output: MediaBounds }>> = Object.freeze({
  speech: {
    input: { mediaTypes: ['text/plain'], maxBytes: 4096, maxItems: 1 },
    output: { mediaTypes: ['audio/mpeg'], maxBytes: 52428800, maxItems: 1 },
  },
  image: {
    input: { mediaTypes: ['text/plain'], maxBytes: 4096, maxItems: 10 },
    output: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 20971520, maxItems: 10 },
  },
  video: {
    input: { mediaTypes: ['text/plain'], maxBytes: 4096, maxItems: 1 },
    output: { mediaTypes: ['video/mp4'], maxBytes: 104857600, maxItems: 1 },
  },
  transcription: {
    input: { mediaTypes: ['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4'], maxBytes: 26214400, maxItems: 1 },
    output: { mediaTypes: ['application/json'], maxBytes: 1048576, maxItems: 1 },
  },
  embeddings: {
    input: { mediaTypes: ['text/plain'], maxBytes: 131072, maxItems: 16 },
    output: { mediaTypes: ['application/json'], maxBytes: 1048576, maxItems: 1 },
  },
});

export function createCanonicalMediaProfile(
  modality: MediaModality,
  endpointOrigin: string = 'http://127.0.0.1:9090',
  options: Partial<Omit<MediaProfileDescriptor, 'schemaVersion' | 'modality' | 'endpoint'>> = {}
): MediaProfileDescriptor {
  const endpointPaths: Record<MediaModality, string> = {
    speech: '/v1/audio/speech',
    image: '/v1/images/generations',
    video: '/api/v1/videos',
    transcription: '/v1/audio/transcriptions',
    embeddings: '/v1/embeddings',
  };
  const url = new URL(endpointPaths[modality], endpointOrigin).href;
  const raw: MediaProfileDescriptor = {
    schemaVersion: 1,
    modality,
    supportLevel: options.supportLevel ?? 'custom_openai_compatible',
    driver: '9router',
    driverRevision: options.driverRevision ?? MEDIA_DRIVER_REVISION,
    endpoint: url,
    destination: 'custom',
    models: options.models ?? [DEFAULT_MEDIA_MODELS[modality]],
    mode: modality === 'video' ? 'job' : 'sync',
    cancellation: options.cancellation ?? 'local_abort_only',
    input: options.input ?? DEFAULT_MEDIA_BOUNDS[modality].input,
    output: options.output ?? DEFAULT_MEDIA_BOUNDS[modality].output,
    credential: 'local_vault:provider:custom',
    commercialVerification: options.commercialVerification ?? 'not_verified',
    termsCheckedAt: options.termsCheckedAt ?? '2026-09-18T00:00:00.000Z',
  };
  return parseMediaProfileDescriptor(raw);
}

export const CANONICAL_MEDIA_PROFILES: Readonly<Record<MediaModality, MediaProfileDescriptor>> = Object.freeze({
  speech: createCanonicalMediaProfile('speech'),
  image: createCanonicalMediaProfile('image'),
  video: createCanonicalMediaProfile('video'),
  transcription: createCanonicalMediaProfile('transcription'),
  embeddings: createCanonicalMediaProfile('embeddings'),
});

export function isModalitySupported(modality: string): modality is MediaModality {
  return MEDIA_MODALITIES.includes(modality as MediaModality);
}
