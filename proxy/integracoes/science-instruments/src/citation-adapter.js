import { Cite } from '@citation-js/core';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-bibtex';
import { createEnvelope, createRecord } from "../../../contratos/data-envelope.js";

function mapCslType(cslType) {
  switch (cslType) {
    case 'article-journal':
      return 'journal_article';
    case 'paper-conference':
      return 'unknown';
    case 'report':
      return 'unknown';
    case 'preprint':
      return 'preprint';
    default:
      return 'unknown';
  }
}

function extractDateString(issued) {
  if (!issued || !Array.isArray(issued['date-parts']) || !issued['date-parts'][0]) {
    return null;
  }
  const parts = issued['date-parts'][0];
  if (parts.length === 1) {
    return String(parts[0]); // e.g. "2021" - Preserves year precision, NO coercion to "-01-01"
  }
  if (parts.length === 2) {
    return `${parts[0]}-${String(parts[1]).padStart(2, '0')}`;
  }
  return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
}

export function formatCitationRecords(cslRecords, options = {}) {
  const recordsInput = Array.isArray(cslRecords) ? cslRecords : [cslRecords];
  const now = new Date().toISOString();
  const sourceId = options.sourceId || 'citation-js';

  const records = recordsInput.map((item, idx) => {
    const rawType = item.type || 'unknown';
    const matType = mapCslType(rawType);
    const pubDate = extractDateString(item.issued);
    const title = item.title ? String(item.title).trim() : 'Sem título';
    const authors = Array.isArray(item.author)
      ? item.author.map(a => a.name || `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean)
      : [];

    const identifiers = {};
    if (item.DOI) identifiers.doi = String(item.DOI);
    if (item.PMID) identifiers.pmid = String(item.PMID);
    if (item.PMCID) identifiers.pmcid = String(item.PMCID);
    if (item.id) identifiers.cslId = String(item.id);

    return createRecord({
      id: String(item.id || item.DOI || `${sourceId}_${idx}`),
      materialType: matType,
      materialTypeSource: 'csl',
      title,
      summary: item.abstract ? String(item.abstract).trim() : null,
      authors,
      publisher: item.publisher || item['container-title'] || null,
      language: item.language || null,
      provenance: {
        sourceId,
        sourceRecordId: item.DOI || (item.id ? String(item.id) : null),
        canonicalUrl: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
        identifiers,
        retrievedAt: now,
        sourcePublishedAt: pubDate,
        query: options.query || null,
        adapterVersion: 'science-instruments/citation-adapter.v2',
      },
      rights: {
        termsUrl: null,
        verifiedAt: null,
        holder: item.publisher || null,
        attribution: item['container-title'] ? `Publicado em ${item['container-title']}` : null,
        permissions: {
          obtain: true,
          store: true,
          display: true,
          export: (options.permissions && options.permissions.export === true),
          model_input: 'unknown',
          train: false,
        },
      },
      fields: {
        cslType: rawType,
        containerTitle: item['container-title'] || null,
        volume: item.volume || null,
        issue: item.issue || null,
        page: item.page || null,
      },
    });
  });

  return createEnvelope({
    records,
    completeness: {
      requested: recordsInput.length,
      obtained: records.length,
      truncationReason: null,
      unavailableSources: [],
      partial: false,
    },
    warnings: [],
    createdAt: now,
  });
}

export function exportCitation(cslRecords, format = 'bibtex') {
  const recordsInput = Array.isArray(cslRecords) ? cslRecords : [cslRecords];
  const cite = new Cite(recordsInput);
  if (format === 'bibtex') {
    return cite.format('bibtex');
  }
  if (format === 'csl' || format === 'json') {
    return cite.format('data');
  }
  return cite.format('bibtex');
}

export async function fetchCitation(input, options = {}) {
  // If input is already structured CSL data (array or object with title/issued), process locally
  if (Array.isArray(input) || (typeof input === 'object' && input !== null)) {
    return formatCitationRecords(input, options);
  }

  // If input is a raw DOI or string without local data:
  // Citation.js Cite(doi) network resolution is FORBIDDEN by policy D01
  if (typeof input === 'string') {
    // If a governed W5 fetcher is provided:
    if (options.governedFetcher && typeof options.governedFetcher === 'function') {
      const doi = input.trim();
      const res = await options.governedFetcher(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { 'Accept': 'application/json' },
        signal: options.signal,
      });
      const data = await res.json();
      const csl = data?.message || data;
      return formatCitationRecords([csl], { ...options, query: doi, sourceId: 'crossref' });
    }

    // Without governed transport, direct library network fetch is blocked
    const now = new Date().toISOString();
    return createEnvelope({
      records: [],
      completeness: {
        requested: 1,
        obtained: 0,
        truncationReason: 'unadmitted_network_resolution_blocked',
        unavailableSources: ['citation-js'],
        partial: true,
      },
      warnings: [{
        code: 'network_blocked',
        message: 'Resolução de DOI direta pelo Citation.js bloqueada. Utilize o transporte governado W5.',
        sourceId: 'citation-js',
      }],
      createdAt: now,
    });
  }

  throw new Error('Input inválido para fetchCitation');
}
