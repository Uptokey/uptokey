import { isDataRecord, projectStringArray, projectDataArray } from './plain-data.js';
import { canonicalJson } from './canonical.js';

// SHA-256 puro (FIPS 180-4): o contrato roda no browser e no Node, e
// `node:crypto` é externalizado pelo bundler do PWA. Saída idêntica ao
// createHash('sha256') do Node (verificada em test/sha256-parity).
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(bytes) {
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 8) >> 6 << 6) + 64;
  const words = new Uint32Array(paddedLength >> 2);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((3 - (i & 3)) << 3);
  words[bytes.length >> 2] |= 0x80 << ((3 - (bytes.length & 3)) << 3);
  words[words.length - 1] = bitLength;
  const w = new Uint32Array(64);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let offset = 0; offset < words.length; offset += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[offset + i];
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    out[index * 4] = word >>> 24; out[index * 4 + 1] = (word >>> 16) & 0xff;
    out[index * 4 + 2] = (word >>> 8) & 0xff; out[index * 4 + 3] = word & 0xff;
  });
  return out;
}

const textEncoder = new TextEncoder();

function sha256Hex(text) {
  return [...sha256Bytes(textEncoder.encode(text))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const PROJECT_AGENT_CONTRACT_VERSION = 1;

const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const isUtcIsoDate = v => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v));

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
    if (/[\x00-\x1f:<>"|?*]/.test(part)) return false;
    if (/[. ]$/.test(part)) return false;
    if (WINDOWS_RESERVED.test(part)) return false;
  }
  return true;
}

export function parseProjectRootBinding(input) {
  const invalid = () => { throw new Error('project_root_binding_invalid'); };
  if (!isDataRecord(input)) invalid();
  const keys = Object.keys(input).sort();
  const hasRevoked = keys.includes('revokedAt');
  const expectedKeys = hasRevoked
    ? ['accessMode', 'displayName', 'expiresAt', 'grantedAt', 'id', 'principalId', 'projectId', 'revision', 'revokedAt', 'rootIdentityDigest']
    : ['accessMode', 'displayName', 'expiresAt', 'grantedAt', 'id', 'principalId', 'projectId', 'revision', 'rootIdentityDigest'];
  if (keys.join(',') !== expectedKeys.join(',')) invalid();

  if (!id(input.id) || !id(input.projectId) || !id(input.principalId)) invalid();
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid();
  if (typeof input.displayName !== 'string' || input.displayName.length < 1 || input.displayName.length > 100) invalid();
  if (!digest(input.rootIdentityDigest)) invalid();
  if (!isUtcIsoDate(input.grantedAt) || !isUtcIsoDate(input.expiresAt)) invalid();
  if (Date.parse(input.expiresAt) <= Date.parse(input.grantedAt)) invalid();
  if (hasRevoked && input.revokedAt !== null && !isUtcIsoDate(input.revokedAt)) invalid();
  if (!['read_write', 'read_only'].includes(input.accessMode)) invalid();

  return Object.freeze({
    id: input.id,
    projectId: input.projectId,
    principalId: input.principalId,
    revision: input.revision,
    displayName: input.displayName,
    rootIdentityDigest: input.rootIdentityDigest,
    grantedAt: input.grantedAt,
    expiresAt: input.expiresAt,
    ...(hasRevoked ? { revokedAt: input.revokedAt } : {}),
    accessMode: input.accessMode
  });
}

export function computeProjectTaskSpecDigest(input) {
  const { digest: _, ...rest } = input;
  return sha256Hex(canonicalJson(rest));
}

