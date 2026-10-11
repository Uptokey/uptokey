import { executeGovernedRead, isPrivateOrLoopbackHost } from '../governed-transport.ts';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { createEnvelope, createRecord, type DataEnvelope, type DataRecord } from '@uptokey/sync-contract/data-envelope';

export interface RssAdapterOptions {
  feedUrl?: string;
  sourceId?: string;
  maxItems?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  deadlineAt?: string;
}

const parser = new Parser();

function sanitizeLink(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Reject unsafe schemes (javascript:, data:, file:, etc.)
  return null;
}

function stripHtml(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>?/gm, '').trim();
}

function classifyMaterialType(title: string, categories: string[] = []): 'news' | 'press_release' | 'preprint' | 'correction' | 'retraction' | 'unknown' {
  const combined = (title + ' ' + categories.join(' ')).toLowerCase();
  if (combined.includes('retraction') || combined.includes('retratação')) return 'retraction';
  if (combined.includes('correction') || combined.includes('errata') || combined.includes('correção')) return 'correction';
  if (combined.includes('preprint') || combined.includes('arxiv') || combined.includes('biorxiv') || combined.includes('medrxiv')) return 'preprint';
  if (combined.includes('press release') || combined.includes('comunicado') || combined.includes('press-release')) return 'press_release';
  return 'news';
}

function extractDateString(pubDate: unknown): string | null {
  if (!pubDate || typeof pubDate !== 'string') return null;
  const trimmed = pubDate.trim();
  if (/^\d{4}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return trimmed;
}

export async function parseRssXml(xmlText: string, options: RssAdapterOptions = {}): Promise<DataEnvelope> {
  const maxItems = options.maxItems ?? 50;
  const maxBytes = options.maxOutputBytes ?? 1_048_576;
  const sourceId = options.sourceId ?? 'rss.feed';
  const feedUrl = options.feedUrl ?? 'https://feed.invalid';
  const retrievedAt = new Date().toISOString();

  const inputByteLength = Buffer.byteLength(xmlText, 'utf8');
  let isTruncated = false;
  let textToParse = xmlText;

  if (inputByteLength > maxBytes) {
    isTruncated = true;
    // Bounded slice at UTF-8 boundary
    textToParse = Buffer.from(xmlText, 'utf8').subarray(0, maxBytes).toString('utf8');
    // If truncation cuts off XML, we attempt parse or create bounded partial outcome
  }

  let feed: any;
  try {
    feed = await parser.parseString(textToParse);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return createEnvelope({
      completeness: {
        requested: maxItems,
        obtained: 0,
        truncationReason: isTruncated ? 'byte_limit_exceeded' : errorMsg,
        unavailableSources: [sourceId],
        partial: true,
      },
      warnings: [{ code: 'rss_parse_failed', message: errorMsg, sourceId }],
      createdAt: retrievedAt,
    });
  }

  const items = Array.isArray(feed.items) ? feed.items : [];
  const countToTake = Math.min(items.length, maxItems);
  const records: DataRecord[] = [];

  for (let i = 0; i < countToTake; i++) {
    const item = items[i];
    const safeLink = sanitizeLink(item.link);
    const title = item.title ? String(item.title).trim() : 'Sem título';
    const summary = stripHtml(item.contentSnippet || item.content || item.summary || '');
    const categories = Array.isArray(item.categories) ? item.categories.map(String) : [];
    const matType = classifyMaterialType(title, categories);
    const publishedAt = extractDateString(item.pubDate || item.isoDate);

    const record = createRecord({
      id: String(item.guid || safeLink || (sourceId + '_' + i)),
      materialType: matType,
      title,
      summary: summary || null,
      authors: item.creator ? [String(item.creator).trim()] : [],
      publisher: feed.title ? String(feed.title).trim() : null,
      provenance: {
        sourceId,
        sourceRecordId: item.guid ? String(item.guid) : null,
        canonicalUrl: safeLink,
        identifiers: safeLink ? { url: safeLink } : {},
        retrievedAt,
        sourcePublishedAt: publishedAt,
        query: options.feedUrl || null,
        adapterVersion: 'api-instruments/rss-adapter.v2',
      },
      rights: {
        termsUrl: null,
        verifiedAt: null,
        holder: feed.title || null,
        attribution: feed.title ? `Fonte: ${feed.title}` : null,
        permissions: {
          obtain: true,
          store: null,
          display: null,
          export: false,
          model_input: 'unknown',
          train: false,
        },
      },
      fields: {
        feedTitle: feed.title || null,
        feedLink: sanitizeLink(feed.link),
        categories,
      },
    });

    records.push(record);
  }

  const isPartial = isTruncated || records.length < items.length;

  return createEnvelope({
    records,
    completeness: {
      requested: maxItems,
      obtained: records.length,
      truncationReason: isTruncated ? 'max_output_bytes_exceeded' : (records.length < items.length ? 'max_items_limit' : null),
      unavailableSources: [],
      partial: isPartial,
    },
    warnings: isTruncated ? [{ code: 'byte_limit_truncated', message: `Conteúdo excedeu o limite de ${maxBytes} bytes`, sourceId }] : [],
    createdAt: retrievedAt,
  });
}

/** One admitted request. Redirects require a new reviewed URL/plan, never a hidden second call. */
export async function fetchAndNormalizeRss(
  url: string,
  options: RssAdapterOptions = {},
  fetcher?: typeof fetch
): Promise<DataEnvelope> {
  const destination = new URL(url);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash ||
      isPrivateOrLoopbackHost(destination.hostname)) throw new Error('rss_destination_denied');
  const maxBytes = options.maxOutputBytes ?? 512_000;
  const digest = createHash('sha256').update(destination.href).digest('hex');
  const outcome = await executeGovernedRead({
    schemaVersion: 1, operationId: 'read', capabilityId: 'api.rss.read', serviceId: 'rss', method: 'GET',
    url: destination.href, origin: destination.origin, path: destination.pathname,
    query: Object.fromEntries(destination.searchParams), schemaDigest: digest, callDigest: digest,
    limits: {maxSteps: 1, maxCalls: 1, maxOutputTokens:4096, timeoutMs: 12_000, maxOutputBytes: maxBytes},
  }, {responseFormat: 'feed', admittedOrigins: [destination.origin], signal: options.signal,
      deadlineAt: options.deadlineAt, ...(fetcher ? {fetchFn: fetcher} : {})});
  if (outcome.kind !== 'completed') throw Object.assign(new Error(outcome.code), {code: outcome.code, sent: outcome.sent});
  if (typeof outcome.data !== 'string') throw new Error('rss_invalid_response');
  options.signal?.throwIfAborted();
  const envelope = await parseRssXml(outcome.data, {...options, feedUrl: destination.href});
  options.signal?.throwIfAborted();
  if ((envelope.warnings??[]).some(item => item.code === 'rss_parse_failed')) throw Object.assign(new Error('rss_parse_failed'), {sent: 'yes'});
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > maxBytes) throw Object.assign(new Error('api_response_too_large'), {sent: 'yes'});
  return envelope;
}
