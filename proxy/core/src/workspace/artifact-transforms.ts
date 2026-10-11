import { createHash } from "node:crypto";
import {
  type Artifact,
  createArtifactRecord,
  assertImmutableReplace,
  projectByteLength,
  PROJECT_STORAGE_MAX_BYTES,
  sha256Hex,
} from "./artifacts.ts";
import type { WorkspaceStore } from "./store.ts";
import type { DataRecord, DataEnvelope, RecordRelation, RecordProvenance } from "@uptokey/sync-contract/data-envelope";

// ── 1. CSV EXPORT WITH FORMULA INJECTION MITIGATION (RFC 4180) ──

export interface CsvExportOptions {
  delimiter?: string;
  sanitizeFormulas?: boolean;
  columns?: string[];
  includeHeader?: boolean;
  nullPlaceholder?: string;
}

export interface CsvExportResult {
  csv: string;
  byteLength: number;
  formulaSanitizedCount: number;
  rawAvailable: boolean;
  columnCount: number;
  rowCount: number;
}

const FORMULA_TRIGGER_REGEX = /^[\s]*[=+\-@\t\r]/;

export function sanitizeCsvCell(value: unknown, sanitizeFormulas: boolean = true, nullPlaceholder: string = ""): { text: string; sanitized: boolean } {
  if (value === null || value === undefined) {
    return { text: nullPlaceholder, sanitized: false };
  }

  let str: string;
  if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }

  let sanitized = false;
  if (sanitizeFormulas && FORMULA_TRIGGER_REGEX.test(str)) {
    // Prefix with single quote to prevent formula execution in spreadsheet software (RFC/OWASP)
    str = "'" + str;
    sanitized = true;
  }

  // RFC 4180 escaping: if contains quote, delimiter, newline or carriage return, enclose in quotes and double quotes
  if (/[",\n\r]/.test(str) || str.includes(",")) {
    str = '"' + str.replace(/"/g, '""') + '"';
  }

  return { text: str, sanitized };
}

export function exportToCsv(
  records: readonly (Record<string, unknown> | DataRecord)[],
  options: CsvExportOptions = {}
): CsvExportResult {
  const delimiter = options.delimiter ?? ",";
  const sanitizeFormulas = options.sanitizeFormulas ?? true;
  const includeHeader = options.includeHeader ?? true;
  const nullPlaceholder = options.nullPlaceholder ?? "";

  if (!records || records.length === 0) {
    return {
      csv: "",
      byteLength: 0,
      formulaSanitizedCount: 0,
      rawAvailable: true,
      columnCount: 0,
      rowCount: 0,
    };
  }

  // Extract flat rows
  const rows: Record<string, unknown>[] = records.map((rec) => {
    if ("fields" in rec && rec.fields && typeof rec.fields === "object") {
      const dataRecord = rec as DataRecord;
      return {
        id: dataRecord.id,
        title: dataRecord.title ?? null,
        materialType: dataRecord.materialType,
        sourceId: dataRecord.provenance?.sourceId ?? null,
        publishedAt: dataRecord.provenance?.sourcePublishedAt ?? null,
        authors: Array.isArray(dataRecord.authors) ? dataRecord.authors.join("; ") : null,
        ...dataRecord.fields,
      };
    }
    return { ...(rec as Record<string, unknown>) };
  });

  // Determine columns deterministically
  let columns = options.columns;
  if (!columns || columns.length === 0) {
    const keySet = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        keySet.add(k);
      }
    }
    // Deterministic sort
    columns = Array.from(keySet).sort();
  }

  let formulaSanitizedCount = 0;
  const lines: string[] = [];

  if (includeHeader) {
    const headerLine = columns
      .map((col) => {
        const { text } = sanitizeCsvCell(col, false, "");
        return text;
      })
      .join(delimiter);
    lines.push(headerLine);
  }

  for (const row of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      const val = row[col];
      const { text, sanitized } = sanitizeCsvCell(val, sanitizeFormulas, nullPlaceholder);
      if (sanitized) formulaSanitizedCount++;
      cells.push(text);
    }
    lines.push(cells.join(delimiter));
  }

  const csv = lines.join("\r\n");
  const bytes = new TextEncoder().encode(csv);

  return {
    csv,
    byteLength: bytes.byteLength,
    formulaSanitizedCount,
    rawAvailable: true,
    columnCount: columns.length,
    rowCount: rows.length,
  };
}

