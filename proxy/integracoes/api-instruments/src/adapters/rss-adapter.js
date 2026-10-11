import Parser from 'rss-parser';

export async function fetchAndNormalizeRss(url, options = {}) {
  const parser = new Parser({
    timeout: 5000,
    maxRedirects: 3,
    ...options
  });
  
  const fetchedAt = new Date().toISOString();
  let feed;
  
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    return createPartialEnvelope(url, fetchedAt, err.message);
  }
  
  const envelope = {
    schema: 'uptokey.data-envelope.v1',
    version: 1,
    records: feed.items.map(item => ({
      type: 'news',
      title: item.title || 'Untitled',
      link: item.link || '',
      publishedAt: item.pubDate || null,
      snippet: item.contentSnippet || '',
      id: item.guid || item.link || '',
      creator: item.creator || item.author || ''
    })),
    provenance: {
      source: url,
      generator: feed.generator || 'unknown',
      adapter: 'api-instruments/rss-adapter.v1'
    },
    sourceIdentifiers: {
      url: url,
      title: feed.title || 'Unknown Feed'
    },
    retrievedAt: fetchedAt,
    sourcePublishedAt: feed.pubDate || feed.lastBuildDate || null,
    contentRights: {
      localProcessing: true,
      redistribution: 'unknown',
      modelInputAllowed: 'unknown',
      training: false
    },
    completeness: 'partial',
    warnings: []
  };
  
  return envelope;
}

function createPartialEnvelope(url, time, error) {
  return {
    schema: 'uptokey.data-envelope.v1',
    version: 1,
    records: [],
    provenance: { source: url, adapter: 'api-instruments/rss-adapter.v1' },
    sourceIdentifiers: { url },
    retrievedAt: time,
    contentRights: { localProcessing: false, redistribution: 'unknown', modelInputAllowed: 'unknown', training: false },
    completeness: 'failed',
    warnings: [`Fetch failed: ${error}`]
  };
}
