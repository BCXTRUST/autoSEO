import type { BrowserSession } from "@rakazo/adapter-kit";
import { load } from "cheerio";

export interface ThreadPostMeta {
  author: string;
  at: string | null;
  /** First 400 characters of the post body, without the author sidebar. */
  text?: string;
}

export interface ThreadMeta {
  lastActivityAt: string | null;
  posts: ThreadPostMeta[];
  closed: boolean;
  section: string | null;
  /** Visible text of the opening post, used by the topic gate. */
  firstPost: string;
  /** The page HTML could not be read, so an empty date is not a stale thread. */
  unreadable?: boolean;
}

const MONTHS: Record<string, number> = {
  januar: 1,
  februar: 2,
  marz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

function foldMonth(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss");
}

function iso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

/** German dates as they appear on forum posts, including Heute and Gestern. */
export function parseGermanDate(text: string, now: Date): string | null {
  const today = /heute,?\s*(\d{1,2}):(\d{2})/i.exec(text);
  if (today) {
    const at = new Date(now.getTime());
    at.setHours(Number(today[1]), Number(today[2]), 0, 0);
    return at.toISOString();
  }
  const yesterday = /gestern,?\s*(\d{1,2}):(\d{2})/i.exec(text);
  if (yesterday) {
    const at = new Date(now.getTime() - 86_400_000);
    at.setHours(Number(yesterday[1]), Number(yesterday[2]), 0, 0);
    return at.toISOString();
  }
  const numeric = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    text,
  );
  if (numeric) {
    return iso(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
      numeric[4] ? Number(numeric[4]) : 0,
      numeric[5] ? Number(numeric[5]) : 0,
      numeric[6] ? Number(numeric[6]) : 0,
    );
  }
  const named =
    /(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜß]+)\s+(\d{4})(?:\s+um\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
      text,
    );
  if (named) {
    const month = MONTHS[foldMonth(named[2] ?? "")];
    if (!month) return null;
    return iso(
      Number(named[3]),
      month,
      Number(named[1]),
      named[4] ? Number(named[4]) : 0,
      named[5] ? Number(named[5]) : 0,
      named[6] ? Number(named[6]) : 0,
    );
  }
  return null;
}

