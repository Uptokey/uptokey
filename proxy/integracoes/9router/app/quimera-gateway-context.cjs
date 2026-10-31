const { AsyncLocalStorage } = require('node:async_hooks');
// W0 has one source. The child and its Next handler use the same revision-5
// parser as the parent, including bounded audio parts; no local protocol fork.
const { parseGatewayChatRequest } = require('../../../contratos/gateway.js');
// Next bundles and the native server share one request-local authority in this process.
const key = Symbol.for('uptokey.quimera.gateway.context.v1');
const storage = globalThis[key] ??= new AsyncLocalStorage();
const current = () => storage.getStore();
function run(context, action) {
  if (!context || typeof context.dispatch !== 'function' || !context.signal) throw new Error('quimera_gateway_context_invalid');
  return storage.run(context, action);
}
function assertChatBody(body) {
  const context = current();
  // The parent still owns exact wire equality, artifact provenance, consent,
  // destination declarations and last-moment authority at dispatch.
  try {
    if (!context || body?.model !== context.model) throw new Error();
    parseGatewayChatRequest(body);
  } catch { throw new Error('quimera_gateway_chat_invalid'); }
  return context;
}
module.exports = { current, run, assertChatBody, assertTextBody: assertChatBody };
