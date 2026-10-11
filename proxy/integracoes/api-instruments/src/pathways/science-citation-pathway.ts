import { formatCitationRecords, exportCitation, fetchCitation } from '../../../science-instruments/src/citation-adapter.js';
import type { DataEnvelope } from '@uptokey/sync-contract/data-envelope';

export interface ScienceCitationPathwayInput {
  query?: string;
  doi?: string;
  cslData?: any[];
  exportFormat?: 'bibtex' | 'csl';
  signal?: AbortSignal;
}

export interface ScienceCitationPathwayResult {
  envelope: DataEnvelope;
  formattedExport: string;
  identifierCount: number;
}

export async function executeScienceCitationPathway(
  input: ScienceCitationPathwayInput,
  governedFetcher?: typeof fetch
): Promise<ScienceCitationPathwayResult> {
  let envelope: DataEnvelope;

  if (input.cslData && input.cslData.length > 0) {
    envelope = formatCitationRecords(input.cslData, { query: input.query });
  } else if (input.doi) {
    envelope = await fetchCitation(input.doi, {
      governedFetcher,
      signal: input.signal,
      query: input.doi,
    });
  } else {
    throw new Error('ScienceCitationPathway requer cslData ou doi');
  }

  const exportFormat = input.exportFormat || 'bibtex';
  let formattedExport = '';

  if (envelope.records.length > 0) {
    // Reconstruct CSL items for local export
    const cslItems = envelope.records.map(r => ({
      id: r.id,
      type: r.fields?.cslType || 'article',
      title: r.title,
      DOI: r.provenance?.identifiers?.doi,
      PMID: r.provenance?.identifiers?.pmid,
      author: r.authors?.map(name => ({ family: name })),
      issued: r.provenance?.sourcePublishedAt ? { 'date-parts': [[parseInt(r.provenance.sourcePublishedAt, 10)]] } : undefined,
    }));
    try {
      formattedExport = exportCitation(cslItems, exportFormat);
    } catch {
      formattedExport = `# Exportação ${exportFormat} indisponível para este item`;
    }
  }

  let identifierCount = 0;
  for (const r of envelope.records) {
    if (r.provenance.identifiers?.doi) identifierCount++;
    if (r.provenance.identifiers?.pmid) identifierCount++;
  }

  return {
    envelope,
    formattedExport,
    identifierCount,
  };
}
