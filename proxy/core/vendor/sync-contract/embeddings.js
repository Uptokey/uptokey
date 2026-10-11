/** Embeddings intent, captured request and persisted manifest. Parsing never authorizes an effect. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';
import {WORKFLOW_LIMITS} from './workflow.js';

export const EMBEDDINGS_CONTRACT_VERSION = 1;
/** Local bounds chosen below documented OpenAI limits (2048 inputs, 8192 tokens each); not provider allowances. */
export const EMBEDDINGS_INPUTS_MAX = 32;
export const EMBEDDINGS_INPUT_MAX_BYTES = 8_000;
export const EMBEDDINGS_TOTAL_MAX_BYTES = 48_000;
export const EMBEDDINGS_DIMENSION_MAX = 8_192;
const fail = kind => {throw new Error(`embeddings_${kind}_invalid`);};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const artifactId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const utf8 = value => new TextEncoder().encode(value).byteLength;
const cleanText = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
  new TextDecoder().decode(new TextEncoder().encode(value)) === value && utf8(value) <= EMBEDDINGS_INPUT_MAX_BYTES;

function input(value) {
  if (keys(value, ['kind','text']) && value.kind === 'text' && cleanText(value.text)) return Object.freeze({...value});
  if (keys(value, ['kind','artifactId','sha256']) && value.kind === 'artifact' && artifactId(value.artifactId) && hash(value.sha256)) return Object.freeze({...value});
  fail('request');
}
/** Inputs are literal texts or selected text artifacts bound by hash; order is significant. */
export function parseEmbeddingsRequest(value) {
  if (!keys(value, ['schemaVersion','model','inputs'], ['dimensions']) || value.schemaVersion !== 1) fail('request');
  if (typeof value.model !== 'string' || !/^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,198}$/.test(value.model)) fail('request');
  if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > EMBEDDINGS_INPUTS_MAX) fail('request');
  if (Object.hasOwn(value, 'dimensions') && (!Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > EMBEDDINGS_DIMENSION_MAX)) fail('request');
  const inputs = value.inputs.map(input);
  if (new Set(inputs.filter(item => item.kind === 'artifact').map(item => item.artifactId)).size !== inputs.filter(item => item.kind === 'artifact').length) fail('request');
  return Object.freeze({...value, inputs:Object.freeze(inputs)});
}
export function canonicalEmbeddingsPayload(value) {return canonicalJson(parseEmbeddingsRequest(value));}

/** Exact body for the pinned OpenAI-compatible embeddings adapter; texts are the resolved inputs in order. */
export function embeddingsProviderBody(value, texts) {
  const request = parseEmbeddingsRequest(value);
  if (!Array.isArray(texts) || texts.length !== request.inputs.length || !texts.every(cleanText) ||
      texts.reduce((sum, text) => sum + utf8(text), 0) > EMBEDDINGS_TOTAL_MAX_BYTES ||
      request.inputs.some((item, i) => item.kind === 'text' && item.text !== texts[i])) fail('request');
  return Object.freeze({model:request.model.slice('openai/'.length), input:Object.freeze([...texts]), encoding_format:'float',
    ...(request.dimensions !== undefined ? {dimensions:request.dimensions} : {})});
}

export function parseEmbeddingsWireRequest(value, intent) {
  if (!keys(value, ['schemaVersion','driver','driverRevision','provider','model','url','method','headers','body']) ||
      value.schemaVersion !== 1 || value.driver !== '9router' || typeof value.driverRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.driverRevision) ||
      typeof value.provider !== 'string' || !/^openai-compatible-[a-z0-9-]{1,90}$/.test(value.provider) || value.method !== 'POST') fail('wire');
  if (typeof value.url !== 'string' || value.url.length > 2048) fail('wire');
  let url;try {url = new URL(value.url);} catch {fail('wire');}
  if (url.href !== value.url || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/embeddings' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) fail('wire');
  if (!keys(value.headers, ['content-type']) || value.headers['content-type'] !== 'application/json') fail('wire');
  if (typeof value.body !== 'string' || utf8(value.body) > WORKFLOW_LIMITS.commandBytes / 2) fail('wire');
  let body;try {body = JSON.parse(value.body);} catch {fail('wire');}
  if (!keys(body, ['model','input','encoding_format'], ['dimensions']) || body.encoding_format !== 'float' || !Array.isArray(body.input)) fail('wire');
  try {
    const request = intent !== undefined ? parseEmbeddingsRequest(intent) :
      parseEmbeddingsRequest({schemaVersion:1, model:value.model, inputs:body.input.map(text => ({kind:'text', text})), ...(Object.hasOwn(body,'dimensions') ? {dimensions:body.dimensions} : {})});
    if (request.model !== value.model || canonicalJson(embeddingsProviderBody(request, body.input)) !== value.body) fail('wire');
  } catch {fail('wire');}
  return Object.freeze({...value, headers:Object.freeze({...value.headers})});
}
export function canonicalEmbeddingsWirePayload(value, intent) {return canonicalJson(parseEmbeddingsWireRequest(value, intent));}

