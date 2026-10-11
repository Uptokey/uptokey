/**
 * E2-09 09-09 — reconciliation policy for a provider VideoDelivery ingress event.
 *
 * This is state evidence only: it never authorizes a new generation and never creates a job. The caller
 * supplies the known durable job identity, the event ids already accepted (durable log) and a signature
 * verifier that resolves the secret by reference. Transport and durability of the event log belong to
 * E2-18/13; the decision here is pure and testable without a daemon.
 */
import {parseVideoDelivery,VIDEO_JOB_STATUSES,type VideoDelivery} from '@uptokey/sync-contract/video';

export type VideoDeliveryCode='video_delivery_invalid'|'video_delivery_unknown_job'|'video_delivery_foreign'|'video_delivery_replay'|'video_delivery_signature_invalid'|'video_delivery_stale'|'video_delivery_out_of_order';
export class VideoDeliveryError extends Error {readonly code:VideoDeliveryCode;constructor(code:VideoDeliveryCode){super(code);this.code=code;}}

const TERMINAL=new Set(['completed','failed','cancelled','expired']);
export interface KnownVideoJob {readonly jobId:string;readonly workspaceId:string;readonly destinationRef:string;readonly status:string;}
export interface VideoDeliveryContext {
 /** Workspace that owns the job; a delivery from another workspace is foreign. */
 readonly workspaceId:string;
 /** Known durable job, or null when no such job exists (a delivery never creates one). */
 readonly job:KnownVideoJob|null;
 /** Event ids already accepted for this job; a repeat must not mutate anything. */
 readonly seenEventIds:ReadonlySet<string>;
 /** Most recent accepted issuedAt for this job, or null. */
 readonly lastIssuedAt:string|null;
 /** Resolves the configured secret by reference and checks the event signature. */
 readonly verify:(delivery:VideoDelivery)=>boolean;
 readonly now?:()=>Date;
 readonly maxAgeMs?:number;
}
export interface VideoDeliveryDecision {readonly status:VideoDelivery['status'];readonly changed:boolean;}

/** Validates, orders and reconciles one delivery against the durable job; never creates a job or a generation. */
export function reconcileVideoDelivery(input:unknown,context:VideoDeliveryContext):VideoDeliveryDecision {
 let delivery:VideoDelivery;
 try{delivery=parseVideoDelivery(input);}catch{throw new VideoDeliveryError('video_delivery_invalid');}
 if(!context.job||context.job.jobId!==delivery.jobId)throw new VideoDeliveryError('video_delivery_unknown_job');
 if(context.workspaceId!==delivery.workspaceId||context.job.workspaceId!==delivery.workspaceId||context.job.destinationRef!==delivery.destinationRef)throw new VideoDeliveryError('video_delivery_foreign');
 if(context.seenEventIds.has(delivery.eventId))throw new VideoDeliveryError('video_delivery_replay');
 if(!context.verify(delivery))throw new VideoDeliveryError('video_delivery_signature_invalid');
 const now=context.now?.()??new Date(),issuedAt=Date.parse(delivery.issuedAt),maxAgeMs=context.maxAgeMs??300_000;
 if(!Number.isFinite(issuedAt)||now.getTime()-issuedAt>maxAgeMs)throw new VideoDeliveryError('video_delivery_stale');
 if(context.lastIssuedAt!==null&&issuedAt<=Date.parse(context.lastIssuedAt))throw new VideoDeliveryError('video_delivery_out_of_order');
 // A terminal job is never downgraded or reopened by a later or repeated callback.
 if(TERMINAL.has(context.job.status))return {status:context.job.status as VideoDelivery['status'],changed:false};
 if(!VIDEO_JOB_STATUSES.includes(delivery.status))throw new VideoDeliveryError('video_delivery_invalid');
 return {status:delivery.status,changed:delivery.status!==context.job.status};
}
