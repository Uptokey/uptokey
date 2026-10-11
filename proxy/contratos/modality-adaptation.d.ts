export const MODALITY_ADAPTATION_CONTRACT_VERSION:1;
export const ADAPTATION_MAX_TRANSFORMS:number;
export type AdaptationTransformKind='transcribe'|'describe_image'|'ocr';
export type AdaptationLossiness='none'|'low'|'high';
export type AdaptationCostClass='none'|'low'|'high';
export const ADAPTATION_TRANSFORM_KINDS:readonly AdaptationTransformKind[];
export const ADAPTATION_LOSSINESS:readonly AdaptationLossiness[];
export const ADAPTATION_COST_CLASSES:readonly AdaptationCostClass[];
export interface AdaptationTransform {
  readonly kind:AdaptationTransformKind;readonly lossiness:AdaptationLossiness;readonly costClass:AdaptationCostClass;readonly model?:string;
}
export interface ModalitySourceRef {readonly artifactId:string;readonly sha256:string;readonly mediaType:string;}
export interface ModalityAdaptationPlan {
  readonly sourceRefs:readonly ModalitySourceRef[];
  readonly targetModelRevision:number;
  readonly transforms:readonly AdaptationTransform[];
  readonly intermediateDestinations:readonly string[];
  readonly lossNotice:readonly string[];
}
export function parseModalityAdaptationPlan(value:unknown):ModalityAdaptationPlan;
export function canonicalModalityAdaptationPayload(value:unknown):string;
