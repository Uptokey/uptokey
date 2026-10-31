import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_FETCH_CONTRACT_VERSION,
  WEB_CITATION_CONTRACT_VERSION,
  webPublicUrl,
  parseWebSearchRequest,
  parseWebSearchResult,
  parseWebFetchRequest,
  parseWebFetchResult,
  parseSourceCitation,
  canonicalWebSearchPayload,
  canonicalWebSearchResultPayload,
  canonicalWebFetchPayload,
  canonicalWebFetchResultPayload,
  canonicalSourceCitationPayload,
} from '../web.js';

const search = { schemaVersion: 1, engine: 'fixture', query: 'uptokey web search' };
const fetch = { schemaVersion: 1, url: 'https://example.com/page' };
const iso = '2026-09-20T12:00:00.000Z';

test('web search request parses only the governed fixture engine with bounded parameters', () => {
  const parsed = parseWebSearchRequest(search);
  assert.equal(parsed.engine, 'fixture');
  assert.equal(parsed.query, 'uptokey web search');
  assert.equal(canonicalWebSearchPayload(search), JSON.stringify({ engine: 'fixture', query: 'uptokey web search', schemaVersion: 1 }));
  for (const bad of [
    { ...search, engine: 'public-engine' },
    { ...search, query: '' },
    { ...search, query: 'x'.repeat(513) },
    { ...search, extra: true },
    { schemaVersion: 2, engine: 'fixture', query: 'a' },
    { ...search, maxResults: 0 },
    { ...search, maxResults: 21 },
    { ...search, maxResults: 1.5 },
    { ...search, recency: 'century' },
    { ...search, domains: ['ok.example', 'x'.repeat(254)] },
    { ...search, language: 'not a language' },
    { ...search, country: 'BRA' },
    null,
    'query',
    7,
  ]) assert.throws(() => parseWebSearchRequest(bad), /web_search_invalid/);
});

test('web search result envelope binds ranks, urls and coverage; snippets stay bounded', () => {
  const result = {
    schemaVersion: 1,
    engine: 'fixture',
    query: search.query,
    fetchedAt: iso,
    results: [
      { rank: 1, title: 'First', url: 'https://example.com/first', snippet: 'quoted snippet' },
      { rank: 2, title: 'Second', url: 'http://example.org/second', snippet: '' },
    ],
    complete: true,
    engineNote: 'synthetic fixture results; not a live engine',
    coverage: { requestedMaxResults: 20, returned: 2 },
  };
  const parsed = parseWebSearchResult(result);
  assert.equal(parsed.results[1].rank, 2);
  assert.equal(canonicalWebSearchResultPayload(result).length > 0, true);
  const bump = JSON.parse(JSON.stringify(result));
  bump.results[1].rank = 3;
  assert.throws(() => parseWebSearchResult(bump), /web_search_result_invalid/);
  const dup = JSON.parse(JSON.stringify(result));
  dup.results[1].url = dup.results[0].url;
  assert.throws(() => parseWebSearchResult(dup), /web_search_result_invalid/);
  const empty = JSON.parse(JSON.stringify(result));
  empty.complete = false;
  empty.results = [];
  empty.coverage.returned = 0;
  assert.throws(() => parseWebSearchResult(empty), /web_search_result_invalid/);
  const isoBad = JSON.parse(JSON.stringify(result));
  isoBad.fetchedAt = '2026-09-20 12:00:00';
  assert.throws(() => parseWebSearchResult(isoBad), /web_search_result_invalid/);
  const giant = JSON.parse(JSON.stringify(result));
  giant.results[0].snippet = 'x'.repeat(513);
  assert.throws(() => parseWebSearchResult(giant), /web_search_result_invalid/);
  const cred = JSON.parse(JSON.stringify(result));
  cred.results[0].url = 'https://user:pass@example.com/first';
  assert.throws(() => parseWebSearchResult(cred), /web_search_result_invalid/);
});

