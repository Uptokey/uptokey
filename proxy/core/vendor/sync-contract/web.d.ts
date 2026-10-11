/**
 * E2-12 — web search / page fetch / source citation contracts (PROPOSED).
 * Parsing binds exact data and never authorizes a network effect.
 */
export const WEB_SEARCH_CONTRACT_VERSION: 1;
export const WEB_FETCH_CONTRACT_VERSION: 1;
export const WEB_CITATION_CONTRACT_VERSION: 1;

export interface WebSearchRequest {
  readonly schemaVersion: 1;
  readonly engine: 'fixture'|'brave'|'searxng';
  readonly query: string;
  readonly language?: string;
  readonly country?: string;
  readonly domains?: readonly string[];
  readonly recency?: 'day' | 'week' | 'month' | 'year';
  readonly maxResults?: number;
}
export function parseWebSearchRequest(input: unknown): Readonly<WebSearchRequest>;
export function canonicalWebSearchPayload(input: unknown): string;
/** Public http(s) URL without credentials, userinfo or fragments; null when refused. */
export function webPublicUrl(input: unknown): URL | null;

export interface WebSearchResultRow { readonly rank: number; readonly title: string; readonly url: string; readonly snippet: string; }
export interface WebSearchResult {
  readonly schemaVersion: 1;
  readonly engine: 'fixture'|'brave'|'searxng';
  readonly query: string;
  readonly fetchedAt: string;
  readonly results: readonly WebSearchResultRow[];
  readonly complete: boolean;
  readonly engineNote: string;
  readonly coverage: { readonly requestedMaxResults: number; readonly returned: number };
}
export function parseWebSearchResult(input: unknown): Readonly<WebSearchResult>;
export function canonicalWebSearchResultPayload(input: unknown): string;

export interface WebFetchRequest {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly extractionMode?: 'text' | 'raw';
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}
export function parseWebFetchRequest(input: unknown): Readonly<WebFetchRequest>;
export function canonicalWebFetchPayload(input: unknown): string;

export interface WebFetchLink { readonly url: string; readonly rel?: string; }
export interface WebFetchResult {
  readonly schemaVersion: 1;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly links: readonly WebFetchLink[];
  readonly engineNote?: string;
}
export function parseWebFetchResult(input: unknown): Readonly<WebFetchResult>;
export function canonicalWebFetchResultPayload(input: unknown): string;

export interface SourceCitation {
  readonly schemaVersion: 1;
  readonly sourceArtifactId: string;
  readonly title: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly locator: { readonly kind: 'text_offset'; readonly start: number; readonly end: number }
    | { readonly kind: 'search_result'; readonly rank: number };
  /** sha-256 hex of the located excerpt's UTF-8 bytes; recomputed before display. */
  readonly excerptDigest: string;
  readonly verified: boolean;
  readonly claimRefs?: readonly string[];
}
export function parseSourceCitation(input: unknown): Readonly<SourceCitation>;
export function canonicalSourceCitationPayload(input: unknown): string;

export declare const WEB_SEARCH_ENGINES: readonly ('fixture'|'brave'|'searxng')[];
