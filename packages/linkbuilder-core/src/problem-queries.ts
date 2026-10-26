/**
 * Discovery searches the human problem, never the shop.
 * German DE/AT/CH queries come from the topic map. The shop name is only a later deep link.
 */

export const PROBLEM_MARKETS = ["DE", "AT", "CH"] as const;
export type ProblemMarket = string;

export interface ProblemQueryInput {
  language?: string | null;
  country?: string | null;
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
  /** A topic query in the configured language. Never includes the shop name. */
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
    match: /vitamin[\s-]*d|vitamin[\s-]*k2|\bk2[\s-]*vitamin/i,
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
    match: /vitamin[\s-]*b12|\bb12\b|b-komplex|b komplex/i,
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
      { useCase: "Kinder", query: "Kind schläft nicht ein Forum" },
    ],
  },
  {
    id: "creatin",
    label: "Kreatin",
    match: /creatin|kreatin/i,
    uses: [
      { useCase: "Krafttraining", query: "Kreatin Krafttraining Forum" },
      { useCase: "Muskelaufbau", query: "Kreatin Muskelaufbau Forum" },
      { useCase: "Regeneration", query: "Kreatin Regeneration Sport Forum" },
      { useCase: "Energie", query: "Kreatin Energie Training Forum" },
    ],
  },
  {
    id: "folsaeure",
    label: "Folsäure",
    match: /fols[aä]ure|folsaeure|folic/i,
    uses: [
      { useCase: "Mangel", query: "Folsäure Mangel Forum" },
      { useCase: "Müdigkeit", query: "Folsäure Müdigkeit Forum" },
      { useCase: "Blutbildung", query: "Folsäure Blutwerte Forum" },
    ],
  },
  {
    id: "sango",
    label: "Sango",
    match: /sango|meeres[\s-]*koralle/i,
    uses: [
      { useCase: "Knochen", query: "Knochenschmerzen Forum" },
      { useCase: "Krämpfe", query: "Wadenkrämpfe Forum" },
      { useCase: "Kalzium", query: "Kalzium Mangel Forum" },
    ],
  },
  {
    id: "spirulina",
    label: "Spirulina",
    match: /spirulina/i,
    uses: [
      { useCase: "Energie", query: "Müdigkeit Energie Forum" },
      { useCase: "Eisen", query: "Eisenmangel Forum" },
      { useCase: "Immun", query: "Immunsystem schwach Forum" },
    ],
  },
  {
    id: "vitamin-b",
    label: "Vitamin B",
    match: /vitamin[\s-]*b(?![\s-]*12)\b|b[\s-]*complex|b[\s-]*komplex/i,
    uses: [
      { useCase: "Müdigkeit", query: "Vitamin B Müdigkeit Forum" },
      { useCase: "Mangel", query: "Vitamin B Mangel Forum" },
      { useCase: "Nerven", query: "Vitamin B Nerven Forum" },
    ],
  },
  {
    id: "stimmung",
    label: "Stimmung",
    match: /stimmungsaufheller|stimmungstief/i,
    uses: [
      { useCase: "Stimmung", query: "Stimmungstief Forum" },
      { useCase: "Antrieb", query: "Antriebslosigkeit Forum" },
      { useCase: "Schlaf", query: "schlechte Stimmung Schlaf Forum" },
    ],
  },
  {
    id: "einschlafen",
    label: "Einschlafen",
    match: /tipps zum einschlafen|nicht einschlafen|einschlafprobleme/i,
    uses: [
      { useCase: "Einschlafen", query: "nicht einschlafen können Forum" },
      { useCase: "Schlaf", query: "Einschlafprobleme Forum" },
      { useCase: "Nacht", query: "nachts wach liegen Forum" },
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
  if (input.language && !/^de(?:-|$)/i.test(input.language)) {
    return configuredTopicLanes(input);
  }
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

function configuredTopicLanes(input: ProblemQueryInput): UseCaseLane[] {
  const shops = shopNames(input);
  const candidates = [
    input.topic,
    ...(input.keywords ?? []),
    ...(input.pages ?? []).map((p) => p.keyword),
  ];
  const topics = new Map<string, string>();
  for (const value of candidates.flatMap((value) =>
    typeof value === "string" ? value.split(/[,;\n]+/) : [],
  )) {
    if (typeof value !== "string" || /https?:\/\/|www\.|[\w-]+\.[a-z]{2,}(?:\b|\/)/i.test(value))
      continue;
    const topic = stripShopNames(value, shops)
      .replace(/\b(?:buy|shop|kaufen|bestellen)\b/gi, " ")
      .replace(/\bforums?\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      topic.length < 2 ||
      topic.length > 80 ||
      /[<>"'\\]/.test(topic) ||
      !queryOmitsShop(topic, shops)
    )
      continue;
    topics.set(topic.toLowerCase(), topics.get(topic.toLowerCase()) ?? topic);
  }
  const market = /^[A-Z]{2}$/.test(input.country ?? "") ? input.country! : "US";
  return [...topics.values()].map((topic, index) => ({
    id: `configured-${index + 1}`,
    nutrient: topic,
    useCase: topic,
    query: `${topic} forum`,
    market,
    destinationUrl: null,
    destinationKind: null,
  }));
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
  markets?: unknown;
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
  markets?: unknown;
}): string[] {
  return boardTopicQueries(problemInputFromProject(project));
}

/** Topic the relevance check should use: the symptom, not the shop keyword. */
export function relevanceTopicFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
  markets?: unknown;
}): { tag: string; description: string } {
  const lane =
    Array.isArray(project.topicLanes) &&
    project.topicLanes[0] &&
    typeof project.topicLanes[0] === "object"
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

/** Every use case, not only the first. Search queries still use `relevanceTopicFromProject`. */
export function relevanceTopicsFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
  markets?: unknown;
}): { tag: string; description: string } {
  const lanes = useCaseLanes(problemInputFromProject(project));
  const nutrients: string[] = [];
  const groups: string[][] = [];
  let group: string[] = [];
  let previousNutrient = "";
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!nutrients.some((item) => item.toLowerCase() === lane.nutrient.toLowerCase())) {
      nutrients.push(lane.nutrient);
    }
    const key = lane.useCase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (lane.nutrient !== previousNutrient) {
      if (group.length > 0) groups.push(group);
      group = [];
      previousNutrient = lane.nutrient;
    }
    group.push(lane.useCase);
  }
  if (group.length > 0) groups.push(group);
  const listed: string[] = [];
  for (let depth = 0; listed.length < 24; depth += 1) {
    let added = false;
    for (const uses of groups) {
      const useCase = uses[depth];
      if (!useCase) continue;
      listed.push(useCase);
      added = true;
      if (listed.length >= 24) break;
    }
    if (!added) break;
  }
  const foods = nutrients.slice(0, 24);
  if (listed.length === 0) return relevanceTopicFromProject(project);
  const description = [
    `Threads about any of these everyday problems are on topic: ${listed.join(", ")}.`,
    `Helpful nutrients: ${foods.join(", ")}.`,
    "Diet, blood values, deficiencies, and medication side effects that touch these nutrients also count.",
    "The thread does not have to name a nutrient or a product.",
  ].join(" ");
  return { tag: listed.join(", "), description: description.slice(0, 1_500) };
}

export function problemInputFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
  markets?: unknown;
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
  const market = Array.isArray(project.markets) ? project.markets[0] : null;
  return {
    ...(typeof market?.language === "string" ? { language: market.language } : {}),
    ...(typeof market?.country === "string" ? { country: market.country } : {}),
    name: project.name,
    brandName: project.brandName,
    keywords,
    pages,
  };
}
