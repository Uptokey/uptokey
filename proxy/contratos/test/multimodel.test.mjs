import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMultiModelPlan,
  parsePanelResult,
  parseSynthesisResult,
  parseMultimodelRun,
  parseCreateMultimodelPlanCommand,
  canonicalMultiModelPlanPayload,
} from '../multimodel.js';

const members = [
  { id: 'm_1', role: 'worker', modelId: 'model-a', connectionId: 'local', task: 'tarefa A', allowedCapabilityIds: [], contextRefs: [], outputSchemaRef: null },
  { id: 'm_2', role: 'worker', modelId: 'model-b', connectionId: 'local', task: 'tarefa B', allowedCapabilityIds: [], contextRefs: [], outputSchemaRef: null },
];
const limits = { maxMembers: 2, maxConcurrency: 2, maxDepth: 0, maxCalls: 8, maxElapsedMs: 10000, maxCostMicros: '1000000', maxTokens: 1000 };
const quorum = { minSuccess: 2, graceMs: 0, deadlineMs: 10000 };
const digest = 'a'.repeat(64);

test('plano válido é aceito e congelado', () => {
  const plan = parseMultiModelPlan({
    schemaVersion: 1, id: 'mmp_1', createdAt: '2026-09-20T00:00:00.000Z',
    projectId: 'proj-1', principalId: 'user-1', revision: 1,
    mode: 'fusion', principalModel: 'principal', members,
    analystModel: 'analyst', finalModel: 'writer', limits, quorum,
    contextSnapshotId: 'snap-1', digest,
  });
  assert.equal(plan.mode, 'fusion');
  assert.equal(plan.members.length, 2);
  assert.throws(() => { plan.members.push(members[0]); });
});

test('fusão sem analista é recusada', () => {
  assert.throws(() => parseMultiModelPlan({
    schemaVersion: 1, id: 'mmp_1', createdAt: '2026-09-20T00:00:00.000Z',
    projectId: 'proj-1', principalId: 'user-1', revision: 1,
    mode: 'fusion', principalModel: 'principal', members,
    limits, quorum, contextSnapshotId: 'snap-1', digest,
  }), /multimodel_invalid/);
});

test('membro duplicado, quórum inválido e digest inválido são recusados', () => {
  const base = { schemaVersion: 1, id: 'mmp_1', createdAt: '2026-09-20T00:00:00.000Z', projectId: 'proj-1', principalId: 'user-1', revision: 1, mode: 'compare', principalModel: 'p', contextSnapshotId: 'snap-1', digest };
  assert.throws(() => parseMultiModelPlan({ ...base, members: [members[0], members[0]], limits, quorum }), /multimodel_invalid/);
  assert.throws(() => parseMultiModelPlan({ ...base, members, limits, quorum: { ...quorum, minSuccess: 3 } }), /multimodel_invalid/);
  assert.throws(() => parseMultiModelPlan({ ...base, members, limits, quorum, digest: 'zz' }), /multimodel_invalid/);
});

test('propriedade desconhecida no plano é recusada', () => {
  assert.throws(() => parseMultiModelPlan({
    schemaVersion: 1, id: 'mmp_1', createdAt: '2026-09-20T00:00:00.000Z',
    projectId: 'proj-1', principalId: 'user-1', revision: 1,
    mode: 'compare', principalModel: 'p', members, limits, quorum,
    contextSnapshotId: 'snap-1', digest, extra: 1,
  }), /multimodel_invalid/);
});

test('canonical payload exclui o digest', () => {
  const payload = canonicalMultiModelPlanPayload({
    schemaVersion: 1, id: 'mmp_1', createdAt: '2026-09-20T00:00:00.000Z',
    projectId: 'proj-1', principalId: 'user-1', revision: 1,
    mode: 'compare', principalModel: 'p', members, limits, quorum,
    contextSnapshotId: 'snap-1', digest,
  });
  assert.ok(!payload.includes('"digest"'));
  assert.ok(payload.includes('"principalModel":"p"'));
});