function zoneOffsetMs(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = value("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function zonedIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone?: string,
): string | null {
  if (!timeZone) return iso(year, month, day, hour, minute, second);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(timeZone, new Date(wall));
  const secondOffset = zoneOffsetMs(timeZone, new Date(wall - first));
  const at = new Date(wall - secondOffset);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

function zonedParts(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day") };
}

function skippedDate(text: string, index: number): boolean {
  for (const match of text.matchAll(/mitglied seit|registriert|dabei seit|beigetreten|joined/gi)) {
    const start = match.index ?? 0;
    if (index >= start && index < start + match[0].length + 24) return true;
  }
  return false;
}

/**
 * The post time, not the author's join date. A date with a clock wins.
 * diabetes-forum.de shows "Mitglied seit" before "am DD.MM.YYYY HH:MM:SS".
 */
export function parseGermanPostDate(text: string, now: Date, timeZone?: string): string | null {
  const timed: string[] = [];
  const plain: string[] = [];
  const push = (index: number, value: string | null, hasTime: boolean) => {
    if (!value || skippedDate(text, index)) return;
    (hasTime ? timed : plain).push(value);
  };
  for (const match of text.matchAll(/heute,?\s*(\d{1,2}):(\d{2})/gi)) {
    const parts = timeZone ? zonedParts(now, timeZone) : null;
    const at = parts
      ? zonedIso(
          parts.year,
          parts.month,
          parts.day,
          Number(match[1]),
          Number(match[2]),
          0,
          timeZone,
        )
      : (() => {
          const date = new Date(now.getTime());
          date.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
          return date.toISOString();
        })();
    push(match.index ?? 0, at, true);
  }
  for (const match of text.matchAll(/gestern,?\s*(\d{1,2}):(\d{2})/gi)) {
    const base = new Date(now.getTime() - 86_400_000);
    const parts = timeZone ? zonedParts(base, timeZone) : null;
    const at = parts
      ? zonedIso(
          parts.year,
          parts.month,
          parts.day,
          Number(match[1]),
          Number(match[2]),
          0,
          timeZone,
        )
      : (() => {
          base.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
          return base.toISOString();
        })();
    push(match.index ?? 0, at, true);
  }
  for (const match of text.matchAll(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/g,
  )) {
    const hasTime = match[4] !== undefined;
    push(
      match.index ?? 0,
      zonedIso(
        Number(match[3]),
        Number(match[2]),
        Number(match[1]),
        hasTime ? Number(match[4]) : 0,
        hasTime ? Number(match[5]) : 0,
        hasTime && match[6] ? Number(match[6]) : 0,
        timeZone,
      ),
      hasTime,
    );
  }
  for (const match of text.matchAll(
    /(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜß]+)\s+(\d{4})(?:\s+um\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/g,
  )) {
    const month = MONTHS[foldMonth(match[2] ?? "")];
    if (!month) continue;
    const hasTime = match[4] !== undefined;
    push(
      match.index ?? 0,
      zonedIso(
        Number(match[3]),
        month,
        Number(match[1]),
        hasTime ? Number(match[4]) : 0,
        hasTime && match[5] ? Number(match[5]) : 0,
        hasTime && match[6] ? Number(match[6]) : 0,
        timeZone,
      ),
      hasTime,
    );
  }
  if (timed[0]) return timed[0];
  if (plain[0]) return plain[0];
  return parseGermanDate(text, now);
}

function newestAt(posts: ThreadPostMeta[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const post of posts) {
    if (!post.at) continue;
    const ms = Date.parse(post.at);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    bestMs = ms;
    best = post.at;
  }
  return best;
}

type Loaded = ReturnType<typeof load>;

/** Closed is a thread-header fact. Inline language packs say "Geschlossen" on every page. */
function threadIsClosed($: Loaded, kind: "woltlab" | "phpbb" | "markup"): boolean {
  if (kind === "woltlab") {
    if ($(".contentHeader[data-is-closed='1'], .wbbThread[data-is-closed='1']").length > 0) {
      return true;
    }
    if (
      $(".contentHeader .jsIconClosed, .contentHeaderIcon .fa-lock, .wbbThreadClosed").length > 0
    ) {
      return true;
    }
    const loggedIn = $("a.logout, a[href*='logout'], a[href*='logoff']").length > 0;
    const canReply =
      $("a[href*='action=reply'], a[href*='action=add'], textarea[name='text']").length > 0;
    return loggedIn && !canReply;
  }
  if (kind === "phpbb") {
    if ($(".action-bar .fa-lock, .action-bar .icon-lock").length > 0) return true;
    return /dieses thema ist gesperrt/i.test($(".action-bar").text());
  }
  const header = $(".topic-header, .contentHeader, h1").first();
  return header.find(".locked, [title*='geschlossen' i]").length > 0;
}

const AUTHOR_LINK =
  "a[href*='/user/'], a[href*='/profile/'], a[href*='/member'], a[href*='memberlist']";

const SIDEBAR =
  ".forum-user, .member, .postprofile, .userinfo, .user-info, .messageSidebar, .author-info";

function postBodyText(post: ReturnType<Loaded>, selector: string): string {
  const body = post.clone();
  body.find(SIDEBAR).remove();
  const node = selector ? body.find(selector).first() : body;
  const source = node.length > 0 ? node : body;
  return source.text().replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Posts on boards without a platform reader, including diabetes-forum.de `li[id^=m_]`. */
export function genericPostsFromHtml(
  html: string,
  now = new Date(),
  timeZone?: string,
): ThreadPostMeta[] {
  const $ = load(html);
  $("script, style, template, noscript").remove();
  return genericPosts($, now, timeZone);
}

function genericPosts($: Loaded, now: Date, timeZone?: string): ThreadPostMeta[] {
  const byId = $("[id]").filter((_, el) => /^(?:m_|p|post|msg)\d+$/i.test($(el).attr("id") ?? ""));
  const nodes = byId.length > 0 ? byId : $("article, .post, .message");
  const posts: ThreadPostMeta[] = [];
  nodes.each((_, node) => {
    const post = $(node);
    const author = post.find(AUTHOR_LINK).first().text().replace(/\s+/g, " ").trim();
    const body = post.clone();
    body.find(SIDEBAR).remove();
    const text = body.text().replace(/\s+/g, " ").trim();
    const at = parseGermanPostDate(text, now, timeZone);
    if (!author && !at) return;
    posts.push({
      author,
      at,
      text: postBodyText(post, ".forumcontent, .messageText, .postbody .content, .post .content"),
    });
  });
  return posts;
}

/** WoltLab jumps to the newest post. One-page threads still show the opener there. */
export function woltlabLastPageUrl(threadUrl: string): string {
  const url = new URL(threadUrl);
  url.hash = "";
  url.search = "";
  url.searchParams.set("action", "lastPost");
  return url.href;
}

/** Highest phpBB `start=` page, or null when the thread has no later page. */
export function phpbbLastPageUrl(html: string, pageUrl: string): string | null {
  const $ = load(html);
  let best = 0;
  let href: string | null = null;
  $("a[href*='start=']").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let absolute: URL;
    try {
      absolute = new URL(raw, pageUrl);
    } catch {
      return;
    }
    const start = Number(absolute.searchParams.get("start"));
    if (!Number.isFinite(start) || start <= best) return;
    best = start;
    href = absolute.href;
  });
  return href;
}

/**
 * Highest `page=` link. diabetes-forum.de offers `pagesize=100`, which puts the
 * newest posts on one fetch.
 */
export function genericLastPageUrl(html: string, pageUrl: string): string | null {
  const $ = load(html);
  const wide = $("a[href*='pagesize=100']").first().attr("href");
  if (wide) {
    try {
      return new URL(wide, pageUrl).href;
    } catch {
      // Fall through to numbered pages.
    }
  }
  let best = 1;
  let href: string | null = null;
  $("a[href*='page=']").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let absolute: URL;
    try {
      absolute = new URL(raw, pageUrl);
    } catch {
      return;
    }
    const page = Number(absolute.searchParams.get("page"));
    if (!Number.isFinite(page) || page <= best) return;
    best = page;
    href = absolute.href;
  });
  return href;
}

