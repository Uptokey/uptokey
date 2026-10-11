/**
 * Tokenizer & Counter Catalog (Uptokey W0 / Observability) — versioned, provider-aware, auditable.
 *
 * Design contract:
 * - A count is only as trustworthy as its declared state. The state machine is explicit:
 *     verified    — counted offline with the model family's real BPE tokenizer plus the
 *                   provider's documented message-framing constants, verifier matched.
 *     partial     — real tokenizer applied to the countable text portion, but some parts
 *                   are estimated with documented formulas (media) or could not be counted
 *                   at all; the uncountable parts are listed, never silently folded in.
 *     heuristic   — no tokenizer available offline; conservative chars/4 over the exact
 *                   serialized payload, clearly labeled. Never presented as exact.
 *     unknown     — nothing countable (e.g. multimodal-only payload for a text-only path).
 *     unavailable — the counter itself could not run safely (oversize, overflow, encoder
 *                   failure, verifier disagreement). Distinct from "we chose not to count".
 * - Heuristic output is never relabeled as exact; exact output is never produced by a heuristic.
 * - Zero-custody: strictly local in-process, zero telemetry egress, zero vocabulary downloads.
 * - Media (image/audio/video) is never approximated as text. Media tokens come only from
 *   provider-documented, versioned formulas with locally measurable inputs (pixel dimensions
 *   parsed from the payload bytes, or explicitly declared duration). Otherwise the part is
 *   reported as uncountable with a reason — never invented.
 *
 * Versioning: TOKEN_CATALOG_VERSION bumps on ANY change to constants, formulas, framing or
 * family mapping. Cache keys embed the catalog version and the tokenizer id@version, so a
 * catalog bump invalidates every cached count deterministically. The artifact audit surface
 * carries its own explicit contracts: the historical probe digest (v1) and the v2 profile
 * bound to the effective encoder material (ranks, segmentation, special tokens).
 */

import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken';
import o200kRanks from 'js-tiktoken/ranks/o200k_base';
import cl100kRanks from 'js-tiktoken/ranks/cl100k_base';
import type { ChatCompletionRequest } from './types.ts';
import type { TokenUsageBasis } from '@uptokey/sync-contract/workflow';

export const TOKEN_CATALOG_VERSION = '2026-09-25.2';

export type TokenizerStatus = 'verified' | 'partial' | 'heuristic' | 'unknown' | 'unavailable';
export type TokenConfidence = 'high' | 'medium' | 'low';
export type TokenizerEncoding = 'o200k_base' | 'cl100k_base' | 'p50k_base';

/** Documented chat-message framing constants (tokens added around the raw content). */
export interface MessageFraming {
  readonly perMessage: number;
  readonly perReplyPriming: number;
  readonly perName: number;
  readonly formatVersion: string;
  readonly provenance: string;
}

/** Documented media token formula. Constants are provider-published values, captured offline. */
export interface MediaFormula {
  readonly id: string;
  readonly kind: 'image' | 'audio' | 'video';
  readonly provenance: string;
  readonly confidence: TokenConfidence;
  /** Exact bare model ids/aliases; text-tokenizer family membership is not media support. */
  readonly models?: readonly string[];
  /** image: base + perTile * tiles(tilePx); anthropic: ceil(w*h/divisor); per-image flat: flatTokens. */
  readonly image?: { readonly mode: 'tiles' | 'patches' | 'wh_ratio' | 'flat'; readonly base?: number; readonly perTile?: number; readonly tilePx?: number; readonly fitPx?: number; readonly shortestSidePx?: number; readonly divisor?: number; readonly flatTokens?: number; readonly smallImagePx?: number; readonly lowDetailTokens?: number; readonly patchBudget?: number; readonly multiplier?: number };
  /** audio: tokens per second (requires explicit duration — never guessed). */
  readonly audioTokensPerSecond?: number;
  /** video: tokens per sampled frame at the documented default fps (requires explicit duration). */
  readonly videoTokensPerFrame?: number;
  readonly videoDefaultFps?: number;
}

export interface TokenizerCatalogEntry {
  readonly family: string;
  readonly provider: string;
  readonly status: TokenizerStatus;
  readonly tokenizerName: string;
  readonly encoding?: TokenizerEncoding;
  readonly license: string;
  readonly provenance: string;
  readonly version: string;
  readonly multimodalSupport: boolean;
  /** Ordered regex sources matched against the normalized (provider-prefix-stripped) model id. */
  readonly match: readonly string[];
  readonly framing: MessageFraming | null;
  readonly media: readonly MediaFormula[];
  /** Why this family is not verified, and what would unlock exact offline counting. */
  readonly limitation: string | null;
}

export interface UncountablePart {
  readonly kind: 'image' | 'audio' | 'video' | 'file' | 'message' | 'tools' | 'response_format' | 'segment';
  readonly reason: string;
  readonly index?: number;
}

export interface TokenBreakdown {
  readonly textTokens: number;
  readonly framingTokens: number;
  readonly toolsTokens: number;
  readonly responseFormatTokens: number;
  readonly mediaTokens: number;
  readonly messagesCounted: number;
  readonly mediaCounted: number;
  readonly uncountable: readonly UncountablePart[];
}

export interface TokenMeasurement {
  readonly model: string;
  /** Total accountable input tokens; null when nothing could be counted (unknown/unavailable). */
  readonly input: number | null;
  /** Declared output budget (max_tokens/max_completion_tokens) or the documented default estimate. */
  readonly output: number;
  readonly outputBasis: 'declared_limit' | 'default_estimate';
  /**
   * Declared output budget only (null when the caller declared none). This is an
   * admission limit, never a measurement: provider-reported output tokens arrive
   * exclusively through usage-meter.ts and are never overwritten by this estimate.
   */
  readonly outputLimit: number | null;
  readonly basis: TokenUsageBasis;
  readonly state: TokenizerStatus;
  readonly confidence: TokenConfidence | null;
  readonly source: string;
  readonly version: string;
  readonly catalogVersion: string;
  /** Layered model identity (provider inference, alias form, family resolution). */
  readonly identity: ModelIdentity;
  /** Provider inferred from an explicit id prefix (openai/anthropic/google/…); null when the request carries none. */
  readonly provider: string | null;
  /** Model revision: null — no provider exposes a revision in the request path; never guessed. */
  readonly modelRevision: string | null;
  /** Counting artifact id (tokenizer name, or chars4-v1 for the labeled fallback). */
  readonly tokenizerId: string;
  /** Historical integrity digest of the counting artifact (catalog identity + frozen vectors); null when there is no artifact. The effective-material digest lives in `tokenizerArtifactProfile()`. */
  readonly artifactDigest: string | null;
  readonly reason: string | null;
  readonly flags: readonly string[];
  readonly isMultimodal: boolean;
  readonly breakdown: TokenBreakdown | null;
  readonly verifier: TokenVerifier;
  readonly measuredAt: string;
}

/** Second-path provenance for a measurement. Never a bare boolean. */
export interface TokenVerifier {
  readonly status: 'matched' | 'skipped' | 'mismatch' | 'not_applicable';
  readonly digest: string | null;
  /**
   * Engine that performed the recount: an independently held encoder object
   * plus the frozen artifact vector set it is pinned to. 'not_applicable'
   * outside the verified tokenizer path (heuristic/unknown/unavailable).
   */
  readonly engineId: string;
  /** Frozen vector-set id the artifact is pinned to; null when inapplicable. */
  readonly vectorId: string | null;
}

/**
 * Layered model identity. Resolution order: explicit provider prefix (or
 * gateway prefix such as openrouter/) → known family (with warning when the
 * family is heuristic-only) → unknown. The catalog holds families, never exact
 * model ids, so resolution is 'family' or 'unknown' — never a fabricated exact
 * match. Local runtime aliases are rewritten by the router before measurement;
 * an id that cannot be resolved deterministically stays 'unknown', never
 * unavailable-for-counting (counting must not break legitimate requests).
 */
export interface ModelIdentity {
  readonly raw: string;
  readonly bare: string;
  readonly provider: string | null;
  readonly aliasKind: 'none' | 'provider-prefix' | 'gateway-prefix';
  readonly resolution: 'family' | 'unknown';
  readonly family: string;
  readonly warning: string | null;
}

/** Legacy shape kept for existing consumers (estimateRequestTokens). */
export interface CatalogTokenMeasurement {
  readonly input: number | null;
  readonly output: number | null;
  readonly basis: TokenUsageBasis;
  readonly source: string;
  readonly version: string;
  readonly measuredAt: string;
  readonly reason: string | null;
  readonly isMultimodal: boolean;
}

/* ------------------------------------------------------------------ limits */

export const TOKEN_LIMITS = Object.freeze({
  maxSerializedRequestBytes: 8 * 1024 * 1024,
  maxMessages: 4096,
  maxSegmentBytes: 4 * 1024 * 1024,
  maxToolsBytes: 1024 * 1024,
  maxResponseFormatBytes: 1024 * 1024,
  maxMediaParts: 64,
  maxCacheEntries: 512,
  liveTokenizeMaxResponseBytes: 1024 * 1024,
  liveTokenizeTimeoutMs: 2_000,
});

/* ------------------------------------------------------------------ catalog */

const OPENAI_FRAMING: MessageFraming = Object.freeze({
  perMessage: 3,
  perReplyPriming: 3,
  perName: 1,
  formatVersion: 'openai-cookbook-3+3+name1',
  provenance: 'https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken (3/message, 3/reply, 1/name; checked 2026-09-25)',
});
const OPENAI_NAME_FRAMING_SNAPSHOTS = new Set([
  'gpt-3.5-turbo-0125', 'gpt-4-0314', 'gpt-4-0613', 'gpt-4-32k-0314', 'gpt-4-32k-0613',
  'gpt-4o-2024-08-06', 'gpt-4o-mini-2024-07-18',
]);

const OPENAI_VISION_TILES: MediaFormula['image'] = Object.freeze({
  mode: 'tiles', base: 85, perTile: 170, tilePx: 512, fitPx: 2048, shortestSidePx: 768, lowDetailTokens: 85,
});
const OPENAI_VISION_PATCHES: MediaFormula['image'] = Object.freeze({
  mode: 'patches', tilePx: 32, fitPx: 2048, patchBudget: 6144, multiplier: 1.62,
});
const OPENAI_VISION_MINI_TILES: MediaFormula['image'] = Object.freeze({
  mode: 'tiles', base: 2833, perTile: 5667, tilePx: 512, fitPx: 2048, shortestSidePx: 768, lowDetailTokens: 2833,
});
const OPENAI_VISION_SOURCE = 'https://developers.openai.com/api/docs/guides/images-vision (checked 2026-09-25; documented estimate, not provider usage)';
const ANTHROPIC_IMAGE: MediaFormula['image'] = Object.freeze({ mode: 'wh_ratio', divisor: 750 });
const GEMINI_IMAGE: MediaFormula['image'] = Object.freeze({
  mode: 'tiles', base: 0, perTile: 258, tilePx: 768, smallImagePx: 384, fitPx: undefined, shortestSidePx: undefined, lowDetailTokens: undefined,
});

