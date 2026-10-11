import { isDataRecord, projectDataArray, projectStringArray } from './plain-data.js';
import { canonicalJson } from './canonical.js';

/**
 * E2-12 — web search / page fetch / source citation contracts.
 * PROPOSED schemas (expansao-2/12-web-fontes-apis). Parsing binds the exact
 * request/result data; it never authorizes a network effect. The W0 plan,
 * approval and executor still gate every dispatch.
 *
 * First governed profile: `engine:'fixture'` (deterministic synthetic results,
 * zero network) and a read-only public fetch with explicit destination policy.
 * Additional engines/profiles are future revisions, never caller-supplied.
 */

export const WEB_SEARCH_CONTRACT_VERSION = 1;
export const WEB_FETCH_CONTRACT_VERSION = 1;
export const WEB_CITATION_CONTRACT_VERSION = 1;

const WEB_URL_MAX_LENGTH = 2048;
const WEB_SEARCH_QUERY_MAX = 512;
const WEB_SEARCH_MAX_RESULTS = 20;
const WEB_SEARCH_SNIPPET_MAX = 512;
const WEB_SEARCH_TITLE_MAX = 300;
const WEB_FETCH_TEXT_MAX_BYTES = 5_242_880;
const WEB_FETCH_LINKS_MAX = 200;
const WEB_ENGINE_NOTE_MAX = 300;
const RECENCY_VALUES = new Set(['day', 'week', 'month', 'year']);
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const COUNTRY_PATTERN = /^[a-zA-Z]{2}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function onlyKeys(value, required, optional) {
  if (!isDataRecord(value)) return false;
  const present = new Set(Object.keys(value));
  for (const key of required) if (!present.has(key)) return false;
  return [...present].every((key) => required.includes(key) || (optional ?? []).includes(key));
}

/** Public http(s) URL without credentials, userinfo or fragments. Returns null instead of throwing for probes. */
export function webPublicUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > WEB_URL_MAX_LENGTH) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.href !== input) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.hash) return null;
  if (!url.hostname || url.hostname.includes('\0')) return null;
  return url;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString() === value ? value : null;
}

function boundedText(value, maximum) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  if (new TextEncoder().encode(value).byteLength > maximum) return null;
  return value;
}

/** Search engines: synthetic fixture, Brave Search API (key of the person) and a local SearXNG instance (no key). */
export const WEB_SEARCH_ENGINES = Object.freeze(['fixture', 'brave', 'searxng']);

export function parseWebSearchRequest(input) {
  const invalid = () => { throw new Error('web_search_invalid'); };
  if (!onlyKeys(input, ['engine', 'query', 'schemaVersion'], ['country', 'domains', 'language', 'maxResults', 'recency'])) invalid();
  if (input.schemaVersion !== WEB_SEARCH_CONTRACT_VERSION) invalid();
  if (!WEB_SEARCH_ENGINES.includes(input.engine)) invalid();
  const query = boundedText(input.query, WEB_SEARCH_QUERY_MAX);
  if (query === null || !query.trim()) invalid();
  const request = { schemaVersion: WEB_SEARCH_CONTRACT_VERSION, engine: input.engine, query };
  if (input.language !== undefined) {
    if (typeof input.language !== 'string' || !LANGUAGE_PATTERN.test(input.language) || input.language.length > 35) invalid();
    request.language = input.language;
  }
  if (input.country !== undefined) {
    if (typeof input.country !== 'string' || !COUNTRY_PATTERN.test(input.country)) invalid();
    request.country = input.country;
  }
  if (input.domains !== undefined) {
    const domains = projectStringArray(input.domains, 8);
    if (!domains || !domains.length || domains.some((domain) => domain.length < 3 || domain.length > 253 || !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain))) invalid();
    request.domains = Object.freeze([...domains]);
  }
  if (input.recency !== undefined) {
    if (!RECENCY_VALUES.has(input.recency)) invalid();
    request.recency = input.recency;
  }
  if (input.maxResults !== undefined) {
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > WEB_SEARCH_MAX_RESULTS) invalid();
    request.maxResults = input.maxResults;
  }
  return Object.freeze(request);
}

export function canonicalWebSearchPayload(input) {
  return canonicalJson(parseWebSearchRequest(input));
}