export function parseProjectTaskSpec(input) {
  const invalid = () => { throw new Error('project_task_spec_invalid'); };
  if (!isDataRecord(input)) invalid();
  const expectedKeys = [
    'acceptanceSpecRef', 'allowedCapabilityIds', 'allowedDestinations', 'digest',
    'filePolicy', 'id', 'installPolicy', 'limits', 'mode', 'networkPolicy',
    'projectId', 'rootBindingId', 'rootBindingRevision', 'rootIdentityDigest',
    'runtimeProfileIds', 'schemaVersion', 'objective'
  ].sort();
  if (Object.keys(input).sort().join(',') !== expectedKeys.join(',')) invalid();

  if (input.schemaVersion !== 1) invalid();
  if (!id(input.id) || !id(input.projectId) || !id(input.rootBindingId)) invalid();
  if (!Number.isSafeInteger(input.rootBindingRevision) || input.rootBindingRevision < 1) invalid();
  if (!digest(input.rootIdentityDigest)) invalid();
  if (typeof input.objective !== 'string' || input.objective.length < 1 || input.objective.length > 2000) invalid();
  if (!['supervised', 'bounded'].includes(input.mode)) invalid();

  const allowedCaps = projectStringArray(input.allowedCapabilityIds, 50);
  const allowedDests = projectStringArray(input.allowedDestinations, 50);
  const runtimeProfiles = projectStringArray(input.runtimeProfileIds, 10);
  if (!allowedCaps || !allowedDests || !runtimeProfiles) invalid();

  if (!isDataRecord(input.filePolicy)) invalid();
  const fpKeys = Object.keys(input.filePolicy).sort().join(',');
  if (fpKeys !== 'allowHidden,allowedExtensions,excludedPaths') invalid();
  const allowedExts = projectStringArray(input.filePolicy.allowedExtensions, 100);
  const excludedPaths = projectStringArray(input.filePolicy.excludedPaths, 100);
  if (!allowedExts || !excludedPaths || typeof input.filePolicy.allowHidden !== 'boolean') invalid();

  if (!['none', 'isolated_loopback', 'allowlist'].includes(input.networkPolicy)) invalid();
  if (!['none', 'lockfile_only', 'explicit_approval'].includes(input.installPolicy)) invalid();

  if (!isDataRecord(input.limits)) invalid();
  const limKeys = Object.keys(input.limits).sort().join(',');
  if (limKeys !== 'maxAggregateOutputTokens,maxFileSizeBytes,maxFiles,maxInferenceCalls,maxIterations,maxTotalChangeBytes,timeoutMs') invalid();
  const { maxIterations, maxInferenceCalls, maxAggregateOutputTokens, timeoutMs, maxFiles, maxFileSizeBytes, maxTotalChangeBytes } = input.limits;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) invalid();
  if (!Number.isSafeInteger(maxInferenceCalls) || maxInferenceCalls < 1 || maxInferenceCalls > 500) invalid();
  if (!Number.isSafeInteger(maxAggregateOutputTokens) || maxAggregateOutputTokens < 1 || maxAggregateOutputTokens > 1_000_000) invalid();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) invalid();
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) invalid();
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 1 || maxFileSizeBytes > 50_000_000) invalid();
  if (!Number.isSafeInteger(maxTotalChangeBytes) || maxTotalChangeBytes < 1 || maxTotalChangeBytes > 500_000_000) invalid();

  if (typeof input.acceptanceSpecRef !== 'string' || input.acceptanceSpecRef.length < 1) invalid();
  if (!digest(input.digest)) invalid();

  const computedDigest = computeProjectTaskSpecDigest(input);
  if (computedDigest !== input.digest) invalid();

  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    rootBindingId: input.rootBindingId,
    rootBindingRevision: input.rootBindingRevision,
    rootIdentityDigest: input.rootIdentityDigest,
    objective: input.objective,
    mode: input.mode,
    allowedCapabilityIds: Object.freeze([...allowedCaps]),
    allowedDestinations: Object.freeze([...allowedDests]),
    runtimeProfileIds: Object.freeze([...runtimeProfiles]),
    filePolicy: Object.freeze({
      allowedExtensions: Object.freeze([...allowedExts]),
      excludedPaths: Object.freeze([...excludedPaths]),
      allowHidden: input.filePolicy.allowHidden
    }),
    networkPolicy: input.networkPolicy,
    installPolicy: input.installPolicy,
    limits: Object.freeze({
      maxIterations,
      maxInferenceCalls,
      maxAggregateOutputTokens,
      timeoutMs,
      maxFiles,
      maxFileSizeBytes,
      maxTotalChangeBytes
    }),
    acceptanceSpecRef: input.acceptanceSpecRef,
    digest: input.digest
  });
}

