import {
  CampaignSearchError,
  type CampaignSearchProvider,
  type CampaignSearchRequest,
  type CampaignSearchResponse,
} from "@rakazo/adapter-kit/campaign-search";
import { JSDOM } from "jsdom";
import {
  type CampaignPublicResource,
  fetchCampaignPublicResource,
  validateCampaignResearchUrl,
} from "./campaign-research.js";

const BING_ORIGIN = "https://www.bing.com";
const MAX_QUERY_LENGTH = 300;
const MAX_LIMIT = 10;
const MAX_RESPONSE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "msclkid", "ref"]);

type FetchResource = typeof fetchCampaignPublicResource;

export interface BingCampaignSearchOptions {
  /** Injection seam for offline tests; production uses the SSRF-safe public fetcher. */
  fetchResource?: FetchResource;
  now?: () => Date;
  timeoutMs?: number;
}

/** Optional public Bing RSS search. It uses no credentials and never retries requests. */
export function createBingCampaignSearchProvider(
  options: BingCampaignSearchOptions = {},
): CampaignSearchProvider {
  const fetchResource = options.fetchResource ?? fetchCampaignPublicResource;
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS));

  return {
    async search(request: CampaignSearchRequest): Promise<CampaignSearchResponse> {
      const query = typeof request?.query === "string" ? request.query.trim() : "";
      const limit = request?.limit;
      if (!query || query.length > MAX_QUERY_LENGTH || hasControlCharacters(query)) {
        throw new CampaignSearchError("invalid_input", "search_query_invalid", "query_invalid");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new CampaignSearchError("invalid_input", "search_query_invalid", "limit_invalid");
      }
      if (request.signal?.aborted) {
        throw new CampaignSearchError("transient", "search_aborted", "caller_aborted");
      }

      const url = new URL("/search", BING_ORIGIN);
      url.searchParams.set("format", "rss");
      url.searchParams.set("q", query);
      if (
        url.origin !== BING_ORIGIN ||
        url.hostname !== "www.bing.com" ||
        url.protocol !== "https:" ||
        url.username ||
        url.password
      ) {
        throw new CampaignSearchError("unavailable", "search_unavailable", "endpoint_invalid");
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      let fetched: CampaignPublicResource;
      try {
        fetched = await Promise.race([
          fetchResource(url.toString(), {
            signal,
            timeoutMs,
            accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
            readContentTypes: ["application/rss+xml", "application/xml", "text/xml"],
            allowedOrigin: BING_ORIGIN,
            userAgent: "AutoSEO-CampaignSearch/1.0",
          }),
          rejectOnAbort(signal),
        ]);
      } catch {
        if (request.signal?.aborted) {
          throw new CampaignSearchError("transient", "search_aborted", "caller_aborted");
        }
        if (timeoutSignal.aborted) {
          throw new CampaignSearchError("transient", "search_timeout", "fetch_timeout");
        }
        throw new CampaignSearchError("transient", "search_unavailable", "network_error");
      }

      if (request.signal?.aborted) {
        throw new CampaignSearchError("transient", "search_aborted", "caller_aborted");
      }
      if (timeoutSignal.aborted) {
        throw new CampaignSearchError("transient", "search_timeout", "fetch_timeout");
      }
      if (!isExpectedEndpoint(fetched.url)) {
        throw new CampaignSearchError("unavailable", "search_unavailable", "endpoint_mismatch");
      }
      if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
        const retryable = fetched.httpStatus === 429 || fetched.httpStatus >= 500;
        throw new CampaignSearchError(
          retryable ? "transient" : "unavailable",
          "search_unavailable",
          `http_${fetched.httpStatus}`,
        );
      }
      if (!isXmlContentType(fetched.contentType)) {
        throw new CampaignSearchError("unavailable", "search_unavailable", "content_type_invalid");
      }
      if (Buffer.byteLength(fetched.body, "utf8") > MAX_RESPONSE_BYTES) {
        throw new CampaignSearchError("unavailable", "search_unavailable", "response_too_large");
      }

      const results = parseRssResults(fetched.body, limit);
      return {
        query,
        results,
        observedAt: now().toISOString(),
        provider: "bing-rss",
      };
    },
  };
}

function parseRssResults(xml: string, limit: number): CampaignSearchResponse["results"] {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new CampaignSearchError("unavailable", "search_unavailable", "xml_declaration_blocked");
  }
  let dom: JSDOM;
  try {
    // XML mode is inert: no script execution or resource loading is enabled.
    dom = new JSDOM(xml, { contentType: "application/xml" });
  } catch {
    throw new CampaignSearchError("unavailable", "search_unavailable", "xml_malformed");
  }
  try {
    const document = dom.window.document;
    const root = document.documentElement;
    if (root.localName.toLowerCase() !== "rss" || document.querySelector("parsererror")) {
      throw new CampaignSearchError("unavailable", "search_unavailable", "rss_invalid");
    }
    const items = Array.from(document.getElementsByTagName("item"));
    const results: CampaignSearchResponse["results"] = [];
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const title = sanitizeText(childText(item, "title"), 200);
      const snippet = sanitizeText(childText(item, "description"), 1_000);
      const rawUrl = childText(item, "link").trim();
      if (!title || !snippet || !rawUrl) continue;
      const canonical = canonicalPublicResultUrl(rawUrl);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      results.push({ url: canonical, title, snippet, rank: index + 1 });
      if (results.length === limit) break;
    }
    return results;
  } finally {
    dom.window.close();
  }
}

function childText(parent: Element, localName: string): string {
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === localName) return child.textContent ?? "";
  }
  return "";
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function canonicalPublicResultUrl(value: string): string | null {
  try {
    const url = validateCampaignResearchUrl(value);
    if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return null;
    }
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function isExpectedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.bing.com" &&
      url.origin === BING_ORIGIN &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isXmlContentType(value: string): boolean {
  const type = value.toLowerCase().split(";", 1)[0]?.trim();
  return type === "application/rss+xml" || type === "application/xml" || type === "text/xml";
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("request aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  });
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}