/** Persisted search outcome. Snippets are quoted source data, never a fetched page. */
export function parseWebSearchResult(input) {
  const invalid = () => { throw new Error('web_search_result_invalid'); };
  if (!onlyKeys(input, ['complete', 'coverage', 'engine', 'engineNote', 'fetchedAt', 'query', 'results', 'schemaVersion'])) invalid();
  if (input.schemaVersion !== WEB_SEARCH_CONTRACT_VERSION || !WEB_SEARCH_ENGINES.includes(input.engine)) invalid();
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > WEB_SEARCH_QUERY_MAX) invalid();
  const fetchedAt = isoTimestamp(input.fetchedAt);
  if (fetchedAt === null) invalid();
  if (typeof input.complete !== 'boolean') invalid();
  const engineNote = boundedText(input.engineNote, WEB_ENGINE_NOTE_MAX);
  if (engineNote === null || !engineNote.trim()) invalid();
  const rows = projectDataArray(input.results, WEB_SEARCH_MAX_RESULTS);
  if (!rows) invalid();
  const results = [];
  const urls = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!onlyKeys(row, ['rank', 'snippet', 'title', 'url'])) invalid();
    const url = webPublicUrl(row.url);
    if (url === null || urls.has(row.url) || !/^(https?:)/.test(url.protocol)) invalid();
    urls.add(row.url);
    const title = boundedText(row.title, WEB_SEARCH_TITLE_MAX);
    const snippet = boundedText(row.snippet, WEB_SEARCH_SNIPPET_MAX);
    if (title === null || !title.trim() || snippet === null) invalid();
    if (row.rank !== index + 1) invalid();
    results.push(Object.freeze({ rank: row.rank, title, url: row.url, snippet }));
  }
  if (!onlyKeys(input.coverage, ['requestedMaxResults', 'returned'])) invalid();
  const { requestedMaxResults, returned } = input.coverage;
  if (!Number.isSafeInteger(requestedMaxResults) || requestedMaxResults < 1 || requestedMaxResults > WEB_SEARCH_MAX_RESULTS || returned !== results.length) invalid();
  if (!input.complete && results.length === 0) invalid();
  return Object.freeze({ schemaVersion: WEB_SEARCH_CONTRACT_VERSION, engine: input.engine, query: input.query, fetchedAt, results: Object.freeze(results), complete: input.complete, engineNote, coverage: Object.freeze({ requestedMaxResults, returned: results.length }) });
}

export function canonicalWebSearchResultPayload(input) {
  return canonicalJson(parseWebSearchResult(input));
}

export function parseWebFetchRequest(input) {
  const invalid = () => { throw new Error('web_fetch_invalid'); };
  if (!onlyKeys(input, ['schemaVersion', 'url'], ['extractionMode', 'maxBytes', 'maxRedirects'])) invalid();
  if (input.schemaVersion !== WEB_FETCH_CONTRACT_VERSION) invalid();
  const url = webPublicUrl(input.url);
  if (url === null) invalid();
  const request = { schemaVersion: WEB_FETCH_CONTRACT_VERSION, url: input.url };
  if (input.extractionMode !== undefined) {
    if (input.extractionMode !== 'text' && input.extractionMode !== 'raw') invalid();
    request.extractionMode = input.extractionMode;
  }
  if (input.maxBytes !== undefined) {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > WEB_FETCH_TEXT_MAX_BYTES) invalid();
    request.maxBytes = input.maxBytes;
  }
  if (input.maxRedirects !== undefined) {
    if (!Number.isSafeInteger(input.maxRedirects) || input.maxRedirects < 0 || input.maxRedirects > 3) invalid();
    request.maxRedirects = input.maxRedirects;
  }
  return Object.freeze(request);
}

export function canonicalWebFetchPayload(input) {
  return canonicalJson(parseWebFetchRequest(input));
}

