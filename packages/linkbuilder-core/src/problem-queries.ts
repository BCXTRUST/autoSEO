/**
 * Discovery searches the human problem, never the shop.
 * German DE/AT/CH queries come from the topic map. The shop name is only a later deep link.
 */

export const PROBLEM_MARKETS = ["DE", "AT", "CH"] as const;
export type ProblemMarket = (typeof PROBLEM_MARKETS)[number];

export interface ProblemQueryInput {
  name?: string | null;
  brandName?: string | null;
  topic?: string | null;
  keywords?: readonly string[] | null;
  pages?: readonly { url?: string | null; title?: string | null; keyword?: string | null }[] | null;
}

export interface CatalogTarget {
  url: string;
  kind: PageKind;
}

export type PageKind = "ratgeber" | "buy";

export interface UseCaseLane {
  id: string;
  nutrient: string;
  useCase: string;
  /** Short German Google.de query. Never includes the shop name. */
  query: string;
  market: ProblemMarket;
  destinationUrl: string | null;
  destinationKind: PageKind | null;
}

interface NutrientUse {
  useCase: string;
  query: string;
}

interface Nutrient {
  id: string;
  label: string;
  match: RegExp;
  uses: readonly NutrientUse[];
}

/** Topic map and the brief's query templates. Hashimoto and pregnancy stay off the automatic list. */
const NUTRIENTS: readonly Nutrient[] = [
  {
    id: "magnesium",
    label: "Magnesium",
    match: /magnesium/i,
    uses: [
      { useCase: "Krämpfe", query: "Magnesium Krämpfe Forum" },
      { useCase: "Schlaf", query: "Magnesium Schlaf Forum Deutschland" },
      { useCase: "Muskelzucken", query: "Magnesium Muskelzucken Forum" },
      { useCase: "Einschlafen", query: "Magnesium Einschlafen Forum" },
      { useCase: "Stress", query: "Magnesium Stress Forum" },
      { useCase: "Sport-Regeneration", query: "Magnesium Sport Regeneration Forum" },
      { useCase: "Migräne", query: "Magnesium Migräne Forum" },
      { useCase: "Magnesiummangel", query: "Magnesiummangel Forum" },
    ],
  },
  {
    id: "vitamin-d",
    label: "Vitamin D",
    match: /vitamin\s*d|vitamin\s*k2/i,
    uses: [
      { useCase: "Mangel", query: "Vitamin D Mangel Forum" },
      { useCase: "Knochen", query: "Vitamin D Knochen Forum" },
      { useCase: "Wintermüdigkeit", query: "Vitamin D Wintermüdigkeit Forum" },
      { useCase: "Laborwerte", query: "Vitamin D Laborwerte Forum" },
      { useCase: "Osteoporose", query: "Vitamin D Osteoporose Forum" },
    ],
  },
  {
    id: "b12",
    label: "B12",
    match: /vitamin\s*b12|\bb12\b|b-komplex|b komplex/i,
    uses: [
      { useCase: "Vegan", query: "Vitamin B12 Vegan Forum" },
      { useCase: "Müdigkeit", query: "Vitamin B12 Müdigkeit Forum" },
      { useCase: "Konzentration", query: "Vitamin B12 Konzentration Forum" },
    ],
  },
  {
    id: "omega-3",
    label: "Omega-3",
    match: /omega-?\s*3/i,
    uses: [
      { useCase: "Gelenke", query: "Omega-3 Gelenke Forum" },
      { useCase: "Herz", query: "Omega-3 Herz Forum" },
      { useCase: "Entzündung", query: "Omega-3 Entzündung Forum" },
      { useCase: "Sport", query: "Omega-3 Sport Forum" },
    ],
  },
  {
    id: "zink",
    label: "Zink",
    match: /\bzink\b/i,
    uses: [
      { useCase: "Immun", query: "Zink Immun Forum" },
      { useCase: "Haut", query: "Zink Haut Forum" },
      { useCase: "Haare", query: "Zink Haare Forum" },
      { useCase: "Erkältung", query: "Zink Erkältung Forum" },
    ],
  },
  {
    id: "melatonin",
    label: "Melatonin",
    match: /melatonin|5-htp/i,
    uses: [
      { useCase: "Schlaf", query: "Schlafprobleme Forum Melatonin" },
      { useCase: "Jetlag", query: "Melatonin Jetlag Forum" },
      { useCase: "Schichtarbeit", query: "Melatonin Schichtarbeit Forum" },
    ],
  },
  {
    id: "gelenke",
    label: "Gelenke",
    match: /glucosamin|kollagen|\bmsm\b/i,
    uses: [
      { useCase: "Gelenkschmerzen", query: "Gelenkschmerzen Forum Glucosamin" },
      { useCase: "Sportverletzung", query: "Gelenkschmerzen Sportverletzung Forum" },
    ],
  },
  {
    id: "darm",
    label: "Darm",
    match: /probiotik|reizdarm/i,
    uses: [
      { useCase: "Reizdarm", query: "Reizdarm Forum Probiotika" },
      { useCase: "Blähungen", query: "Blähungen Forum Probiotika" },
      { useCase: "Antibiotika-Nachsorge", query: "Antibiotika Darm Forum" },
    ],
  },
  {
    id: "sport",
    label: "Sport",
    match: /kraftsport|ausdauer|sportliche?\s+regeneration/i,
    uses: [{ useCase: "Regeneration", query: "Sport Regeneration Supplement Forum" }],
  },
];

