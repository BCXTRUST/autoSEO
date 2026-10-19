import type { BrowserSession } from "@rakazo/adapter-kit";
import { load } from "cheerio";

export interface ThreadPostMeta {
  author: string;
  at: string | null;
}

export interface ThreadMeta {
  lastActivityAt: string | null;
  posts: ThreadPostMeta[];
  closed: boolean;
  section: string | null;
  /** Visible text of the opening post, used by the topic gate. */
  firstPost: string;
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

function closedFrom(html: string, text: string): boolean {
  if (/jsThreadIsClosed|icon-lock|locked-icon|i\.icon\.fa-lock/i.test(html)) return true;
  return /(?:^|[^a-zäöü])geschlossen(?:[^a-zäöü]|$)/i.test(text);
}

/** Reads posts, the board section, and whether replies are closed. */
export function threadMetaFromHtml(
  html: string,
  kind: "woltlab" | "phpbb" | "markup",
  now = new Date(),
): ThreadMeta {
  const $ = load(html);
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
      posts.push({ author, at });
    });
  } else if (kind === "phpbb") {
    $(".post").each((_, node) => {
      const post = $(node);
      const author = post.find(".postprofile .username").first().text().replace(/\s+/g, " ").trim();
      const at = post.find(".author time[datetime]").attr("datetime") || null;
      if (!author && !at) return;
      posts.push({ author, at });
    });
  } else {
    const times = $("time[datetime]")
      .map((_, node) => $(node).attr("datetime") || "")
      .get()
      .filter(Boolean);
    const authors = $(".username, .postprofile .username")
      .map((_, node) => $(node).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    const count = Math.max(times.length, authors.length);
    for (let index = 0; index < count; index += 1) {
      posts.push({ author: authors[index] ?? "", at: times[index] ?? null });
    }
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
        : $(".messageText, .postbody .content, .post .content").first().text()
  )
    .replace(/\s+/g, " ")
    .trim();
  return {
    lastActivityAt: newestAt(posts),
    posts,
    closed: closedFrom(html, $("body").text()),
    section,
    firstPost,
  };
}

export async function readThreadMetaFromSession(
  session: BrowserSession,
  kind: "woltlab" | "phpbb" | "markup",
): Promise<ThreadMeta> {
  const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
  if (!html) {
    return { lastActivityAt: null, posts: [], closed: false, section: null, firstPost: "" };
  }
  return threadMetaFromHtml(html, kind);
}
