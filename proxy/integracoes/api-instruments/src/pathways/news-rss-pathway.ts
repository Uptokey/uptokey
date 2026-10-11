import { parseRssXml, fetchAndNormalizeRss, type RssAdapterOptions } from '../adapters/rss-adapter.ts';
import type { DataEnvelope, DataRecord } from '@uptokey/sync-contract/data-envelope';

export interface NewsRssPathwayInput {
  topic?: string;
  feedUrl?: string;
  rawXml?: string;
  maxItems?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface NewsRssPathwayResult {
  envelope: DataEnvelope;
  selectedCount: number;
  dedupCount: number;
  provenanceSummary: string;
}

export async function executeNewsRssPathway(
  input: NewsRssPathwayInput,
  fetcher?: typeof fetch
): Promise<NewsRssPathwayResult> {
  const maxItems = input.maxItems ?? 10;
  const maxBytes = input.maxBytes ?? 524_288;
  let envelope: DataEnvelope;

  if (input.rawXml) {
    envelope = await parseRssXml(input.rawXml, {
      maxItems: maxItems * 2, // Fetch slightly more to allow dedup
      maxOutputBytes: maxBytes,
      sourceId: input.topic ? `rss.news.${input.topic}` : 'rss.news',
      feedUrl: input.feedUrl,
      signal: input.signal,
    });
  } else if (input.feedUrl) {
    envelope = await fetchAndNormalizeRss(
      input.feedUrl,
      {
        maxItems: maxItems * 2,
        maxOutputBytes: maxBytes,
        sourceId: input.topic ? `rss.news.${input.topic}` : 'rss.news',
        feedUrl: input.feedUrl,
        signal: input.signal,
      },
      fetcher
    );
  } else {
    throw new Error('NewsRssPathway requer feedUrl ou rawXml');
  }

  // Deduplication by canonical URL or GUID
  const seenIds = new Set<string>();
  const dedupedRecords: DataRecord[] = [];
  let dedupCount = 0;

  for (const record of envelope.records) {
    const key = record.provenance.canonicalUrl || record.provenance.sourceRecordId || record.id;
    if (seenIds.has(key)) {
      dedupCount++;
      continue;
    }
    seenIds.add(key);
    dedupedRecords.push(record);
    if (dedupedRecords.length >= maxItems) break;
  }

  envelope.records = dedupedRecords;
  envelope.completeness.obtained = dedupedRecords.length;

  return {
    envelope,
    selectedCount: dedupedRecords.length,
    dedupCount,
    provenanceSummary: `Obtidos ${dedupedRecords.length} itens de notícias; ${dedupCount} duplicatas removidas.`,
  };
}
