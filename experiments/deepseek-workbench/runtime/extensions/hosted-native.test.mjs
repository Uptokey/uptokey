import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {apply} from './hosted.mjs';
test('plugin registers the installed native adapter with retries disabled and no credential read at startup',()=>{
  let registered;
  apply({llm:{registerAdapter:(routes,adapter)=>{registered={routes,adapter};}},credentials:{resolve:()=>{throw Error('must not resolve at startup');}}});
  assert.deepEqual(registered.routes,['uptokey-hosted']);
  assert.ok(registered.adapter instanceof LlmAdapter);
  assert.equal(registered.adapter.providerRetryPolicy().maxRetries,0);
  assert.equal(registered.adapter.providerInfo().name,'Uptokey hosted');
});
