#!/usr/bin/env node
/** Synthetic HTTP pipeline measurement. Run with Node 22 --experimental-strip-types.
 * Reuses the loopback fixture pattern in test/responses-sdk.test.ts and the existing
 * eventsource-parser (MIT). No real provider, profile, prompt or credential is used.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createParser } from 'eventsource-parser';

const core = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(core, '../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error(code), { benchmarkCode: code });
const ensure = (condition, code) => { if (!condition) throw failure(code); };

export function parseOptions(argv) {
  const defaults = { samples: 1000, warmup: 100, repetitions: 3, concurrency: 8,
    payloadKiB: 1, requestTimeoutMs: 5000, deadlineMs: 600000, idleMs: 60000, phaseTiming: 0, nullControl: 0, fixtureDelayMs: 2, fixtureChunked: 0 };
  const bounds = { samples: [1, 100000], warmup: [0, 10000], repetitions: [1, 10],
    concurrency: [1, 32], payloadKiB: [1, 256], requestTimeoutMs: [100, 60000],
    deadlineMs: [1000, 3600000], idleMs: [0, 60000], phaseTiming: [0, 1], nullControl: [0, 1], fixtureDelayMs: [0, 100], fixtureChunked: [0, 1] };
  const names = { 'payload-kib': 'payloadKiB', 'request-timeout-ms': 'requestTimeoutMs',
    'deadline-ms': 'deadlineMs', 'idle-ms': 'idleMs', 'phase-timing': 'phaseTiming', 'null-control': 'nullControl', 'fixture-delay-ms': 'fixtureDelayMs', 'fixture-chunked': 'fixtureChunked' };
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]?.slice(2)] ?? argv[i]?.slice(2);
    ensure(argv[i]?.startsWith('--') && (Object.hasOwn(bounds, key) || key === 'output'), 'invalid_option');
    const value = argv[i + 1];
    if (key === 'output') {
      ensure(typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*\.json$/i.test(value) && basename(value) === value, 'invalid_output_name');
      options.output = value;
    } else {
      const number = Number(value), [min, max] = bounds[key];
      ensure(typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= min && number <= max, 'invalid_option_value');
      options[key] = number;
    }
  }
  return options;
}

export function distribution(values) {
  ensure(values.length > 0 && values.every(Number.isFinite), 'invalid_observations');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: values.length, min: sorted[0], p50: percentile(.5), p95: percentile(.95),
    p99: percentile(.99), max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
}

export function summarizePairs(pairs) {
  ensure(pairs.length > 0 && pairs.every(p => p.direct && p.gateway), 'unpaired_observation');
  return Object.fromEntries(['latencyMs', 'firstContentMs'].map(metric => [metric, {
    direct: distribution(pairs.map(p => p.direct[metric])),
    gateway: distribution(pairs.map(p => p.gateway[metric])),
    pairedOverhead: distribution(pairs.map(p => p.gateway[metric] - p.direct[metric])),
  }]));
}

// An error rejects the phase after active requests settle; no successful-only percentile.
export async function boundedBatch(count, concurrency, operation) {
  const results = new Array(count);
  let cursor = 0, error;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (!error && cursor < count) {
      const index = cursor++;
      try { results[index] = await operation(index); } catch (caught) { error ??= caught; }
    }
  }));
  if (error) throw error;
  return results;
}

export async function measureRequest(endpoint, body, token, route, timeoutMs, signal, expected, fetchImpl = fetch) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const started = performance.now();
  let reader, firstContentMs, done = false, finish = false, content = '', usage = false, bytes = 0;
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-benchmark-route': route },
      body, signal: AbortSignal.any([signal, timeout.signal]) });
    if (response.status !== 200) { await response.body?.cancel(); throw failure(`http_status_${response.status}`); }
    ensure(response.headers.get('content-type')?.startsWith('text/event-stream') && response.body, 'invalid_sse_response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = createParser({ onError: () => { throw failure('invalid_sse'); }, onEvent(event) {
      ensure(!done, 'event_after_done');
      if (event.data === '[DONE]') { done = true; return; }
      let data;
      try { data = JSON.parse(event.data); } catch { throw failure('invalid_sse_json'); }
      ensure(!data.error, 'sse_error');
      for (const choice of data.choices ?? []) {
        const text = choice.delta?.content;
        if (typeof text === 'string' && text.length) {
          firstContentMs ??= performance.now() - started;
          content += text;
          ensure(content.length <= expected.length, 'unexpected_content');
        }
        if (choice.finish_reason === 'stop') finish = true;
      }
      if (data.usage) usage = data.usage.prompt_tokens === 256 && data.usage.completion_tokens === 8 && data.usage.total_tokens === 264;
    } });
    reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      ensure(bytes <= 65536, 'response_too_large');
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
    ensure(done && finish && usage && content === expected && Number.isFinite(firstContentMs), 'incomplete_or_wrong_response');
    return { latencyMs: performance.now() - started, firstContentMs, bytes };
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {});
    if (error?.benchmarkCode) throw error;
    throw failure(timeout.signal.aborted ? 'request_timeout' : signal.aborted ? 'run_aborted' : 'request_failed');
  } finally { clearTimeout(timer); reader?.releaseLock(); }
}

async function sourceDigest() {
  const entries = [];
  async function walk(directory, relative) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (entry.isFile()) entries.push([name, sha256(await readFile(join(directory, entry.name)))]);
    }
  }
  await walk(join(core, 'src'), 'src');
  await walk(join(core, 'vendor/sync-contract'), 'vendor/sync-contract');
  for (const name of ['package.json', 'package-lock.json', 'scripts/benchmark-proxy-pipeline.mjs']) entries.push([name, sha256(await readFile(join(core, name)))]);
  return { sha256: sha256(JSON.stringify(entries)), files: entries.length, scope: 'core/src + core/vendor/sync-contract + core/package{,-lock}.json + harness',
    harnessSha256: entries.at(-1)[1] };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections();
  });
}

// Opt-in diagnostic wrappers on fixture-owned instances only. Originals still own
// admission, serialization, atomic writes/fsync, upstream dispatch and responses.
function instrumentPhases(router, ledger, adapter) {
  const local = new AsyncLocalStorage(), rows = [];
  const profiler = { measuring: false, rows };
  const add = (record, key, value) => { record[key] = (record[key] ?? 0) + value; };
  for (const name of ['reserve', 'compensateConnectionFailure', 'reconcileProvider']) {
    const original = ledger[name];
    ledger[name] = function (...args) {
      const parent = local.getStore();
      if (!parent) return original.apply(this, args);
      const started = performance.now();
      if (name === 'reserve') parent.record.dispatchToReserveMs ??= started - parent.started;
      return local.run({ ...parent, operation: name }, async () => {
        try { return await original.apply(this, args); }
        finally { add(parent.record, `${name}Ms`, performance.now() - started); add(parent.record, `${name}Calls`, 1); }
      });
    };
  }
  const serial = ledger.serial;
  ensure(typeof serial === 'function', 'phase_serial_hook_unavailable');
  ledger.serial = function (operation) {
    const context = local.getStore(), queued = performance.now();
    return serial.call(this, async () => {
      const started = performance.now();
      if (context) add(context.record, `${context.operation}QueueMs`, started - queued);
      try { return await operation(); }
      finally { if (context) add(context.record, `${context.operation}ExecutionMs`, performance.now() - started); }
    });
  };
  const attach = router.attachEgressStore;
  router.attachEgressStore = function (store) {
    const original = store.recordReceipt;
    store.recordReceipt = async function (...args) {
      const context = local.getStore(), started = performance.now();
      try { return await original.apply(this, args); }
      finally {
        if (context) { add(context.record, 'egressReceiptMs', performance.now() - started); add(context.record, 'egressReceiptCalls', 1); }
      }
    };
    return attach.call(this, store);
  };
  const providerDispatch = adapter.dispatch;
  adapter.dispatch = async function (...args) {
    const context = local.getStore(), started = performance.now();
    if (context) context.record.dispatchToProviderMs = started - context.started;
    try { return await providerDispatch.apply(this, args); }
    finally { if (context) add(context.record, 'providerHeadersMs', performance.now() - started); }
  };
  const dispatch = router.dispatch;
  router.dispatch = function (...args) {
    const context = { started: performance.now(), record: {}, measuring: profiler.measuring };
    return local.run(context, async () => {
      try { return await dispatch.apply(this, args); }
      finally {
        context.record.dispatchHeadersMs = performance.now() - context.started;
        if (context.measuring) rows.push(context.record);
      }
    });
  };
  return profiler;
}

export async function runBenchmark(options) {
  ensure(Number(process.versions.node.split('.')[0]) === 22, 'node22_required');
  const profile = await mkdtemp(join(tmpdir(), 'uptokey-pipeline-benchmark-'));
  // Same environment allowlist as scripts/test-isolated.mjs, before product imports.
  const osKeys = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec', 'processor_architecture', 'number_of_processors', 'programfiles', 'programfiles(x86)', 'lang', 'lc_all']);
  for (const key of Object.keys(process.env)) if (!osKeys.has(key.toLowerCase())) delete process.env[key];
  Object.assign(process.env, { UPTOKEY_QUIMERA_DATA_DIR: join(profile, 'data'), UPTOKEY_SETTINGS_DIR: join(profile, 'settings'), UPTOKEY_AUTOMATIONS_DIR: join(profile, 'automations') });
  const sourcesBefore = await sourceDigest();
  let gitHead = null, gitTrackedDirty = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, windowsHide: true, stdio: 'ignore' }); gitTrackedDirty = false; } catch { gitTrackedDirty = true; }
  } catch { /* Actual source digest remains available for an uncommitted workspace. */ }
  const report = { schema: 'uptokey-proxy-pipeline-benchmark-v1', status: 'failed', startedAt: new Date().toISOString(),
    options, provenance: { gitHead, gitTrackedDirty, node: process.version, platform: process.platform, arch: process.arch,
      osRelease: release(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), sourcesBefore },
    method: { fixture: `synthetic loopback HTTP SSE, fixed content, ${options.fixtureDelayMs} ms first-content delay + ${options.fixtureDelayMs} ms tail delay; zero emits without timers`,
      payloadUnit: 'UTF-8 user-message bytes; serialized body bytes recorded separately', cache: 'not instantiated; hits asserted zero',
      pairing: 'same payload and index in sequential bounded batches; route order alternates every batch and repetition',
      overhead: 'gateway minus direct per matched pair, signed; percentiles of differences, not differences of percentiles',
      percentile: 'nearest-rank', throughput: 'successful requests / sum of route batch wall time, excludes warmup and other route',
      memory: 'whole process: client + fixture + gateway + retained numeric samples; no forced GC; not isolated proxy retained-memory gate',
      isolation: 'random loopback ports, MemorySecretStore, temporary disk ledger, environment allowlist; fetch egress restricted to owned listeners',
      acceptance: 'measurement validity only; no full R7, production provider, cold-start, cancellation, UI or saturation acceptance',
      nullControl: options.nullControl === 1 ? 'Both labels call the SAME upstream directly. No proxy dispatch. Diagnoses paired estimator noise; never a proxy acceptance result.' : false },
    repetitions: [] };
  const run = new AbortController();
  const timer = setTimeout(() => run.abort(), options.deadlineMs);
  const abort = () => run.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const originalFetch = globalThis.fetch, allowedOrigins = new Set();
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!allowedOrigins.has(url.origin)) return Promise.reject(failure('non_fixture_egress_blocked'));
    return originalFetch(input, init);
  };
  let provider, gateway, app, allowedHosts, gatewayHost;
  try {
    const [{ serve }, { createApp, ALLOWED_HOSTS, ensureLocalToken }, { defaultConfig, ensureProviderEntry },
      { GenericOpenAIAdapter }, { MemorySecretStore }, { Router }, { QuotaLedger }, { RequestAdmission }] = await Promise.all([
      import('@hono/node-server'), import('../src/app.ts'), import('../src/config.ts'), import('../src/adapters.ts'),
      import('../src/secret-store.ts'), import('../src/router.ts'), import('../src/quota-ledger.ts'), import('../src/request-admission.ts')]);
    allowedHosts = ALLOWED_HOSTS;
    const expected = 'Synthetic pipeline result.';
    const payload = 'Synthetic bounded benchmark. '.repeat(Math.ceil(options.payloadKiB * 1024 / 29)).slice(0, options.payloadKiB * 1024);
    const body = JSON.stringify({ model: 'fixture-pipeline', messages: [{ role: 'user', content: payload }], max_tokens: 32,
      stream: true, stream_options: { include_usage: true }, temperature: 0 });
    const providerToken = 'synthetic-benchmark-provider';
    const counts = { direct: 0, gateway: 0, invalid: 0 };
    const frame = value => `data: ${JSON.stringify({ id: 'chatcmpl-fixture-pipeline', object: 'chat.completion.chunk', created: 1, model: 'fixture-pipeline', ...value })}\n\n`;
    provider = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const route = request.headers.get('x-benchmark-route');
      let incoming; try { incoming = await request.json(); } catch { /* Invalid fixture input fails below. */ }
      if (!['direct', 'gateway'].includes(route) || request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions' ||
        request.headers.get('authorization') !== `Bearer ${providerToken}` || incoming?.model !== 'fixture-pipeline' || incoming?.messages?.[0]?.content !== payload || !incoming?.stream) {
        counts.invalid++; return new Response(null, { status: 400 });
      }
      counts[route]++;
      let firstTimer, tailTimer;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] })));
        const first = () => {
          controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { content: expected.slice(0, 10) } }] })));
          const tail = () => {
            controller.enqueue(encoder.encode(frame({ choices: [{ index: 0, delta: { content: expected.slice(10) }, finish_reason: 'stop' }] }) +
              frame({ choices: [], usage: { prompt_tokens: 256, completion_tokens: 8, total_tokens: 264 } }) + 'data: [DONE]\n\n'));
            controller.close();
          };
          if (options.fixtureDelayMs) tailTimer = setTimeout(tail, options.fixtureDelayMs); else tail();
        };
        if (options.fixtureDelayMs) firstTimer = setTimeout(first, options.fixtureDelayMs); else first();
      }, cancel() { clearTimeout(firstTimer); clearTimeout(tailTimer); } }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', ...(options.fixtureChunked ? { 'transfer-encoding': 'chunked' } : {}) } });
    } });
    if (!provider.listening) await once(provider, 'listening');
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    allowedOrigins.add(providerOrigin);
    const endpoint = `${providerOrigin}/v1/chat/completions`;
    const config = structuredClone(defaultConfig); ensureProviderEntry(config, 'custom');
    Object.assign(config.providers.custom, { enabled: true, configured: true, endpointUrl: endpoint,
      models: ['fixture-pipeline'], defaultModel: 'fixture-pipeline', max429Retries: 0, requestTimeoutMs: options.requestTimeoutMs,
      budget: { rpm: 10000000, tpm: 1000000000000, source: 'account_user_input' } });
    config.fallbackOrder = ['custom'];
    const secrets = new MemorySecretStore(); await ensureLocalToken(secrets);
    const token = await secrets.get('local:api-token'); await secrets.set('provider:custom', providerToken);
    const ledger = new QuotaLedger(join(profile, 'quota-ledger.json')); await ledger.initialize();
    const adapter = new GenericOpenAIAdapter('custom', endpoint, { 'x-benchmark-route': 'gateway' });
    const router = new Router(config, new Map([['custom', adapter]]), secrets, ledger);
    const profiler = options.phaseTiming && !options.nullControl ? instrumentPhases(router, ledger, adapter) : undefined;
    const admission = new RequestAdmission(Math.max(16, options.concurrency));
    app = createApp(config, router, secrets, async () => ({ allowed: true }), undefined, undefined, undefined, admission, async () => structuredClone(config));
    await app.workspaceReady;
    gateway = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    if (!gateway.listening) await once(gateway, 'listening');
    gatewayHost = `127.0.0.1:${gateway.address().port}`; ALLOWED_HOSTS.add(gatewayHost);
    allowedOrigins.add(`http://${gatewayHost}`);
    const targets = { direct: [endpoint, providerToken], gateway: options.nullControl ? [endpoint, providerToken] : [`http://${gatewayHost}/v1/chat/completions`, token] };
    report.fixture = { payloadBytes: Buffer.byteLength(payload), requestBodyBytes: Buffer.byteLength(body), payloadSha256: sha256(payload),
      responseContentBytes: Buffer.byteLength(expected), localAdmissionMaximum: admission.maximum, quotas: config.providers.custom.budget };
    async function phase(count, repetition, retain) {
      if (profiler) profiler.measuring = retain;
      const pairs = [], routeWallMs = { direct: 0, gateway: 0 }, started = performance.now();
      for (let offset = 0, batch = 0; offset < count; offset += options.concurrency, batch++) {
        run.signal.throwIfAborted();
        const size = Math.min(options.concurrency, count - offset), pairBatch = Array.from({ length: size }, () => ({}));
        const order = (batch + repetition) % 2 ? ['gateway', 'direct'] : ['direct', 'gateway'];
        for (const route of order) {
          const before = performance.now();
          const values = await boundedBatch(size, options.concurrency, () => measureRequest(targets[route][0], body, targets[route][1], route,
            options.requestTimeoutMs, run.signal, expected));
          routeWallMs[route] += performance.now() - before;
          values.forEach((value, index) => { pairBatch[index][route] = value; });
        }
        if (retain) pairs.push(...pairBatch);
      }
      return { pairs, routeWallMs, wallMs: performance.now() - started };
    }
    const allPairs = [];
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      const warmup = await phase(options.warmup, repetition, false);
      const memoryBefore = process.memoryUsage();
      const measured = await phase(options.samples, repetition, true);
      allPairs.push(...measured.pairs);
      report.repetitions.push({ repetition: repetition + 1, firstBatchOrder: repetition % 2 ? 'gateway_then_direct' : 'direct_then_gateway',
        warmup: { matchedPairs: options.warmup, wallMs: warmup.wallMs }, matchedPairs: measured.pairs.length,
        wallMs: measured.wallMs, routeWallMs: measured.routeWallMs,
        requestsPerSecond: Object.fromEntries(Object.entries(measured.routeWallMs).map(([route, ms]) => [route, measured.pairs.length * 1000 / ms])),
        metrics: summarizePairs(measured.pairs), memoryBefore, memoryAfter: process.memoryUsage(),
        samples: measured.pairs.map(p => [p.direct.latencyMs, p.gateway.latencyMs, p.direct.firstContentMs, p.gateway.firstContentMs]) });
    }
    const routeWallMs = Object.fromEntries(['direct', 'gateway'].map(route => [route, report.repetitions.reduce((sum, r) => sum + r.routeWallMs[route], 0)]));
    report.aggregate = { uniqueMatchedPairs: allPairs.length, httpRequestsMeasured: allPairs.length * 2, routeWallMs,
      requestsPerSecond: Object.fromEntries(Object.entries(routeWallMs).map(([route, ms]) => [route, allPairs.length * 1000 / ms])),
      metrics: summarizePairs(allPairs), p95SampleCountMetPerRepetition: options.samples >= 1000,
      p99SampleCountMetPerRepetition: options.samples >= 10000, threeRepetitionsMet: options.repetitions >= 3,
      sampleColumns: ['directLatencyMs', 'gatewayLatencyMs', 'directFirstContentMs', 'gatewayFirstContentMs'] };
    if (profiler) {
      ensure(profiler.rows.length === allPairs.length, 'phase_count_mismatch');
      const columns = [...new Set(profiler.rows.flatMap(Object.keys))].sort();
      report.phaseTiming = { scope: 'instrumented diagnostic; measured gateway requests only, warmup excluded',
        method: 'wrappers on fixture-owned Router, adapter, QuotaLedger methods and serial callback, and attached EgressStore.recordReceipt; original persistence and serialization preserved',
        interpretation: 'reserveMs includes queue and durable atomic-write callback; ExecutionMs includes validation and I/O, not an isolated fsync timer; dispatch/provider durations end at response headers, not stream EOF; overlapping metrics must not be added',
        count: profiler.rows.length, metrics: Object.fromEntries(columns.map(key => [key, distribution(profiler.rows.map(row => row[key] ?? 0))])),
        sampleColumns: columns, samples: profiler.rows.map(row => columns.map(key => row[key] ?? 0)) };
    }
    report.memory = { beforeIdle: process.memoryUsage(), requestedIdleMs: options.idleMs };
    const idleStart = performance.now(); await delay(options.idleMs, undefined, { signal: run.signal });
    Object.assign(report.memory, { actualIdleMs: performance.now() - idleStart, afterIdle: process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024 });
    report.memory.deltaFromFirstPostWarmup = Object.fromEntries(Object.entries(report.memory.afterIdle).map(([key, value]) => [key, value - report.repetitions[0].memoryBefore[key]]));
    const expectedRequests = options.repetitions * (options.samples + options.warmup);
    report.correctness = { fixtureRequests: counts, expectedRequestsPerRoute: expectedRequests, ledgerRequests: ledger.snapshot().custom?.day.requests ?? 0,
      admission: admission.status(), cache: router.cacheMetrics() };
    ensure(counts.invalid === 0 && counts.direct === expectedRequests && counts.gateway === expectedRequests, 'fixture_count_mismatch');
    ensure(report.correctness.ledgerRequests === (options.nullControl ? 0 : expectedRequests) && admission.status().active === 0, 'accounting_mismatch');
    ensure(router.cacheMetrics().exactHits === 0, 'cache_hit_in_basecase');
    report.provenance.sourcesAfter = await sourceDigest();
    ensure(report.provenance.sourcesAfter.sha256 === sourcesBefore.sha256, 'sources_changed_during_measurement');
    report.status = 'valid_measurement';
  } catch (error) {
    report.error = error?.benchmarkCode ?? (run.signal.aborted ? 'run_deadline_or_signal' : 'setup_or_measurement_failed');
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    const closed = await Promise.allSettled([closeServer(gateway), closeServer(provider)]);
    if (closed.some(result => result.status === 'rejected')) { report.status = 'failed'; report.error = 'listener_cleanup_failed'; }
    try { await app?.closeWorkspace(); } catch { report.status = 'failed'; report.error = 'workspace_cleanup_failed'; }
    if (gatewayHost) allowedHosts.delete(gatewayHost);
    globalThis.fetch = originalFetch;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Node22 --experimental-strip-types benchmark-proxy-pipeline.mjs [--samples 1000] [--warmup 100] [--repetitions 3] [--concurrency 8] [--payload-kib 1] [--request-timeout-ms 5000] [--deadline-ms 600000] [--idle-ms 60000] [--phase-timing 0|1] [--null-control 0|1] [--fixture-delay-ms 2] [--fixture-chunked 0|1] [--output basename.json]\nAll upstream traffic is synthetic loopback; output is restricted to output/proxy-programa. Run alone. Null control compares direct upstream against itself and never certifies proxy performance. Full proposed matrix: payload-kib 1/16/256 and concurrency 1/8/32; p99 sample gate requires 10000 per repetition.');
  } else {
    try {
      const options = parseOptions(process.argv.slice(2));
      const report = await runBenchmark(options);
      const output = join(root, 'output/proxy-programa', options.output ?? `benchmark-proxy-pipeline-${Date.now()}.json`);
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ status: report.status, artifact: `output/proxy-programa/${basename(output)}`, error: report.error ?? null }));
      if (report.status !== 'valid_measurement') process.exitCode = 1;
    } catch (error) { console.error(JSON.stringify({ status: 'failed', error: error?.benchmarkCode ?? 'benchmark_failed' })); process.exitCode = 1; }
  }
}
