import test from 'node:test';
import assert from 'node:assert/strict';
import { unavailableVerificationDisplayed } from './journey-claim.mjs';

test('claim journey distinguishes a negated warning from an actual runner result', () => {
  const warning = '△ Os arquivos atuais ainda não foram verificados por testes aprovados.';
  const blocked = '  ▶ Verificação node-app indisponível · bloqueada — runtime_image_not_configured';
  assert.equal(unavailableVerificationDisplayed(warning + '\n' + blocked), true);
  assert.equal(unavailableVerificationDisplayed(warning), false, 'a warning alone is not an executor result');
  assert.equal(unavailableVerificationDisplayed(warning + '\n  ▶ Verificação node-app · test · aprovada'), false, 'a fabricated approval is still rejected');
  assert.equal(unavailableVerificationDisplayed(blocked + '\n  ▶ Verificação node-app · test · succeeded'), false, 'another successful runner row cannot hide behind a blocked row');
  assert.equal(unavailableVerificationDisplayed('▶ Verificação node-app · test · running'), false, 'starting the runner is not a settled outcome');
});
