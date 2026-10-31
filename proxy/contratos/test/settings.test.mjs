import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSettingsPatch,
  parseExportRequest,
  parsePurgeRequest,
  parseLocale,
  clampPanelState,
  SETTINGS_LOCALES,
} from '../settings.js';

test('parseSettingsPatch device theme + CAS', () => {
  const patch = parseSettingsPatch({
    schemaVersion: 1,
    scope: 'device',
    expectedRevision: 0,
    device: { theme: 'auto' },
  });
  assert.equal(patch.device.theme, 'auto');
  assert.equal(patch.expectedRevision, 0);
});

test('rejects unknown fields and invalid locale', () => {
  assert.throws(() => parseSettingsPatch({ schemaVersion: 1, scope: 'device', expectedRevision: 0, device: { theme: 'neon' } }));
  assert.throws(() => parseLocale('xx-ZZ'));
  assert.ok(SETTINGS_LOCALES.includes('pt-BR'));
});

test('export and purge require idempotency key', () => {
  const exp = parseExportRequest({ kind: 'preferences', idempotencyKey: '12345678-export' });
  assert.equal(exp.kind, 'preferences');
  assert.throws(() => parseExportRequest({ kind: 'preferences', idempotencyKey: 'short' }));
  const purge = parsePurgeRequest({ targetClass: 'conversation', targetId: 'c1', idempotencyKey: '12345678-purge' });
  assert.equal(purge.targetClass, 'conversation');
});

test('clampPanelState respects viewport', () => {
  const clamped = clampPanelState({ leftWidth: 900, rightWidth: 900, dividerRatio: 0.99 }, 400);
  assert.ok(clamped.leftWidth <= 180);
  assert.ok(clamped.dividerRatio <= 0.85);
});
