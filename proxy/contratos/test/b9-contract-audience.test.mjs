// B9 — additive 'tui' audience, audience transition parser and single JS/d.ts surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PAIRING_AUDIENCES, parsePairingAudience, CLIENT_AUDIENCE_TRANSITIONS, parseClientAudienceTransition } from '../client-keys.js';
import { checkContractSurface, jsExports, dtsExports } from '../scripts/check-contract-surface.mjs';

const ID = '11111111-1111-4111-8111-111111111111';

test('PAIRING_AUDIENCES adds explicit public PWA approval without changing previous values or the legacy default', () => {
  assert.deepEqual([...PAIRING_AUDIENCES], ['legacy', 'vscode', 'browser-extension', 'tauri', 'tui', 'pwa']);
  assert.ok(Object.isFrozen(PAIRING_AUDIENCES));
  assert.equal(parsePairingAudience(undefined), 'legacy');
  assert.equal(parsePairingAudience('tui'), 'tui');
  assert.equal(parsePairingAudience('pwa'), 'pwa');
  for (const value of ['cli', 'admin', 'TUI', ' tui', null, 1, {}, ['tui']]) assert.throws(() => parsePairingAudience(value), /pairing_audience_invalid/);
});

test('audience transition: only published narrowing pairs, exact keys, UUID and positive revision', () => {
  assert.ok(Object.isFrozen(CLIENT_AUDIENCE_TRANSITIONS) && CLIENT_AUDIENCE_TRANSITIONS.every(Object.isFrozen));
  const ok = parseClientAudienceTransition({ kind: 'transition', clientId: ID, from: 'pwa', to: 'tui', expectedPolicyRevision: 7 });
  assert.deepEqual(ok, { kind: 'transition', clientId: ID, from: 'pwa', to: 'tui', expectedPolicyRevision: 7 });
  assert.ok(Object.isFrozen(ok));
  assert.deepEqual(parseClientAudienceTransition({ kind: 'revert', clientId: ID, expectedPolicyRevision: 8 }), { kind: 'revert', clientId: ID, expectedPolicyRevision: 8 });
  const bad = [
    { kind: 'transition', clientId: ID, from: 'tui', to: 'pwa', expectedPolicyRevision: 1 },
    { kind: 'transition', clientId: ID, from: 'legacy', to: 'tui', expectedPolicyRevision: 1 },
    { kind: 'transition', clientId: ID, from: 'vscode', to: 'tui', expectedPolicyRevision: 1 },
    { kind: 'transition', clientId: ID, from: 'pwa', to: 'tui' },
    { kind: 'transition', clientId: ID, from: 'pwa', to: 'tui', expectedPolicyRevision: '1' },
    { kind: 'transition', clientId: ID, from: 'pwa', to: 'tui', expectedPolicyRevision: 1, clientName: 'Uptokey TUI' },
    { kind: 'revert', clientId: ID, expectedPolicyRevision: 1, to: 'pwa' },
    { kind: 'revert', clientId: 'x', expectedPolicyRevision: 1 },
    Object.assign(Object.create({ kind: 'revert' }), { clientId: ID, expectedPolicyRevision: 1 }),
    undefined, null, 'transition', [],
  ];
  for (const input of bad) assert.throws(() => parseClientAudienceTransition(input), /audience_transition_invalid/);
});

test('every runtime export has a declaration and every package export resolves', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = checkContractSurface(root);
  assert.deepEqual(result.problems, []);
  assert.ok(result.modules >= 40);
});

test('surface checker detects undeclared values and declarations without runtime', () => {
  const js = jsExports("export const A = 1;\nexport function b() {}\nconst C = 1, D = 2;\nexport { C, D as E };\n// export const F = 1;");
  assert.deepEqual([...js].sort(), ['A', 'C', 'E', 'b']);
  const d = dtsExports("export declare const A: 1;\nexport function b(): void;\nexport type T = 1;\nexport interface I {}\nexport const G: 2;");
  assert.deepEqual([...d.values].sort(), ['A', 'G', 'b']);
  assert.deepEqual([...d.types].sort(), ['I', 'T']);
});