export function parseProjectFileManifest(input) {
  const invalid = () => { throw new Error('project_file_manifest_invalid'); };
  if (!isDataRecord(input)) invalid();
  if (Object.keys(input).sort().join(',') !== 'entries,id,projectId,rootBindingId,snapshotDigest') invalid();
  if (!id(input.id) || !id(input.projectId) || !id(input.rootBindingId) || !digest(input.snapshotDigest)) invalid();

  const entriesRaw = projectDataArray(input.entries, 10_000);
  if (!entriesRaw) invalid();

  const seenPaths = new Set();
  const parsedEntries = entriesRaw.map(e => {
    if (!isDataRecord(e)) invalid();
    const validEntryKeys = ['byteLength', 'contentArtifactRef', 'empty', 'kind', 'language', 'mediaType', 'protectedRef', 'relativePath', 'sensitivity', 'sha256'];
    for (const k of Object.keys(e)) {
      if (!validEntryKeys.includes(k)) invalid();
    }
    if (!isSafeRelativePath(e.relativePath) || seenPaths.has(e.relativePath)) invalid();
    seenPaths.add(e.relativePath);
    if (!['file', 'directory'].includes(e.kind)) invalid();
    if (!Number.isSafeInteger(e.byteLength) || e.byteLength < 0) invalid();
    if (!digest(e.sha256)) invalid();
    if (e.language !== undefined && (typeof e.language !== 'string' || e.language.length > 50)) invalid();
    if (e.mediaType !== undefined && (typeof e.mediaType !== 'string' || e.mediaType.length > 100)) invalid();
    if (e.contentArtifactRef !== undefined && e.contentArtifactRef !== null && typeof e.contentArtifactRef !== 'string') invalid();
    if (e.empty !== undefined && typeof e.empty !== 'boolean') invalid();
    if (e.sensitivity !== undefined && !['public', 'protected', 'secret'].includes(e.sensitivity)) invalid();
    if (e.protectedRef !== undefined && typeof e.protectedRef !== 'string') invalid();

    return Object.freeze({
      relativePath: e.relativePath,
      kind: e.kind,
      ...(e.language !== undefined ? { language: e.language } : {}),
      ...(e.mediaType !== undefined ? { mediaType: e.mediaType } : {}),
      byteLength: e.byteLength,
      sha256: e.sha256,
      ...(e.contentArtifactRef !== undefined ? { contentArtifactRef: e.contentArtifactRef } : {}),
      ...(e.empty !== undefined ? { empty: e.empty } : {}),
      ...(e.sensitivity !== undefined ? { sensitivity: e.sensitivity } : {}),
      ...(e.protectedRef !== undefined ? { protectedRef: e.protectedRef } : {})
    });
  });

  return Object.freeze({
    id: input.id,
    projectId: input.projectId,
    rootBindingId: input.rootBindingId,
    snapshotDigest: input.snapshotDigest,
    entries: Object.freeze(parsedEntries)
  });
}

export function computeProjectChangeSetDigest(input) {
  const { digest: _, ...rest } = input;
  return sha256Hex(canonicalJson(rest));
}

