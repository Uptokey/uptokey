export const MAX_CONFIG_REQUEST_BYTES: number;
export const MAX_LOCAL_CONTROL_REQUEST_BYTES: number;
export const MAX_INFERENCE_REQUEST_BYTES: number;
export const MAX_CONTROL_RESPONSE_BYTES: number;
export type BoundedJsonResult = { ok: true; value: unknown } | { ok: false; reason: "invalid" | "too_large" };
export type BoundedBodyResult = { ok: true; value: Uint8Array } | { ok: false; reason: "invalid" | "too_large" };
export function readBoundedJson(request: Request | Response, maxBytes?: number, timeoutMs?: number): Promise<BoundedJsonResult>;
export function readArtifactImportJson(request:Request):Promise<BoundedJsonResult>;
export function readBoundedBody(request: Request | Response, maxBytes?: number, timeoutMs?: number): Promise<BoundedBodyResult>;