const BUY_PATH = /kaufen|bestellen|warenkorb|\bshop\b/i;

export function shopNames(input: { name?: string | null; brandName?: string | null }): string[] {
  const names = [input.brandName, input.name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 2);
  return [...new Set(names)];
}

export function stripShopNames(text: string, shops: readonly string[]): string {
  let result = text;
  for (const shop of shops) {
    const escaped = shop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "ig"), " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

export function queryOmitsShop(query: string, shops: readonly string[]): boolean {
  const folded = query.toLowerCase();
  return shops.every((shop) => {
    const token = shop.trim().toLowerCase();
    return token.length < 3 || !folded.includes(token);
  });
}

/** A line for the feed. Shown only after a search has been counted. */
export function searchedGoogleLine(query: string): string {
  return `Searched Google.de for ${query}`;
}

export function pageKind(url: string): PageKind {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url;
  }
  return BUY_PATH.test(path) ? "buy" : "ratgeber";
}

function catalogBlob(input: ProblemQueryInput): string {
  const parts: string[] = [];
  if (input.topic) parts.push(input.topic);
  for (const keyword of input.keywords ?? []) parts.push(keyword);
  for (const page of input.pages ?? []) {
    if (page.url) parts.push(page.url);
    if (page.title) parts.push(page.title);
    if (page.keyword) parts.push(page.keyword);
  }
  return stripShopNames(parts.join("\n"), shopNames(input));
}

function matchedNutrients(text: string): Nutrient[] {
  const found: { nutrient: Nutrient; at: number }[] = [];
  for (const nutrient of NUTRIENTS) {
    const match = nutrient.match.exec(text);
    if (!match || match.index < 0) continue;
    found.push({ nutrient, at: match.index });
  }
  found.sort((left, right) => left.at - right.at);
  return found.map((item) => item.nutrient);
}

function targetsFromPages(pages: ProblemQueryInput["pages"]): CatalogTarget[] {
  const targets: CatalogTarget[] = [];
  for (const page of pages ?? []) {
    const url = page.url?.trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    targets.push({ url, kind: pageKind(url) });
  }
  return targets;
}

function destinationFor(
  nutrient: Nutrient,
  targets: readonly CatalogTarget[],
): { url: string | null; kind: PageKind | null } {
  const related = targets.filter((target) => nutrient.match.test(stripShopNames(target.url, [])));
  const ratgeber = related.find((target) => target.kind === "ratgeber");
  if (ratgeber) return { url: ratgeber.url, kind: "ratgeber" };
  return { url: null, kind: null };
}

/** Use-case lanes for every nutrient the pages and catalog actually mention. */
export function useCaseLanes(input: ProblemQueryInput): UseCaseLane[] {
  const text = catalogBlob(input);
  if (!text) return [];
  const targets = targetsFromPages(input.pages);
  const lanes: UseCaseLane[] = [];
  for (const nutrient of matchedNutrients(text)) {
    const destination = destinationFor(nutrient, targets);
    for (const use of nutrient.uses) {
      if (!queryOmitsShop(use.query, shopNames(input))) continue;
      lanes.push({
        id: `${nutrient.id}-${lanes.length + 1}`,
        nutrient: nutrient.label,
        useCase: use.useCase,
        query: use.query,
        market: "DE",
        destinationUrl: destination.url,
        destinationKind: destination.kind,
      });
    }
  }
  return lanes;
}