test('web fetch request accepts public http(s) targets with pilot limits only', () => {
  assert.equal(parseWebFetchRequest(fetch).url, fetch.url);
  assert.equal(parseWebFetchRequest({ ...fetch, extractionMode: 'text', maxBytes: 5_242_880, maxRedirects: 3 }).maxBytes, 5_242_880);
  assert.equal(canonicalWebFetchPayload(fetch).length > 0, true);
  for (const bad of [
    { ...fetch, url: 'https://user:pass@example.com/' },
    { ...fetch, url: 'ftp://example.com/x' },
    { ...fetch, url: 'https://example.com/#frag' },
    { ...fetch, maxBytes: 5_242_881 },
    { ...fetch, maxRedirects: 4 },
    { ...fetch, extractionMode: 'exec' },
    { ...fetch, extra: 1 },
    { schemaVersion: 2, url: fetch.url },
    42,
  ]) assert.throws(() => parseWebFetchRequest(bad), /web_fetch_invalid/);
});

test('web fetch result envelope preserves final destination, digest and bounded links', () => {
  const result = {
    schemaVersion: 1,
    requestedUrl: fetch.url,
    finalUrl: 'https://example.com/page-final',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    contentHash: 'a'.repeat(64),
    fetchedAt: iso,
    text: 'Extracted page text',
    truncated: false,
    links: [{ url: 'https://example.com/next', rel: 'next' }, { url: 'http://other.example/' }],
    engineNote: 'public read-only fetch',
  };
  const parsed = parseWebFetchResult(result);
  assert.equal(parsed.links.length, 2);
  assert.equal(canonicalWebFetchResultPayload(result).length > 0, true);
  for (const mutate of [
    (value) => ({ ...value, status: 199 }),
    (value) => ({ ...value, contentHash: 'z'.repeat(64) }),
    (value) => ({ ...value, finalUrl: 'https://user:pass@example.com/' }),
    (value) => ({ ...value, links: [...value.links, { url: value.links[0].url }] }),
    (value) => ({ ...value, links: [{ url: 'javascript:alert(1)' }] }),
    (value) => ({ ...value, text: 'x'.repeat(5_242_881) }),
    (value) => ({ ...value, extra: 1 }),
    (value) => { const copy = { ...value }; delete copy.links; return copy; },
  ]) assert.throws(() => parseWebFetchResult(mutate(result)), /web_fetch_result_invalid/);
});

test('source citations bind artifact, locator and digest; offsets are never freeform', () => {
  const citation = {
    schemaVersion: WEB_CITATION_CONTRACT_VERSION,
    sourceArtifactId: 'webfetch_abc',
    title: 'Example page',
    url: 'https://example.com/page',
    retrievedAt: iso,
    locator: { kind: 'text_offset', start: 0, end: 19 },
    excerptDigest: 'b'.repeat(64),
    verified: false,
  };
  assert.equal(parseSourceCitation(citation).locator.end, 19);
  assert.equal(canonicalSourceCitationPayload(citation).length > 0, true);
  const rank = { ...citation, locator: { kind: 'search_result', rank: 2 } };
  assert.equal(parseSourceCitation(rank).locator.rank, 2);
  for (const bad of [
    { ...citation, locator: { kind: 'text_offset', start: 5, end: 5 } },
    { ...citation, locator: { kind: 'page', start: 0, end: 1 } },
    { ...citation, locator: { kind: 'search_result', rank: 0 } },
    { ...citation, excerptDigest: 'B'.repeat(64) },
    { ...citation, url: 'https://user:pass@example.com/' },
    { ...citation, claimRefs: ['a'.repeat(201)] },
    { ...citation, verified: 'yes' },
    { ...citation, schemaVersion: 2 },
  ]) assert.throws(() => parseSourceCitation(bad), /web_citation_invalid/);
});

test('webPublicUrl refuses credentials, fragments and non-http schemes without throwing', () => {
  assert.equal(webPublicUrl('https://example.com/a?b=c')?.origin, 'https://example.com');
  assert.equal(webPublicUrl('http://example.com'), null);
  assert.equal(webPublicUrl('https://user:pass@example.com/'), null);
  assert.equal(webPublicUrl('https://example.com/#frag'), null);
  assert.equal(webPublicUrl('javascript:alert(1)'), null);
  assert.equal(webPublicUrl('https://'), null);
  assert.equal(webPublicUrl(null), null);
});
