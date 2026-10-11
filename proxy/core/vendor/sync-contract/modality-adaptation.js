/** PROPOSED E2-10: governed modality-adaptation plan (image→description/OCR, audio→transcription). */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';

export const MODALITY_ADAPTATION_CONTRACT_VERSION = 1;
/** Local pilot bound; a chain longer than this requires a new plan and authorization. */
export const ADAPTATION_MAX_TRANSFORMS = 2;
export const ADAPTATION_TRANSFORM_KINDS = Object.freeze(['transcribe','describe_image','ocr']);
export const ADAPTATION_LOSSINESS = Object.freeze(['none','low','high']);
export const ADAPTATION_COST_CLASSES = Object.freeze(['none','low','high']);
const fail = () => {throw new Error('modality_adaptation_invalid');};
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const stableId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function sourceRef(value) {
  if (!keys(value, ['artifactId','mediaType','sha256'])) fail();
  if (!stableId(value.artifactId) || !digest(value.sha256) || typeof value.mediaType !== 'string' ||
      !/^[a-z]+\/[A-Za-z0-9.+-]{1,64}$/.test(value.mediaType)) fail();
  return Object.freeze({...value});
}

/**
 * A transform names the auxiliary operation, its declared information loss and a cost class. Declaring loss/cost is
 * required so the reviewer sees what the derived representation drops and what extra provider cost it adds.
 */
function transform(value) {
  if (!keys(value, ['costClass','kind','lossiness'], ['model'])) fail();
  if (!ADAPTATION_TRANSFORM_KINDS.includes(value.kind) || !ADAPTATION_LOSSINESS.includes(value.lossiness) ||
      !ADAPTATION_COST_CLASSES.includes(value.costClass)) fail();
  if (Object.hasOwn(value,'model') && (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.model))) fail();
  return Object.freeze({...value});
}

/**
 * A plan binds the source artifacts, the auxiliary transforms, every intermediate destination and the losses the
 * derived representation introduces. The original context is preserved; the derived text is identified as derived.
 */
export function parseModalityAdaptationPlan(value) {
  if (!keys(value, ['intermediateDestinations','lossNotice','sourceRefs','targetModelRevision','transforms'])) fail();
  if (!Number.isSafeInteger(value.targetModelRevision) || value.targetModelRevision < 1) fail();
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > 8) fail();
  const sourceRefs = value.sourceRefs.map(sourceRef);
  if (new Set(sourceRefs.map(item => item.artifactId)).size !== sourceRefs.length) fail();
  if (!Array.isArray(value.transforms) || value.transforms.length < 1 || value.transforms.length > ADAPTATION_MAX_TRANSFORMS) fail();
  const transforms = value.transforms.map(transform);
  if (new Set(transforms.map(item => item.kind)).size !== transforms.length) fail();
  if (!Array.isArray(value.intermediateDestinations) || value.intermediateDestinations.length < 1 || value.intermediateDestinations.length > 4 ||
      new Set(value.intermediateDestinations).size !== value.intermediateDestinations.length ||
      value.intermediateDestinations.some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(item))) fail();
  if (!Array.isArray(value.lossNotice) || value.lossNotice.length > 8 ||
      value.lossNotice.some(item => typeof item !== 'string' || item.length > 280)) fail();
  return Object.freeze({...value, sourceRefs:Object.freeze(sourceRefs), transforms:Object.freeze(transforms),
    intermediateDestinations:Object.freeze([...value.intermediateDestinations]), lossNotice:Object.freeze([...value.lossNotice])});
}
export function canonicalModalityAdaptationPayload(value) {return canonicalJson(parseModalityAdaptationPlan(value));}