// ── 2. EXACT DEDUPLICATION & PROVENANCE PRESERVATION ──

export interface DeduplicateResult {
  records: DataRecord[];
  mergedCount: number;
  candidateMatches: RecordRelation[];
  preservedProvenanceCount: number;
}

export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  let clean = doi.trim().toLowerCase();
  clean = clean.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "");
  return clean.trim() || null;
}

export function normalizePmid(pmid: string | null | undefined): string | null {
  if (!pmid) return null;
  let clean = pmid.trim().toLowerCase();
  clean = clean.replace(/^(https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:)/, "");
  return clean.trim() || null;
}

export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deduplicateRecords(records: readonly DataRecord[]): DeduplicateResult {
  const resultRecords: DataRecord[] = [];
  const candidateMatches: RecordRelation[] = [];
  let mergedCount = 0;
  let preservedProvenanceCount = 0;

  // Index maps
  const doiMap = new Map<string, number>(); // normalizedDoi -> index in resultRecords
  const pmidMap = new Map<string, number>(); // normalizedPmid -> index in resultRecords
  const sourceRecordMap = new Map<string, number>(); // sourceId:sourceRecordId -> index in resultRecords

  for (const record of records) {
    const doi = normalizeDoi(record.provenance?.identifiers?.doi ?? (record.fields?.doi as string | undefined));
    const pmid = normalizePmid(record.provenance?.identifiers?.pmid ?? (record.fields?.pmid as string | undefined));
    const sourceRecordKey = record.provenance?.sourceId && record.provenance?.sourceRecordId
      ? `${record.provenance.sourceId}:${record.provenance.sourceRecordId}`
      : null;

    // Check if this record is an erratum, retraction, or correction
    const isRetraction = record.materialType === "retraction" ||
      (record.fields && (record.fields.isRetraction === true || record.fields.retraction === true)) ||
      /\b(retraction|retracted)\b/i.test(record.title || "");
    const isCorrection = record.materialType === "correction" ||
      /\b(erratum|correction|corrigendum)\b/i.test(record.title || "");

    let existingIdx = -1;
    if (doi && doiMap.has(doi)) {
      existingIdx = doiMap.get(doi)!;
    } else if (pmid && pmidMap.has(pmid)) {
      existingIdx = pmidMap.get(pmid)!;
    } else if (sourceRecordKey && sourceRecordMap.has(sourceRecordKey)) {
      existingIdx = sourceRecordMap.get(sourceRecordKey)!;
    }

    if (existingIdx >= 0) {
      const existing = resultRecords[existingIdx]!;
      const existingIsRetraction = existing.materialType === "retraction" || /\b(retraction|retracted)\b/i.test(existing.title || "");
      const existingIsCorrection = existing.materialType === "correction" || /\b(erratum|correction)\b/i.test(existing.title || "");

      // Criterion 08-03: Retractions and corrections must NEVER be merged with the original work!
      if (isRetraction || isCorrection || existingIsRetraction || existingIsCorrection) {
        const relationType = (isRetraction || existingIsRetraction) ? "retracts" : "corrects";
        const relation: RecordRelation = {
          targetId: existing.id,
          type: relationType,
          method: "exact_id",
          evidence: `Distinct ${relationType} record with matched identifier ${doi || pmid || sourceRecordKey}`,
        };
        candidateMatches.push(relation);

        // Add as separate distinct record with relation link
        const unmergedRecord: DataRecord = {
          ...record,
          relations: [...(record.relations || []), relation],
        };
        resultRecords.push(unmergedRecord);
        continue;
      }

      // Exact match between two standard records of the same work: merge and PRESERVE all provenances
      mergedCount++;
      const existingAllProv: RecordProvenance[] = (existing.fields?.allProvenances as RecordProvenance[]) || [existing.provenance];
      const updatedAllProv = [...existingAllProv, record.provenance];
      preservedProvenanceCount = updatedAllProv.length;

      const existingSourceRefs = (existing.fields?.sourceRefs as string[]) || [existing.provenance.sourceId];
      const updatedSourceRefs = Array.from(new Set([...existingSourceRefs, record.provenance.sourceId]));

      // Merge fields while preserving existing non-null fields
      resultRecords[existingIdx] = {
        ...existing,
        summary: existing.summary || record.summary,
        authors: (existing.authors && existing.authors.length > 0) ? existing.authors : record.authors,
        fields: {
          ...record.fields,
          ...existing.fields,
          allProvenances: updatedAllProv,
          sourceRefs: updatedSourceRefs,
        },
      };
      continue;
    }

    // Check for candidate title matches with DIFFERENT identifiers (must NOT be merged automatically)
    const normTitle = normalizeTitle(record.title);
    if (normTitle && normTitle.length > 15) {
      for (const existing of resultRecords) {
        const existingNormTitle = normalizeTitle(existing.title);
        if (existingNormTitle && existingNormTitle === normTitle) {
          // Same title but different or absent ID: create candidate_match, DO NOT MERGE
          const candidateRelation: RecordRelation = {
            targetId: existing.id,
            type: "version_of",
            method: "candidate_match",
            evidence: "Exact normalized title match but distinct or unverified identifiers",
          };
          candidateMatches.push(candidateRelation);
        }
      }
    }

    // Insert new unique record
    const newIdx = resultRecords.length;
    resultRecords.push({
      ...record,
      fields: {
        ...record.fields,
        allProvenances: [record.provenance],
        sourceRefs: [record.provenance.sourceId],
      },
    });

    if (doi) doiMap.set(doi, newIdx);
    if (pmid) pmidMap.set(pmid, newIdx);
    if (sourceRecordKey) sourceRecordMap.set(sourceRecordKey, newIdx);
  }

  return {
    records: resultRecords,
    mergedCount,
    candidateMatches,
    preservedProvenanceCount: preservedProvenanceCount || resultRecords.length,
  };
}

