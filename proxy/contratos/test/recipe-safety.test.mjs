import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertNoForbiddenContent, assertNoSecretSolicitation, assertNoDangerousLinks } from '../recipe-safety.js';

test('shared recipe guards retain benign guidance and reject concrete secret/link requests', () => {
  assert.doesNotThrow(() => assertNoForbiddenContent({ description: 'Authorization: never share your password here.' }));
  assert.throws(() => assertNoSecretSolicitation('Do not share your password; paste your API key below.'), /forbidden_secret_solicitation/);
  assert.throws(() => assertNoDangerousLinks('java&#x73;cript&colon;alert(1)'), /forbidden_unsafe_link/);
  assert.throws(() => assertNoForbiddenContent({ description: 'uptokey_canary_contract_synthetic' }), /forbidden_recipe_content/);
  assert.throws(() => assertNoForbiddenContent({ steps: [{ description: 'AQ.' + 'synthetic_authorization_key_20261006' }] }), /forbidden_recipe_content/);
  assert.throws(() => assertNoForbiddenContent({ description: 'LLM|123456789|' + 'synthetic_meta_key_20261006' }), /forbidden_recipe_content/);
});

test('core uses byte-identical generated recipe safety contract and exported entry', () => {
  const paths = JSON.parse(readFileSync(new URL('../../CAMINHOS.json', import.meta.url), 'utf8'));
  const root = new URL('../../../', import.meta.url);
  const core = new URL(`${paths.aliases.CORE.current}/`, root);
  for (const file of ['recipe-safety.js', 'recipe-safety.d.ts', 'package.json']) {
    const canonical = readFileSync(new URL(`../${file}`, import.meta.url));
    const generated = readFileSync(new URL(`vendor/sync-contract/${file}`, core));
    assert.equal(createHash('sha256').update(generated).digest('hex'), createHash('sha256').update(canonical).digest('hex'), file);
  }
  const require = createRequire(new URL('package.json', core));
  const module = require('@uptokey/sync-contract/recipe-safety');
  assert.throws(() => module.assertNoDangerousLinks('javascript:alert(1)'), /forbidden_unsafe_link/);
});