export function parseProjectChangeSet(input) {
  const invalid = () => { throw new Error('project_change_set_invalid'); };
  if (!isDataRecord(input)) invalid();
  if (Object.keys(input).sort().join(',') !== 'baseManifestDigest,digest,id,operations,revision,taskId') invalid();

  if (!id(input.id) || !id(input.taskId) || !digest(input.baseManifestDigest) || !digest(input.digest)) invalid();
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid();

  const opsRaw = projectDataArray(input.operations, 1000);
  if (!opsRaw || opsRaw.length === 0) invalid();

  const parsedOps = opsRaw.map(op => {
    if (!isDataRecord(op)) invalid();
    const validOpKeys = ['content', 'expectedSha256', 'fromPath', 'newSha256', 'patches', 'path', 'type'];
    for (const k of Object.keys(op)) {
      if (!validOpKeys.includes(k)) invalid();
    }
    if (!['mkdir', 'create', 'replace', 'move', 'patch_lines', 'delete'].includes(op.type)) invalid();
    if (!isSafeRelativePath(op.path)) invalid();

    if (op.type === 'move') {
      if (!isSafeRelativePath(op.fromPath) || op.fromPath === op.path) invalid();
    } else if (op.fromPath !== undefined) invalid();

    // A deletion is bound to the exact bytes it removes; it never carries content.
    if (op.type === 'delete' && (op.content !== undefined || op.newSha256 !== undefined || op.patches !== undefined)) invalid();
    if (op.type === 'replace' || op.type === 'patch_lines' || op.type === 'delete') {
      if (!digest(op.expectedSha256)) invalid();
    } else if (op.expectedSha256 !== undefined && !digest(op.expectedSha256)) invalid();

    if (['create', 'replace'].includes(op.type)) {
      if (!digest(op.newSha256)) invalid();
    } else if (op.newSha256 !== undefined && !digest(op.newSha256)) invalid();

    if (op.content !== undefined && (typeof op.content !== 'string' || textEncoder.encode(op.content).byteLength > 50_000_000)) invalid();

    let parsedPatches;
    if (op.type === 'patch_lines') {
      if (!Array.isArray(op.patches) || op.patches.length === 0 || op.patches.length > 500) invalid();
      parsedPatches = op.patches.map(p => {
        if (!isDataRecord(p)) invalid();
        if (!Number.isSafeInteger(p.startLine) || p.startLine < 1) invalid();
        if (!Number.isSafeInteger(p.deleteCount) || p.deleteCount < 0) invalid();
        if (!Array.isArray(p.newLines) || p.newLines.some(l => typeof l !== 'string')) invalid();
        return Object.freeze({
          startLine: p.startLine,
          deleteCount: p.deleteCount,
          newLines: Object.freeze([...p.newLines])
        });
      });
    }

    return Object.freeze({
      type: op.type,
      path: op.path,
      ...(op.fromPath !== undefined ? { fromPath: op.fromPath } : {}),
      ...(op.expectedSha256 !== undefined ? { expectedSha256: op.expectedSha256 } : {}),
      ...(op.newSha256 !== undefined ? { newSha256: op.newSha256 } : {}),
      ...(op.content !== undefined ? { content: op.content } : {}),
      ...(parsedPatches !== undefined ? { patches: Object.freeze(parsedPatches) } : {})
    });
  });

  const computed = computeProjectChangeSetDigest(input);
  if (computed !== input.digest) invalid();

  return Object.freeze({
    id: input.id,
    taskId: input.taskId,
    baseManifestDigest: input.baseManifestDigest,
    revision: input.revision,
    operations: Object.freeze(parsedOps),
    digest: input.digest
  });
}

