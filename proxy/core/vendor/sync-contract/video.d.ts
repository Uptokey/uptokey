import type {MediaInputRef} from './media-profile';
export const VIDEO_CONTRACT_VERSION:1;
export const VIDEO_PROMPT_MAX_BYTES:12000;
export const VIDEO_POLL_INTERVAL_MS:30000;
export type VideoJobStatus='pending'|'in_progress'|'completed'|'failed'|'cancelled'|'expired';
export const VIDEO_JOB_STATUSES:readonly VideoJobStatus[];
/** E2-09: declared video operations; derived from inputRefs, never stored as a separate field. */
export type VideoOperation='text_to_video'|'image_to_video';
export const VIDEO_OPERATIONS:readonly VideoOperation[];
export interface VideoRequest {readonly schemaVersion:1;readonly model:string;readonly prompt:string;readonly duration:number;readonly aspectRatio:string;readonly resolution:string;readonly generateAudio:boolean;readonly seed?:number;
  readonly firstFrameUrl?:string;
  /** E2-09: at most one authorized image artifact; presence selects image_to_video. */
  readonly inputRefs:MediaInputRef[]}
export interface VideoProviderBody {readonly model:string;readonly prompt:string;readonly duration:number;readonly aspect_ratio:string;readonly resolution:string;readonly generate_audio:boolean;readonly seed?:number;readonly frame_images?:readonly {type:'image_url';image_url:{url:string};frame_type:'first_frame'}[];}
export interface VideoWireRequest {readonly schemaVersion:1;readonly driver:'9router';readonly driverRevision:string;readonly provider:string;readonly model:string;readonly url:string;readonly method:'POST';readonly headers:Readonly<{'content-type':'application/json';accept:'application/json'}>;readonly body:string;}
export interface VideoStatus {readonly jobId:string;readonly status:VideoJobStatus;}
export interface VideoJob extends VideoStatus {readonly schemaVersion:1;readonly model:string;readonly provider:string;readonly endpoint:string;readonly requestDigest:string;readonly wireDigest:string;readonly observedAt:string;}
/** PROPOSED E2-09: validated provider ingress event; state evidence only, never a generation authority. */
export interface VideoDelivery {readonly schemaVersion:1;readonly jobId:string;readonly workspaceId:string;readonly destinationRef:string;readonly eventId:string;readonly status:VideoJobStatus;readonly contentDigest:string|null;readonly issuedAt:string;readonly signature:string;}
export function parseVideoRequest(v:unknown):VideoRequest;
export function parseVideoFrameUrl(v:unknown):string;
export function canonicalVideoPayload(v:unknown):string;
/** E2-09: derived operation of a parsed request. */
export function videoRequestOperation(v:unknown):VideoOperation;
/** Throws video_operation_invalid when the request carries inputRefs. */
export function videoProviderBody(v:unknown):VideoProviderBody;
export function parseVideoEndpoint(v:unknown):string;
export function parseVideoWireRequest(v:unknown,intent?:unknown):VideoWireRequest;
export function canonicalVideoWirePayload(v:unknown,intent?:unknown):string;
export function parseVideoStatus(v:unknown):VideoStatus;
export function parseVideoJob(v:unknown):VideoJob;
export function canonicalVideoJob(v:unknown):string;
export function videoJobUrl(endpoint:string,id:string,operation:'poll'|'content'):string;
export function parseVideoDelivery(v:unknown):VideoDelivery;
export function canonicalVideoDelivery(v:unknown):string;
/** Signature classification only; does not decode video. */
export function detectVideoMediaType(bytes:Uint8Array):'video/mp4';
