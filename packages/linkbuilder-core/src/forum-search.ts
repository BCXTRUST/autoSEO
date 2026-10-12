import { isFixtureHostDomain } from "./fake-scenario.js";
import {
  type ProblemQueryInput,
  primaryProblemQuery,
  primaryProblemQueryFromProject,
  shopNames,
} from "./problem-queries.js";

/** Google.de. The computer searches a problem, never the shop. */
const SEARCH_ORIGIN = "https://www.google.de/search";

export interface ForumSearchInput extends ProblemQueryInput {}

/** A search term we can type. Blank text, URLs, and example hosts are not a topic. */
export function forumSearchTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  if (/^https?:/i.test(cleaned)) return null;
  if (/\.example\b/i.test(cleaned) || isFixtureHostDomain(cleaned)) return null;
  if (/[<>"'\\]/.test(cleaned)) return null;
  return cleaned;
}

export function forumSearchQuery(input: ForumSearchInput): string {
  const query = primaryProblemQuery(input);
  if (!query) return "on-topic forums";
  const shops = shopNames(input);
  const folded = query.toLowerCase();
  if (shops.some((shop) => folded.includes(shop.toLowerCase()))) return "on-topic forums";
  return query;
}

/** Google search for the stored topic. Never a forum host and never an example domain. */
export function forumSearchUrl(input: ForumSearchInput): string {
  const url = new URL(SEARCH_ORIGIN);
  url.searchParams.set("q", forumSearchQuery(input));
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  return url.toString();
}

export function topicFromLanes(lanes: unknown): string | null {
  if (!Array.isArray(lanes)) return null;
  for (const lane of lanes) {
    if (!lane || typeof lane !== "object") continue;
    const record = lane as { tag?: unknown; description?: unknown };
    const tag = forumSearchTerm(record.tag);
    if (tag) return tag;
    const description = forumSearchTerm(record.description);
    if (description) return description;
  }
  return null;
}

export function keywordsFromTargets(targets: unknown): string[] {
  if (!Array.isArray(targets)) return [];
  const keywords: string[] = [];
  for (const target of targets) {
    if (!target || typeof target !== "object") continue;
    const clusters = (target as { keywordClusters?: unknown }).keywordClusters;
    if (!Array.isArray(clusters)) continue;
    for (const cluster of clusters) {
      const term = forumSearchTerm(cluster);
      if (term) keywords.push(term);
    }
  }
  return keywords;
}

export function forumSearchUrlFromProject(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): string {
  const fromCatalog = primaryProblemQueryFromProject(project);
  return forumSearchUrl({
    name: project.name,
    brandName: project.brandName,
    topic: fromCatalog ?? topicFromLanes(project.topicLanes),
    keywords: fromCatalog ? [fromCatalog] : keywordsFromTargets(project.targets),
    pages: pagesFromTargets(project.targets),
  });
}

function pagesFromTargets(targets: unknown): ProblemQueryInput["pages"] {
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target) => {
    if (!target || typeof target !== "object") return [];
    const record = target as { url?: unknown; description?: unknown; keywordClusters?: unknown };
    const keyword = Array.isArray(record.keywordClusters)
      ? record.keywordClusters.filter((item): item is string => typeof item === "string").join(" ")
      : "";
    return [
      {
        ...(typeof record.url === "string" ? { url: record.url } : {}),
        ...(typeof record.description === "string" ? { title: record.description } : {}),
        ...(keyword ? { keyword } : {}),
      },
    ];
  });
}

function foldTitle(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** True when a visible window is already a Google search or results page. */
export function desktopShowsForumSearch(titles: readonly string[]): boolean {
  for (const title of titles) {
    const text = title.trim();
    if (!text || /sorry|unusual traffic|captcha/i.test(text)) continue;
    if (/welcome to google chrome|can.?t update|couldn.?t update|reinstall chrome/i.test(text)) {
      continue;
    }
    if (/google (?:search|suche)/i.test(text)) return true;
  }
  return false;
}

/**
 * True when the visible Google results are this problem query.
 * A shop name in the title is the wrong search and must be replaced.
 */
export function desktopShowsProblemSearch(
  titles: readonly string[],
  query: string,
  shopNames: readonly string[] = [],
): boolean {
  const needle = foldTitle(query.trim());
  const words = needle.split(/\s+/).filter((word) => word.length > 2);
  if (words.length === 0) return false;
  const shops = shopNames.map((shop) => foldTitle(shop.trim())).filter((shop) => shop.length > 2);
  for (const title of titles) {
    const text = title.trim();
    if (!text || /sorry|unusual traffic|captcha/i.test(text)) continue;
    if (/welcome to google chrome|can.?t update|couldn.?t update|reinstall chrome/i.test(text)) {
      continue;
    }
    if (!/google (?:search|suche)/i.test(text)) continue;
    const folded = foldTitle(text);
    if (shops.some((shop) => folded.includes(shop))) continue;
    if (words.every((word) => folded.includes(word))) return true;
  }
  return false;
}
