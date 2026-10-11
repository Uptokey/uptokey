import { createHash } from "node:crypto";
import {
  type Artifact,
  parseArtifact,
  WORKFLOW_LIMITS,
  WorkflowContractError,
} from "@uptokey/sync-contract/workflow";

export type { Artifact };

export const ARTIFACT_MAX_BYTES = WORKFLOW_LIMITS.artifactBytes;
export const ARTIFACT_TEXT_MAX_BYTES = ARTIFACT_MAX_BYTES;
export const PROJECT_STORAGE_MAX_BYTES = WORKFLOW_LIMITS.projectBytes;
export const SNAPSHOT_JSON_MAX_BYTES = WORKFLOW_LIMITS.commandBytes * 4;

const FILENAME_BY_TYPE = {
  "text/markdown": "report.md",
  "text/plain": "note.txt",
  "application/json": "data.json",
  "text/csv": "data.csv",
  "audio/mpeg": "speech.mp3",
  "audio/wav": "speech.wav",
  "audio/ogg": "speech.ogg",
  "audio/webm": "speech.webm",
  "audio/mp4": "speech.mp4",
  "image/png": "image.png",
  "image/jpeg": "image.jpg",
  "image/webp": "image.webp",
  "video/mp4": "video.mp4",
} as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactByteLimit(mediaType:Artifact["mediaType"]):number{return mediaType==='video/mp4'?WORKFLOW_LIMITS.videoArtifactBytes:ARTIFACT_MAX_BYTES;}
export function sealedJsonByteLimit(rawBytes:number):number{return Math.ceil(rawBytes/3)*4+16384;}
export function assertArtifactBytes(bytes: Uint8Array,mediaType:Artifact["mediaType"]='text/plain'): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > artifactByteLimit(mediaType)) {
    throw new Error("workspace_artifact_size_invalid");
  }
}

function asContract<T>(run: () => T, code: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowContractError) throw new Error(code);
    throw error;
  }
}

export function assertArtifact(value: unknown): Artifact {
  return asContract(() => parseArtifact(value), "workspace_artifact_invalid");
}

export function createArtifactRecord(input: {
  id: string;
  createdAt: string;
  projectId: string;
  runId: string;
  version: number;
  mediaType: Artifact["mediaType"];
  bytes: Uint8Array;
  filename?: string;
  receiptRefs?: string[];
  sourceRefs?: string[];
}): Artifact {
  assertArtifactBytes(input.bytes,input.mediaType);
  return assertArtifact({
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    projectId: input.projectId,
    runId: input.runId,
    version: input.version,
    mediaType: input.mediaType,
    filename: input.filename ?? FILENAME_BY_TYPE[input.mediaType],
    byteLength: input.bytes.byteLength,
    sha256: sha256Hex(input.bytes),
    receiptRefs: input.receiptRefs ?? [],
    sourceRefs: input.sourceRefs ?? [],
  });
}

export function projectByteLength(snapshotBytes: number, artifacts: Artifact[]): number {
  if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes < 0) throw new Error("workspace_project_size_invalid");
  let total = snapshotBytes;
  for (const artifact of artifacts) total += artifact.byteLength;
  if (total > PROJECT_STORAGE_MAX_BYTES) throw new Error("workspace_project_quota_exceeded");
  return total;
}

export function assertImmutableReplace(existing: Artifact | undefined, next: Artifact): void {
  if (!existing) return;
  if (existing.sha256 !== next.sha256 || existing.byteLength !== next.byteLength || existing.mediaType !== next.mediaType ||
      existing.filename !== next.filename || existing.runId !== next.runId ||
      JSON.stringify(existing.receiptRefs) !== JSON.stringify(next.receiptRefs) || JSON.stringify(existing.sourceRefs) !== JSON.stringify(next.sourceRefs)) throw new Error("workspace_artifact_immutable");
}
