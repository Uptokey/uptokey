import test from 'node:test';
import assert from 'node:assert/strict';

import * as dataEnvelope from '../data-envelope.js';
import * as catalog from '../catalog.js';
import * as recipe from '../recipe.js';

test('DataEnvelope: default envelope is valid and canonical v2', () => {
  const env = dataEnvelope.createEnvelope();
  assert.equal(env.schema, 'uptokey.data-envelope.v2');
  assert.equal(env.version, '2.0.0');
  assert.equal(dataEnvelope.isDataEnvelope(env), true);
  assert.deepEqual(dataEnvelope.validateEnvelope(env), []);
  assert.doesNotThrow(() => dataEnvelope.validateDataEnvelope(env));
});

test('DataEnvelope: rejects malformed envelopes (version, dates, counts, unknown fields, permissions)', () => {
  const malformed = dataEnvelope.createEnvelope({
    version: 'not-a-supported-version',
    createdAt: 'not-a-date',
    unexpectedAuthority: true,
    completeness: { requested: -1, obtained: 99999, partial: 'false' },
    records: [
      dataEnvelope.createRecord({
        provenance: { sourceId: 'fixture', retrievedAt: 'invalid-date' },
        rights: { permissions: { model_input: 'allow' } }
      })
    ]
  });

  const errors = dataEnvelope.validateEnvelope(malformed);
  assert.ok(errors.length >= 5, 'Must report multiple errors');
  assert.ok(errors.some(e => e.includes('Versão não suportada')));
  assert.ok(errors.some(e => e.includes('createdAt')));
  assert.ok(errors.some(e => e.includes('unexpectedAuthority')));
  assert.ok(errors.some(e => e.includes('completeness.requested')));
  assert.ok(errors.some(e => e.includes('completeness.partial')));
  assert.ok(errors.some(e => e.includes('retrievedAt')));
  assert.ok(errors.some(e => e.includes('model_input')));
  assert.equal(dataEnvelope.isDataEnvelope(malformed), false);
  assert.throws(() => dataEnvelope.validateDataEnvelope(malformed));
});

test('DataEnvelope: rejects non-existent dates like 2026-02-30', () => {
  const env = dataEnvelope.createEnvelope({
    createdAt: '2026-02-30T00:00:00.000Z'
  });
  const errors = dataEnvelope.validateEnvelope(env);
  assert.ok(errors.some(e => e.includes('createdAt deve ser uma data ISO UTC válida')));
});

test('DataEnvelope: record preserves publication precision (e.g. year only) without date coercion', () => {
  const rec = dataEnvelope.createRecord({
    provenance: {
      sourceId: 'world_bank',
      retrievedAt: '2026-09-18T00:00:00.000Z',
      sourcePublishedAt: '2020'
    }
  });
  assert.equal(rec.provenance.sourcePublishedAt, '2020');
  assert.notEqual(rec.provenance.sourcePublishedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(dataEnvelope.isDataRecord(rec), true);
});

test('Catalog: rankInstruments filters out unavailable, quota-zero and restricted candidates', () => {
  const profile = (overrides = {}) => catalog.createInstrumentProfile({
    capabilityId: 'fixture.read',
    displayName: 'Fixture',
    authMode: 'anonymous',
    connectionState: 'verified',
    ...overrides
  });

  const testCases = [
    { name: 'unavailable', profile: profile({ connectionState: 'unavailable' }), health: [] },
    { name: 'quota-zero', profile: profile(), health: [{ provider: 'fixture.read', status: 'healthy', quotaRemaining: 0 }] },
    { name: 'restricted-production', profile: profile({ accessEvidence: { officialUrl: 'https://example.invalid/terms', checkedAt: '2026-09-18T00:00:00.000Z', status: 'restricted', productionAllowed: false } }), health: [] },
    { name: 'down-health', profile: profile(), health: [{ provider: 'fixture.read', status: 'down' }] }
  ];

  for (const tc of testCases) {
    const selected = catalog.rankInstruments([tc.profile], { requiredActions: ['read'] }, { activeConnections: [] }, tc.health);
    assert.equal(selected.length, 0, 'Candidate ' + tc.name + ' must NOT be selected');
  }

  // Valid profile should be selected
  const validProfile = profile();
  const selected = catalog.rankInstruments([validProfile], { requiredActions: ['read'] }, { activeConnections: [] }, []);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].capabilityId, 'fixture.read');
});

