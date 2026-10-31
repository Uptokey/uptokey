// D01-core: contrato v2 de perfil de mídia — identidade por conta/provedor
// com legado custom preservado. Estes testes fixam os DOIS formatos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaConfigurationRequest, parseMediaConfigurationInfo, parseMediaProfileDescriptor } from '../media-profile.js';

const CONN = '11111111-1111-4111-8111-111111111111';
const REV = 'a'.repeat(64);

test('v2: perfil por CONTA escolhida aceita connectionId UUID + providerId', () => {
  const parsed = parseMediaConfigurationRequest('image', {
    expectedRevision: 0,
    connectionId: CONN,
    connectionRevision: REV,
    providerId: 'groq',
    model: 'fixture-image-1',
    endpoint: 'https://api.example.com/v1/images/generations',
  });
  assert.equal(parsed.connectionId, CONN);
  assert.equal(parsed.providerId, 'groq');
});

test('v2: perfil por conta EXIGE providerId (sem atalho para custom)', () => {
  assert.throws(() => parseMediaConfigurationRequest('image', {
    expectedRevision: 0, connectionId: CONN, connectionRevision: REV,
    model: 'm', endpoint: 'https://api.example.com/v1/images/generations',
  }), /media_profile_invalid/);
  assert.throws(() => parseMediaConfigurationRequest('image', {
    expectedRevision: 0, connectionId: CONN, connectionRevision: REV,
    providerId: 'BAD provider!', model: 'm', endpoint: 'https://api.example.com/v1/images/generations',
  }), /media_profile_invalid/);
});

test('v2: legado custom continua válido (sem providerId)', () => {
  const parsed = parseMediaConfigurationRequest('image', {
    expectedRevision: 0, connectionId: 'custom', connectionRevision: REV,
    model: 'm', endpoint: 'https://api.example.com/v1/images/generations',
  });
  assert.equal(parsed.connectionId, 'custom');
});

test('v2: info de configuração lista conexão por conta com providerId', () => {
  const parsed = parseMediaConfigurationInfo({
    kind: 'image', mode: 'managed', configured: true, available: true, profileRevision: 0,
    profile: { connectionId: CONN, providerId: 'groq', model: 'm', endpoint: 'https://api.example.com/v1/images/generations' },
    connections: [{ id: CONN, providerId: 'groq', label: 'Groq conta', endpointOrigin: 'https://api.example.com', revision: REV }],
  });
  assert.equal(parsed.connections[0].id, CONN);
  assert.equal(parsed.connections[0].providerId, 'groq');
});

test('v2: descriptor declara destino e credencial POR CONTA', () => {
  const parsed = parseMediaProfileDescriptor({
    schemaVersion: 1, modality: 'image', supportLevel: 'custom_openai_compatible',
    driver: '9router', driverRevision: 'b'.repeat(40),
    endpoint: 'https://api.example.com/v1/images/generations',
    destination: 'groq', models: ['fixture-image-1'], mode: 'sync', cancellation: 'none',
    input: { mediaTypes: ['image/png'], maxBytes: 1, maxItems: 1 },
    output: { mediaTypes: ['image/png'], maxBytes: 1, maxItems: 1 },
    credential: 'local_vault:provider:groq', commercialVerification: 'not_verified', termsCheckedAt: null,
  });
  assert.equal(parsed.destination, 'groq');
  assert.equal(parsed.credential, 'local_vault:provider:groq');
  // Legado custom continua aceito.
  const legacy = parseMediaProfileDescriptor({
    schemaVersion: 1, modality: 'image', supportLevel: 'custom_openai_compatible',
    driver: '9router', driverRevision: 'b'.repeat(40),
    endpoint: 'https://api.example.com/v1/images/generations',
    destination: 'custom', models: ['m'], mode: 'sync', cancellation: 'none',
    input: { mediaTypes: ['image/png'], maxBytes: 1, maxItems: 1 },
    output: { mediaTypes: ['image/png'], maxBytes: 1, maxItems: 1 },
    credential: 'local_vault:provider:custom', commercialVerification: 'not_verified', termsCheckedAt: null,
  });
  assert.equal(legacy.destination, 'custom');
});
