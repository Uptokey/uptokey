import {WORKFLOW_LIMITS} from './workflow.js';
export const MAX_CONFIG_REQUEST_BYTES = 64 * 1024;
export const MAX_LOCAL_CONTROL_REQUEST_BYTES = 64 * 1024;
export const MAX_INFERENCE_REQUEST_BYTES = 1024 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 256 * 1024;

export async function readBoundedJson(request, maxBytes = MAX_CONFIG_REQUEST_BYTES, timeoutMs = 10_000) {
  return readJson(request,maxBytes,timeoutMs,MAX_INFERENCE_REQUEST_BYTES);
}

/** Only artifact upload routes may use the larger base64 envelope. */
export async function readArtifactImportJson(request) {
  const limit=Math.ceil(WORKFLOW_LIMITS.artifactBytes/3)*4+2048;
  return readJson(request,limit,30_000,limit);
}

async function readJson(request,maxBytes,timeoutMs,ceiling) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") { cancelStream(request.body); return { ok: false, reason: "invalid" }; }
  const body = await readBody(request, maxBytes, timeoutMs,ceiling);
  if (!body.ok) return body;
  try { return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.value)) }; }
  catch { return { ok: false, reason: "invalid" }; }
}

export async function readBoundedBody(request, maxBytes = MAX_CONFIG_REQUEST_BYTES, timeoutMs = 10_000) {
  return readBody(request,maxBytes,timeoutMs,MAX_INFERENCE_REQUEST_BYTES);
}
async function readBody(request,maxBytes,timeoutMs,ceiling) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    cancelStream(request?.body);
    return { ok: false, reason: "invalid" };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) { cancelStream(request.body); return { ok: false, reason: "invalid" }; }
    if (Number(declared) > maxBytes) { cancelStream(request.body); return { ok: false, reason: "too_large" }; }
  }
  if (!request.body) return { ok: false, reason: "invalid" };
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  const deadline = Symbol("bounded_json_timeout");
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(deadline), timeoutMs); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part === deadline) { cancelStream(reader); return { ok: false, reason: "invalid" }; }
      const { done, value } = part;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { cancelStream(reader); return { ok: false, reason: "too_large" }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, value: bytes };
  } catch { cancelStream(reader); return { ok: false, reason: "invalid" }; }
  finally { clearTimeout(timer); }
}

function cancelStream(stream) {
  try { void Promise.resolve(stream?.cancel()).catch(() => undefined); } catch {}
}
