/** Small, read-only beta connectors. No caller-controlled origins or credentials. */
export type PublicSource = "crossref" | "open-library" | "pubmed" | "openalex";
export type SourceRecord = { title: string; url: string; detail: string; doi?: string };
/** `email` (opcional) alimenta apenas o parâmetro de contato educado da fonte (mailto da Crossref/OpenAlex). */
export type SourceSearch = { source: PublicSource; query: string; email?: string };
export const BIBLIOGRAPHY_ACCEPT = "application/vnd.uptokey.bibliography+json, application/json";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export function parseSourceSearch(value: unknown): SourceSearch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (!["query,source", "email,query,source"].includes(Object.keys(item).sort().join(","))) return;
  if (!["crossref", "open-library", "pubmed", "openalex"].includes(String(item.source))) return;
  if (typeof item.query !== "string" || item.query.trim().length < 2 || item.query.length > 300 || /[\u0000-\u001f]/.test(item.query)) return;
  let email: string | undefined;
  if (item.email !== undefined) {
    if (item.source !== "crossref" && item.source !== "openalex") return; // somente essas consomem mailto hoje
    if (typeof item.email !== "string" || item.email.length > 200 || !EMAIL_RE.test(item.email)) return;
    email = item.email;
  }
  return { source: item.source as PublicSource, query: item.query.trim(), ...(email ? { email } : {}) };
}

async function readSourceJson(response: Response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 ? "source_rate_limited" : "source_unavailable"); }
  if (!response.body) throw new Error("source_invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 512_000) throw new Error("source_response_too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(buffer));
}

function normalizedDoi(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^10\.\d{4,9}\/\S{1,200}$/.test(value) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return;
  return value.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function pubMedDoi(articleIds: unknown): string | undefined {
  if (!Array.isArray(articleIds) || articleIds.length > 32) return;
  let doi: string | undefined;
  for (const identifier of articleIds) {
    if (identifier?.idtype !== "doi") continue;
    const value = normalizedDoi(identifier.value);
    if (!value || (doi && doi !== value)) return;
    doi = value;
  }
  return doi;
}

export async function searchPublicSource(input: SourceSearch, signal?: AbortSignal, fetcher: typeof fetch = fetch,
  { bibliography = false, includeDoi = bibliography }: { bibliography?: boolean; includeDoi?: boolean } = {}) {
  const url = new URL(input.source === "crossref" ? "https://api.crossref.org/works" : input.source === "pubmed" ? "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" : input.source === "openalex" ? "https://api.openalex.org/works" : "https://openlibrary.org/search.json");
  if (input.source === "crossref") {
    url.searchParams.set("query.bibliographic", input.query);
    url.searchParams.set("rows", "5");
    url.searchParams.set("select", "DOI,title,publisher");
    if (bibliography) url.searchParams.set("filter", "type:journal-article");
    if (input.email) url.searchParams.set("mailto", input.email);
  } else if (input.source === "openalex") {
    url.searchParams.set("search", input.query);
    url.searchParams.set("per-page", "5");
    if (input.email) url.searchParams.set("mailto", input.email);
  } else if (input.source === "pubmed") {
    url.searchParams.set("db", "pubmed");
    url.searchParams.set("term", input.query);
    url.searchParams.set("retmode", "json");
    url.searchParams.set("retmax", "5");
  } else if (input.source === "open-library") {
    url.searchParams.set("q", input.query);
    url.searchParams.set("limit", "5");
    url.searchParams.set("fields", "key,title,author_name,first_publish_year");
  }
  const started = performance.now();
  const deadline = AbortSignal.timeout(12_000);
  const request: RequestInit = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error", headers: { Accept: "application/json", "User-Agent": "Uptokey/0.1 beta public-source-search" } };
  const body = await readSourceJson(await fetcher(url, request));
  let entries = input.source === "crossref" ? body?.message?.items : input.source === "openalex" ? body?.results : body?.docs;
  if (input.source === "pubmed") {
    const idList: unknown = body?.esearchresult?.idlist;
    if (!Array.isArray(idList)) throw new Error("source_invalid_response");
    const ids = [...new Set(idList.filter((id): id is string => typeof id === "string" && /^\d{1,12}$/.test(id)))].slice(0, 5);
    if (ids.length) {
      const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
      summary.searchParams.set("db", "pubmed"); summary.searchParams.set("retmode", "json"); summary.searchParams.set("id", ids.join(","));
      const summaryBody = await readSourceJson(await fetcher(summary, request));
      entries = ids.map(id => summaryBody?.result?.[id]).filter((record, index) => record?.uid === ids[index]);
    } else entries = [];
  }
  if (!Array.isArray(entries)) throw new Error("source_invalid_response");
  const records: SourceRecord[] = [];
  for (const item of entries.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    if (input.source === "crossref") {
      if (typeof item.DOI !== "string" || !/^10\.\d{4,9}\/\S{1,200}$/.test(item.DOI) || !Array.isArray(item.title) || typeof item.title[0] !== "string") continue;
      const doi = includeDoi ? normalizedDoi(item.DOI) : undefined;
      records.push({ title: item.title[0].slice(0, 500), url: "https://doi.org/" + encodeURIComponent(item.DOI),
        detail: typeof item.publisher === "string" ? item.publisher.slice(0, 200) : "", ...(doi ? { doi } : {}) });
    } else if (input.source === "openalex") {
      if (typeof item.id !== "string" || !/^https:\/\/openalex\.org\/W\d{6,}$/.test(item.id)) continue;
      const title = typeof item.display_name === "string" ? item.display_name : typeof item.title === "string" ? item.title : null;
      if (!title) continue;
      records.push({ title: title.slice(0, 500), url: item.id, detail: typeof item.publication_year === "number" ? String(item.publication_year) : "" });
    } else if (input.source === "open-library") {
      if (typeof item.key !== "string" || !/^\/works\/OL\d+W$/.test(item.key) || typeof item.title !== "string") continue;
      const authors = Array.isArray(item.author_name) ? item.author_name.filter((a: unknown) => typeof a === "string").slice(0, 3).join(", ") : "";
      records.push({ title: item.title.slice(0, 500), url: "https://openlibrary.org" + item.key, detail: authors.slice(0, 200) });
    } else {
      if (typeof item.uid !== "string" || !/^\d{1,12}$/.test(item.uid) || typeof item.title !== "string") continue;
      const journal = typeof item.fulljournalname === "string" ? item.fulljournalname : typeof item.source === "string" ? item.source : "PubMed";
      const doi = includeDoi ? pubMedDoi(item.articleids) : undefined;
      records.push({ title: item.title.slice(0, 500), url: "https://pubmed.ncbi.nlm.nih.gov/" + item.uid + "/",
        detail: journal.slice(0, 200), ...(doi ? { doi } : {}) });
    }
  }
  return { source: input.source, records, checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), measurement: "single-request" as const };
}
