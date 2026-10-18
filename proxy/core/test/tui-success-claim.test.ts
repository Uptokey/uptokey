import './isolated-gateway-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsSuccess } from '../src/tui/success-claim.ts';

test('success claims are recognized in the ten interface languages', () => {
  const claims = [
    'I updated slugify. The test now passes with the updated implementation.',
    'Fixed: sum adds the numbers.',
    'Corrigido. Os testes passam agora.',
    'Listo, el error está corregido y las pruebas pasan.',
    'C’est corrigé, les tests passent.',
    'Der Fehler ist behoben, alle Tests bestehen.',
    'Ho corretto il bug, i test passano.',
    'バグを修正しました。テストは通ります。',
    '버그를 수정했습니다. 테스트가 통과합니다.',
    '已修复，测试通过。',
    'تم الإصلاح والاختبارات تنجح الآن.',
  ];
  for (const text of claims) assert.equal(claimsSuccess(text), true, text);
});

test('negated, failing, hedged or code-only text is not a claim', () => {
  const notClaims = [
    'The test still fails after the change.',
    'This is not fixed yet; the test doesn\'t pass.',
    'It might work now, but I could not run the tests.',
    'O teste ainda falha.',
    'Não foi corrigido.',
    'La prueba no pasa todavía.',
    'Les tests ne passent pas.',
    'Der Test schlägt fehl.',
    'Il test fallisce ancora.',
    'テストは失敗しました。',
    '테스트가 실패했습니다.',
    '测试没有通过。',
    'فشل الاختبار.',
    'I read the file and changed the regex.',
    '```js\nassert.ok(result.passes); // fixed\n```',
  ];
  for (const text of notClaims) assert.equal(claimsSuccess(text), false, text);
});

test('one claiming sentence among neutral ones is enough; Portuguese "no" does not hide it', () => {
  assert.equal(claimsSuccess('Li o arquivo no diretório src. O teste passa no arquivo de testes.'), true);
  assert.equal(claimsSuccess('Changed restock to add units.\n\nAll tests pass.'), true);
});