/** The query the computer opens. Null when the catalog has no human problem. */
export function primaryProblemQuery(input: ProblemQueryInput): string | null {
  return useCaseLanes(input)[0]?.query ?? null;
}

/**
 * One thread, one deep URL. A buy question gets the buy page. Anything else gets the Ratgeber.
 * The shop name is not part of the search that found the thread.
 */
export function matchDeepLink(input: {
  threadText: string;
  targets: readonly { url: string }[];
}): string | null {
  const pages = input.targets
    .map((target) => target.url.trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .map((url) => ({ url, kind: pageKind(url) }));
  if (pages.length === 0) return null;
  const nutrient = matchedNutrients(input.threadText)[0];
  if (!nutrient) return null;
  const related = pages.filter((page) => nutrient.match.test(page.url));
  if (related.length === 0) return null;
  const buyThread = /kaufen|bestellen|preis|\bshop\b/i.test(input.threadText);
  const wanted = buyThread ? "buy" : "ratgeber";
  return related.find((page) => page.kind === wanted)?.url ?? null;
}

export function primaryProblemQueryFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): string | null {
  return primaryProblemQuery(problemInputFromProject(project));
}

/**
 * Terms for the board's own search box.
 * The Google query ends in "Forum"; that word is useless once we are already on a board.
 */
export function boardTopicQueries(input: ProblemQueryInput): string[] {
  const first = useCaseLanes(input)[0];
  if (!first) return [];
  const queries: string[] = [];
  const push = (value: string) => {
    const cleaned = value
      .replace(/\b(?:forum|deutschland)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < 2) return;
    if (queries.some((query) => query.toLowerCase() === cleaned.toLowerCase())) return;
    queries.push(cleaned);
  };
  push(first.query);
  push(first.nutrient);
  return queries.slice(0, 2);
}

export function boardTopicQueriesFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): string[] {
  return boardTopicQueries(problemInputFromProject(project));
}

/** Topic the relevance check should use: the symptom, not the shop keyword. */
export function relevanceTopicFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): { tag: string; description: string } {
  const lane =
    Array.isArray(project.topicLanes) && project.topicLanes[0] && typeof project.topicLanes[0] === "object"
      ? (project.topicLanes[0] as { tag?: unknown; description?: unknown })
      : undefined;
  const laneTag = typeof lane?.tag === "string" ? lane.tag.trim() : "";
  const laneDescription = typeof lane?.description === "string" ? lane.description.trim() : "";
  const problem = useCaseLanes(problemInputFromProject(project))[0];
  if (!problem) return { tag: laneTag || "topic", description: laneDescription };
  return {
    tag: problem.useCase,
    description: `Threads about ${problem.useCase} are on topic. ${problem.nutrient} is one possible answer. The thread does not have to name ${problem.nutrient}.`,
  };
}

export function problemInputFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): ProblemQueryInput {
  const pages: { url?: string; title?: string; keyword?: string }[] = [];
  const keywords: string[] = [];
  if (Array.isArray(project.topicLanes)) {
    for (const lane of project.topicLanes) {
      if (!lane || typeof lane !== "object") continue;
      const record = lane as { tag?: unknown; description?: unknown };
      if (typeof record.tag === "string") keywords.push(record.tag);
      if (typeof record.description === "string") keywords.push(record.description);
    }
  }
  if (Array.isArray(project.targets)) {
    for (const target of project.targets) {
      if (!target || typeof target !== "object") continue;
      const record = target as {
        url?: unknown;
        description?: unknown;
        keywordClusters?: unknown;
      };
      const keyword = Array.isArray(record.keywordClusters)
        ? record.keywordClusters
            .filter((item): item is string => typeof item === "string")
            .join(" ")
        : "";
      pages.push({
        ...(typeof record.url === "string" ? { url: record.url } : {}),
        ...(typeof record.description === "string" ? { title: record.description } : {}),
        ...(keyword ? { keyword } : {}),
      });
      if (keyword) keywords.push(keyword);
    }
  }
  return {
    name: project.name,
    brandName: project.brandName,
    keywords,
    pages,
  };
}
