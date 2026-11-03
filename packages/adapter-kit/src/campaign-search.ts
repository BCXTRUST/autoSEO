export interface CampaignSearchRequest {
  query: string;
  /** Providers and callers are both restricted to at most ten results per query. */
  limit: number;
  signal?: AbortSignal;
}

export interface CampaignSearchResult {
  url: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface CampaignSearchResponse {
  query: string;
  results: CampaignSearchResult[];
  observedAt: string;
  provider: string;
}

export interface CampaignSearchProvider {
  search(request: CampaignSearchRequest): Promise<CampaignSearchResponse>;
}

export type CampaignSearchErrorKind = "transient" | "unavailable" | "invalid_input";
export type CampaignSearchErrorCode =
  | "search_unavailable"
  | "search_timeout"
  | "search_aborted"
  | "search_query_invalid";

/** Sanitized failure classes and stable cause codes; never stores a raw response or exception. */
export class CampaignSearchError extends Error {
  readonly kind: CampaignSearchErrorKind;
  readonly safeCode: CampaignSearchErrorCode;
  readonly causeCode: string;
  readonly retryable: boolean;

  constructor(kind: CampaignSearchErrorKind, safeCode: CampaignSearchErrorCode, causeCode: string) {
    super(safeCode);
    this.name = "CampaignSearchError";
    this.kind = kind;
    this.safeCode = safeCode;
    this.causeCode = causeCode;
    this.retryable = kind === "transient";
  }
}

export interface CampaignSearchSource {
  url: string;
  title: string;
  text: string;
}

/**
 * Derive bounded search queries from exact-host source rows selected by the trusted catalog.
 * Callers must not pass unverified user-claimed sources here.
 */
export function deriveCampaignSearchQueries(input: {
  websiteUrl: string;
  sources: readonly CampaignSearchSource[];
}): string[] {
  let website: URL;
  try {
    website = new URL(input.websiteUrl);
  } catch {
    return [];
  }
  if (
    (website.protocol !== "http:" && website.protocol !== "https:") ||
    website.username ||
    website.password
  ) {
    return [];
  }
  const host = website.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return [];

  const evidenceTerms: string[][] = [];
  for (const source of input.sources) {
    if (typeof source.title !== "string" || typeof source.text !== "string") continue;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(source.url);
    } catch {
      continue;
    }
    if (
      (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") ||
      sourceUrl.username ||
      sourceUrl.password ||
      sourceUrl.hostname.toLowerCase().replace(/\.$/, "") !== host
    ) {
      continue;
    }
    const titleWords = significantWords(source.title).slice(0, 4);
    const textWords = titleWords.length >= 2 ? [] : significantWords(source.text).slice(0, 4);
    const words = [...titleWords, ...textWords].slice(0, 4);
    if (words.length >= 2) evidenceTerms.push(words);
  }
  if (evidenceTerms.length === 0) return [];

  const queries: string[] = [`"${host}" ${evidenceTerms[0]![0]} (forum OR discussion)`];
  const seen = new Set<string>();
  seen.add(queries[0]!);
  for (const words of evidenceTerms) {
    const query = `${words.join(" ")} (community OR forum OR discussion) -site:${host}`;
    if (query.length > 300 || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
    if (queries.length === 3) break;
  }
  return queries;
}

const IGNORED_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "between",
  "but",
  "can",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "most",
  "not",
  "only",
  "other",
  "over",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  // Treat likely embedded instructions and credential terms as data to discard.
  "assistant",
  "credential",
  "ignore",
  "instruction",
  "password",
  "policy",
  "prompt",
  "secret",
  "system",
  "token",
]);

function significantWords(value: string): string[] {
  const plain = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of plain.match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    const word = raw.toLowerCase();
    if (IGNORED_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    output.push(word);
  }
  return output;
}