const vectorOf = (value, dimension) => Array.isArray(value) && value.length === dimension && value.every(n => typeof n === 'number' && Number.isFinite(n));
/**
 * OpenAI-compatible response → vectors in input order. Refuses count/index/dimension mismatch,
 * non-finite values and base64 payloads. Usage is null when unreported.
 */
export function normalizeEmbeddingsResponse(body, request) {
  const intent = parseEmbeddingsRequest(request);
  if (!isDataRecord(body) || !Array.isArray(body.data) || body.data.length !== intent.inputs.length) fail('response');
  const ordered = new Array(intent.inputs.length);
  for (const item of body.data) {
    if (!isDataRecord(item) || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= ordered.length || ordered[item.index]) fail('response');
    if (!Array.isArray(item.embedding)) fail('response');
    ordered[item.index] = item.embedding;
  }
  const dimension = ordered[0]?.length;
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > EMBEDDINGS_DIMENSION_MAX ||
      intent.dimensions !== undefined && dimension !== intent.dimensions || !ordered.every(vector => vectorOf(vector, dimension))) fail('response');
  const tokens = body.usage?.prompt_tokens;
  return Object.freeze({dimension, vectors:Object.freeze(ordered.map(vector => Object.freeze([...vector]))),
    inputTokens:Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null});
}

function manifestInput(value, index) {
  if (!keys(value, ['index','sha256','byteLength','source']) || value.index !== index || !hash(value.sha256) ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > EMBEDDINGS_INPUT_MAX_BYTES) fail('manifest');
  const source = value.source;
  if (!(keys(source, ['kind']) && source.kind === 'text' || keys(source, ['kind','artifactId','sha256']) && source.kind === 'artifact' && artifactId(source.artifactId) && hash(source.sha256))) fail('manifest');
  return Object.freeze({...value, source:Object.freeze({...source})});
}
/** Persisted result. Model, revision, endpoint and dimension define the vector space; inputs keep order and source authorization. */
export function parseEmbeddingsManifest(value) {
  if (!keys(value, ['schemaVersion','model','modelRevision','provider','endpoint','dimension','inputs','vectors','inputTokens','requestDigest','wireDigest','observedAt']) ||
      value.schemaVersion !== 1 || typeof value.model !== 'string' || !/^openai\//.test(value.model) ||
      typeof value.modelRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.modelRevision) ||
      typeof value.provider !== 'string' || typeof value.endpoint !== 'string' || !Number.isSafeInteger(value.dimension) ||
      value.dimension < 1 || value.dimension > EMBEDDINGS_DIMENSION_MAX || !Array.isArray(value.inputs) || value.inputs.length < 1 ||
      value.inputs.length > EMBEDDINGS_INPUTS_MAX || !Array.isArray(value.vectors) || value.vectors.length !== value.inputs.length ||
      !value.vectors.every(vector => vectorOf(vector, value.dimension)) || value.inputTokens !== null && (!Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0) ||
      !hash(value.requestDigest) || !hash(value.wireDigest) || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) fail('manifest');
  return Object.freeze({...value, inputs:Object.freeze(value.inputs.map(manifestInput)), vectors:Object.freeze(value.vectors.map(vector => Object.freeze([...vector])))});
}

/** Vectors from different model/revision/endpoint/dimension are not comparable; refuse instead of guessing. */
export function assertComparableEmbeddings(left, right) {
  const a = parseEmbeddingsManifest(left), b = parseEmbeddingsManifest(right);
  if (a.model !== b.model || a.modelRevision !== b.modelRevision || a.endpoint !== b.endpoint || a.provider !== b.provider || a.dimension !== b.dimension) throw new Error('embeddings_space_mismatch');
  return [a, b];
}
export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) fail('vector');
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) {dot += left[i] * right[i];a += left[i] ** 2;b += right[i] ** 2;}
  if (!(a > 0 && b > 0)) return null;
  const value = dot / Math.sqrt(a * b);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : null;
}
/** Optional local consumer: pairwise similarity between two comparable manifests (or one manifest with itself). */
export function embeddingSimilarityMatrix(left, right = left) {
  const [a, b] = assertComparableEmbeddings(left, right);
  return a.vectors.map(x => b.vectors.map(y => cosineSimilarity(x, y)));
}
