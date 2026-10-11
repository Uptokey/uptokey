export const MEDIA_PROFILE_CONTRACT_VERSION:1;
export type ManagedMediaKind='image'|'video'|'speech'|'transcription';
export const MANAGED_MEDIA_KINDS:readonly ManagedMediaKind[];
export interface MediaConfigurationProfile {readonly connectionId:'custom'|string;readonly providerId?:string;readonly model:string;readonly endpoint:string;readonly editEndpoint?:string;readonly imageOrigins?:readonly string[];}
export interface MediaConfigurationRequest extends MediaConfigurationProfile {readonly expectedRevision:number;readonly connectionRevision:string;}
export interface MediaModelChoice {readonly id:string;readonly label?:string;}
export interface MediaProviderChoice {readonly id:string;readonly label:string;readonly endpoint:string;readonly editEndpoint?:string;readonly models:readonly MediaModelChoice[];readonly modelSource:'catalog'|'manual';readonly documentationUrl:string|null;readonly getKeyUrl?:string;}
export interface MediaConfigurationInfo {
  readonly kind:ManagedMediaKind;readonly mode:'managed'|'startup';readonly configured:boolean;readonly available:boolean;
  readonly profileRevision:number;readonly profile:MediaConfigurationProfile|null;
  readonly connections:readonly {readonly id:'custom'|string;readonly providerId?:string;readonly label:string;readonly endpointOrigin:string;readonly revision:string;readonly endpoint?:string;readonly editEndpoint?:string;readonly models?:readonly MediaModelChoice[];readonly modelSource?:'catalog'|'manual'}[];
  readonly providers?:readonly MediaProviderChoice[];
  readonly error?:string;
}
export function parseMediaConfigurationRequest(kind:ManagedMediaKind,input:unknown):MediaConfigurationRequest;
export function parseMediaConfigurationInfo(input:unknown):MediaConfigurationInfo;
export type MediaModality='speech'|'image'|'video'|'transcription'|'embeddings';
export type MediaSupportLevel='native'|'experimental'|'custom_openai_compatible'|'research_only';
export const MEDIA_MODALITIES:readonly MediaModality[];
export const MEDIA_SUPPORT_LEVELS:readonly MediaSupportLevel[];
/** E2-09: declared operation names per modality; a profile may advertise only this subset. */
export type MediaOperation='generate'|'edit'|'variation'|'text_to_video'|'image_to_video';
export const MEDIA_OPERATIONS:Readonly<Partial<Record<MediaModality,readonly MediaOperation[]>>>;
export type MediaInputRole='image'|'mask'|'video'|'frame';
export const MEDIA_INPUT_ROLES:readonly MediaInputRole[];
/** E2-09: reference to an authorized project artifact used as media input. Identity is artifactId + digest + byte count. */
export type MediaInputRef = {
  readonly artifactId:string;
  /** sha256 hex digest of the artifact bytes. */
  readonly sha256:string;
  readonly mediaType:string;
  readonly role:MediaInputRole;
  readonly bytes:number;
};
export function parseMediaInputRef(value:unknown):MediaInputRef;
export interface MediaBounds {readonly mediaTypes:readonly string[];readonly maxBytes:number|null;readonly maxItems:number|null;}
export interface MediaProfileDescriptor {
  readonly schemaVersion:1;readonly modality:MediaModality;readonly supportLevel:MediaSupportLevel;
  readonly driver:'9router';readonly driverRevision:string;readonly endpoint:string;readonly destination:'custom'|string;
  readonly models:readonly string[];readonly mode:'sync'|'job';
  /** local_abort_only: local abort does not prove the provider stopped or did not bill. */
  readonly cancellation:'local_abort_only'|'none';
  readonly input:MediaBounds;readonly output:MediaBounds;
  readonly credential:'local_vault:provider:custom'|string;
  readonly commercialVerification:'not_verified'|'verified';readonly termsCheckedAt:string|null;
  /** E2-09: operations the configured endpoint declares; image/video only. Normalized: omitted input keeps the legacy single-operation default. */
  readonly operations?:readonly MediaOperation[];
}
export function parseMediaProfileDescriptor(value:unknown):MediaProfileDescriptor;