test('Recipe: computeRecipeDigest binds all material fields (effects, schemas, destinations, budgets)', () => {
  const baseSpec = {
    proposalSchema: 'uptokey.task-recipe.v2',
    id: 'test-recipe',
    version: '1.0.0',
    nodes: [{ id: 'n0', capabilityRef: 'fixture.read', dependsOn: [] }],
    bindings: [],
    budgets: { maxCalls: 1, maxBytes: 1000, maxDurationMs: 5000, maxPages: 1, maxRecords: 10 },
    effectManifest: { reads: ['fixture.read'], writes: [], requiresInference: false, externalDestinations: [] },
    inputSchema: { type: 'object' },
    stopConditions: [{ type: 'node_failure', behavior: 'abort' }],
    sourceRequirements: { rights: 'verified' }
  };

  const digestBase = recipe.computeRecipeDigest(baseSpec);
  assert.equal(typeof digestBase, 'string');
  assert.equal(digestBase.length, 64);

  // Change effectManifest (add write/destination)
  const alteredEffect = {
    ...baseSpec,
    effectManifest: { reads: [], writes: ['channel.send'], requiresInference: true, externalDestinations: ['new-destination'] }
  };
  assert.notEqual(recipe.computeRecipeDigest(alteredEffect), digestBase);

  // Change inputSchema
  const alteredSchema = { ...baseSpec, inputSchema: { type: 'string' } };
  assert.notEqual(recipe.computeRecipeDigest(alteredSchema), digestBase);

  // Change stopConditions
  const alteredStop = { ...baseSpec, stopConditions: [{ type: 'timeout', behavior: 'partial_result' }] };
  assert.notEqual(recipe.computeRecipeDigest(alteredStop), digestBase);

  // Change sourceRequirements
  const alteredSource = { ...baseSpec, sourceRequirements: { rights: 'custom' } };
  assert.notEqual(recipe.computeRecipeDigest(alteredSource), digestBase);

  // Change budgets
  const alteredBudget = { ...baseSpec, budgets: { ...baseSpec.budgets, maxCalls: 2 } };
  assert.notEqual(recipe.computeRecipeDigest(alteredBudget), digestBase);
});

test('Recipe: validateRecipe rejects malformed budgets and invalid revisionDigest', () => {
  const malformed = {
    proposalSchema: 'uptokey.task-recipe.v2',
    id: 'malformed-recipe',
    version: '1.0.0',
    nodes: [{ id: 'n0', capabilityRef: 'fixture.read' }],
    bindings: [],
    budgets: { maxCalls: NaN, maxDurationMs: Infinity },
    effectManifest: { reads: [], writes: [], requiresInference: false, externalDestinations: [] },
    revisionDigest: 'not-a-hash'
  };

  const errors = recipe.validateRecipe(malformed);
  assert.ok(errors.length >= 3, 'Must reject NaN, Infinity, missing budgets and non-hex digest');
  assert.ok(errors.some(e => e.includes('revisionDigest')));
  assert.ok(errors.some(e => e.includes('budgets.maxCalls')));
  assert.ok(errors.some(e => e.includes('budgets.maxDurationMs')));
  assert.ok(errors.some(e => e.includes('budgets.maxBytes')));
  assert.equal(recipe.isTaskRecipeSpec(malformed), false);
});

test('Recipe: resolvePointer implements strict RFC 6901 JSON Pointer', () => {
  // Slash '/' points to empty-string key
  assert.equal(recipe.resolvePointer({ '': 'empty-name' }, '/'), 'empty-name');

  // Empty string '' points to root object
  const root = { a: 1 };
  assert.equal(recipe.resolvePointer(root, ''), root);

  // Array index must be strict integer, 0junk is invalid
  assert.equal(recipe.resolvePointer({ items: ['first'] }, '/items/0junk'), undefined);
  assert.equal(recipe.resolvePointer({ items: ['first', 'second'] }, '/items/1'), 'second');

  // Nested object lookup
  assert.equal(recipe.resolvePointer({ a: { b: { c: 'found' } } }, '/a/b/c'), 'found');

  // Tilde decoding: ~1 is / and ~0 is ~
  assert.equal(recipe.resolvePointer({ 'a/b': 'slash' }, '/a~1b'), 'slash');
  assert.equal(recipe.resolvePointer({ 'm~n': 'tilde' }, '/m~0n'), 'tilde');

  // Prototype poisoning prevention
  assert.equal(recipe.resolvePointer({}, '/__proto__'), undefined);
  assert.equal(recipe.resolvePointer({}, '/constructor/prototype'), undefined);
});

test('Recipe: topologicalSort orders nodes and detects cycles', () => {
  const nodes = [
    { id: 'step2', capabilityRef: 'c2', dependsOn: ['step1'] },
    { id: 'step1', capabilityRef: 'c1', dependsOn: [] },
    { id: 'step3', capabilityRef: 'c3', dependsOn: ['step2'] }
  ];
  const sorted = recipe.topologicalSort(nodes);
  assert.deepEqual(sorted.map(n => n.id), ['step1', 'step2', 'step3']);

  const cycleNodes = [
    { id: 'a', capabilityRef: 'ca', dependsOn: ['b'] },
    { id: 'b', capabilityRef: 'cb', dependsOn: ['a'] }
  ];
  assert.throws(() => recipe.topologicalSort(cycleNodes), /Ciclo/);
});