test('PanelResult exige completedAt em status terminal e errorCode nulo em sucesso', () => {
  const base = { memberId: 'm_1', runId: 'mmr_1', attemptIds: ['a1'], actualModel: 'm', artifactRefs: [], usage: { basis: 'provider_reported', inputTokens: 1, outputTokens: 2 }, cost: { micros: '1000' }, startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:00:01.000Z', responseHash: 'a'.repeat(64) };
  assert.doesNotThrow(() => parsePanelResult({ ...base, status: 'succeeded', errorCode: null }));
  assert.doesNotThrow(() => parsePanelResult({ ...base, status: 'succeeded', usage: null, cost: null, errorCode: null }), 'unknown não vira zero falso');
  assert.throws(() => parsePanelResult({ ...base, status: 'succeeded', errorCode: 'boom' }), /multimodel_invalid/);
  assert.throws(() => parsePanelResult({ ...base, status: 'failed', completedAt: null }), /multimodel_invalid/);
  assert.throws(() => parsePanelResult({ ...base, status: 'succeeded', usage: { basis: 'unknown', inputTokens: 1, outputTokens: null } }), /multimodel_invalid/, 'unknown com tokens é rejeitado');
  assert.throws(() => parsePanelResult({ ...base, status: 'succeeded', responseHash: 'nao-hash' }), /multimodel_invalid/);
});

test('SynthesisResult limita arrays e valida finalArtifactRef', () => {
  const synth = { agreement: ['a'], contradictions: [], coverageGaps: [], uniqueInsights: [], blindSpots: [], sourceResultIds: ['m_1'], finalArtifactRef: null };
  assert.doesNotThrow(() => parseSynthesisResult(synth));
  assert.throws(() => parseSynthesisResult({ ...synth, finalArtifactRef: 'não válido com espaço' }), /multimodel_invalid/);
  assert.throws(() => parseSynthesisResult({ ...synth, agreement: Array.from({ length: 33 }, () => 'x') }), /multimodel_invalid/);
});

test('parseMultimodelRun exige finishedAt em status terminal', () => {
  const branches = [{ memberId: 'm_1', runId: 'mmr_1', attemptIds: [], status: 'succeeded', actualModel: 'm', artifactRefs: [], usage: null, cost: null, startedAt: null, completedAt: '2026-09-20T00:00:01.000Z', errorCode: null, responseHash: null }];
  const base = { schemaVersion: 1, id: 'mmr_1', projectId: 'proj-1', principalId: 'user-1', planId: 'mmp_1', planDigest: digest, status: 'running', branches, synthesis: null, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', revision: 1 };
  assert.doesNotThrow(() => parseMultimodelRun(base));
  assert.throws(() => parseMultimodelRun({ ...base, status: 'succeeded' }), /multimodel_invalid/);
  assert.doesNotThrow(() => parseMultimodelRun({ ...base, status: 'succeeded', finishedAt: '2026-09-20T00:00:02.000Z' }));
  assert.throws(() => parseMultimodelRun({ ...base, unknown: true }), /multimodel_invalid/);
});

test('comando de criação aceita forma simplificada e preenche padrões', () => {
  const cmd = parseCreateMultimodelPlanCommand({
    expectedRevision: 1, mode: 'compare', principalModel: 'p',
    members: [{ role: 'worker', modelId: 'm', task: 't' }],
    limits, quorum: { ...quorum, minSuccess: 1 }, contextSnapshotId: 'snap-1',
  });
  assert.equal(cmd.members[0].connectionId, 'local');
  assert.deepEqual(cmd.members[0].allowedCapabilityIds, []);
  assert.equal(cmd.analystModel, null);
  assert.throws(() => parseCreateMultimodelPlanCommand({ expectedRevision: 1, mode: 'outro', principalModel: 'p', members: [{ role: 'worker', modelId: 'm', task: 't' }], limits, quorum, contextSnapshotId: 'snap-1' }), /multimodel_invalid/);
});
