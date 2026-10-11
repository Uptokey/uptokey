/** Etapa 07: scientific metadata through the same importer, transport and W5 dispatcher.
 * Primary documentation checked 2026-09-18; fixtures only, no account or live request.
 * - NCBI E-utilities: https://www.ncbi.nlm.nih.gov/books/NBK25499/
 * - arXiv RSS: https://info.arxiv.org/help/rss.html and https://info.arxiv.org/help/api/tou.html
 */
const consultedAt = '2026-09-18T00:00:00.000Z';
const response = { '200': { description: 'Public response' } };
const pubmedCommon = [
  { name: 'db', in: 'query', required: true, description: 'PubMed only', schema: { type: 'string', enum: ['pubmed'], default: 'pubmed' } },
  { name: 'retmode', in: 'query', required: true, description: 'JSON only', schema: { type: 'string', enum: ['json'], default: 'json' } },
] as const;

export const PUBMED_EUTILS_SPEC = {
  openapi: '3.0.3',
  info: { title: 'NCBI E-utilities (PubMed)', version: '1.0.0', 'x-uptokey-metadata': {
    serviceId: 'pubmed', domain: 'scientific_literature', officialUrl: 'https://pubmed.ncbi.nlm.nih.gov',
    specUrl: 'https://www.ncbi.nlm.nih.gov/books/NBK25499/', revision: '2026.09.18',
    codeLicense: 'HTTP service; no NCBI implementation copied',
    dataLicense: 'PubMed records may include publisher-copyrighted abstracts; reuse rights are unknown per record',
    commercialTerms: 'NCBI usage policies apply. One bounded request per approved step, without API key, email or tool identity of the person.',
    authentication: 'none', rateLimit: 'Without an API key NCBI asks for no more than 3 requests per second; 429 is not retried internally.',
    attribution: 'National Library of Medicine — PubMed', consultedAt,
    contentRights: { termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/', verifiedAt: consultedAt,
      permissions: { obtain: true, store: 'unknown', display: 'unknown', export: 'unknown', model_input: 'unknown', train: 'unknown' } },
  } },
  servers: [{ url: 'https://eutils.ncbi.nlm.nih.gov' }],
  paths: {
    '/entrez/eutils/esearch.fcgi': { get: {
      operationId: 'search_pubmed', summary: 'Buscar artigos no PubMed', description: 'Uma página de identificadores PMID; count maior que a página é resultado parcial, sem buscar páginas seguintes.',
      parameters: [
        ...pubmedCommon,
        { name: 'term', in: 'query', required: true, description: 'PubMed query', schema: { type: 'string', minLength: 2, maxLength: 500 } },
        { name: 'retmax', in: 'query', required: true, description: 'Maximum identifiers on this page', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'retstart', in: 'query', required: false, description: 'Explicit offset of this single page', schema: { type: 'integer', minimum: 0, maximum: 9999, default: 0 } },
        { name: 'sort', in: 'query', required: false, description: 'Source ordering', schema: { type: 'string', enum: ['relevance', 'pub_date', 'Author', 'JournalName'] } },
      ], responses: response,
    } },
    '/entrez/eutils/esummary.fcgi': { get: {
      operationId: 'get_pubmed_summaries', summary: 'Consultar metadados de artigos PubMed', description: 'Resumo bibliográfico de até 20 PMIDs; identificador ausente ou com erro torna o resultado parcial.',
      parameters: [
        ...pubmedCommon,
        { name: 'id', in: 'query', required: true, description: 'Comma-separated PMIDs (1–20)', schema: { type: 'string', pattern: '^[0-9]{1,9}(,[0-9]{1,9}){0,19}$', maxLength: 199 } },
      ], responses: response,
    } },
  },
} as const;

export const ARXIV_FEED_SPEC = {
  openapi: '3.0.3',
  info: { title: 'arXiv category feed', version: '1.0.0', 'x-uptokey-metadata': {
    serviceId: 'arxiv', domain: 'scientific_literature', officialUrl: 'https://arxiv.org',
    specUrl: 'https://info.arxiv.org/help/rss.html', revision: '2026.09.18',
    codeLicense: 'HTTP service; no arXiv implementation copied',
    dataLicense: 'Descriptive metadata is CC0 per arXiv API terms; each e-print keeps its own license (dc:rights), which is not granted here',
    commercialTerms: 'arXiv API terms: at most one request every three seconds, single connection; no implied endorsement; e-prints are not downloaded.',
    authentication: 'none', rateLimit: 'One request every three seconds; feeds update daily.',
    attribution: 'arXiv.org — metadata CC0; e-prints belong to their authors', consultedAt,
    contentRights: { termsUrl: 'https://info.arxiv.org/help/api/tou.html', verifiedAt: consultedAt,
      permissions: { obtain: true, store: true, display: true, export: true, model_input: true, train: 'unknown' } },
  } },
  servers: [{ url: 'https://rss.arxiv.org' }],
  paths: {
    '/rss/{category}': { get: {
      operationId: 'get_category_feed', summary: 'Novos preprints de uma categoria arXiv', description: 'Feed RSS diário de uma categoria; preprints conservam tipo próprio e a licença de cada item como observada.',
      'x-uptokey-response-format': 'feed', 'x-uptokey-feed-material-type': 'preprint',
      parameters: [
        { name: 'category', in: 'path', required: true, description: 'Single arXiv archive or subject class, e.g. cs.AI', schema: { type: 'string', pattern: '^[a-z][a-z-]{0,15}(\\.[A-Za-z][A-Za-z-]{0,15})?$', maxLength: 32 } },
      ], responses: response,
    } },
  },
} as const;
