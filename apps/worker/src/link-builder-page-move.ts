import type { BoardThread } from "@rakazo/linkbuilder-drivers";

/**
 * One look when the forum rules find no thread on a page that is already open.
 * Browser agents do the same: read the page, take one next action, then change
 * strategy if the page did not move. We never follow a URL the model invented.
 */
export const PAGE_LOOK_MODEL = "x-ai/grok-4.7";
export const PAGE_LOOK_WAIT_MS = 45_000;

export interface PageLink {
  text: string;
  url: string;
}

const UTILITY_TEXT =
  /^(abmelden|logout|log ?out|anmelden|login|sign in|register|registrieren|suche|search|hilfe|help|portal|impressum|datenschutz|privacy|kontakt|contact|home|startseite)$/i;
const UTILITY_HREF = /logout|logoff|mode=login|mode=register|search\.php|ucp\.php/i;
const THREAD_HREF = /viewtopic|showthread|thread-\d+|[?&/]thread[/=]|\/topic\/|\/t\/\d+/i;
const BOARD_HREF = /viewforum|forumdisplay|forum-\d+|[?&/]board[/=]|\/forum\/|f=\d+/i;

export function sameSiteUrl(href: string, pageUrl: string, domain: string): string | null {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const site = domain.replace(/^www\./, "").toLowerCase();
    if (host !== site && !host.endsWith(`.${site}`)) return null;
    if (UTILITY_HREF.test(`${url.pathname}${url.search}`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function usablePageLinks(
  anchors: readonly { text: string; href: string }[],
  pageUrl: string,
  domain: string,
): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  let current = "";
  try {
    current = new URL(pageUrl).href;
  } catch {
    current = pageUrl;
  }
  for (const item of anchors) {
    const text = item.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 120 || UTILITY_TEXT.test(text)) continue;
    const url = sameSiteUrl(item.href, pageUrl, domain);
    if (!url || url === current || seen.has(url)) continue;
    seen.add(url);
    links.push({ text, url });
    if (links.length >= 24) break;
  }
  return links;
}

const DROPPED_QUERY = new Set(["action", "postid", "p", "start", "page", "sid", "view"]);

/**
 * One thread, whatever last-post anchor or session id the listing used.
 * phpBB `t` and `f` stay. WoltLab and diabetes topic ids drop the slug.
 */
export function threadKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.split("#")[0]?.toLowerCase() ?? url.toLowerCase();
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    if (DROPPED_QUERY.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.pathname = parsed.pathname
    .replace(/\/page\/\d+\/?$/i, "/")
    .replace(/\/seite-\d+\/?$/i, "/")
    .replace(/\/forum\/thread\/(\d+)-[^/]+\/?$/i, "/forum/thread/$1/")
    .replace(/\/forum\/topic\/(\d+)\/[^/]+\/?$/i, "/forum/topic/$1/");
  const keys = [...parsed.searchParams.keys()].sort();
  const search = new URLSearchParams();
  for (const key of keys) {
    const value = parsed.searchParams.get(key);
    if (value !== null) search.set(key, value);
  }
  const query = search.toString();
  return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
}

function withoutFirstNew(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("action") === "firstNew") {
      parsed.searchParams.delete("action");
      parsed.hash = "";
    }
    return parsed.href;
  } catch {
    return url.replace(/\?action=firstNew$/, "");
  }
}

export function threadsFromLinks(links: readonly PageLink[]): BoardThread[] {
  return links
    .filter((link) => THREAD_HREF.test(link.url))
    .slice(0, 8)
    .map((link) => ({
      url: withoutFirstNew(link.url),
      title: link.text,
      openQuestion: /\?/.test(link.text),
    }));
}

export function boardLink(
  links: readonly PageLink[],
  topicWords: readonly string[],
): PageLink | null {
  const boards = links.filter((link) => BOARD_HREF.test(link.url) && !THREAD_HREF.test(link.url));
  if (boards.length === 0) return null;
  const words = topicWords.map((word) => word.toLowerCase()).filter((word) => word.length > 3);
  return (
    boards.find((link) => words.some((word) => link.text.toLowerCase().includes(word))) ??
    boards[0] ??
    null
  );
}

/** Accept only an index from the list we showed the model. */
export function chosenLink(
  links: readonly PageLink[],
  action: string,
  index: number | undefined,
): PageLink | null {
  if (action !== "open" || index === undefined || !Number.isInteger(index)) return null;
  if (index < 0 || index >= links.length) return null;
  return links[index] ?? null;
}

export function pageLookPrompt(links: readonly PageLink[]): string {
  const lines = links.map((link, index) => `${index}. ${link.text} — ${link.url}`);
  return [
    "The page is already open. The rules found no thread.",
    "Pick one link that opens a forum board or a discussion, or skip.",
    "Do not pick logout, login, search, or the page that is already open.",
    "Links:",
    ...lines,
    'Reply JSON only: {"action":"open","index":0} or {"action":"skip"}',
  ].join("\n");
}

export const PAGE_LOOK_SYSTEM =
  "You choose the next page on a forum that is already open. Pick only an index from the list. Never invent a URL. If none is a board or a thread, skip.";