export function parseProjectRunRequest(input) {
  const invalid = () => { throw new Error('project_run_request_invalid'); };
  if (!isDataRecord(input)) invalid();
  const keys = Object.keys(input).filter(key => key !== 'execution').sort().join(',');
  const base = 'actionId,artifactInputRefs,manifestDigest,outputLimitBytes,relativeWorkingDirectory,runtimeProfileId,taskId,timeoutMs';
  // `exec` carries a structured argv (no shell); every other action keeps the exact base shape.
  const withArgv = 'actionId,argv,artifactInputRefs,manifestDigest,outputLimitBytes,relativeWorkingDirectory,runtimeProfileId,taskId,timeoutMs';
  if (keys !== base && !(keys === withArgv && input.actionId === 'exec')) invalid();
  if (input.actionId === 'exec') {
    if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 64) invalid();
    if (!/^[A-Za-z0-9._+/-]{1,200}$/.test(input.argv[0])) invalid();
    if (input.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) invalid();
  }

  let execution;
  if (Object.hasOwn(input, 'execution')) {
    const value = input.execution;
    if (input.actionId !== 'exec' || !isDataRecord(value) || value.writable !== true ||
        Object.keys(value).some(key => !['writable', 'outputPaths', 'dependencies', 'resources'].includes(key)) ||
        !Array.isArray(value.outputPaths) || value.outputPaths.length > 32 ||
        value.outputPaths.some(item => !isSafeRelativePath(item) || item.startsWith('.uptokey-dependencies/')) ||
        new Set(value.outputPaths).size !== value.outputPaths.length) invalid();
    const dependencies = value.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 32) invalid();
    const parsedDependencies = dependencies.map(item => {
      if (!isDataRecord(item) || Object.keys(item).sort().join(',') !== 'path,sha256,url' ||
          !digest(item.sha256) || typeof item.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(item.path) ||
          typeof item.url !== 'string' || item.url.length > 2048) invalid();
      let url; try { url = new URL(item.url); } catch { invalid(); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) invalid();
      return Object.freeze({path:item.path,sha256:item.sha256,url:url.href});
    });
    if (new Set(parsedDependencies.map(item => item.path)).size !== parsedDependencies.length) invalid();
    let resources;
    if(value.resources!==undefined){
      const r=value.resources;
      if(!isDataRecord(r)||Object.keys(r).sort().join(',')!=='cpus,diskMiB,memoryMiB'||!Number.isSafeInteger(r.memoryMiB)||r.memoryMiB<64||r.memoryMiB>2048||!Number.isSafeInteger(r.diskMiB)||r.diskMiB<32||r.diskMiB>512||typeof r.cpus!=='number'||!Number.isFinite(r.cpus)||r.cpus<0.25||r.cpus>4||r.cpus*4!==Math.floor(r.cpus*4))invalid();
      resources=Object.freeze({cpus:r.cpus,diskMiB:r.diskMiB,memoryMiB:r.memoryMiB});
    }
    execution = Object.freeze({writable:true,outputPaths:Object.freeze([...value.outputPaths]),dependencies:Object.freeze(parsedDependencies),...(resources?{resources}:{})});
  }

  if (!id(input.taskId) || !digest(input.manifestDigest)) invalid();
  if (typeof input.runtimeProfileId !== 'string' || input.runtimeProfileId.length < 1 || input.runtimeProfileId.length > 50) invalid();
  if (typeof input.actionId !== 'string' || input.actionId.length < 1 || input.actionId.length > 50) invalid();
  if (input.relativeWorkingDirectory !== '.' && input.relativeWorkingDirectory !== '' && !isSafeRelativePath(input.relativeWorkingDirectory)) invalid();

  const artifactRefs = projectStringArray(input.artifactInputRefs, 50);
  if (!artifactRefs) invalid();

  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 86_400_000) invalid();
  if (!Number.isSafeInteger(input.outputLimitBytes) || input.outputLimitBytes < 1024 || input.outputLimitBytes > 50_000_000) invalid();

  return Object.freeze({
    taskId: input.taskId,
    manifestDigest: input.manifestDigest,
    runtimeProfileId: input.runtimeProfileId,
    actionId: input.actionId,
    relativeWorkingDirectory: input.relativeWorkingDirectory,
    artifactInputRefs: Object.freeze([...artifactRefs]),
    timeoutMs: input.timeoutMs,
    outputLimitBytes: input.outputLimitBytes,
    ...(input.actionId === 'exec' ? { argv: Object.freeze([...input.argv]) } : {}),
    ...(execution ? {execution} : {})
  });
}

export function parseProjectVerificationReport(input) {
  const invalid = () => { throw new Error('project_verification_report_invalid'); };
  if (!isDataRecord(input)) invalid();
  if (Object.keys(input).sort().join(',') !== 'checks,manifestDigest,runId,runtimeFingerprint,taskId') invalid();

  if (!id(input.taskId) || !id(input.runId) || !digest(input.manifestDigest)) invalid();
  if (typeof input.runtimeFingerprint !== 'string' || input.runtimeFingerprint.length < 1) invalid();

  const checksRaw = projectDataArray(input.checks, 200);
  if (!checksRaw) invalid();

  const parsedChecks = checksRaw.map(c => {
    if (!isDataRecord(c)) invalid();
    const validCheckKeys = ['artifactRefs', 'command', 'exitCode', 'expected', 'id', 'method', 'observed', 'status'];
    for (const k of Object.keys(c)) {
      if (!validCheckKeys.includes(k)) invalid();
    }
    if (typeof c.id !== 'string' || c.id.length < 1) invalid();
    if (typeof c.method !== 'string' || c.method.length < 1) invalid();
    if (c.command !== undefined && typeof c.command !== 'string') invalid();
    if (c.exitCode !== undefined && (!Number.isInteger(c.exitCode) || c.exitCode < 0 || c.exitCode > 255)) invalid();
    if (typeof c.expected !== 'string' || typeof c.observed !== 'string') invalid();
    const artifactRefs = projectStringArray(c.artifactRefs, 20);
    if (!artifactRefs) invalid();
    if (!['pass', 'fail', 'blocked', 'not_run'].includes(c.status)) invalid();

    return Object.freeze({
      id: c.id,
      method: c.method,
      ...(c.command !== undefined ? { command: c.command } : {}),
      ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
      expected: c.expected,
      observed: c.observed,
      artifactRefs: Object.freeze([...artifactRefs]),
      status: c.status
    });
  });

  return Object.freeze({
    taskId: input.taskId,
    runId: input.runId,
    manifestDigest: input.manifestDigest,
    runtimeFingerprint: input.runtimeFingerprint,
    checks: Object.freeze(parsedChecks)
  });
}

