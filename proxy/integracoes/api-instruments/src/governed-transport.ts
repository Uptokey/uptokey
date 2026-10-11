import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import type {
  CuratedOperation,
  GovernedReadOutcome,
  PreparedApiCall,
} from './types.ts';
import { canonicalStringify, validateParameterWithAjv } from './importer.ts';
import { CURATED_SPECS } from './specs/index.ts';

export class ApiValidationError extends Error {
  readonly code: string;
  readonly parameterName?: string;
  constructor(code: string, message: string, parameterName?: string) {
    super(`${code}: ${message}${parameterName ? ` [${parameterName}]` : ''}`);
    this.name = 'ApiValidationError';
    this.code = code;
    this.parameterName = parameterName;
  }
}

function computeSha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export const ADMITTED_SERVICE_ORIGINS = new Set([
  ...CURATED_SPECS.flatMap(spec => spec.servers.map(server => new URL(server.url).origin)),
  // Existing approved origin retained for persisted plans from the prior API version.
  'https://api.frankfurter.app',
]);

/** DNS results are checked in the socket's lookup callback, avoiding a second resolution. */
export async function resolvePublicAddresses(hostname: string, resolve = (host: string) => lookup(host, {all: true})) {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some(item => !isIP(item.address) || isPrivateOrLoopbackHost(item.address))) throw new Error('api_private_dns_address');
  return addresses;
}

/** Fixed HTTPS transport, manual redirects, normal TLS hostname verification, public socket addresses.
 * The resolver is injectable only so tests can prove the socket-level refusal without real DNS. */
export function createPublicHttpsFetch(resolver?: (host: string) => Promise<Array<{address: string; family: number}>>): typeof fetch {
  const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateOrLoopbackHost(url.hostname)) throw new Error('api_destination_denied');
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined,
      lookup(hostname, options, callback) {
        resolvePublicAddresses(hostname, resolver).then(addresses => {
          const selected = options.family ? addresses.filter(item => item.family === options.family) : addresses;
          if (!selected.length) throw new Error('api_dns_family_unavailable');
          if (options.all) callback(null, selected as any);
          else callback(null, selected[0]!.address, selected[0]!.family);
        }).catch(error => callback(error, '', 4));
      },
    }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      const body = [204, 205, 304].includes(response.statusCode!) ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
      if (!body) response.resume();
      resolve(new Response(body, {status: response.statusCode!, headers}));
    });
    request.once('error', reject);
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') {request.destroy(); reject(new Error('api_unsupported_body')); return;}
      request.write(init.body);
    }
    request.end();
  });
  };
  return customFetch as unknown as typeof fetch;
}
export const publicHttpsFetch: typeof fetch = createPublicHttpsFetch();

/** Check if an IP/host is private/loopback/metadata (SSRF prevention, C05) */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase().trim();

  // Strip brackets from IPv6: [::1] -> ::1
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host.includes(':')) {
    try { host = new URL(`https://[${host}]`).hostname.slice(1, -1); } catch { return true; }
    if (host.startsWith('ff')) return true;
  }

  // Known symbolic localhost / local suffixes
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  // IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    if (mapped.includes('.')) {
      host = mapped;
    } else {
      const parts = mapped.split(':');
      if (parts.length <= 2) {
        const p1 = parts[0] ? parts[0].padStart(4, '0') : '0000';
        const p2 = parts[1] ? parts[1].padStart(4, '0') : '0000';
        const hex = p1 + p2;
        if (hex.length === 8) {
          const a = parseInt(hex.slice(0, 2), 16);
          const b = parseInt(hex.slice(2, 4), 16);
          const c = parseInt(hex.slice(4, 6), 16);
          const d = parseInt(hex.slice(6, 8), 16);
          host = `${a}.${b}.${c}.${d}`;
        }
      }
    }
  }

  // IPv6 ULA (fc00::/7) or Link-Local (fe80::/10)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(host) || /^fe[89ab][0-9a-f]{0,2}:/i.test(host)) {
    return true;
  }

  // IPv4 dotted-decimal
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private network RFC 1918)
    if (a === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud metadata)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private network RFC 1918)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private network RFC 1918)
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10 (Shared Address Space RFC 6598)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (a >= 240) return true;
  }

  // Hex or integer IP representations: 0x7f000001, 2130706433
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    return true;
  }

  return false;
}