/** Persisted fetch outcome: final destination, digest of the exact bytes and extracted text. */
export function parseWebFetchResult(input) {
  const invalid = () => { throw new Error('web_fetch_result_invalid'); };
  if (!onlyKeys(input, ['contentHash', 'contentType', 'fetchedAt', 'finalUrl', 'links', 'requestedUrl', 'schemaVersion', 'status', 'text', 'truncated'], ['engineNote'])) invalid();
  if (input.schemaVersion !== WEB_FETCH_CONTRACT_VERSION) invalid();
  const requested = webPublicUrl(input.requestedUrl);
  const final = webPublicUrl(input.finalUrl);
  if (requested === null || final === null) invalid();
  if (!Number.isSafeInteger(input.status) || input.status < 200 || input.status > 599) invalid();
  const contentType = boundedText(input.contentType, 200);
  if (contentType === null || !contentType.trim() || /[^\x20-\x7E]/.test(contentType)) invalid();
  if (typeof input.contentHash !== 'string' || !DIGEST_PATTERN.test(input.contentHash)) invalid();
  const fetchedAt = isoTimestamp(input.fetchedAt);
  if (fetchedAt === null) invalid();
  const text = boundedText(input.text, WEB_FETCH_TEXT_MAX_BYTES);
  if (text === null) invalid();
  if (typeof input.truncated !== 'boolean') invalid();
  const rows = projectDataArray(input.links, WEB_FETCH_LINKS_MAX);
  if (!rows) invalid();
  const links = [];
  const seen = new Set();
  for (const row of rows) {
    if (!onlyKeys(row, ['url'], ['rel'])) invalid();
    const link = webPublicUrl(row.url);
    if (link === null || seen.has(row.url)) invalid();
    seen.add(row.url);
    links.push(Object.freeze(row.rel === undefined ? { url: row.url } : { url: row.url, rel: boundedText(row.rel, 100) ?? invalid() }));
  }
  let engineNote;
  if (input.engineNote !== undefined) {
    engineNote = boundedText(input.engineNote, WEB_ENGINE_NOTE_MAX);
    if (engineNote === null || !engineNote.trim()) invalid();
  }
  return Object.freeze({
    schemaVersion: WEB_FETCH_CONTRACT_VERSION,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    contentType,
    contentHash: input.contentHash,
    fetchedAt,
    text,
    truncated: input.truncated,
    links: Object.freeze(links),
    ...(engineNote !== undefined ? { engineNote } : {}),
  });
}

export function canonicalWebFetchResultPayload(input) {
  return canonicalJson(parseWebFetchResult(input));
}

/**
 * Citation binding a claim to the artifact that was actually read. `locator`
 * addresses the persisted artifact (never a model-invented offset):
 * - `text_offset` points at the persisted fetch text by code-unit range;
 * - `search_result` points at a persisted search result by rank.
 * `excerptDigest` is the sha-256 hex of the located excerpt's UTF-8 bytes;
 * consumers recompute it before showing `verified:true`.
 */
export function parseSourceCitation(input) {
  const invalid = () => { throw new Error('web_citation_invalid'); };
  if (!onlyKeys(input, ['excerptDigest', 'locator', 'retrievedAt', 'schemaVersion', 'sourceArtifactId', 'title', 'url', 'verified'], ['claimRefs'])) invalid();
  if (input.schemaVersion !== WEB_CITATION_CONTRACT_VERSION) invalid();
  if (typeof input.sourceArtifactId !== 'string' || !ID_PATTERN.test(input.sourceArtifactId)) invalid();
  const title = boundedText(input.title, WEB_SEARCH_TITLE_MAX);
  if (title === null || !title.trim()) invalid();
  if (webPublicUrl(input.url) === null) invalid();
  const retrievedAt = isoTimestamp(input.retrievedAt);
  if (retrievedAt === null) invalid();
  const locator = input.locator;
  if (!onlyKeys(locator, ['kind'], ['end', 'rank', 'start'])) invalid();
  if (locator.kind === 'text_offset') {
    if (!Number.isSafeInteger(locator.start) || locator.start < 0 || !Number.isSafeInteger(locator.end) || locator.end <= locator.start) invalid();
  } else if (locator.kind === 'search_result') {
    if (!Number.isSafeInteger(locator.rank) || locator.rank < 1 || locator.rank > WEB_SEARCH_MAX_RESULTS) invalid();
  } else invalid();
  if (typeof input.excerptDigest !== 'string' || !DIGEST_PATTERN.test(input.excerptDigest)) invalid();
  if (typeof input.verified !== 'boolean') invalid();
  if (input.claimRefs !== undefined) {
    const claimRefs = projectStringArray(input.claimRefs, 16);
    if (!claimRefs || claimRefs.some((ref) => !ref.trim() || ref.length > 200)) invalid();
    return Object.freeze({ schemaVersion: WEB_CITATION_CONTRACT_VERSION, excerptDigest: input.excerptDigest, locator: Object.freeze({ ...locator }), retrievedAt, sourceArtifactId: input.sourceArtifactId, title, url: input.url, verified: input.verified, claimRefs: Object.freeze([...claimRefs]) });
  }
  return Object.freeze({ schemaVersion: WEB_CITATION_CONTRACT_VERSION, excerptDigest: input.excerptDigest, locator: Object.freeze({ ...locator }), retrievedAt, sourceArtifactId: input.sourceArtifactId, title, url: input.url, verified: input.verified });
}

export function canonicalSourceCitationPayload(input) {
  return canonicalJson(parseSourceCitation(input));
}