export function parseProjectTask(input) {
  const invalid = () => { throw new Error('project_task_invalid'); };
  if (!isDataRecord(input)) invalid();
  const keys = Object.keys(input).sort();
  const validKeys = [
    'authorityRef', 'budgetReservations', 'childRunIds', 'currentRunId',
    'iteration', 'lastVerification', 'nextAction', 'resultRefs', 'revision',
    'specRef', 'status', 'updatedAt', 'writeOperationRefs'
  ];
  for (const k of keys) {
    if (!validKeys.includes(k)) invalid();
  }

  if (typeof input.specRef !== 'string' || typeof input.authorityRef !== 'string') invalid();
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid();
  if (!['draft', 'awaiting_approval', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'needs_attention', 'blocked_dependency'].includes(input.status)) invalid();
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 0) invalid();

  const childRunIds = projectStringArray(input.childRunIds, 500);
  if (!childRunIds) invalid();
  if (input.currentRunId !== null && typeof input.currentRunId !== 'string') invalid();

  if (!isDataRecord(input.budgetReservations)) invalid();
  const bKeys = Object.keys(input.budgetReservations).sort().join(',');
  if (bKeys !== 'inferenceCallsUsed,iterationsUsed,outputTokensUsed,totalChangeBytesUsed') invalid();
  const { inferenceCallsUsed, iterationsUsed, outputTokensUsed, totalChangeBytesUsed } = input.budgetReservations;
  if (!Number.isSafeInteger(inferenceCallsUsed) || inferenceCallsUsed < 0) invalid();
  if (!Number.isSafeInteger(iterationsUsed) || iterationsUsed < 0) invalid();
  if (!Number.isSafeInteger(outputTokensUsed) || outputTokensUsed < 0) invalid();
  if (!Number.isSafeInteger(totalChangeBytesUsed) || totalChangeBytesUsed < 0) invalid();

  const writeOperationRefs = projectStringArray(input.writeOperationRefs, 500);
  const resultRefs = projectStringArray(input.resultRefs, 500);
  if (!writeOperationRefs || !resultRefs) invalid();

  let lastVerification = null;
  if (input.lastVerification) {
    lastVerification = parseProjectVerificationReport(input.lastVerification);
  }

  if (input.nextAction !== undefined && typeof input.nextAction !== 'string') invalid();
  if (!isUtcIsoDate(input.updatedAt)) invalid();

  return Object.freeze({
    specRef: input.specRef,
    authorityRef: input.authorityRef,
    revision: input.revision,
    status: input.status,
    iteration: input.iteration,
    childRunIds: Object.freeze([...childRunIds]),
    currentRunId: input.currentRunId,
    budgetReservations: Object.freeze({
      inferenceCallsUsed,
      iterationsUsed,
      outputTokensUsed,
      totalChangeBytesUsed
    }),
    writeOperationRefs: Object.freeze([...writeOperationRefs]),
    resultRefs: Object.freeze([...resultRefs]),
    ...(lastVerification ? { lastVerification } : {}),
    ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
    updatedAt: input.updatedAt
  });
}