const CATALOG_ENTRIES: ReadonlyArray<TokenizerCatalogEntry> = Object.freeze([
  {
    family: 'openai:o200k',
    provider: 'openai',
    status: 'verified',
    tokenizerName: 'tiktoken-o200k_base',
    encoding: 'o200k_base',
    license: 'MIT',
    provenance: 'js-tiktoken@1.0.21',
    version: '1.0.21',
    multimodalSupport: true,
    match: ['^(gpt-4o|chatgpt-4o|gpt-4\\.1|gpt-4\\.5|gpt-5|o1|o3|o4)(\\b|[-.])', '^openai/(gpt-4o|chatgpt-4o|gpt-4\\.1|gpt-5|o1|o3|o4)(\\b|[-.])'],
    framing: OPENAI_FRAMING,
    media: Object.freeze([
      Object.freeze({ id: 'openai-vision-tiles-v1', kind: 'image' as const, provenance: OPENAI_VISION_SOURCE, confidence: 'medium' as const, image: OPENAI_VISION_TILES,
        models: Object.freeze(['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4.1', 'gpt-4.1-2025-04-14']) }),
      Object.freeze({ id: 'openai-4o-mini-tiles-2024-07-18-v1', kind: 'image' as const, provenance: OPENAI_VISION_SOURCE, confidence: 'medium' as const, image: OPENAI_VISION_MINI_TILES,
        models: Object.freeze(['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']) }),
      Object.freeze({ id: 'openai-4.1-mini-patches-2025-04-14-v1', kind: 'image' as const, provenance: OPENAI_VISION_SOURCE, confidence: 'medium' as const, image: OPENAI_VISION_PATCHES,
        models: Object.freeze(['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14']) }),
    ]),
    limitation: null,
  },
  {
    family: 'openai:cl100k',
    provider: 'openai',
    status: 'verified',
    tokenizerName: 'tiktoken-cl100k_base',
    encoding: 'cl100k_base',
    license: 'MIT',
    provenance: 'js-tiktoken@1.0.21',
    version: '1.0.21',
    multimodalSupport: true,
    match: ['^(gpt-4|gpt-3\\.5|text-embedding-ada|text-embedding-3)(\\b|[-.])', '^openai/(gpt-4|gpt-3\\.5|text-embedding)(\\b|[-.])'],
    framing: OPENAI_FRAMING,
    media: Object.freeze([
      Object.freeze({ id: 'openai-vision-tiles-v1', kind: 'image' as const, provenance: 'OpenAI vision guide "calculating costs" (gpt-4-turbo/gpt-4-vision: 85 base + 170 per 512px tile)', confidence: 'medium' as const, image: OPENAI_VISION_TILES }),
    ]),
    limitation: null,
  },
  {
    family: 'anthropic:claude',
    provider: 'anthropic',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'Anthropic tokenizer is not published as an offline artifact; the hosted count_tokens API is a paid/remote path this proxy never calls automatically',
    version: 'none',
    multimodalSupport: false,
    match: ['^(anthropic/)?claude(\\b|[-.])'],
    framing: null,
    media: Object.freeze([
      Object.freeze({ id: 'anthropic-image-wh750-v1', kind: 'image' as const, provenance: 'Anthropic vision docs: image tokens ≈ (width px × height px) / 750', confidence: 'medium' as const, image: ANTHROPIC_IMAGE }),
    ]),
    limitation: 'No offline tokenizer; text falls back to labeled chars/4. Image media uses the documented w*h/750 formula only when pixel dimensions are locally measurable.',
  },
  {
    family: 'google:gemini',
    provider: 'gemini',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'Gemini SentencePiece vocabulary is a downloadable artifact; zero-download policy forbids fetching it at runtime',
    version: 'none',
    multimodalSupport: false,
    match: ['^(google/)?gemini(\\b|[-.])', '^gemma'],
    framing: null,
    media: Object.freeze([
      Object.freeze({ id: 'gemini-image-258-v1', kind: 'image' as const, provenance: 'Gemini API tokens doc: 258 tokens per image (tiled at 768px; small images ≤384px count as one tile)', confidence: 'low' as const, image: GEMINI_IMAGE }),
      Object.freeze({ id: 'gemini-audio-32ps-v1', kind: 'audio' as const, provenance: 'Gemini API tokens doc: audio ≈ 32 tokens per second', confidence: 'low' as const, audioTokensPerSecond: 32 }),
      Object.freeze({ id: 'gemini-video-258pf-v1', kind: 'video' as const, provenance: 'Gemini API tokens doc: video frames ≈ 258 tokens per frame at 1 fps default sampling', confidence: 'low' as const, videoTokensPerFrame: 258, videoDefaultFps: 1 }),
    ]),
    limitation: 'No offline tokenizer; text falls back to labeled chars/4. Media formulas are documented constants with low confidence, applied only with locally measurable dimensions/durations.',
  },
  {
    family: 'qwen',
    provider: 'qwen',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'Qwen2 vocab is a tiktoken-derived BPE with a different merge table; cl100k would be an approximation, not a count',
    version: 'none',
    multimodalSupport: false,
    match: ['^(qwen[/.-]|qwen$)', '.*[/-]qwen(\\b|[-.])'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'Qwen BPE vocab not vendored; exact counting would require shipping tokenizer.json (license/size review pending).',
  },
  {
    family: 'deepseek',
    provider: 'deepseek',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'DeepSeek BBPE 128k vocab not vendored offline',
    version: 'none',
    multimodalSupport: false,
    match: ['^deepseek[/.-]', '^deepseek$'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'Tokenizer artifact not vendored; heuristic is labeled, never exact.',
  },
  {
    family: 'llama',
    provider: 'meta',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'Llama-3 SentencePiece 128k BPE vocab not vendored offline',
    version: 'none',
    multimodalSupport: false,
    match: ['^(meta-llama[/.-])', '(^|[/.-])llama[-.]?(\\d|3[.-])', '^llama3', '[/.-]llama-3'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'Local runtimes (ollama/vllm) may expose live /tokenize; see measureWithLocalTokenizer for the opt-in verified local path.',
  },
  {
    family: 'mistral',
    provider: 'mistral',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'Mistral tekken tokenizer is Rust-based (mistral-common); no pure-JS offline artifact vendored',
    version: 'none',
    multimodalSupport: false,
    match: ['^(mistral|mixtral|codestral|pixtral)(\\b|[-.])', '^mistralai[/.-]'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'tekken vocabulary not vendored; heuristic is labeled, never exact.',
  },
  {
    family: 'openai:gpt-oss',
    provider: 'openai',
    status: 'heuristic',
    tokenizerName: 'unavailable-offline',
    license: 'n/a',
    provenance: 'gpt-oss ships its own harmony-format tokenizer; no offline rank table is vendored and parity with o200k_base/cl100k_base is unverified — reusing those encodings would be a guess, not a count',
    version: 'none',
    multimodalSupport: false,
    match: ['^gpt-oss(\\b|[-.])', '^openai/gpt-oss(\\b|[-.])'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'Explicit family (not universal fallback) so groq-preset gpt-oss ids resolve deterministically; labeled chars/4 until a licensed artifact with vectors lands.',
  },
  {
    family: 'universal:heuristic',
    provider: 'unknown',
    status: 'heuristic',
    tokenizerName: 'uptokey-conservative-chars4',
    license: 'AGPL-3.0-or-later',
    provenance: 'proxy-local/token-estimate.ts',
    version: 'chars4-v1',
    multimodalSupport: false,
    match: ['.*'],
    framing: null,
    media: Object.freeze([]),
    limitation: 'Fallback for unrecognized families: conservative chars/4 over the exact serialized payload.',
  },
]);

export function listTokenizerCatalog(): ReadonlyArray<TokenizerCatalogEntry> {
  return CATALOG_ENTRIES;
}

/** Normalize model id: lowercase, strip provider prefix (openrouter-style "vendor/model"). */
export function normalizeModelId(modelName: string): string {
  const norm = (modelName || '').toLowerCase().trim();
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

export function resolveTokenizerEntry(modelName: string): TokenizerCatalogEntry {
  const norm = (modelName || '').toLowerCase().trim();
  const bare = normalizeModelId(modelName);
  for (const entry of CATALOG_ENTRIES) {
    for (const pattern of entry.match) {
      if (new RegExp(pattern, 'i').test(norm) || new RegExp(pattern, 'i').test(bare)) return entry;
    }
  }
  return CATALOG_ENTRIES[CATALOG_ENTRIES.length - 1]!;
}

/** Provider labels inferred from an explicit id prefix. Bare ids infer nothing. */
const ID_PREFIX_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  'meta-llama': 'meta',
  mistralai: 'mistral',
  deepseek: 'deepseek',
  qwen: 'qwen',
  openrouter: 'openrouter-gateway',
  together: 'together',
  cerebras: 'cerebras',
  groq: 'groq',
  ollama: 'ollama',
  vllm: 'vllm',
});

/**
 * Layered identity resolution: explicit prefix (provider or gateway) → known
 * catalog family → unknown. Deterministic first-match; the catalog holds
 * families, never exact model ids, so no fabricated exact match is possible.
 */
export function resolveModelIdentity(modelName: string): ModelIdentity {
  const raw = typeof modelName === 'string' ? modelName : '';
  const norm = raw.toLowerCase().trim();
  const bare = normalizeModelId(raw);
  const slash = norm.indexOf('/');
  let provider: string | null = null;
  let aliasKind: ModelIdentity['aliasKind'] = 'none';
  if (slash > 0) {
    const prefix = norm.slice(0, slash);
    provider = ID_PREFIX_PROVIDERS[prefix] ?? null;
    aliasKind = prefix === 'openrouter' ? 'gateway-prefix' : 'provider-prefix';
  }
  const entry = resolveTokenizerEntry(raw);
  const resolution: ModelIdentity['resolution'] = entry.family === 'universal:heuristic' ? 'unknown' : 'family';
  const warning =
    resolution === 'unknown'
      ? 'unrecognized_model_family'
      : entry.status === 'heuristic'
        ? `heuristic_family:${entry.family}`
        : null;
  return { raw, bare, provider, aliasKind, resolution, family: entry.family, warning };
}

/* ------------------------------------------------- effective encoder material */
//
// Counting and verifier encoder objects are constructed from the SAME imported
// rank objects whose full content is snapshotted and digested here, so the audit
// identity is bound to the material actually consumed by the encoder — BPE rank
// table, segmentation expression and special-token map — instead of to sampled
// probe counts alone. The rank fields (`pat_str`, `special_tokens`, `bpe_ranks`)
// are the library's public TiktokenBPE constructor contract, not `@internal`
// instance state. A rank changed anywhere (inside or outside the frozen probes)
// changes both the count and the profile identity for that encoder. No catalog
// bump: ranks, counts and the historical probe digest are unchanged.

export interface TiktokenRankMaterial {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

/** Explicit contract id for the effective-material digest (separate from the historical digest). */
export const TOKENIZER_MATERIAL_CONTRACT = 'uptokey:tiktoken-bpe-material/v1';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Digest of the effective counting material: the complete BPE rank table, the
 * segmentation expression and the special-token map, in canonical order. Pure
 * over the public constructor shape, so it can be recomputed by an auditor from
 * the same artifact the encoder consumes; the historical probe-based digest
 * remains available separately through `tokenizerArtifactDigest`.
 */
export function tokenizerMaterialDigest(ranks: TiktokenRankMaterial): { readonly ranksDigest: string; readonly materialDigest: string } {
  const ranksDigest = sha256Hex(ranks.bpe_ranks);
  const specialTokens = Object.entries(ranks.special_tokens).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const materialDigest = sha256Hex(JSON.stringify([TOKENIZER_MATERIAL_CONTRACT, ranksDigest, ranks.pat_str, specialTokens]));
  return { ranksDigest, materialDigest };
}

interface EffectiveTokenizerMaterial {
  readonly encoding: TokenizerEncoding;
  readonly patStr: string;
  readonly specialTokens: Readonly<Record<string, number>>;
  readonly ranksDigest: string;
  readonly materialDigest: string;
  createEncoder(): Tiktoken;
}

const tokenizerMaterials = new Map<TokenizerEncoding, EffectiveTokenizerMaterial>();

function effectiveMaterial(encoding: TokenizerEncoding): EffectiveTokenizerMaterial {
  const cached = tokenizerMaterials.get(encoding);
  if (cached) return cached;
  const source: TiktokenRankMaterial = encoding === 'o200k_base' ? o200kRanks : cl100kRanks;
  // Snapshot once and build every encoder from this frozen copy: a mutation of
  // the imported module object afterwards cannot desync count from identity.
  const snapshot: TiktokenRankMaterial = {
    pat_str: source.pat_str,
    special_tokens: { ...source.special_tokens },
    bpe_ranks: source.bpe_ranks,
  };
  Object.freeze(snapshot.special_tokens);
  Object.freeze(snapshot);
  const { ranksDigest, materialDigest } = tokenizerMaterialDigest(snapshot);
  const material: EffectiveTokenizerMaterial = Object.freeze({
    encoding,
    patStr: snapshot.pat_str,
    specialTokens: snapshot.special_tokens,
    ranksDigest,
    materialDigest,
    createEncoder: () => new Tiktoken(snapshot),
  });
  tokenizerMaterials.set(encoding, material);
  return material;
}

let o200kInstance: Tiktoken | null = null;
let cl100kInstance: Tiktoken | null = null;
let o200kVerifierInstance: Tiktoken | null = null;
let cl100kVerifierInstance: Tiktoken | null = null;

// Counter and verifier hold distinct Tiktoken objects built from the same frozen
// material snapshot. The verifier recounts through its separate object so
// singleton state corruption on the counting path cannot mask itself, and
// structural invariants (non-empty ⇒ count ≥ 1; count ≤ UTF-8 bytes) provide
// logic independent of the BPE tables. A second, vendor-distinct engine would
// require shipping third-party vocabularies (Anthropic/Gemini/Qwen/Llama/Mistral);
// see each catalog entry's limitation for why no offline artifact is vendored.
function encoderFor(encoding: TokenizerEncoding): Tiktoken {
  if (encoding === 'o200k_base') {
    if (!o200kInstance) o200kInstance = effectiveMaterial(encoding).createEncoder();
    return o200kInstance;
  }
  if (!cl100kInstance) cl100kInstance = effectiveMaterial(encoding).createEncoder();
  return cl100kInstance;
}

function verifierFor(encoding: TokenizerEncoding): Tiktoken {
  if (encoding === 'o200k_base') {
    if (!o200kVerifierInstance) o200kVerifierInstance = effectiveMaterial(encoding).createEncoder();
    return o200kVerifierInstance;
  }
  if (!cl100kVerifierInstance) cl100kVerifierInstance = effectiveMaterial(encoding).createEncoder();
  return cl100kVerifierInstance;
}

/* ------------------------------------------- frozen tokenizer vectors (Fase C) */

export interface TokenizerVector { readonly text: string; readonly o200k: number; readonly cl100k: number; }

/**
 * Frozen artifact-integrity vectors for the two vendored offline encodings.
 * Counts were recorded from js-tiktoken@1.0.21 and frozen here: any rank-table
 * drift, silent upgrade or corrupted bundle fails verifyTokenizerVectors()
 * deterministically on Node and Bun. These vectors pin the ARTIFACT (detecting
 * change), they do not certify vendor provenance by themselves — provenance
 * rests on the pinned MIT dependency plus the public cookbook framing
 * constants, and the live second path is provider-reported reconciliation
 * (token-calibration.ts), never a second call to the same ranks.
 */
export const TOKENIZER_VECTOR_SET_ID = 'uptokey:tokenizer-vectors/v1';

const TOKENIZER_VECTORS: readonly TokenizerVector[] = Object.freeze([
  { text: 'Hello world', o200k: 2, cl100k: 2 },
  { text: 'The quick brown fox jumps over the lazy dog.', o200k: 10, cl100k: 10 },
  { text: '😊😊😊 hello world 1234567890 antidisestablishmentarianism', o200k: 16, cl100k: 19 },
  { text: 'Você é um assistente prestativo e conciso.', o200k: 11, cl100k: 12 },
  { text: 'console.log("uptokey"); // token probe', o200k: 10, cl100k: 10 },
  { text: '{"city":"Paris","temp":21}', o200k: 9, cl100k: 9 },
  { text: 'Tokenização: çéñü — 漢字テスト 🚀', o200k: 15, cl100k: 17 },
  { text: 'a', o200k: 1, cl100k: 1 },
  { text: 'Anthropic Claude versus OpenAI GPT framing comparison probe 42.', o200k: 13, cl100k: 14 },
  { text: 'Supercalifragilisticexpialidocious tokenizer discrimination probe 42', o200k: 15, cl100k: 16 },
]);

export function listTokenizerVectors(): readonly TokenizerVector[] { return TOKENIZER_VECTORS; }

const artifactDigests = new Map<string, string>();

/** Identity key for artifact memos: encoding + declared tokenizer name/version (never encoding alone). */
function identityCacheKey(encoding: TokenizerEncoding, tokenizerName: string, tokenizerVersion: string): string {
  return `${encoding}\u0000${tokenizerName}\u0000${tokenizerVersion}`;
}

/** Bounded insert (FIFO eviction at TOKEN_LIMITS.maxCacheEntries) for artifact memos. */
function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= TOKEN_LIMITS.maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/**
 * Historical integrity digest of a counting artifact: catalog version,
 * tokenizer id@version and the full frozen vector set. Verified families pin a
 * digest; the heuristic fallback has no artifact (null). A catalog bump re-keys
 * it. This value is frozen for existing consumers and is NOT derived from the
 * encoder instance — the effective-material identity lives in
 * `tokenizerArtifactProfile().materialDigest`. Memoized per complete identity
 * (encoding + tokenizer name + version), bounded.
 */
export function tokenizerArtifactDigest(encoding: TokenizerEncoding, tokenizerName: string, tokenizerVersion: string): string {
  const cacheKey = identityCacheKey(encoding, tokenizerName, tokenizerVersion);
  const cached = artifactDigests.get(cacheKey);
  if (cached !== undefined) return cached;
  const canonical = JSON.stringify({
    catalog: TOKEN_CATALOG_VERSION,
    vectors: TOKENIZER_VECTOR_SET_ID,
    encoding,
    tokenizer: `${tokenizerName}@${tokenizerVersion}`,
    probes: TOKENIZER_VECTORS.map((v) => [v.text, encoding === 'o200k_base' ? v.o200k : v.cl100k]),
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  setBounded(artifactDigests, cacheKey, digest);
  return digest;
}

/**
 * Verifies the vendored rank tables against the frozen vectors using FRESH
 * encoder objects built from the same effective material the counter consumes
 * (never the counting/verifier singletons) so singleton state or a swapped
 * encoder cannot mask artifact corruption. Returns false (never throws).
 */
export function verifyTokenizerVectors(): boolean {
  try {
    const o200kFresh = effectiveMaterial('o200k_base').createEncoder();
    const cl100kFresh = effectiveMaterial('cl100k_base').createEncoder();
    for (const vector of TOKENIZER_VECTORS) {
      if (o200kFresh.encode(vector.text).length !== vector.o200k) return false;
      if (cl100kFresh.encode(vector.text).length !== vector.cl100k) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- machine-readable capabilities (single source) */

/** Text-counting capability of one catalog family, derived from its entry. */
export interface TokenizerFamilyCapabilities {
  readonly family: string;
  readonly provider: string;
  readonly status: TokenizerStatus;
  /** exact-offline only for verified BPE families; every other family is labeled heuristic. */
  readonly text: 'exact-offline' | 'heuristic-chars4';
  readonly tokenizerName: string;
  readonly encoding: TokenizerEncoding | null;
  readonly media: readonly { readonly kind: 'image' | 'audio' | 'video'; readonly formulaId: string; readonly confidence: TokenConfidence; readonly models: readonly string[] | null }[];
  readonly framing: MessageFraming | null;
  readonly limitation: string | null;
}

/**
 * Capabilities for every catalog family, built from CATALOG_ENTRIES (the same
 * source the resolver uses), so clients never maintain a parallel model table.
 * An OpenAI-compatible wire format never implies an OpenAI tokenizer here:
 * only families with status 'verified' and an offline encoding count exactly.
 */
export function describeTokenizerCapabilities(): readonly TokenizerFamilyCapabilities[] {
  return CATALOG_ENTRIES.map((entry) => ({
    family: entry.family,
    provider: entry.provider,
    status: entry.status,
    text: entry.status === 'verified' && (entry.encoding === 'o200k_base' || entry.encoding === 'cl100k_base') ? 'exact-offline' : 'heuristic-chars4',
    tokenizerName: entry.tokenizerName,
    encoding: entry.encoding ?? null,
    media: entry.media.map((formula) => ({ kind: formula.kind, formulaId: formula.id, confidence: formula.confidence, models: formula.models ? [...formula.models] : null })),
    framing: entry.framing,
    limitation: entry.limitation,
  }));
}

/* ------------------------- effective-material artifact profile (profile v2) */

const SPECIAL_TOKEN_PROBES: readonly string[] = Object.freeze(['<|endoftext|>', '<|fim_prefix|>', '<|im_start|>']);

/** Version of the profile contract; bumps when the profile identity changes shape. */
export const TOKENIZER_PROFILE_VERSION = 'uptokey:tokenizer-artifact-profile/v2';

export interface TokenizerSpecialTokenProbe {
  readonly marker: string;
  /** Effective special-token id in the consumed material; null when the marker is ordinary text there. */
  readonly id: number | null;
  readonly allowedLength: number | null;
}

/**
 * Hardened artifact profile: binds the audit identity to the EFFECTIVE counting
 * material consumed by the encoder. Extends (never replaces) the historical
 * probe digest, whose values stay frozen for existing consumers:
 * - `digest`/`digestContract` — historical v1 digest (catalog + frozen vectors).
 * - `materialDigest`/`materialContract`/`ranksDigest`/`segmentation` — v2 identity
 *   derived from the complete BPE rank table, the segmentation expression and
 *   the special-token map actually used to build the encoder, so a rank changed
 *   outside the frozen probes changes the profile.
 * - `specialTokens` — behavior probes against the live encoder, now carrying the
 *   effective special-token id as well.
 * - `framing` — documented chat framing constants.
 * `profileDigest` covers all of the above. Results are frozen and memoized per
 * (material, encoding, tokenizer name, version) within a bounded cache; a
 * mutation attempt cannot contaminate later calls.
 */
export interface TokenizerArtifactProfile {
  readonly profileVersion: string;
  readonly encoding: TokenizerEncoding;
  readonly tokenizer: string;
  readonly digest: string;
  readonly digestContract: 'uptokey:tokenizer-artifact-digest/v1';
  readonly materialDigest: string;
  readonly materialContract: string;
  readonly ranksDigest: string;
  readonly segmentation: string;
  readonly vectorSetId: string;
  readonly vectorCount: number;
  readonly framing: MessageFraming | null;
  readonly specialTokens: readonly TokenizerSpecialTokenProbe[];
  readonly profileDigest: string;
}

const artifactProfiles = new Map<string, TokenizerArtifactProfile>();

export function tokenizerArtifactProfile(encoding: TokenizerEncoding, tokenizerName: string, tokenizerVersion: string): TokenizerArtifactProfile {
  const material = effectiveMaterial(encoding);
  // Full identity in the key: name and version never alias another tokenizer's digest/profile.
  const cacheKey = `${material.materialDigest}\u0000${identityCacheKey(encoding, tokenizerName, tokenizerVersion)}`;
  const cached = artifactProfiles.get(cacheKey);
  if (cached) return cached;
  const digest = tokenizerArtifactDigest(encoding, tokenizerName, tokenizerVersion);
  const framing = encoding === 'o200k_base' || encoding === 'cl100k_base' ? OPENAI_FRAMING : null;
  const encoder = material.createEncoder();
  const specialTokens = Object.freeze(SPECIAL_TOKEN_PROBES.map((marker) => {
    const rawId = material.specialTokens[marker];
    const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? rawId : null;
    let allowedLength: number | null = null;
    try {
      const length = encoder.encode(marker, 'all').length;
      if (Number.isSafeInteger(length)) allowedLength = length;
    } catch {
      allowedLength = null;
    }
    return Object.freeze({ marker, id, allowedLength });
  }));
  const profileDigest = createHash('sha256').update(JSON.stringify({
    profile: TOKENIZER_PROFILE_VERSION,
    digest,
    material: material.materialDigest,
    materialContract: TOKENIZER_MATERIAL_CONTRACT,
    tokenizer: `${tokenizerName}@${tokenizerVersion}`,
    framing,
    specialTokens,
  }), 'utf8').digest('hex');
  const profile: TokenizerArtifactProfile = Object.freeze({
    profileVersion: TOKENIZER_PROFILE_VERSION,
    encoding,
    tokenizer: `${tokenizerName}@${tokenizerVersion}`,
    digest,
    digestContract: 'uptokey:tokenizer-artifact-digest/v1',
    materialDigest: material.materialDigest,
    materialContract: TOKENIZER_MATERIAL_CONTRACT,
    ranksDigest: material.ranksDigest,
    segmentation: material.patStr,
    vectorSetId: TOKENIZER_VECTOR_SET_ID,
    vectorCount: TOKENIZER_VECTORS.length,
    framing,
    specialTokens,
    profileDigest,
  });
  setBounded(artifactProfiles, cacheKey, profile);
  return profile;
}

/* ----------------------------------------- auditable local metrics (no content) */

export interface TokenMetricsSnapshot {
  readonly schemaVersion: 1;
  readonly catalogVersion: string;
  readonly basis: 'process_local_since_start';
  readonly measurements: number;
  readonly byState: Readonly<Record<TokenizerStatus, number>>;
  readonly byBasis: Readonly<Record<string, number>>;
  readonly cache: { readonly entries: number; readonly hits: number; readonly misses: number; readonly evictions: number };
  readonly verifier: { readonly checked: number; readonly matched: number; readonly mismatched: number };
  readonly rejected: Readonly<Record<string, number>>;
}

const METRICS_STATE: TokenizerStatus[] = ['verified', 'partial', 'heuristic', 'unknown', 'unavailable'];
const metrics = {
  measurements: 0,
  byState: Object.fromEntries(METRICS_STATE.map((s) => [s, 0])) as Record<TokenizerStatus, number>,
  byBasis: Object.create(null) as Record<string, number>,
  cacheHits: 0,
  cacheMisses: 0,
  cacheEvictions: 0,
  verifierChecked: 0,
  verifierMatched: 0,
  verifierMismatched: 0,
  rejected: Object.create(null) as Record<string, number>,
};

function saturatingInc(value: number): number { return value >= Number.MAX_SAFE_INTEGER ? value : value + 1; }

export function tokenMetricsSnapshot(): TokenMetricsSnapshot {
  return {
    schemaVersion: 1,
    catalogVersion: TOKEN_CATALOG_VERSION,
    basis: 'process_local_since_start',
    measurements: metrics.measurements,
    byState: { ...metrics.byState },
    byBasis: { ...metrics.byBasis },
    cache: { entries: TOKEN_COUNT_CACHE.size, hits: metrics.cacheHits, misses: metrics.cacheMisses, evictions: metrics.cacheEvictions },
    verifier: { checked: metrics.verifierChecked, matched: metrics.verifierMatched, mismatched: metrics.verifierMismatched },
    rejected: { ...metrics.rejected },
  };
}

/** Test hook: resets the in-process metrics and the count cache. Never called in production paths. */
export function resetTokenMetricsForTests(): void {
  metrics.measurements = 0;
  for (const s of METRICS_STATE) metrics.byState[s] = 0;
  metrics.byBasis = Object.create(null);
  metrics.cacheHits = 0; metrics.cacheMisses = 0; metrics.cacheEvictions = 0;
  metrics.verifierChecked = 0; metrics.verifierMatched = 0; metrics.verifierMismatched = 0;
  metrics.rejected = Object.create(null);
  TOKEN_COUNT_CACHE.clear();
}

/* ----------------------------------------- digest-keyed bounded count cache */

const TOKEN_COUNT_CACHE = new Map<string, number>();

function digestKey(tokenizerName: string, tokenizerVersion: string, text: string): string {
  // Full-payload SHA-256 plus catalog + tokenizer identity: colliding prefixes or equal
  // lengths can never alias two distinct payloads to one cached count.
  return `${TOKEN_CATALOG_VERSION}|${tokenizerName}@${tokenizerVersion}|${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function cachedEncodeCount(encoder: Tiktoken, text: string, key: string): number {
  const cached = TOKEN_COUNT_CACHE.get(key);
  if (cached !== undefined) { metrics.cacheHits = saturatingInc(metrics.cacheHits); return cached; }
  metrics.cacheMisses = saturatingInc(metrics.cacheMisses);
  const count = encoder.encode(text).length;
  if (TOKEN_COUNT_CACHE.size >= TOKEN_LIMITS.maxCacheEntries) {
    const firstKey = TOKEN_COUNT_CACHE.keys().next().value;
    if (firstKey !== undefined) { TOKEN_COUNT_CACHE.delete(firstKey); metrics.cacheEvictions = saturatingInc(metrics.cacheEvictions); }
  }
  TOKEN_COUNT_CACHE.set(key, count);
  return count;
}

/** Test/diagnostic hook: current cache occupancy. */
export function tokenCountCacheSize(): number { return TOKEN_COUNT_CACHE.size; }

/* ------------------------------------------------------------ multimodality */

const MEDIA_PART_TYPES = new Set(['image_url', 'image', 'input_image', 'audio', 'input_audio', 'video', 'input_video', 'file']);

export function hasMultimodalParts(request: ChatCompletionRequest): boolean {
  if (!Array.isArray(request.messages)) return false;
  for (const msg of request.messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && 'type' in part) {
          if (MEDIA_PART_TYPES.has(String((part as { type: unknown }).type))) return true;
        }
      }
    }
  }
  return false;
}

export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1_024;

/* --------------------------------------------------------- image dimensions */

interface ImageDimensions { width: number; height: number }

function u32be(buf: Uint8Array, off: number): number {
  return ((buf[off]! * 0x1000000) + ((buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!)) >>> 0;
}

/** Parse pixel dimensions from raw image bytes (PNG/GIF/JPEG). Bounded scan; null when unknown. */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) return null;
  // PNG: 8-byte signature, IHDR length+type, then width/height big-endian at offset 16.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = u32be(bytes, 16), height = u32be(bytes, 20);
    return width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000 ? { width, height } : null;
  }
  // GIF87a/89a: width/height little-endian u16 at offsets 6/8.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes[6]! | (bytes[7]! << 8), height = bytes[8]! | (bytes[9]! << 8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: scan SOF0..SOF15 markers (excluding DHT/DAC/RST), bounded to first 64 KiB.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const limit = Math.min(bytes.length, 65_536);
    let off = 2;
    while (off + 9 < limit) {
      if (bytes[off] !== 0xff) { off += 1; continue; }
      const marker = bytes[off + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[off + 5]! << 8) | bytes[off + 6]!;
        const width = (bytes[off + 7]! << 8) | bytes[off + 8]!;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      const segLen = (bytes[off + 2]! << 8) | bytes[off + 3]!;
      if (segLen < 2) return null;
      off += 2 + segLen;
    }
    return null;
  }
  return null;
}

const MAX_BASE64_DECODE_BYTES = 64 * 1024;

function decodeDataUrlPrefix(url: string): Uint8Array | null {
  const match = /^data:image\/(png|gif|jpe?g);base64,([A-Za-z0-9+/=\r\n]+)/.exec(url);
  if (!match) return null;
  try {
    const b64 = match[2]!.replace(/[\r\n]/g, '');
    const buf = Buffer.from(b64.slice(0, Math.ceil(MAX_BASE64_DECODE_BYTES / 3) * 4), 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.length, MAX_BASE64_DECODE_BYTES));
  } catch { return null; }
}

/* ------------------------------------------------------------- media formulas */

function applyImageFormula(image: NonNullable<MediaFormula['image']>, dims: ImageDimensions, detail: string | null): number | null {
  if (detail !== null && !['low', 'high', 'auto'].includes(detail)) return null;
  if (image.mode === 'patches') {
    if (!image.tilePx || !image.patchBudget || !image.multiplier) return null;
    let { width, height } = dims;
    const fit = image.fitPx ? Math.min(1, image.fitPx / Math.max(width, height)) : 1;
    width = Math.max(1, Math.floor(width * fit)); height = Math.max(1, Math.floor(height * fit));
    const tile = image.tilePx;
    if (Math.ceil(width / tile) * Math.ceil(height / tile) > image.patchBudget) {
      const shrink = Math.sqrt(tile * tile * image.patchBudget / (width * height));
      const adjusted = shrink * Math.min(Math.floor(width * shrink / tile) / (width * shrink / tile), Math.floor(height * shrink / tile) / (height * shrink / tile));
      width = Math.max(1, Math.floor(width * adjusted)); height = Math.max(1, Math.floor(height * adjusted));
    }
    const patches = Math.ceil(width / tile) * Math.ceil(height / tile);
    if (patches > image.patchBudget) return null;
    return Math.ceil(patches * image.multiplier);
  }
  if (detail === 'low') return image.lowDetailTokens ?? null;
  if (image.mode === 'flat') return image.flatTokens ?? null;
  if (image.mode === 'wh_ratio') {
    if (!image.divisor) return null;
    const tokens = Math.ceil((dims.width * dims.height) / image.divisor);
    return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
  }
  // tiles mode
  let { width, height } = dims;
  if (image.smallImagePx && width <= image.smallImagePx && height <= image.smallImagePx) {
    return (image.base ?? 0) + (image.perTile ?? 0);
  }
  if (image.fitPx) {
    const largest = Math.max(width, height);
    if (largest > image.fitPx) {
      const scale = image.fitPx / largest;
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }
  }
  if (image.shortestSidePx) {
    const shortest = Math.min(width, height);
    if (shortest > image.shortestSidePx) {
      const scale = image.shortestSidePx / shortest;
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }
  }
  const tile = image.tilePx ?? 0;
  if (tile <= 0 || width <= 0 || height <= 0) return null;
  const tiles = Math.ceil(width / tile) * Math.ceil(height / tile);
  const tokens = (image.base ?? 0) + (image.perTile ?? 0) * tiles;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

/* ------------------------------------------------------- payload decomposition */

interface DecomposedPart {
  readonly kind: 'text' | 'image' | 'audio' | 'video' | 'file';
  readonly text?: string;
  readonly mediaKind?: 'image' | 'audio' | 'video';
  readonly dims?: ImageDimensions | null;
  readonly detail?: string | null;
  readonly durationSeconds?: number | null;
  readonly index: number;
}

interface DecomposedRequest {
  readonly roles: readonly string[];
  readonly names: readonly string[];
  readonly textSegments: readonly string[];
  readonly toolCallSegments: readonly string[];
  readonly toolsJson: string | null;
  readonly responseFormatJson: string | null;
  readonly media: readonly DecomposedPart[];
  readonly uncountable: readonly UncountablePart[];
  readonly messagesCounted: number;
  readonly flags: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COUNTED_ENVELOPE_FIELDS = new Set(['messages', 'system', 'tools', 'functions', 'response_format', 'model']);
const CONTROL_ENVELOPE_FIELDS = new Set([
  'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n', 'seed',
  'presence_penalty', 'frequency_penalty', 'logprobs', 'top_logprobs', 'parallel_tool_calls', 'user', 'store', 'data_collection',
]);

/**
 * System content that the catalog does not count. A plain string and an array of
 * plain-text blocks ('text'/'input_text' with a string `text`) are counted by
 * `decomposeRequest`; every other form (non-text blocks, malformed entries, an
 * object/number body) is returned verbatim so the reservation keeps partial
 * coverage instead of silently dropping those bytes. Mirrors the counting rules
 * in decomposeRequest so the catalog and the reservation describe the same fields.
 */
function extractUncountedSystem(system: unknown): unknown {
  if (system === undefined || system === null || typeof system === 'string') return null;
  if (Array.isArray(system)) {
    const extra: unknown[] = [];
    system.forEach((part, index) => {
      if (typeof part === 'string') return;
      if (isRecord(part)) {
        const type = typeof part.type === 'string' ? part.type : '';
        if ((type === 'text' || type === 'input_text') && typeof part.text === 'string') return;
      }
      extra.push({ index, part });
    });
    return extra.length ? extra : null;
  }
  return system;
}

/** One coverage boundary for catalog labels and reservation. Only uncounted fields are returned. */
export function uncoveredEnvelopeJson(request: ChatCompletionRequest): string | null {
  const rest: Record<string, unknown> = Object.fromEntries(Object.entries(request).filter(([key, value]) =>
    value !== undefined && !COUNTED_ENVELOPE_FIELDS.has(key) && !CONTROL_ENVELOPE_FIELDS.has(key) && !key.startsWith('uptokey_')));
  const messages: Array<Record<string, unknown>> = [];
  for (const [index, msg] of (Array.isArray(request.messages) ? request.messages : []).entries()) {
    if (!isRecord(msg)) continue;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(msg)) {
      if (value === undefined || key === 'role' || key === 'content' || key === 'cache_control' || (key === 'name' && typeof value === 'string')) continue;
      if (key === 'tool_calls' && Array.isArray(value)) {
        const calls = value.map(call => {
          if (!isRecord(call)) return call;
          const remaining = { ...call };
          if (isRecord(call.function)) {
            const fn = { ...call.function };
            if (typeof fn.name === 'string') delete fn.name;
            else if (typeof call.name === 'string') delete remaining.name;
            if (typeof fn.arguments === 'string') delete fn.arguments;
            else if (typeof call.arguments === 'string') delete remaining.arguments;
            if (Object.keys(fn).length) remaining.function = fn; else delete remaining.function;
          } else {
            if (typeof call.name === 'string') delete remaining.name;
            if (typeof call.arguments === 'string') delete remaining.arguments;
          }
          return Object.keys(remaining).length ? remaining : null;
        });
        if (calls.some(call => call !== null)) extra[key] = calls;
      } else if (key === 'function_call' && isRecord(value)) {
        const fn = { ...value };
        if (typeof fn.name === 'string') delete fn.name;
        if (typeof fn.arguments === 'string') delete fn.arguments;
        if (Object.keys(fn).length) extra[key] = fn;
      } else extra[key] = value;
    }
    if (Object.keys(extra).length) messages.push({ index, ...extra });
  }
  if (messages.length) rest.messages = messages;
  // `system` is counted only in its string/plain-text-array form; surface every
  // other form so reservation keeps partial coverage instead of dropping it.
  const systemExtra = extractUncountedSystem((request as { system?: unknown }).system);
  if (systemExtra !== null) rest.system = systemExtra;
  return Object.keys(rest).length ? JSON.stringify(rest) : null;
}

function readExplicitDimensions(part: Record<string, unknown>): ImageDimensions | null {
  const w = part.width, h = part.height;
  if (typeof w === 'number' && typeof h === 'number' && Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 && w <= 1_000_000 && h <= 1_000_000) return { width: w, height: h };
  return null;
}

function readDurationSeconds(part: Record<string, unknown>): number | null {
  const d = part.durationSeconds ?? part.duration_seconds;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= 86_400) return d;
  return null;
}

function mediaKindOf(type: string): 'image' | 'audio' | 'video' | 'file' {
  if (type === 'image_url' || type === 'image' || type === 'input_image') return 'image';
  if (type === 'audio' || type === 'input_audio') return 'audio';
  if (type === 'video' || type === 'input_video') return 'video';
  return 'file';
}

/**
 * Detects provider prompt-cache breakpoints (e.g. Anthropic `cache_control` on
 * messages, content parts, system blocks or tools). Cached tokens remain input
 * tokens — the count is unchanged — but breakpoints change pricing and the
 * provider-reported cache accounting, so their presence is flagged for audits.
 * Billing, quotas and receipts always use provider_reported usage, never the
 * local estimate. Bounded scan; never throws.
 */
function hasPromptCacheBreakpoints(request: ChatCompletionRequest): boolean {
  const hasMarker = (value: unknown): boolean =>
    isRecord(value) && 'cache_control' in value && isRecord(value.cache_control);
  try {
    const messages = Array.isArray(request.messages) ? request.messages.slice(0, TOKEN_LIMITS.maxMessages) : [];
    for (const msg of messages) {
      if (!isRecord(msg)) continue;
      if (hasMarker(msg)) return true;
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const part of content) { if (isRecord(part) && hasMarker(part)) return true; }
      } else if (isRecord(content) && hasMarker(content)) return true;
    }
    const system = (request as { system?: unknown }).system;
    if (Array.isArray(system)) {
      for (const part of system) { if (isRecord(part) && hasMarker(part)) return true; }
    } else if (isRecord(system) && hasMarker(system)) return true;
    const tools = (request as { tools?: unknown }).tools;
    if (Array.isArray(tools)) {
      for (const tool of tools.slice(0, 128)) {
        if (!isRecord(tool)) continue;
        if (hasMarker(tool)) return true;
        if (isRecord(tool.function) && hasMarker(tool.function)) return true;
      }
    }
  } catch { return false; }
  return false;
}

function decomposeRequest(request: ChatCompletionRequest): DecomposedRequest {
  const roles: string[] = [];
  const names: string[] = [];
  const textSegments: string[] = [];
  const toolCallSegments: string[] = [];
  const media: DecomposedPart[] = [];
  const uncountable: UncountablePart[] = [];
  const flags: string[] = [];
  let messagesCounted = 0;
  let toolsJson: string | null = null;
  let responseFormatJson: string | null = null;

  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length > TOKEN_LIMITS.maxMessages) {
    uncountable.push({ kind: 'message', reason: 'message_count_limit_exceeded' });
  }
  const bounded = messages.slice(0, TOKEN_LIMITS.maxMessages);

  for (let index = 0; index < bounded.length; index += 1) {
    const msg = bounded[index];
    if (!isRecord(msg)) { uncountable.push({ kind: 'message', reason: 'malformed_message_entry', index }); continue; }
    const role = typeof msg.role === 'string' ? msg.role : 'user';
    roles.push(role);
    const participantName = (msg as Record<string, unknown>).name;
    if (typeof participantName === 'string') names.push(participantName);
    messagesCounted += 1;
    const content = msg.content;
    if (typeof content === 'string') {
      textSegments.push(content);
    } else if (Array.isArray(content)) {
      for (const rawPart of content) {
        if (typeof rawPart === 'string') { textSegments.push(rawPart); continue; }
        if (!isRecord(rawPart)) { uncountable.push({ kind: 'segment', reason: 'malformed_content_part', index }); continue; }
        const type = typeof rawPart.type === 'string' ? rawPart.type : '';
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof rawPart.text === 'string') {
          textSegments.push(rawPart.text);
          continue;
        }
        if (!MEDIA_PART_TYPES.has(type)) {
          // Unknown part types are skipped deterministically, never silently dropped.
          uncountable.push({ kind: 'segment', reason: `unrecognized_part_type:${type.slice(0, 32) || 'missing'}`, index });
          continue;
        }
        if (media.length >= TOKEN_LIMITS.maxMediaParts) {
          uncountable.push({ kind: mediaKindOf(type) === 'file' ? 'file' : mediaKindOf(type), reason: 'media_part_limit_exceeded', index });
          continue;
        }
        const kind = mediaKindOf(type);
        if (kind === 'file') { uncountable.push({ kind: 'file', reason: 'file_part_not_countable', index }); continue; }
        let dims: ImageDimensions | null = null;
        let detail: string | null = null;
        if (kind === 'image') {
          dims = readExplicitDimensions(rawPart);
          const imageUrl = isRecord(rawPart.image_url) ? rawPart.image_url : undefined;
          const url = typeof imageUrl?.url === 'string' ? imageUrl.url : typeof rawPart.url === 'string' ? rawPart.url : null;
          if (!dims && url && url.startsWith('data:')) dims = parseImageDimensions(decodeDataUrlPrefix(url) ?? new Uint8Array(0));
          const rawDetail = typeof imageUrl?.detail === 'string' ? imageUrl.detail : typeof rawPart.detail === 'string' ? rawPart.detail : null;
          detail = rawDetail;
        }
        media.push({ kind, mediaKind: kind, dims, detail, durationSeconds: readDurationSeconds(rawPart), index });
      }
    } else if (content !== null && content !== undefined) {
      uncountable.push({ kind: 'message', reason: 'malformed_content', index });
    }
    // tool_calls on assistant messages (OpenAI shape); arguments are JSON text.
    const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (!isRecord(call)) { uncountable.push({ kind: 'tools', reason: 'malformed_tool_call', index }); continue; }
        const fn = isRecord(call.function) ? call.function : undefined;
        const name = typeof fn?.name === 'string' ? fn.name : typeof call.name === 'string' ? call.name : '';
        const args = typeof fn?.arguments === 'string' ? fn.arguments : typeof call.arguments === 'string' ? call.arguments : '';
        if (name) toolCallSegments.push(name);
        if (args) toolCallSegments.push(args);
      }
    }
    // Legacy single function_call on assistant messages (OpenAI pre-tools shape).
    const functionCall = (msg as { function_call?: unknown }).function_call;
    if (isRecord(functionCall)) {
      if (typeof functionCall.name === 'string' && functionCall.name) toolCallSegments.push(functionCall.name);
      if (typeof functionCall.arguments === 'string' && functionCall.arguments) toolCallSegments.push(functionCall.arguments);
    }
  }

  // Top-level system prompt (Anthropic-style `system` string or text blocks): counted
  // as input text like a system-role message body. It is not a message, so it adds
  // no per-message framing. Non-text system blocks are uncountable, never invented.
  const system = (request as { system?: unknown }).system;
  if (typeof system === 'string') {
    textSegments.push(system);
  } else if (Array.isArray(system)) {
    for (const rawPart of system) {
      if (typeof rawPart === 'string') { textSegments.push(rawPart); continue; }
      if (!isRecord(rawPart)) { uncountable.push({ kind: 'message', reason: 'malformed_system_part' }); continue; }
      const type = typeof rawPart.type === 'string' ? rawPart.type : '';
      if ((type === 'text' || type === 'input_text') && typeof rawPart.text === 'string') { textSegments.push(rawPart.text); continue; }
      uncountable.push({ kind: 'message', reason: `unrecognized_system_part_type:${type.slice(0, 32) || 'missing'}` });
    }
  } else if (system !== undefined && system !== null) {
    uncountable.push({ kind: 'message', reason: 'malformed_system' });
  }

  if (request.tools !== undefined || (request as { functions?: unknown }).functions !== undefined) {
    try {
      toolsJson = JSON.stringify(request.tools ?? (request as { functions?: unknown }).functions ?? null);
      if (toolsJson.length > TOKEN_LIMITS.maxToolsBytes) {
        uncountable.push({ kind: 'tools', reason: 'tools_payload_too_large' });
        toolsJson = null;
      }
    } catch {
      uncountable.push({ kind: 'tools', reason: 'tools_unserializable' });
      toolsJson = null;
    }
  }

  // response_format (e.g. json_schema) is sent to the provider and billed as input
  // like tools, but carries no prompt text of its own — decomposed the same way so
  // the catalog's own breakdown accounts for it instead of leaving it uncounted.
  const responseFormat = (request as { response_format?: unknown }).response_format;
  if (responseFormat !== undefined) {
    try {
      responseFormatJson = JSON.stringify(responseFormat);
      if (responseFormatJson.length > TOKEN_LIMITS.maxResponseFormatBytes) {
        uncountable.push({ kind: 'response_format', reason: 'response_format_payload_too_large' });
        responseFormatJson = null;
      }
    } catch {
      uncountable.push({ kind: 'response_format', reason: 'response_format_unserializable' });
      responseFormatJson = null;
    }
  }

  // Lone surrogates are deterministically replaced by U+FFFD at UTF-8 encode time;
  // flag once so audits know the counted form differs from the raw JS string.
  for (const segment of [...textSegments, ...toolCallSegments, ...names]) {
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(segment)) {
      flags.push('lone_surrogates_replaced');
      break;
    }
  }

  // Prompt-cache breakpoints (e.g. Anthropic cache_control) do not change the input
  // token count — cached tokens remain input tokens — but they change pricing and
  // provider-reported cache accounting, so their presence is flagged for audits.
  if (hasPromptCacheBreakpoints(request)) flags.push('prompt_cache_breakpoint_detected');
  if (uncoveredEnvelopeJson(request) !== null) uncountable.push({ kind: 'message', reason: 'envelope_fields_not_counted' });

  return { roles, names, textSegments, toolCallSegments, toolsJson, responseFormatJson, media, uncountable, messagesCounted, flags };
}

/* --------------------------------------------------------------- measurement */

export interface MeasureOptions {
  readonly now?: () => Date;
  /** Verifier policy: 'auto' re-encodes ~1/8 of distinct digests, 'always' re-encodes every payload, 'off' disables. */
  readonly verify?: 'auto' | 'always' | 'off';
}

/** Engine id for the recount path: an independently held encoder object over the same pinned offline ranks. */
export const TOKEN_VERIFIER_ENGINE_ID = 'tiktoken-independent-instance/v1';

function invalid(reason: string, now: Date, model: string, outputLimit: number | null = null): TokenMeasurement {
  metrics.measurements = saturatingInc(metrics.measurements);
  metrics.byState.unavailable = saturatingInc(metrics.byState.unavailable);
  metrics.rejected[reason] = saturatingInc(metrics.rejected[reason] ?? 0);
  const identity = resolveModelIdentity(model);
  return {
    model, input: null, output: 0, outputBasis: 'default_estimate', outputLimit, basis: 'unknown', state: 'unavailable',
    confidence: null, source: 'uptokey:token-catalog', version: TOKEN_CATALOG_VERSION, catalogVersion: TOKEN_CATALOG_VERSION,
    identity, provider: identity.provider, modelRevision: null,
    tokenizerId: 'undetermined', artifactDigest: null,
    reason, flags: Object.freeze([]), isMultimodal: false, breakdown: null,
    verifier: { status: 'not_applicable', digest: null, engineId: 'not_applicable', vectorId: null }, measuredAt: now.toISOString(),
  };
}

function verifyCount(counter: Tiktoken, verifier: Tiktoken, text: string, cached: number, policy: 'auto' | 'always' | 'off', digest: string): 'matched' | 'skipped' | 'mismatch' {
  const should = policy === 'always' || (policy === 'auto' && (parseInt(digest.slice(-2), 16) & 7) === 0);
  if (!should) return 'skipped';
  metrics.verifierChecked = saturatingInc(metrics.verifierChecked);
  try {
    // Recount through the independent verifier object; a shared-singleton fault on
    // the counting path cannot reproduce itself here. Both objects share the same
    // offline ranks (documented limitation), so structural invariants add a second,
    // rank-independent check: a token is at least one UTF-8 byte, hence count ≤ bytes
    // for tiktoken BPE; a non-empty payload never yields zero tokens.
    void counter;
    const recount = verifier.encode(text).length;
    const bytes = Buffer.byteLength(text, 'utf8');
    const ok = recount === cached && recount > 0 && recount <= bytes;
    if (ok) { metrics.verifierMatched = saturatingInc(metrics.verifierMatched); return 'matched'; }
  } catch { /* fall through to mismatch */ }
  metrics.verifierMismatched = saturatingInc(metrics.verifierMismatched);
  return 'mismatch';
}

function countSegments(
  encoder: Tiktoken,
  verifier: Tiktoken,
  tokenizerKey: string,
  tokenizerVersion: string,
  segments: readonly { label: string; text: string }[],
  verifyPolicy: 'auto' | 'always' | 'off',
): { total: number; verifier: 'matched' | 'skipped' | 'mismatch'; digest: string } | { error: string } {
  let total = 0;
  let verifierStatus: 'matched' | 'skipped' | 'mismatch' = 'skipped';
  let firstDigest: string | null = null;
  for (const segment of segments) {
    if (Buffer.byteLength(segment.text, 'utf8') > TOKEN_LIMITS.maxSegmentBytes) return { error: 'segment_too_large' };
    const key = digestKey(tokenizerKey, tokenizerVersion, segment.text);
    if (firstDigest === null) firstDigest = key;
    let count: number;
    try {
      count = segment.text.length === 0 ? 0 : cachedEncodeCount(encoder, segment.text, key);
    } catch {
      return { error: 'encoder_failed' };
    }
    if (segment.text.length > 0) {
      const verdict = verifyCount(encoder, verifier, segment.text, count, verifyPolicy, key);
      if (verdict === 'mismatch') return { error: 'verifier_disagreement' };
      if (verdict === 'matched') verifierStatus = 'matched';
    }
    total += count;
    if (!Number.isSafeInteger(total)) return { error: 'count_overflow' };
  }
  return { total, verifier: verifierStatus, digest: firstDigest ?? digestKey(tokenizerKey, tokenizerVersion, '') };
}

function countMedia(
  entry: TokenizerCatalogEntry,
  model: string,
  parts: readonly DecomposedPart[],
  uncountable: UncountablePart[],
  flags: string[],
): { mediaTokens: number; mediaCounted: number } {
  let mediaTokens = 0;
  let mediaCounted = 0;
  for (const part of parts) {
    const kind = part.mediaKind!;
    const formulas = entry.media.filter((f) => f.kind === kind && (!f.models || f.models.includes(normalizeModelId(model))));
    if (formulas.length === 0) {
      uncountable.push({ kind, reason: `no_documented_${kind}_formula_for_${entry.provider === 'openai' && kind === 'image' ? 'model' : 'family'}`, index: part.index });
      continue;
    }
    const formula = formulas[0]!;
    let tokens: number | null = null;
    if (kind === 'image') {
      if (part.detail === 'low' && formula.image?.lowDetailTokens !== undefined) {
        tokens = formula.image.lowDetailTokens;
      } else if (!part.dims) {
        uncountable.push({ kind, reason: 'image_dimensions_unavailable', index: part.index });
        continue;
      } else tokens = applyImageFormula(formula.image!, part.dims, part.detail ?? null);
      if (part.detail === null || part.detail === 'auto') flags.push('image_detail_unspecified_assumed_high');
    } else if (kind === 'audio') {
      if (part.durationSeconds === null || part.durationSeconds === undefined || !formula.audioTokensPerSecond) {
        uncountable.push({ kind, reason: 'audio_duration_unavailable', index: part.index });
        continue;
      }
      tokens = Math.ceil(part.durationSeconds * formula.audioTokensPerSecond);
    } else if (kind === 'video') {
      if (part.durationSeconds === null || part.durationSeconds === undefined || !formula.videoTokensPerFrame || !formula.videoDefaultFps) {
        uncountable.push({ kind, reason: 'video_duration_unavailable', index: part.index });
        continue;
      }
      const frames = Math.ceil(part.durationSeconds * formula.videoDefaultFps);
      const audioTokens = formula.audioTokensPerSecond !== undefined ? Math.ceil(part.durationSeconds * formula.audioTokensPerSecond) : 0;
      tokens = frames * formula.videoTokensPerFrame + audioTokens;
    }
    if (tokens === null || !Number.isSafeInteger(tokens) || tokens < 0) {
      uncountable.push({ kind, reason: 'media_formula_not_applicable', index: part.index });
      continue;
    }
    mediaTokens += tokens;
    mediaCounted += 1;
    flags.push(`media_formula:${formula.id}`);
    if (!Number.isSafeInteger(mediaTokens)) return { mediaTokens: 0, mediaCounted };
  }
  return { mediaTokens, mediaCounted };
}

/**
 * Full measurement with provenance. Returns undefined only for invalid declared output
 * budgets (legacy contract); every other failure is an explicit 'unavailable' measurement.
 */
export function measureRequestTokens(request: ChatCompletionRequest, options?: MeasureOptions): TokenMeasurement | undefined {
  const now = options?.now?.() ?? new Date();
  const verifyPolicy = options?.verify ?? 'auto';
  const model = typeof request?.model === 'string' ? request.model : '';

  const declaredOutputs = [request?.max_tokens, request?.max_completion_tokens].filter(
    (value): value is number => value !== undefined,
  );
  if (declaredOutputs.some((value) => !Number.isSafeInteger(value) || value < 1)) return undefined;
  const declaredOutput = declaredOutputs.length > 0 ? Math.max(...declaredOutputs) : undefined;
  const output = declaredOutput ?? DEFAULT_ESTIMATED_OUTPUT_TOKENS;
  const outputBasis: TokenMeasurement['outputBasis'] = declaredOutput !== undefined ? 'declared_limit' : 'default_estimate';

  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    return invalid('unserializable_payload', now, model);
  }
  if (!serialized) return invalid('empty_payload', now, model);
  if (Buffer.byteLength(serialized, 'utf8') > TOKEN_LIMITS.maxSerializedRequestBytes) {
    return invalid('payload_too_large', now, model);
  }

  const isMultimodal = hasMultimodalParts(request);
  const entry = resolveTokenizerEntry(model);
  const identity = resolveModelIdentity(model);
  const outputLimit = declaredOutput ?? null;

  /* Heuristic families: conservative ratio, loudly labeled. Multimodal payloads are
   * decomposed so text is still accounted (chars/4 over text segments only — never over
   * base64 media bytes) and media uses documented formulas when inputs are measurable. */
  if (entry.status === 'heuristic' || !entry.encoding) {
    if (!isMultimodal) {
      metrics.measurements = saturatingInc(metrics.measurements);
      metrics.byState.heuristic = saturatingInc(metrics.byState.heuristic);
      metrics.byBasis.heuristic = saturatingInc(metrics.byBasis.heuristic ?? 0);
      const textFlags = hasPromptCacheBreakpoints(request) ? [entry.family, 'prompt_cache_breakpoint_detected'] : [entry.family];
      return {
        model, input: Math.max(1, Math.ceil(serialized.length / 4)), output, outputBasis, outputLimit,
        basis: 'heuristic', state: 'heuristic', confidence: 'low',
        source: 'uptokey:conservative-chars4', version: 'chars4-v1', catalogVersion: TOKEN_CATALOG_VERSION,
        identity, provider: identity.provider, modelRevision: null,
        tokenizerId: entry.tokenizerName, artifactDigest: null,
        reason: 'chars4_heuristic', flags: Object.freeze(textFlags), isMultimodal: false, breakdown: null,
        verifier: { status: 'not_applicable', digest: null, engineId: 'not_applicable', vectorId: null }, measuredAt: now.toISOString(),
      };
    }
    const decomposed = decomposeRequest(request);
    const uncountable: UncountablePart[] = [...decomposed.uncountable];
    const flags: string[] = [...decomposed.flags, entry.family];
    const mediaOutcome = countMedia(entry, model, decomposed.media, uncountable, flags);
    const textChars = decomposed.textSegments.reduce((acc, segment) => acc + segment.length, 0)
      + decomposed.toolCallSegments.reduce((acc, segment) => acc + segment.length, 0)
      + decomposed.names.reduce((acc, segment) => acc + segment.length, 0)
      + (decomposed.toolsJson?.length ?? 0)
      + (decomposed.responseFormatJson?.length ?? 0);
    if (!Number.isSafeInteger(textChars)) return { ...invalid('count_overflow', now, model, outputLimit), output, outputBasis, isMultimodal };
    const textTokens = textChars > 0 ? Math.max(1, Math.ceil(textChars / 4)) : 0;
    const countable = (textTokens > 0 ? 1 : 0) + mediaOutcome.mediaCounted;
    if (countable === 0) {
      metrics.measurements = saturatingInc(metrics.measurements);
      metrics.byState.unknown = saturatingInc(metrics.byState.unknown);
      metrics.byBasis.unknown = saturatingInc(metrics.byBasis.unknown ?? 0);
      return {
        model, input: null, output, outputBasis, outputLimit, basis: 'unknown', state: 'unknown', confidence: null,
        source: 'uptokey:token-catalog', version: TOKEN_CATALOG_VERSION, catalogVersion: TOKEN_CATALOG_VERSION,
        identity, provider: identity.provider, modelRevision: null,
        tokenizerId: entry.tokenizerName, artifactDigest: null,
        reason: 'multimodal_text_counter_inapplicable', flags: Object.freeze(flags), isMultimodal: true,
        breakdown: {
          textTokens: 0, framingTokens: 0, toolsTokens: 0, responseFormatTokens: 0, mediaTokens: 0,
          messagesCounted: decomposed.messagesCounted, mediaCounted: 0, uncountable: Object.freeze(uncountable),
        },
        verifier: { status: 'not_applicable', digest: null, engineId: 'not_applicable', vectorId: null }, measuredAt: now.toISOString(),
      };
    }
    const input = textTokens + mediaOutcome.mediaTokens;
    if (!Number.isSafeInteger(input)) return { ...invalid('count_overflow', now, model, outputLimit), output, outputBasis, isMultimodal };
    const mixed = textTokens > 0 && mediaOutcome.mediaCounted > 0;
    const hasUncountable = uncountable.length > 0;
    const state: TokenizerStatus = hasUncountable || mixed ? 'partial' : 'heuristic';
    const basis: TokenUsageBasis = mediaOutcome.mediaCounted > 0 ? 'estimated' : 'heuristic';
    metrics.measurements = saturatingInc(metrics.measurements);
    metrics.byState[state] = saturatingInc(metrics.byState[state]);
    metrics.byBasis[basis] = saturatingInc(metrics.byBasis[basis] ?? 0);
    return {
      model, input, output, outputBasis, outputLimit, basis, state, confidence: 'low',
      source: mediaOutcome.mediaCounted > 0 ? 'uptokey:conservative-chars4+documented-media' : 'uptokey:conservative-chars4',
      version: 'chars4-v1', catalogVersion: TOKEN_CATALOG_VERSION,
      identity, provider: identity.provider, modelRevision: null,
      tokenizerId: entry.tokenizerName, artifactDigest: null,
      reason: hasUncountable ? `partial_uncountable_parts:${uncountable[0]!.reason}` : mixed ? 'mixed_heuristic_text_documented_media' : 'chars4_heuristic',
      flags: Object.freeze(flags), isMultimodal: true,
      breakdown: {
        textTokens, framingTokens: 0, toolsTokens: decomposed.toolsJson !== null ? Math.ceil(decomposed.toolsJson.length / 4) : 0,
        responseFormatTokens: decomposed.responseFormatJson !== null ? Math.ceil(decomposed.responseFormatJson.length / 4) : 0,
        mediaTokens: mediaOutcome.mediaTokens, messagesCounted: decomposed.messagesCounted,
        mediaCounted: mediaOutcome.mediaCounted, uncountable: Object.freeze(uncountable),
      },
      verifier: { status: 'not_applicable', digest: null, engineId: 'not_applicable', vectorId: null }, measuredAt: now.toISOString(),
    };
  }

  /* Verified families: real tokenizer + documented framing + separated media accounting. */
  const decomposed = decomposeRequest(request);
  const uncountable: UncountablePart[] = [...decomposed.uncountable];
  const flags: string[] = [...decomposed.flags];
  // Alias resolution and other revisions are assumptions, even if the text BPE agrees.
  if (decomposed.names.length && !OPENAI_NAME_FRAMING_SNAPSHOTS.has(normalizeModelId(model))) {
    uncountable.push({ kind: 'message', reason: 'name_framing_assumed_for_model' });
  }
  if (decomposed.toolCallSegments.length) uncountable.push({ kind: 'tools', reason: 'tool_calls_framing_undocumented' });
  let mediaTokens = 0;
  let mediaCounted = 0;
  if (isMultimodal) {
    const mediaOutcome = countMedia(entry, model, decomposed.media, uncountable, flags);
    mediaTokens = mediaOutcome.mediaTokens;
    mediaCounted = mediaOutcome.mediaCounted;
  }

  const encoder = encoderFor(entry.encoding);
  const verifier = verifierFor(entry.encoding);
  const segments: { label: string; text: string }[] = [
    ...decomposed.roles.map((role, i) => ({ label: `role:${i}`, text: role })),
    ...decomposed.names.map((name, i) => ({ label: `name:${i}`, text: name })),
    ...decomposed.textSegments.map((text, i) => ({ label: `text:${i}`, text })),
    ...decomposed.toolCallSegments.map((text, i) => ({ label: `toolcall:${i}`, text })),
  ];
  const counted = countSegments(encoder, verifier, entry.tokenizerName, entry.version, segments, verifyPolicy);
  if ('error' in counted) return { ...invalid(counted.error, now, model, outputLimit), output, outputBasis, isMultimodal };

  let toolsTokens = 0;
  let toolsVerifier: 'matched' | 'skipped' | 'mismatch' = 'skipped';
  if (decomposed.toolsJson !== null) {
    const toolsCounted = countSegments(encoder, verifier, entry.tokenizerName, entry.version, [{ label: 'tools', text: decomposed.toolsJson }], verifyPolicy);
    if ('error' in toolsCounted) return { ...invalid(toolsCounted.error, now, model, outputLimit), output, outputBasis, isMultimodal };
    toolsTokens = toolsCounted.total;
    toolsVerifier = toolsCounted.verifier;
    flags.push('tools_framing_undocumented');
  }

  let responseFormatTokens = 0;
  let responseFormatVerifier: 'matched' | 'skipped' | 'mismatch' = 'skipped';
  if (decomposed.responseFormatJson !== null) {
    const responseFormatCounted = countSegments(encoder, verifier, entry.tokenizerName, entry.version, [{ label: 'response_format', text: decomposed.responseFormatJson }], verifyPolicy);
    if ('error' in responseFormatCounted) return { ...invalid(responseFormatCounted.error, now, model, outputLimit), output, outputBasis, isMultimodal };
    responseFormatTokens = responseFormatCounted.total;
    responseFormatVerifier = responseFormatCounted.verifier;
    flags.push('response_format_framing_undocumented');
  }

  const framingTokens = entry.framing
    ? entry.framing.perMessage * decomposed.messagesCounted + entry.framing.perReplyPriming + entry.framing.perName * decomposed.names.length
    : 0;
  const textTokens = counted.total;
  const input = textTokens + framingTokens + toolsTokens + responseFormatTokens + mediaTokens;
  if (!Number.isSafeInteger(input)) return { ...invalid('count_overflow', now, model, outputLimit), output, outputBasis, isMultimodal };

  const hasUncountable = uncountable.length > 0;
  const state: TokenizerStatus = hasUncountable || mediaCounted > 0 || decomposed.toolsJson !== null || decomposed.responseFormatJson !== null ? 'partial' : 'verified';
  const confidence: TokenConfidence = state === 'verified' ? 'high' : mediaCounted > 0 || decomposed.toolsJson !== null ? 'medium' : 'medium';
  const reason = hasUncountable
    ? `partial_uncountable_parts:${uncountable[0]!.reason}`
    : mediaCounted > 0
      ? 'media_via_documented_formula'
      : decomposed.toolsJson !== null
        ? 'tools_serialized_counted_framing_undocumented'
        : decomposed.responseFormatJson !== null
          ? 'response_format_serialized_counted_framing_undocumented'
          : null;
  const basis: TokenUsageBasis = 'model_tokenizer';

  metrics.measurements = saturatingInc(metrics.measurements);
  metrics.byState[state] = saturatingInc(metrics.byState[state]);
  metrics.byBasis[basis] = saturatingInc(metrics.byBasis[basis] ?? 0);

  return {
    model,
    input: Math.max(1, input),
    output,
    outputBasis,
    outputLimit,
    basis,
    state,
    confidence,
    source: entry.provenance,
    version: entry.version,
    catalogVersion: TOKEN_CATALOG_VERSION,
    identity,
    provider: identity.provider,
    modelRevision: null,
    tokenizerId: entry.tokenizerName,
    artifactDigest: tokenizerArtifactDigest(entry.encoding, entry.tokenizerName, entry.version),
    reason,
    flags: Object.freeze(flags),
    isMultimodal,
    breakdown: {
      textTokens,
      framingTokens,
      toolsTokens,
      responseFormatTokens,
      mediaTokens,
      messagesCounted: decomposed.messagesCounted,
      mediaCounted,
      uncountable: Object.freeze(uncountable),
    },
    verifier: { status: counted.verifier === 'matched' || toolsVerifier === 'matched' || responseFormatVerifier === 'matched' ? 'matched' : 'skipped', digest: counted.digest.slice(-16), engineId: TOKEN_VERIFIER_ENGINE_ID, vectorId: TOKENIZER_VECTOR_SET_ID },
    measuredAt: now.toISOString(),
  };
}

/* ------------------------------------------------- legacy-compatible estimator */

/**
 * Backwards-compatible measurement (CatalogTokenMeasurement shape). Semantics upgrade:
 * multimodal payloads now separate countable text/media from uncountable parts instead of
 * blanket-nulling input; a fully uncountable multimodal payload still yields input=null,
 * basis='unknown', reason='multimodal_text_counter_inapplicable'.
 */
export function estimateRequestTokens(request: ChatCompletionRequest): CatalogTokenMeasurement | undefined {
  const measured = measureRequestTokens(request);
  if (!measured) return undefined;
  if (measured.state === 'unknown' && measured.isMultimodal) {
    return {
      input: null, output: measured.output, basis: 'unknown', source: 'uptokey:token-catalog',
      version: TOKEN_CATALOG_VERSION, measuredAt: measured.measuredAt,
      reason: 'multimodal_text_counter_inapplicable', isMultimodal: true,
    };
  }
  if (measured.state === 'unavailable') {
    return {
      input: null, output: measured.output, basis: 'unknown', source: measured.source,
      version: measured.version, measuredAt: measured.measuredAt, reason: measured.reason, isMultimodal: measured.isMultimodal,
    };
  }
  return {
    input: measured.input, output: measured.output, basis: measured.basis, source: measured.source,
    version: measured.version, measuredAt: measured.measuredAt, reason: measured.reason, isMultimodal: measured.isMultimodal,
  };
}

/* ---------------------------------------------------------------- embeddings */

export interface EmbeddingMeasurement {
  readonly model: string;
  readonly input: number | null;
  readonly basis: TokenUsageBasis;
  readonly state: TokenizerStatus;
  readonly source: string;
  readonly version: string;
  readonly catalogVersion: string;
  readonly tokenizerId: string;
  readonly artifactDigest: string | null;
  readonly reason: string | null;
  readonly inputsCounted: number;
  readonly measuredAt: string;
}

/** Counts embedding inputs (raw text, no chat framing) with the model tokenizer when verified. */
export function measureEmbeddingTokens(model: string, input: string | readonly string[], options?: MeasureOptions): EmbeddingMeasurement | undefined {
  const now = options?.now?.() ?? new Date();
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0 || items.some((item) => typeof item !== 'string')) return undefined;
  if (items.length > 2048) return undefined;
  const entry = resolveTokenizerEntry(model);
  if (entry.status !== 'verified' || !entry.encoding) {
    const joinedLength = items.reduce((acc, item) => acc + item.length, 0);
    if (!Number.isSafeInteger(joinedLength)) return undefined;
    return {
      model, input: Math.max(1, Math.ceil(joinedLength / 4)), basis: 'heuristic', state: 'heuristic',
      source: 'uptokey:conservative-chars4', version: 'chars4-v1', catalogVersion: TOKEN_CATALOG_VERSION,
      tokenizerId: entry.tokenizerName, artifactDigest: null,
      reason: 'chars4_heuristic', inputsCounted: items.length, measuredAt: now.toISOString(),
    };
  }
  const encoder = encoderFor(entry.encoding);
  const counted = countSegments(encoder, verifierFor(entry.encoding), entry.tokenizerName, entry.version, items.map((text, i) => ({ label: `emb:${i}`, text })), options?.verify ?? 'auto');
  if ('error' in counted) return undefined;
  return {
    model, input: counted.total, basis: 'model_tokenizer', state: 'verified',
    source: entry.provenance, version: entry.version, catalogVersion: TOKEN_CATALOG_VERSION,
    tokenizerId: entry.tokenizerName,
    artifactDigest: tokenizerArtifactDigest(entry.encoding, entry.tokenizerName, entry.version),
    reason: null, inputsCounted: items.length, measuredAt: now.toISOString(),
  };
}

/* ------------------------------------------- opt-in verified local tokenization */

export interface LiveTokenizeResult {
  readonly model: string;
  readonly input: number;
  readonly basis: 'model_tokenizer';
  readonly state: 'verified';
  readonly source: string;
  readonly version: string;
  readonly measuredAt: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Verified local counting via a model runtime's own /tokenize endpoint (e.g. vLLM).
 * Strictly loopback-only, bounded response, hard timeout, no credentials in the payload.
 * Returns null on any deviation — the caller falls back to the labeled offline path.
 */
export async function measureWithLocalTokenizer(
  model: string,
  text: string,
  endpointBaseUrl: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => Date },
): Promise<LiveTokenizeResult | null> {
  let base: URL;
  try {
    base = new URL(endpointBaseUrl);
  } catch { return null; }
  if (base.protocol !== 'http:' || !LOOPBACK_HOSTS.has(base.hostname)) return null;
  const textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes > TOKEN_LIMITS.maxSegmentBytes) return null;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? TOKEN_LIMITS.liveTokenizeTimeoutMs);
  try {
    const url = new URL('/tokenize', base).toString();
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > TOKEN_LIMITS.liveTokenizeMaxResponseBytes) return null;
    const body = await response.text();
    if (body.length > TOKEN_LIMITS.liveTokenizeMaxResponseBytes) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!isRecord(parsed)) return null;
    const count = typeof parsed.count === 'number' ? parsed.count
      : Array.isArray(parsed.tokens) ? parsed.tokens.length
        : null;
    if (count === null || !Number.isSafeInteger(count) || count < 0) return null;
    return {
      model,
      input: count,
      basis: 'model_tokenizer',
      state: 'verified',
      source: `local-runtime:/tokenize`,
      version: 'live-1',
      measuredAt: (options?.now?.() ?? new Date()).toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