// ── 3. LOCAL CSL / BIBTEX FORMATTING WITH ZERO NETWORK GUARANTEE ──

export interface CslAuthor {
  family?: string;
  given?: string;
  name?: string; // Institutional or compound author
  literal?: string;
}

export interface CslDate {
  "date-parts"?: number[][];
  raw?: string;
  literal?: string;
}

export interface CslItem {
  id: string;
  type?: string;
  title?: string;
  author?: CslAuthor[];
  issued?: CslDate;
  DOI?: string;
  PMID?: string;
  publisher?: string;
  "container-title"?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  URL?: string;
  abstract?: string;
}

export interface CitationFormatResult {
  output: string;
  networkCalls: 0; // Strictly zero network calls
  itemCount: number;
}

export function formatCslDateString(issued?: CslDate): string | null {
  if (!issued || !Array.isArray(issued["date-parts"]) || !issued["date-parts"][0]) {
    return issued?.literal || issued?.raw || null;
  }
  const parts = issued["date-parts"][0];
  if (parts.length === 1 && parts[0]) {
    // Preserves year precision, NO coercion to "-01-01" (Criterion 08-04)
    return String(parts[0]);
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `${parts[0]}-${String(parts[1]).padStart(2, "0")}`;
  }
  if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
    return `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
  }
  return String(parts[0]);
}

export function formatAuthorBibtex(author: CslAuthor): string {
  // Institutional author: enclose in braces to prevent surname splitting (Criterion 08-04)
  if (author.name || author.literal) {
    return `{${author.name || author.literal}}`;
  }
  if (author.family && author.given) {
    return `${author.family}, ${author.given}`;
  }
  if (author.family) {
    return author.family;
  }
  return author.given || "Anonymous";
}

export function formatCslLocal(
  items: readonly CslItem[],
  format: "bibtex" | "csl-json" | "markdown" = "bibtex"
): CitationFormatResult {
  // Guarantee zero network counter
  const networkCalls: 0 = 0;

  if (format === "csl-json") {
    return {
      output: JSON.stringify(items, null, 2),
      networkCalls,
      itemCount: items.length,
    };
  }

  if (format === "bibtex") {
    const entries = items.map((item) => {
      const type = item.type === "article-journal" ? "article" : (item.type || "misc");
      const citeKey = item.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const lines: string[] = [`@${type}{${citeKey},`];

      if (item.title) {
        lines.push(`  title = {{${item.title}}},`);
      }
      if (Array.isArray(item.author) && item.author.length > 0) {
        const authorsStr = item.author.map(formatAuthorBibtex).join(" and ");
        lines.push(`  author = {${authorsStr}},`);
      }
      const dateStr = formatCslDateString(item.issued);
      if (dateStr) {
        const year = dateStr.slice(0, 4);
        lines.push(`  year = {${year}},`);
        if (dateStr.length > 4) {
          lines.push(`  date = {${dateStr}},`);
        }
      }
      if (item["container-title"]) {
        lines.push(`  journal = {${item["container-title"]}},`);
      }
      if (item.volume) lines.push(`  volume = {${item.volume}},`);
      if (item.issue) lines.push(`  number = {${item.issue}},`);
      if (item.page) lines.push(`  pages = {${item.page}},`);
      if (item.publisher) lines.push(`  publisher = {${item.publisher}},`);
      // Criterion 08-04: DOI ausente permanece ausente
      if (item.DOI) lines.push(`  doi = {${item.DOI}},`);
      if (item.URL) lines.push(`  url = {${item.URL}},`);

      lines.push("}");
      return lines.join("\n");
    });

    return {
      output: entries.join("\n\n"),
      networkCalls,
      itemCount: items.length,
    };
  }

  // Markdown bibliography
  const mdLines = items.map((item, idx) => {
    const authors = Array.isArray(item.author)
      ? item.author.map((a) => a.name || a.literal || (a.family ? `${a.family}, ${a.given || ""}`.trim() : "Anon")).join("; ")
      : "Anon";
    const dateStr = formatCslDateString(item.issued) || "s.d.";
    const title = item.title ? `**${item.title}**` : "Sem título";
    const venue = item["container-title"] ? ` *in* ${item["container-title"]}` : "";
    const doiLink = item.DOI ? ` [DOI:${item.DOI}](https://doi.org/${item.DOI})` : "";
    return `${idx + 1}. ${authors} (${dateStr}). ${title}${venue}.${doiLink}`;
  });

  return {
    output: mdLines.join("\n\n"),
    networkCalls,
    itemCount: items.length,
  };
}