function postIdFromPermalink(permalink: string | null | undefined): string | null {
  if (!permalink) return null;
  const hash = /#((?:post|m_|p|msg)\d+)/i.exec(permalink);
  if (hash?.[1]) return hash[1];
  const query = /[?&]postID=(\d+)/i.exec(permalink);
  if (query?.[1]) return `post${query[1]}`;
  return null;
}

/**
 * Moderation text counts only inside our post, or in a flash shown right after submit.
 * A public moderator log on the same page is not our post.
 */
export function moderationScope(
  html: string,
  username: string,
  permalink?: string | null,
): { ownPost: string; banner: string; pageText: string } {
  const $ = load(html);
  $("script, style, template, noscript").remove();
  const id = postIdFromPermalink(permalink);
  let own = "";
  if (id) {
    const node = $(`[id='${id.replace(/'/g, "")}']`);
    if (node.length > 0) own = node.text();
  }
  if (!own && username.trim()) {
    const named = username.trim().toLowerCase();
    $("article, .post, .message, li[id]").each((_, node) => {
      if (own) return;
      const text = $(node).text();
      if (text.toLowerCase().includes(named)) own = text;
    });
  }
  const banner = $(
    ".systemMessage, .innerSuccess, .flashMessage, .alert, [role='alert'], .success",
  ).text();
  return {
    ownPost: own.replace(/\s+/g, " ").trim(),
    banner: banner.replace(/\s+/g, " ").trim(),
    pageText: $("body").text().replace(/\s+/g, " ").trim(),
  };
}

/** True when the HTML has no link to a second page. */
export function fitsOnOnePage(html: string): boolean {
  if (/[?&]pageNo=([2-9]|\d{2,})/i.test(html)) return false;
  if (/[?&](?:page|seite)=([2-9]|\d{2,})/i.test(html)) return false;
  if (/[?&]start=[1-9]\d*/i.test(html)) return false;
  if (/woltlab-core-pagination[^>]*\bcount="(?:[2-9]|\d{2,})"/i.test(html)) return false;
  return true;
}

/** Reads posts, the board section, and whether replies are closed. */
export function threadMetaFromHtml(
  html: string,
  kind: "woltlab" | "phpbb" | "markup",
  now = new Date(),
  timeZone?: string,
): ThreadMeta {
  const $ = load(html);
  $("script, style, template, noscript").remove();
  const posts: ThreadPostMeta[] = [];
  if (kind === "woltlab") {
    $("article.message").each((_, node) => {
      const post = $(node);
      const author = post
        .find(".messageAuthor .username")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const at =
        post.find(".messagePublicationTime woltlab-core-date-time").attr("date") ||
        post.find("time[datetime]").attr("datetime") ||
        null;
      if (!author && !at) return;
      posts.push({ author, at, text: postBodyText(post, ".messageText") });
    });
  } else if (kind === "phpbb") {
    $(".post").each((_, node) => {
      const post = $(node);
      const author = post.find(".postprofile .username").first().text().replace(/\s+/g, " ").trim();
      const at = post.find(".author time[datetime]").attr("datetime") || null;
      if (!author && !at) return;
      posts.push({ author, at, text: postBodyText(post, ".content") });
    });
  } else {
    posts.push(...genericPosts($, now, timeZone));
  }
  if (posts.length === 0) {
    const visible = parseGermanDate($("body").text(), now);
    if (visible) posts.push({ author: "", at: visible });
  }
  const section =
    kind === "phpbb"
      ? $(".crumb a, .crumbs a, ul.navlinks a").last().text().replace(/\s+/g, " ").trim() || null
      : $(".breadcrumbs a .breadcrumbs__title, .breadcrumbs a, .breadcrumb a")
          .last()
          .text()
          .replace(/\s+/g, " ")
          .trim() || null;
  const firstPost = (
    kind === "woltlab"
      ? $("article.message .messageText").first().text()
      : kind === "phpbb"
        ? $(".post .content").first().text()
        : $(".messageText, .postbody .content, .post .content, .forumcontent").first().text()
  )
    .replace(/\s+/g, " ")
    .trim();
  return {
    lastActivityAt: newestAt(posts),
    posts,
    closed: threadIsClosed($, kind),
    section,
    firstPost,
  };
}

function unreadableMeta(): ThreadMeta {
  return {
    lastActivityAt: null,
    posts: [],
    closed: false,
    section: null,
    firstPost: "",
    unreadable: true,
  };
}

export async function readThreadMetaFromSession(
  session: BrowserSession,
  kind: "woltlab" | "phpbb" | "markup",
): Promise<ThreadMeta> {
  const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
  if (!html) return unreadableMeta();
  let timeZone: string | undefined;
  if (kind === "markup" && session.url) {
    const url = await session.url().catch(() => "");
    if (/diabetes-forum\.de/i.test(url)) timeZone = "Europe/Berlin";
  }
  return threadMetaFromHtml(html, kind, new Date(), timeZone);
}
