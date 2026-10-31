import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicEgressPolicy } from './playwright-egress-policy.mjs';

test('egress denies literal and DNS private targets for HTTP and CONNECT', async () => {
  const resolveHost = async () => [{ address: '127.0.0.1', family: 4 }];
  const prepare = createPublicEgressPolicy({ resolveHost });
  for (const isHttp of [true, false]) for (const hostname of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.1', 'public.example'])
    await assert.rejects(prepare({ hostname, port: 80, isHttp }), /Private network/);
});

test('egress pins validated DNS records into the final socket lookup', async () => {
  let resolutions = 0;
  const prepare = createPublicEgressPolicy({ resolveHost: async () => {
    resolutions++;
    return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  } });
  const config = await prepare({ hostname: 'public.example', port: 443, isHttp: false });
  const dial = options => new Promise((resolve, reject) => config.dnsLookup('public.example', options, (error, ...values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(await dial({}), ['93.184.216.34', 4]);
  assert.deepEqual(await dial({ all: true }), [[{ address: '93.184.216.34', family: 4 }]]);
  assert.equal(resolutions, 1);
  assert.equal(config.httpAgent, false);
  await assert.rejects(prepare({ hostname: 'public.example', port: 443, isHttp: false }), /Private network/);
});

test('local fixture scope is exact to protocol, hostname and port', async () => {
  const prepare = createPublicEgressPolicy({ allowedOrigin: 'http://127.0.0.1:8000' });
  await prepare({ hostname: '127.0.0.1', port: 8000, isHttp: true });
  await assert.rejects(prepare({ hostname: '127.0.0.1', port: 8001, isHttp: true }));
  await assert.rejects(prepare({ hostname: '127.0.0.1', port: 8000, isHttp: false }));
});