// ── 4. EXPORT RIGHTS & PERMISSION ENFORCEMENT ──

export interface ExportRightsResult {
  allowed: boolean;
  status: "export_permitted" | "export_restricted";
  reason?: string;
  sanitizedRecords: DataRecord[];
  restrictedRecordIds: string[];
  manifestNotice: string;
}

export function enforceExportRights(envelope: DataEnvelope): ExportRightsResult {
  const restrictedRecordIds: string[] = [];
  const sanitizedRecords: DataRecord[] = [];

  for (const record of envelope.records) {
    const canExport = record.rights?.permissions?.export === true;
    if (!canExport) {
      restrictedRecordIds.push(record.id);
      // Redact content while preserving metadata attribution and reason
      sanitizedRecords.push({
        ...record,
        summary: "[CONTEÚDO RETIDO - EXPORTAÇÃO RESTRITA PELA FONTE]",
        fields: {
          export_restricted: true,
          restriction_reason: "A fonte original não autoriza exportação deste registro",
        },
      });
    } else {
      sanitizedRecords.push(record);
    }
  }

  const allowed = restrictedRecordIds.length === 0;
  const status = allowed ? "export_permitted" : "export_restricted";
  const reason = allowed
    ? undefined
    : `${restrictedRecordIds.length} registro(s) retido(s) por restrição de direitos de exportação da fonte.`;

  const manifestNotice = allowed
    ? "Exportação autorizada nos termos de distribuição das fontes primárias."
    : `AVISO DE DIREITOS: Exportação restrita para ${restrictedRecordIds.length} item(ns). Conteúdo sensível/restrinto retido.`;

  return {
    allowed,
    status,
    reason,
    sanitizedRecords,
    restrictedRecordIds,
    manifestNotice,
  };
}

