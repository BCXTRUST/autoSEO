import type { LbMarket, LbMarketPolicy, LbTopicLane } from "@rakazo/contracts";
import { marketKey, selectMarkets } from "./market.js";
import { detectLanguage } from "./page-language.js";
import { registrableDomain } from "./policy.js";
import { type ProbeFacts, type ProbePage, probePages, settleProbe } from "./probe.js";
import { useCaseLanes } from "./problem-queries.js";

/**
 * One combined footprint per lane tag. The OR covers every platform in Appendix A, so discovery
 * does not send a separate query per platform. Localisation is the market's country and language.
 */
export const SEARCH_FOOTPRINT =
  "(inurl:viewtopic.php OR inurl:/forum/thread/ OR inurl:showthread.php OR inurl:/t/ OR inurl:/threads/ OR inurl:/topic/ OR inurl:/d/)";

export function footprintQuery(keyword: string): string {
  const cleaned = keyword.replace(/"/g, "").trim();
  if (!cleaned) throw new RangeError("Footprint query needs a keyword");
  return `"${cleaned}" ${SEARCH_FOOTPRINT}`;
}

export interface FootprintQuery {
  market: LbMarket;
  laneId: string;
  laneTag: string;
  query: string;
}

/** Primary market first. Later markets only when `marketPolicy` says the supply is short. */
export function planFootprintQueries(input: {
  lanes: readonly LbTopicLane[];
  markets: readonly LbMarket[];
  policy: LbMarketPolicy;
  supply: Readonly<Record<string, number>>;
  need: number;
}): FootprintQuery[] {
  const markets = selectMarkets({
    markets: input.markets,
    policy: input.policy,
    supply: input.supply,
    need: input.need,
  });
  const problems = [
    ...new Set(
      useCaseLanes({
        keywords: input.lanes.flatMap((lane) => [lane.tag, lane.description]),
      }).map((lane) => lane.query),
    ),
  ];
  const queries: FootprintQuery[] = [];
  for (const market of markets) {
    if (problems.length > 0) {
      const lane = input.lanes[0];
      if (!lane) continue;
      for (const problem of problems) {
        queries.push({
          market,
          laneId: lane.id,
          laneTag: problem,
          query: footprintQuery(problem),
        });
      }
      continue;
    }
    for (const lane of input.lanes) {
      queries.push({
        market,
        laneId: lane.id,
        laneTag: lane.tag,
        query: footprintQuery(lane.tag),
      });
    }
  }
  return queries;
}

/** Up to eight problem queries for one DataForSEO pass. The shop name is never added here. */
export function planDiscoveryQueries(
  problems: readonly string[],
  limit = 8,
  language = "de",
): string[] {
  const queries: string[] = [];
  for (const problem of problems) {
    const cleaned = problem.replace(/"/g, "").trim();
    if (!cleaned) continue;
    for (const query of [
      `${cleaned} Forum`,
      `${cleaned} (inurl:viewtopic OR inurl:showthread OR inurl:forum/thread)`,
      `${language === "de" ? '"Registrieren"' : '"register"'} ${cleaned}`,
    ]) {
      if (queries.length >= limit) return queries;
      queries.push(query);
    }
  }
  return queries;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  market: LbMarket;
  laneId: string;
  laneTag: string;
}

export interface FunnelHost {
  registrableDomain: string;
  homepageUrl: string;
  sampleUrl: string;
  title: string;
  market: LbMarket;
  topicTags: string[];
  laneIds: string[];
  /** Visible text from the fetched pages, used by the topic gate. */
  pageText: string;
  facts: ProbeFacts;
  status: ReturnType<typeof settleProbe>["status"];
  reason: string | null;
  score: number;
}

export type SearchFn = (request: {
  query: string;
  country: string;
  language: string;
  depth: number;
}) => Promise<Array<{ url: string; title: string; snippet: string }>>;

/**
 * SERP hits to registrable domains. Drops deny-list hosts, hosts already used, and duplicates.
 * The first market to see a domain keeps its tag.
 */
export function dedupeHits(
  hits: readonly SearchHit[],
  denyHosts: readonly string[],
  usedHosts: readonly string[],
): SearchHit[] {
  const deny = new Set(denyHosts.map((host) => host.toLowerCase()));
  const used = new Set(usedHosts.map((host) => host.toLowerCase()));
  const seen = new Set<string>();
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    const domain = registrableDomain(hit.url);
    if (!domain || deny.has(domain) || used.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    kept.push(hit);
  }
  return kept;
}

/**
 * Offline-capable funnel: search, dedupe, probe each homepage with the injected fetch.
 * The fetch is only asked for URLs on the host that the search result already named.
 */
export async function discoverHosts(input: {
  lanes: readonly LbTopicLane[];
  markets: readonly LbMarket[];
  policy: LbMarketPolicy;
  supply: Readonly<Record<string, number>>;
  need: number;
  denyHosts?: readonly string[];
  usedHosts?: readonly string[];
  depth?: number;
  search: SearchFn;
  fetchText: (url: string) => Promise<string | null>;
}): Promise<FunnelHost[]> {
  const queries = planFootprintQueries(input);
  const hits: SearchHit[] = [];
  for (const planned of queries) {
    const results = await input.search({
      query: planned.query,
      country: planned.market.country,
      language: planned.market.language,
      depth: input.depth ?? 20,
    });
    for (const result of results) {
      hits.push({
        ...result,
        market: planned.market,
        laneId: planned.laneId,
        laneTag: planned.laneTag,
      });
    }
  }
  const unique = dedupeHits(hits, input.denyHosts ?? [], input.usedHosts ?? []);
  const hosts: FunnelHost[] = [];
  for (const hit of unique) {
    const domain = registrableDomain(hit.url);
    if (!domain) continue;
    const homepageUrl = `${new URL(hit.url).origin}/`;
    const pages: ProbePage[] = [];
    const home = await input.fetchText(homepageUrl);
    if (home !== null) pages.push({ url: homepageUrl, html: home });
    if (onHost(hit.url, domain)) {
      const sample = await input.fetchText(hit.url);
      if (sample !== null) pages.push({ url: hit.url, html: sample });
    }
    const preliminary = probePages({ homepageUrl, sampleUrl: hit.url, pages });
    if (preliminary.registerUrl && onHost(preliminary.registerUrl, domain)) {
      const register = await input.fetchText(preliminary.registerUrl);
      if (register !== null) pages.push({ url: preliminary.registerUrl, html: register });
    }
    for (const path of ["/rules", "/faq", "/tos", "/guidelines"]) {
      const url = `${new URL(homepageUrl).origin}${path}`;
      const html = await input.fetchText(url);
      if (html !== null) pages.push({ url, html });
    }
    const facts = probePages({ homepageUrl, sampleUrl: hit.url, pages });
    const settled = settleProbe(facts, home !== null);
    const detected = detectLanguage(home ?? pages.map((page) => page.html).join("\n"), homepageUrl);
    const language = detected.language ?? hit.market.language;
    const country = detected.country ?? hit.market.country;
    const offLanguage = detected.language
      ? detected.language !== hit.market.language.split("-")[0]
      : /^en(?:-|$)/.test(hit.market.language);
    const forum =
      facts.platform !== "unknown" || (facts.threads.length >= 5 && Boolean(facts.registerUrl));
    let status: FunnelHost["status"] = offLanguage ? "off_topic" : settled.status;
    let reason = offLanguage ? `language:${detected.language ?? "unknown"}` : settled.reason;
    if (!offLanguage && !forum) {
      status = "off_topic";
      reason = "not_forum";
    } else if (
      !offLanguage &&
      forum &&
      facts.platform === "unknown" &&
      settled.reason === "unknown_platform"
    ) {
      status = "qualified";
      reason = null;
    }
    const locale =
      language === "de" && country === "AT"
        ? "de-AT"
        : language === "de" && country === "CH"
          ? "de-CH"
          : language === "de"
            ? "de-DE"
            : language && country
              ? `${language}-${country}`
              : hit.market.locale;
    hosts.push({
      registrableDomain: domain,
      homepageUrl,
      sampleUrl: hit.url,
      title: hit.title,
      market: {
        ...hit.market,
        language: language as LbMarket["language"],
        country: country as LbMarket["country"],
        locale: locale as LbMarket["locale"],
      },
      topicTags: [hit.laneTag],
      laneIds: [hit.laneId],
      pageText: pages.map((page) => visibleText(page.html)).join("\n"),
      facts,
      status,
      reason,
      score: settled.score,
    });
  }
  return hosts;
}

export function countQualified(
  hosts: readonly FunnelHost[],
  market: Pick<LbMarket, "country" | "language">,
): number {
  const key = marketKey(market);
  return hosts.filter((host) => host.status === "qualified" && marketKey(host.market) === key)
    .length;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50_000);
}

function onHost(url: string, domain: string): boolean {
  try {
    return registrableDomain(url) === domain;
  } catch {
    return false;
  }
}