export function parseProjectPreviewSession(input) {
  const invalid = () => { throw new Error('project_preview_session_invalid'); };
  if (!isDataRecord(input)) invalid();
  if (Object.keys(input).sort().join(',') !== 'allowedResourceIds,expiresAt,id,manifestDigest,origin,runtimeJobRef,status,taskId') invalid();

  if (!id(input.id) || !id(input.taskId) || !digest(input.manifestDigest)) invalid();
  if (input.runtimeJobRef !== null && typeof input.runtimeJobRef !== 'string') invalid();
  if (typeof input.origin !== 'string' || !/^https?:\/\/[a-zA-Z0-9_.-]+(?::\d+)?$/.test(input.origin)) invalid();
  const allowedResourceIds = projectStringArray(input.allowedResourceIds, 100);
  if (!allowedResourceIds) invalid();
  if (!isUtcIsoDate(input.expiresAt)) invalid();
  if (!['starting', 'running', 'stopped', 'expired'].includes(input.status)) invalid();

  return Object.freeze({
    id: input.id,
    taskId: input.taskId,
    manifestDigest: input.manifestDigest,
    runtimeJobRef: input.runtimeJobRef,
    origin: input.origin,
    allowedResourceIds: Object.freeze([...allowedResourceIds]),
    expiresAt: input.expiresAt,
    status: input.status
  });
}

export function parseRunAuthority(input) {
  const invalid = () => { throw new Error('run_authority_invalid'); };
  if (!isDataRecord(input) || typeof input.kind !== 'string') invalid();

  if (input.kind === 'plan_approval') {
    if (Object.keys(input).sort().join(',') !== 'approvalId,kind') invalid();
    if (!id(input.approvalId)) invalid();
    return Object.freeze({ kind: 'plan_approval', approvalId: input.approvalId });
  }

  if (input.kind === 'project_task_delegation') {
    const expected = 'childPlanDigest,iteration,kind,reservationId,rootRunId,specDigest,taskId';
    if (Object.keys(input).sort().join(',') !== expected) invalid();
    if (!id(input.taskId) || !id(input.rootRunId) || !id(input.reservationId)) invalid();
    if (!digest(input.specDigest) || !digest(input.childPlanDigest)) invalid();
    if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) invalid();

    return Object.freeze({
      kind: 'project_task_delegation',
      taskId: input.taskId,
      rootRunId: input.rootRunId,
      specDigest: input.specDigest,
      childPlanDigest: input.childPlanDigest,
      reservationId: input.reservationId,
      iteration: input.iteration
    });
  }

  invalid();
}


export function computeTreeDigest(entries) {
  const invalid = () => { throw new Error('project_tree_digest_invalid'); };
  if (!Array.isArray(entries)) invalid();
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const parsed = sorted.map(e => {
    if (!isDataRecord(e) || !isSafeRelativePath(e.path) || !digest(e.sha256) || !Number.isSafeInteger(e.size) || e.size < 0) {
      invalid();
    }
    return Object.freeze({ path: e.path, sha256: e.sha256, size: e.size });
  });
  const rootDigest = sha256Hex(canonicalJson(parsed));
  return Object.freeze({
    rootDigest,
    entries: Object.freeze(parsed)
  });
}

export function extractSymbolOutline(filePath, content) {
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    throw new Error('project_outline_invalid');
  }
  const symbols = [];
  const lines = content.split(/\r?\n/);
  const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/;
  const classRegex = /(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/;
  const ifaceRegex = /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/;
  const constRegex = /export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/;
  const pyDefRegex = /^\s*def\s+([a-zA-Z0-9_]+)/;
  const pyClassRegex = /^\s*class\s+([a-zA-Z0-9_]+)/;

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    let match = fnRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'function', line: lineNum }));
      return;
    }
    match = classRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'class', line: lineNum }));
      return;
    }
    match = ifaceRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'interface', line: lineNum }));
      return;
    }
    match = constRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'export', line: lineNum }));
      return;
    }
    match = pyDefRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'function', line: lineNum }));
      return;
    }
    match = pyClassRegex.exec(line);
    if (match) {
      symbols.push(Object.freeze({ name: match[1], kind: 'class', line: lineNum }));
      return;
    }
  });

  return Object.freeze({
    path: filePath,
    symbols: Object.freeze(symbols)
  });
}
