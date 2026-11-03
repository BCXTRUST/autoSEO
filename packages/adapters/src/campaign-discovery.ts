import {
  CampaignCatalogError,
  type CampaignCatalogPage,
  type CatalogRobotsRules,
  canonicalCatalogUrl,
  fetchCampaignCatalogPage,
  isCatalogUrlAllowed,
  parseCatalogRobots,
} from "./campaign-catalog.js";
import { validateCampaignResearchUrl } from "./campaign-research.js";

const MAX_INVOCATION_MS = 20_000;
const MAX_REQUEST_MS = 8_000;
const MAX_RULE_LINKS = 5;
const MAX_EXCERPT_CHARS = 1_200;

export interface CampaignOpportunityInspection {
  url: string;
  title: string;
  excerpt: string;
  observedAt: string;
  rulesLinks: Array<{ url: string; label: string }>;
  platformHint: "discourse" | "unknown";
  eligibility: "needs_review";
  evidenceKind: "observed_page";
}

export interface CampaignCatalogPageRequestOptions {
  allowedOrigin: string;
  allowedUrl?: (url: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CampaignCatalogPageFetcher = (
  url: string,
  options: CampaignCatalogPageRequestOptions,
) => Promise<CampaignCatalogPage>;

export class CampaignOpportunityInspectionError extends Error {
  constructor(
    readonly kind: "transient" | "unavailable" | "invalid_input",
    readonly safeCode: string,
  ) {
    super(safeCode);
    this.name = "CampaignOpportunityInspectionError";
  }
}

/** Reads only the site's crawl policy and one explicitly supplied candidate page. */
export async function inspectCampaignOpportunity(input: {
  url: string;
  signal?: AbortSignal;
  now?: () => Date;
  fetchCatalogPage?: CampaignCatalogPageFetcher;
}): Promise<CampaignOpportunityInspection> {
  const fetchPage = input.fetchCatalogPage ?? fetchCampaignCatalogPage;
  let candidateUrl: URL;
  try {
    candidateUrl = validateCampaignResearchUrl(input.url);
  } catch {
    throw new CampaignOpportunityInspectionError("invalid_input", "url_invalid");
  }
  const rootOrigin = candidateUrl.origin;
  const canonicalUrl = canonicalCatalogUrl(candidateUrl.toString(), rootOrigin);
  if (!canonicalUrl)
    throw new CampaignOpportunityInspectionError("invalid_input", "url_unsupported");
  if (input.signal?.aborted)
    throw new CampaignOpportunityInspectionError("transient", "fetch_aborted");

  const deadline = Date.now() + MAX_INVOCATION_MS;
  const robotsUrl = new URL("/robots.txt", rootOrigin).toString();
  let rules: CatalogRobotsRules = { allow: [], disallow: [], sitemaps: [] };
  try {
    const robotsPage = await fetchBounded(fetchPage, robotsUrl, rootOrigin, deadline, input.signal);
    const robotsText = robotsPage.robotsText ?? robotsPage.text;
    rules = parseCatalogRobots(robotsText, rootOrigin);
  } catch (error) {
    if (error instanceof CampaignCatalogError && error.safeCode === "page_absent") {
      rules = { allow: [], disallow: [], sitemaps: [] };
    } else {
      throw mapCatalogError(error);
    }
  }

  if (!isCatalogUrlAllowed(canonicalUrl, rules)) {
    throw new CampaignOpportunityInspectionError("unavailable", "robots_disallowed");
  }
  let page: CampaignCatalogPage;
  try {
    page = await fetchBounded(fetchPage, canonicalUrl, rootOrigin, deadline, input.signal, (url) =>
      isCatalogUrlAllowed(url, rules),
    );
  } catch (error) {
    throw mapCatalogError(error);
  }
  const observedUrl = canonicalCatalogUrl(page.url, rootOrigin);
  if (!observedUrl)
    throw new CampaignOpportunityInspectionError("unavailable", "page_origin_invalid");
  if (!isCatalogUrlAllowed(observedUrl, rules)) {
    throw new CampaignOpportunityInspectionError("unavailable", "robots_disallowed");
  }
  if (page.httpStatus < 200 || page.httpStatus >= 300) {
    throw new CampaignOpportunityInspectionError("unavailable", "page_status");
  }
  const excerpt = page.text.trim().slice(0, MAX_EXCERPT_CHARS);
  if (!excerpt) throw new CampaignOpportunityInspectionError("unavailable", "page_has_no_text");

  const rulesLinks = observedRulesLinks(page, rootOrigin);
  return {
    url: observedUrl,
    title: page.title.slice(0, 200),
    excerpt,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
    rulesLinks,
    platformHint: platformHint(page),
    eligibility: "needs_review",
    evidenceKind: "observed_page",
  };
}

async function fetchBounded(
  fetchPage: CampaignCatalogPageFetcher,
  url: string,
  allowedOrigin: string,
  deadline: number,
  signal?: AbortSignal,
  allowedUrl?: (url: string) => boolean,
): Promise<CampaignCatalogPage> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new CampaignOpportunityInspectionError("transient", "fetch_timeout");
  if (signal?.aborted) throw new CampaignOpportunityInspectionError("transient", "fetch_aborted");

  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const request = Promise.resolve().then(() =>
    fetchPage(url, {
      allowedOrigin,
      allowedUrl,
      signal: combinedSignal,
      timeoutMs: Math.min(remainingMs, MAX_REQUEST_MS),
    }),
  );
  void request.catch(() => undefined);
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            new CampaignOpportunityInspectionError(
              "transient",
              signal?.aborted ? "fetch_aborted" : "fetch_timeout",
            ),
          );
        combinedSignal.addEventListener("abort", onAbort, { once: true });
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CampaignOpportunityInspectionError(
                "transient",
                signal?.aborted ? "fetch_aborted" : "fetch_timeout",
              ),
            ),
          remainingMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof CampaignOpportunityInspectionError) throw error;
    if (error instanceof CampaignCatalogError) throw error;
    if (signal?.aborted) throw new CampaignOpportunityInspectionError("transient", "fetch_aborted");
    throw new CampaignOpportunityInspectionError("transient", "fetch_failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) combinedSignal.removeEventListener("abort", onAbort);
  }
}