/** Extract approved inputs without interpreting URL fragments as new destinations. */
export function reconstructPreparedArguments(operation: CuratedOperation, prepared: PreparedApiCall): Record<string, unknown> {
  const raw: Record<string, unknown> = {...prepared.query};
  const template = operation.path.split('/');
  const actual = prepared.path.split('/');
  if (template.length !== actual.length) throw new Error('api_path_mismatch');
  for (let i = 0; i < template.length; i++) {
    const part = template[i]!;
    if (part.startsWith('{') && part.endsWith('}')) raw[part.slice(1, -1)] = decodeURIComponent(actual[i]!);
    else if (part !== actual[i]) throw new Error('api_path_mismatch');
  }
  return raw;
}

/**
 * Validates arguments and prepares an exact API call.
 * Pure function: zero network, zero secrets, zero inferences.
 */
export function prepareApiCall(
  operation: CuratedOperation,
  rawArguments: Record<string, unknown>,
  options?: { allowLoopbackForTesting?: boolean }
): PreparedApiCall {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    throw new ApiValidationError(
      'invalid_arguments_object',
      'Arguments must be a valid key-value object'
    );
  }

  // Check unexpected arguments (arguments not present in parameter definitions)
  const allowedNames = new Set(operation.parameters.map(p => p.name));
  for (const key of Object.keys(rawArguments)) {
    if (!allowedNames.has(key)) {
      throw new ApiValidationError(
        'unexpected_argument',
        `Unexpected argument not allowed by schema: ${key}`,
        key
      );
    }
  }

  const queryParams: Record<string, string> = {};
  const pathParams: Record<string, string> = {};

  // Validate each declared parameter
  for (const param of operation.parameters) {
    let rawVal = rawArguments[param.name];
    if ((rawVal === undefined || rawVal === null || rawVal === '') && param.schema && typeof param.schema === 'object' && 'default' in param.schema && (param.schema as any).default !== undefined) {
      rawVal = (param.schema as any).default;
    }

    // Check required
    if (rawVal === undefined || rawVal === null || rawVal === '') {
      if (param.required) {
        throw new ApiValidationError(
          'missing_required_parameter',
          `Required parameter is missing: ${param.name}`,
          param.name
        );
      }
      continue;
    }

    if (rawVal === null) {
      if (param.schema.nullable) {
        continue;
      }
      throw new ApiValidationError(
        'parameter_not_nullable',
        `Parameter ${param.name} cannot be null`,
        param.name
      );
    }

    // Normalize once through the reused schema validator, then serialize that value.
    let normalized: unknown;
    try { normalized = validateParameterWithAjv(param.name, param.schema, rawVal); }
    catch { throw new ApiValidationError('api_invalid_parameter', 'Parameter does not satisfy the admitted schema', param.name); }
    const validatedValue = Array.isArray(normalized) ? normalized.join(',') : normalized;

    if (param.in === 'path') {
      pathParams[param.name] = encodeURIComponent(String(validatedValue));
    } else {
      queryParams[param.name] = String(validatedValue);
    }
  }

  // Substitute path parameters into template
  let resolvedPath = operation.path;
  for (const [k, v] of Object.entries(pathParams)) {
    const placeholder = `{${k}}`;
    if (!resolvedPath.includes(placeholder)) {
      throw new ApiValidationError(
        'missing_path_placeholder',
        `Path template ${operation.path} does not contain placeholder for path parameter ${k}`,
        k
      );
    }
    resolvedPath = resolvedPath.replace(placeholder, v);
  }

  if (resolvedPath.includes('{') && resolvedPath.includes('}')) {
    throw new ApiValidationError(
      'unresolved_path_parameters',
      `Path ${resolvedPath} has unresolved placeholders`
    );
  }

  // Construct full URL
  const serverOrigin = operation.serverUrl;
  const urlObj = new URL(resolvedPath, serverOrigin);

  // Append query params deterministically (sorted keys)
  const sortedKeys = Object.keys(queryParams).sort();
  for (const k of sortedKeys) {
    urlObj.searchParams.set(k, queryParams[k]!);
  }

  const finalUrl = urlObj.toString();

  // Strict origin confinement
  if (urlObj.origin !== serverOrigin) {
    throw new ApiValidationError(
      'unadmitted_url_origin',
      `Constructed URL origin ${urlObj.origin} does not match admitted server origin ${serverOrigin}`
    );
  }

  // SSRF check
  if (!options?.allowLoopbackForTesting && isPrivateOrLoopbackHost(urlObj.hostname)) {
    throw new ApiValidationError(
      'ssrf_private_host_denied',
      `Access to private or loopback host ${urlObj.hostname} is denied`
    );
  }

  // Compute call digest
  const callPayload = canonicalStringify({
    method: 'GET',
    url: finalUrl,
    schemaDigest: operation.schemaDigest,
    limits: operation.capability.limits,
  });
  const callDigest = computeSha256(callPayload);

  return {
    schemaVersion: 1,
    operationId: operation.operationId,
    capabilityId: operation.id,
    serviceId: operation.serviceId,
    method: 'GET',
    url: finalUrl,
    origin: serverOrigin,
    path: resolvedPath,
    query: queryParams,
    schemaDigest: operation.schemaDigest,
    callDigest,
    limits: { ...operation.capability.limits },
  };
}