// ── 5. SAFE LOCAL PDF INSPECTION & EXTRACTION ──

export interface PdfExtractionResult {
  status: "succeeded" | "failed" | "empty";
  errorCode?: "pdf_encrypted" | "pdf_malformed" | "pdf_no_text";
  message?: string;
  text?: string;
  metadata?: {
    title?: string;
    author?: string;
    pageCount?: number;
  };
  networkCalls: 0;
}

export function extractPdfSafe(buffer: Uint8Array): PdfExtractionResult {
  const networkCalls: 0 = 0;

  if (!buffer || buffer.byteLength < 8) {
    return {
      status: "failed",
      errorCode: "pdf_malformed",
      message: "Estrutura de PDF inválida ou corpo vazio",
      networkCalls,
    };
  }

  // Check PDF magic header %PDF-
  const header = new TextDecoder("latin1").decode(buffer.slice(0, 1024));
  if (!header.startsWith("%PDF-")) {
    return {
      status: "failed",
      errorCode: "pdf_malformed",
      message: "Assinatura mágica de PDF ausente (%PDF-)",
      networkCalls,
    };
  }

  // Scan for encryption (/Encrypt dictionary)
  const fullContent = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (/\/Encrypt\b/.test(fullContent)) {
    return {
      status: "failed",
      errorCode: "pdf_encrypted",
      message: "PDF protegido por senha ou encriptado",
      networkCalls,
    };
  }

  // Search for text operators (BT ... ET)
  const textMatches: string[] = [];
  const btEtRegex = /BT([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;
  while ((match = btEtRegex.exec(fullContent)) !== null) {
    const block = match[1]!;
    // Extract strings in parentheses: (Text) Tj or [(T)(e)(x)(t)] TJ
    const strRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = strRegex.exec(block)) !== null) {
      if (strMatch[1]) {
        textMatches.push(strMatch[1].replace(/\\([()\\])/g, "$1"));
      }
    }
  }

  if (textMatches.length === 0) {
    return {
      status: "empty",
      errorCode: "pdf_no_text",
      message: "PDF não contém texto extraível localmente",
      networkCalls,
    };
  }

  const extractedText = textMatches.join(" ").replace(/\s+/g, " ").trim();

  // Extract basic metadata from /Info dictionary if present
  const metadata: PdfExtractionResult["metadata"] = {};
  const titleMatch = /\/Title\s*\(([^)]+)\)/.exec(fullContent);
  if (titleMatch?.[1]) metadata.title = titleMatch[1];
  const authorMatch = /\/Author\s*\(([^)]+)\)/.exec(fullContent);
  if (authorMatch?.[1]) metadata.author = authorMatch[1];

  const pageMatches = fullContent.match(/\/Type\s*\/Page\b/g);
  if (pageMatches) metadata.pageCount = pageMatches.length;

  return {
    status: "succeeded",
    text: extractedText,
    metadata,
    networkCalls,
  };
}

// ── 6. ATOMIC DERIVATION & ARTIFACT PERSISTENCE HELPER ──

export interface CreateDerivedArtifactParams {
  store: WorkspaceStore;
  identityId: string;
  projectId: string;
  expectedRevision: number;
  artifactId: string;
  mediaType: Artifact["mediaType"];
  content: string | Uint8Array;
  provenance: {
    runId: string;
    receiptRefs: string[];
    sourceRefs: string[];
    requireDispatchedAttemptId?: string;
  };
}

export async function createDerivedArtifact(
  params: CreateDerivedArtifactParams
): Promise<{ project: { id: string; revision: number; artifactRefs: string[] }; artifactId: string }> {
  const { store, identityId, projectId, expectedRevision, artifactId, mediaType, content, provenance } = params;

  if (typeof content === "string") {
    return store.putTextArtifact(
      identityId,
      projectId,
      expectedRevision,
      mediaType,
      content,
      artifactId,
      provenance
    );
  } else {
    return store.putBinaryArtifact(
      identityId,
      projectId,
      expectedRevision,
      mediaType,
      content,
      artifactId,
      provenance
    );
  }
}
