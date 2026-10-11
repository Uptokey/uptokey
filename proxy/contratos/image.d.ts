import type {MediaInputRef} from './media-profile';
export const IMAGE_CONTRACT_VERSION: 1;
/** Local UTF-8 input bound; not a provider allowance. */
export const IMAGE_PROMPT_MAX_BYTES: 12000;
export const IMAGE_BATCH_MAX: 10;
/** E2-09: declared image operations; the pinned generation wire only executes 'generate'. */
export type ImageOperation='generate'|'edit'|'variation';
export const IMAGE_OPERATIONS:readonly ImageOperation[];
export interface ImageRequest {
  readonly schemaVersion: 1;
  /** openai/<opaque model ID>; syntax does not prove model availability. */
  readonly model: string;
  /** Required for generate/edit; optional context note for variation. */
  readonly prompt?: string;
  readonly n: number;
  /** auto or WxH, each dimension 1..16384. Provider support checked separately. */
  readonly size: string;
  readonly quality?: string;
  readonly style?: string;
  /** E2-09: normalized operation; absent input normalizes to 'generate'. */
  readonly operation: ImageOperation;
  /** E2-09: authorized project artifacts as inputs; empty for generate. */
  readonly inputRefs: MediaInputRef[];
  /** E2-09: optional mask artifact for edit only. */
  readonly maskRef?: MediaInputRef;
}
export interface ImageProviderBody {
  readonly model:string;readonly prompt:string;readonly n:number;readonly size:string;
  readonly quality?:string;readonly style?:string;readonly response_format?:'b64_json';
}
export interface ImageWireRequest {
  readonly schemaVersion:1;readonly driver:'9router';readonly driverRevision:string;
  readonly provider:string;readonly model:string;readonly url:string;readonly method:'POST';
  readonly headers:Readonly<{'content-type':'application/json'|'multipart/form-data';accept?:'application/json'}>;
  readonly body:string;
}
export function parseImageRequest(value:unknown):ImageRequest;
export function canonicalImagePayload(value:unknown):string;
/** Throws image_operation_unsupported when the request is not a generate operation. */
export function imageProviderBody(value:unknown):ImageProviderBody;
/** Pure multipart metadata bound to authorized artifact refs; contains no source bytes. */
export function imageEditBody(value:unknown):{readonly request:ImageRequest;readonly fields:Readonly<Record<string,string>>};
export function parseImageWireRequest(value:unknown,intent?:unknown):ImageWireRequest;
export function canonicalImageWirePayload(value:unknown,intent?:unknown):string;
/** Classifies a signature within WORKFLOW_LIMITS.artifactBytes; does not decode or prove integrity. */
export function detectImageMediaType(bytes:Uint8Array):'image/png'|'image/jpeg'|'image/webp';