/**
 * TEST-ONLY fixture upstream hook. When the environment variable
 * UPTOKEY_API_FIXTURE_BASE_URL is set, governed reads for the curated public
 * origins (ADMITTED_SERVICE_ORIGINS, e.g. https://api.github.com) are mapped to
 * `{env}<path+query>` — same method and the same fixed headers, while the
 * prepared URL, call digest, receipts and sources keep referencing the real
 * origin. Other origins are denied. When the variable is unset the behavior is
 * byte-identical to production (publicHttpsFetch). Never set this in production.
 */
export function createFixtureUpstreamFetch(baseUrl: string): typeof fetch {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('api_fixture_base_invalid');
  }
  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!ADMITTED_SERVICE_ORIGINS.has(url.origin)) throw new Error('api_destination_denied');
    const target = new URL(url.pathname + url.search, base);
    return fetch(target, { method: init?.method ?? 'GET', headers: init?.headers, signal: init?.signal ?? null, redirect: 'manual' });
  };
  return fixtureFetch as unknown as typeof fetch;
}

function defaultGovernedFetch(): typeof fetch {
  const fixtureBase = process.env.UPTOKEY_API_FIXTURE_BASE_URL;
  return fixtureBase ? createFixtureUpstreamFetch(fixtureBase) : publicHttpsFetch;
}

export interface ExecuteReadOptions {
  signal?: AbortSignal;
  deadlineAt?: string;
  fetchFn?: typeof fetch;
  allowLoopbackForTesting?: boolean;
  /** Interpretation admitted by the operation catalog, never supplied by user input. */
  statusResult?: Readonly<Record<number, {isPublicHoliday: boolean}>>;
  /** Catalog-declared format. 'feed' returns bounded UTF-8 text for the feed parser; never JSON.parse. */
  responseFormat?: 'feed';
  /**
   * Recipe-scoped origin admission (stage 18 learned recipes only). Supplied
   * exclusively from the admitted server-side recipe record, never from user
   * input, model output or plan arguments. The global allowlist is unchanged;
   * SSRF, DNS pinning and redirect refusal still apply unconditionally.
   */
  admittedOrigins?: readonly string[];
}

const FEED_MIME = ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'];

/**
 * Executes a single governed HTTP read for an approved preparation.
 * Strictly single request, no hidden retries, manual redirect refusal, byte limits during stream.
 * Deadline and abort signal remain active throughout headers and streaming body reader.
 */
