export const EMBEDDINGS_CONTRACT_VERSION:1;
export const EMBEDDINGS_INPUTS_MAX:number;
export const EMBEDDINGS_INPUT_MAX_BYTES:number;
export const EMBEDDINGS_TOTAL_MAX_BYTES:number;
export const EMBEDDINGS_DIMENSION_MAX:number;
export type EmbeddingsInput=Readonly<{kind:'text';text:string}>|Readonly<{kind:'artifact';artifactId:string;sha256:string}>;
export interface EmbeddingsRequest {readonly schemaVersion:1;readonly model:string;readonly inputs:readonly EmbeddingsInput[];readonly dimensions?:number;}
export interface EmbeddingsProviderBody {readonly model:string;readonly input:readonly string[];readonly encoding_format:'float';readonly dimensions?:number;}
export interface EmbeddingsWireRequest {
  readonly schemaVersion:1;readonly driver:'9router';readonly driverRevision:string;readonly provider:string;readonly model:string;
  readonly url:string;readonly method:'POST';readonly headers:Readonly<{'content-type':'application/json'}>;readonly body:string;
}
export interface EmbeddingsManifestInput {readonly index:number;readonly sha256:string;readonly byteLength:number;readonly source:Readonly<{kind:'text'}>|Readonly<{kind:'artifact';artifactId:string;sha256:string}>;}
export interface EmbeddingsManifest {
  readonly schemaVersion:1;readonly model:string;readonly modelRevision:string;readonly provider:string;readonly endpoint:string;
  readonly dimension:number;readonly inputs:readonly EmbeddingsManifestInput[];readonly vectors:readonly (readonly number[])[];
  readonly inputTokens:number|null;readonly requestDigest:string;readonly wireDigest:string;readonly observedAt:string;
}
export function parseEmbeddingsRequest(value:unknown):EmbeddingsRequest;
export function canonicalEmbeddingsPayload(value:unknown):string;
export function embeddingsProviderBody(value:unknown,texts:readonly string[]):EmbeddingsProviderBody;
export function parseEmbeddingsWireRequest(value:unknown,intent?:unknown):EmbeddingsWireRequest;
export function canonicalEmbeddingsWirePayload(value:unknown,intent?:unknown):string;
export function normalizeEmbeddingsResponse(body:unknown,request:unknown):Readonly<{dimension:number;vectors:readonly (readonly number[])[];inputTokens:number|null}>;
export function parseEmbeddingsManifest(value:unknown):EmbeddingsManifest;
export function assertComparableEmbeddings(left:unknown,right:unknown):[EmbeddingsManifest,EmbeddingsManifest];
export function cosineSimilarity(left:readonly number[],right:readonly number[]):number|null;
export function embeddingSimilarityMatrix(left:unknown,right?:unknown):(number|null)[][];