function mapCatalogError(error: unknown): CampaignOpportunityInspectionError {
  if (error instanceof CampaignOpportunityInspectionError) return error;
  if (error instanceof CampaignCatalogError) {
    if (error.kind === "transient") {
      return new CampaignOpportunityInspectionError("transient", error.safeCode);
    }
    return new CampaignOpportunityInspectionError("unavailable", error.safeCode);
  }
  return new CampaignOpportunityInspectionError("transient", "fetch_failed");
}

function observedRulesLinks(
  page: CampaignCatalogPage,
  rootOrigin: string,
): Array<{ url: string; label: string }> {
  const output: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  for (const observed of page.links) {
    if (!/\b(?:rules?|guidelines?|terms|community[-\s]?policy)\b/i.test(observed.label)) continue;
    const url = canonicalCatalogUrl(observed.url, rootOrigin);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push({ url, label: observed.label.slice(0, 200) || url });
    if (output.length >= MAX_RULE_LINKS) break;
  }
  return output;
}

function platformHint(page: CampaignCatalogPage): "discourse" | "unknown" {
  const titleAndText = `${page.title}\n${page.text}`;
  if (
    /(?:^|\/)t\/[^/]+\/\d+(?:\/|$)/i.test(new URL(page.url).pathname) ||
    /powered by discourse/i.test(titleAndText) ||
    /\bdiscourse\b/i.test(page.title)
  ) {
    return "discourse";
  }
  return "unknown";
}