export async function executeGovernedRead(
  prepared: PreparedApiCall,
  options?: ExecuteReadOptions
): Promise<GovernedReadOutcome> {
  const fetchImpl = options?.fetchFn ?? defaultGovernedFetch();

  // Validate finite and positive limits (C04)
  const rawTimeout = prepared.limits?.timeoutMs;
  const rawMaxBytes = prepared.limits?.maxOutputBytes;

  if (
    typeof rawTimeout !== 'number' ||
    !Number.isFinite(rawTimeout) ||
    rawTimeout <= 0 ||
    typeof rawMaxBytes !== 'number' ||
    !Number.isFinite(rawMaxBytes) ||
    rawMaxBytes <= 0
  ) {
    return { kind: 'failed', code: 'api_invalid_limits', sent: 'no' };
  }

  const timeoutMs = Math.min(rawTimeout, 60_000);
  const maxBytes = Math.min(rawMaxBytes, 524_288);

  // Verify origin matches prepared origin strictly
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(prepared.url);
  } catch {
    return { kind: 'failed', code: 'api_malformed_url', sent: 'no' };
  }

  if (parsedUrl.origin !== prepared.origin) {
    return { kind: 'failed', code: 'api_origin_mismatch', sent: 'no' };
  }

  // SSRF prevention: private/loopback/metadata check (C05)
  if (!options?.allowLoopbackForTesting && isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    return { kind: 'failed', code: 'api_ssrf_denied', sent: 'no' };
  }

  // Fail-closed destination boundary: origin must be in catalog admitted origins (C05),
  // or in the recipe-scoped admission supplied from the server-side recipe record.
  if (!options?.allowLoopbackForTesting && !ADMITTED_SERVICE_ORIGINS.has(parsedUrl.origin) &&
      !(options?.admittedOrigins ?? []).includes(parsedUrl.origin)) {
    return { kind: 'failed', code: 'api_unadmitted_destination_origin', sent: 'no' };
  }

  // Setup timeout and signal controller
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;

  // If outer signal is already aborted
  if (options?.signal?.aborted) {
    return { kind: 'failed', code: 'api_cancelled', sent: 'no' };
  }

  const onOuterAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onOuterAbort, { once: true });

  // Handle deadlineAt if specified
  let effectiveTimeout = timeoutMs;
  if (options?.deadlineAt) {
    const deadlineTime = new Date(options.deadlineAt).getTime();
    const remaining = deadlineTime - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      options?.signal?.removeEventListener('abort', onOuterAbort);
      return { kind: 'failed', code: 'api_deadline_exceeded', sent: 'no' };
    }
    effectiveTimeout = Math.min(timeoutMs, remaining);
  }

  timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    let response: Response;
    try {
      response = await fetchImpl(prepared.url, {
        method: 'GET',
        headers: {
          Accept: options?.responseFormat === 'feed' ? 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' : 'application/json, text/plain;q=0.9',
          'User-Agent': 'Uptokey-Governed-Instrument/1.0',
          ...(prepared.origin === 'https://api.github.com' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } : {}),
        },
        redirect: 'manual', // Never follow redirects automatically (SSRF prevention)
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        if (options?.signal?.aborted) {
          return { kind: 'failed', code: 'api_cancelled', sent: 'unknown' };
        }
        return { kind: 'failed', code: 'api_timeout', sent: 'unknown' };
      }
      return {
        kind: 'failed',
        code: 'api_network_error',
        sent: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Handle 3xx Redirects
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'failed',
        code: 'api_redirect_denied',
        sent: 'yes',
        httpStatus: response.status,
      };
    }

    // Handle Rate Limiting (429)
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'failed',
        code: 'api_rate_limit',
        sent: 'yes',
        httpStatus: 429,
      };
    }

    // Handle Client/Server Errors
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'failed',
        code: 'api_not_found',
        sent: 'yes',
        httpStatus: 404,
      };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'failed',
        code: response.status >= 500 ? 'api_server_error' : 'api_request_failed',
        sent: 'yes',
        httpStatus: response.status,
      };
    }

    const statusResult = options?.statusResult?.[response.status];
    if (statusResult && (response.status === 200 || response.status === 204)) {
      await response.body?.cancel().catch(() => undefined);
      const data = structuredClone(statusResult);
      const byteLength = new TextEncoder().encode(JSON.stringify(data)).byteLength;
      if (byteLength > maxBytes) return {kind: 'failed', code: 'api_response_too_large', sent: 'yes'};
      if (controller.signal.aborted) return {kind: 'failed', code: options?.signal?.aborted ? 'api_cancelled' : 'api_timeout', sent: 'yes'};
      return {kind: 'completed', data, origin: prepared.origin, operation: prepared.operationId, retrievedAt: new Date().toISOString(), byteLength};
    }

    // Check Content-Type MIME
    const contentType = response.headers.get('content-type') || '';
    const mime = contentType.split(';')[0]!.trim().toLowerCase();
    const isJson = contentType.includes('application/json') || contentType.includes('+json');
    const isText = contentType.includes('text/plain');
    const admitted = options?.responseFormat === 'feed' ? FEED_MIME.includes(mime) : (isJson || isText);

    if (!admitted) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: 'failed',
        code: 'api_invalid_mime',
        sent: 'yes',
        httpStatus: response.status,
        error: `Disallowed content-type: ${contentType}`,
      };
    }

    // Stream reader with strict byte boundary while keeping timer and abort signal attached!
    const reader = response.body?.getReader();
    if (!reader) {
      return { kind: 'failed', code: 'api_empty_response', sent: 'yes' };
    }

    const onSignalAbort = () => {
      reader.cancel('aborted').catch(() => undefined);
    };
    controller.signal.addEventListener('abort', onSignalAbort, { once: true });

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        if (controller.signal.aborted) {
          await reader.cancel().catch(() => undefined);
          if (options?.signal?.aborted) {
            return { kind: 'failed', code: 'api_cancelled', sent: 'yes' };
          }
          return { kind: 'failed', code: 'api_timeout', sent: 'yes' };
        }

        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel('output_limit_exceeded').catch(() => undefined);
            return {
              kind: 'failed',
              code: 'api_response_too_large',
              sent: 'yes',
              error: `Exceeded maxOutputBytes limit (${maxBytes} bytes)`,
            };
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        if (options?.signal?.aborted) {
          return { kind: 'failed', code: 'api_cancelled', sent: 'yes' };
        }
        return { kind: 'failed', code: 'api_timeout', sent: 'yes' };
      }
      return {
        kind: 'failed',
        code: 'api_stream_read_error',
        sent: 'yes',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      controller.signal.removeEventListener('abort', onSignalAbort);
    }

    if (controller.signal.aborted) {
      if (options?.signal?.aborted) {
        return { kind: 'failed', code: 'api_cancelled', sent: 'yes' };
      }
      return { kind: 'failed', code: 'api_timeout', sent: 'yes' };
    }

    // Combine bytes
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    if (options?.responseFormat === 'feed') {
      let feedText: string;
      try { feedText = new TextDecoder('utf-8', {fatal: true}).decode(combined); }
      catch { return { kind: 'failed', code: 'api_invalid_feed', sent: 'yes', httpStatus: response.status }; }
      return { kind: 'completed', data: feedText, origin: prepared.origin, operation: prepared.operationId, retrievedAt: new Date().toISOString(), byteLength: totalBytes };
    }

    const textPayload = new TextDecoder('utf-8').decode(combined);
    let parsedData: unknown;
    try {
      parsedData = JSON.parse(textPayload);
    } catch (err) {
      return {
        kind: 'failed',
        code: 'api_invalid_json',
        sent: 'yes',
        httpStatus: response.status,
        error: `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      kind: 'completed',
      data: parsedData,
      origin: prepared.origin,
      operation: prepared.operationId,
      retrievedAt: new Date().toISOString(),
      byteLength: totalBytes,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onOuterAbort);
  }
}
