import type { BrowserSession } from "@rakazo/adapter-kit";
import {
  hasTerm,
  WARMUP_BOARD_TERMS,
  warmupBoardScore,
  warmupHealthTitle,
} from "@rakazo/linkbuilder-core";
import { load } from "cheerio";
import type { BoardThread, ReplyResult } from "./driver.js";
import { commonFields, defineBoard, field, MarkupBoardDriver } from "./markup-driver.js";
import { readThreadMetaFromSession, woltlabLastPageUrl } from "./thread-meta.js";

/** Canonical WoltLab permalink `/forum/thread/<id>-slug/?postID=<id>#post<id>`. */
export function woltlabPermalink(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const match = /\/forum\/thread\/(\d+)-([^/?#]+)\/?/.exec(parsed.pathname);
  if (!match) return null;
  const post = parsed.searchParams.get("postID") ?? /^#post(\d+)$/.exec(parsed.hash)?.[1];
  if (!post || !/^\d+$/.test(post)) return null;
  return permalinkFor(parsed, match[1]!, match[2]!, post);
}

/** The post id that appeared after a quick reply. */
export function newestWoltlabPostId(
  before: readonly number[],
  after: readonly number[],
): number | null {
  const known = new Set(before);
  let newest: number | null = null;
  for (const id of after) {
    if (known.has(id)) continue;
    if (newest === null || id > newest) newest = id;
  }
  return newest;
}

/** Permalink for a post id inserted into the current thread. */
export function woltlabPermalinkForPost(pageUrl: string, postId: number): string | null {
  const parsed = parseUrl(pageUrl);
  if (!parsed || !Number.isInteger(postId) || postId <= 0) return null;
  const match = /\/forum\/thread\/(\d+)-([^/?#]+)\/?/.exec(parsed.pathname);
  if (!match) return null;
  return permalinkFor(parsed, match[1]!, match[2]!, String(postId));
}

function permalinkFor(parsed: URL, threadId: string, slug: string, postId: string): string {
  return `${parsed.origin}/forum/thread/${threadId}-${slug}/?postID=${postId}#post${postId}`;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Post ids from permalink anchors. The full page is too large to pull back through the sandbox. */
async function listedPostIds(session: BrowserSession): Promise<number[]> {
  if (!session.listAnchors) return [];
  const anchors = await session.listAnchors("a[href*='postID=']");
  const ids: number[] = [];
  for (const anchor of anchors) {
    const match = /postID=(\d+)/.exec(anchor.href);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

export const woltlabBoard = defineBoard({
  platform: "woltlab",
  bodyFormat: "bbcode",
  allowEmoji: false,
  nofollowDefault: true,
  formClass: "wbbRegister",
  challenge: "turnstile",
  footprint: /data-wsc=|\/wcf\//i,
  footprintSample:
    '<meta name="generator" content="WoltLab Suite" data-wsc="6.1"><a href="/wcf/">WoltLab</a>',
  paths: { register: "/register/", login: "/login/", profile: "/account/", list: "/forum/" },
  fields: commonFields({ confirm: field("passwordConfirm") }),
  routes: {
    index: "/",
    register: "/register/",
    login: "/login/",
    activate: "/activate",
    list: "/forum/",
    profile: "/account/",
    captcha: "/captcha.png",
    thread: /^\/forum\/thread\/\d+-[a-z0-9-]+\/?$/,
    reply: /^\/forum\/thread\/\d+-[a-z0-9-]+\/\?action=reply$/,
    permalink: /postID=\d+/,
  },
  threadHref: "/forum/thread/1-membership/",
  replyHref: "/forum/thread/1-membership/?action=reply",
  permalinkHref: (postId) => `/forum/thread/1-membership/?postID=${postId}#post${postId}`,
  permalink: woltlabPermalink,
});

const TOPIC_LINK = "a.wbbTopicLink:not(.wbbBoardNode__lastPostLink)";
const REPLY_LINK = "a[href*='action=reply'], a[href*='action=add']";
const REPLY_FIELD = ["#text", "textarea[name='text']", "#message"] as const;
const REPLY_SUBMIT = [
  "button[data-type='save']",
  "form:has(#text) button[data-type='save']",
  "form:has(textarea[name='text']) button[data-type='save']",
  "form:has(#text) .formSubmit input[type='submit']",
  "form:has(#text) .formSubmit button",
  "form:has(textarea[name='text']) .formSubmit input[type='submit']",
  "form:has(textarea[name='text']) .formSubmit button",
].join(", ");

const SIGNED_IN =
  "a.logout, a[href*='logout'], a[href*='Logout'], a[href*='logoff'], a.userMenuItemLink, a[href*='account-management']";

export class WoltlabDriver extends MarkupBoardDriver {
  constructor() {
    super(woltlabBoard);
  }

  protected override signedInSelector(): string {
    return SIGNED_IN;
  }

  override async listThreads(
    session: BrowserSession,
    homepageUrl: string,
    topic?: { terms: string[]; activityDays?: number },
  ): Promise<BoardThread[]> {
    const listed = await super.listThreads(session, homepageUrl);
    const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
    const base = await session.url().catch(() => homepageUrl);
    const terms = topic?.terms ?? [];
    const discovered = html ? woltlabBoards(html, base, terms) : [];
    if (discovered.length === 0) {
      if (listed.length > 0 || !session.listAnchors) return listed;
      return legacyTopicLinks(session, base);
    }
    const activityDays = topic?.activityDays ?? 30;
    const now = Date.now();
    const found: BoardThread[] = [...woltlabIndexThreads(html, base)];
    for (const board of discovered.slice(0, 8)) {
      try {
        await session.goto(board.url);
      } catch {
        continue;
      }
      const boardHtml = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
      const pageUrl = await session.url().catch(() => board.url);
      for (const row of woltlabBoardRows(boardHtml, pageUrl)) {
        if (row.closed || row.sticky) continue;
        if (row.lastActivityAt) {
          const age = (now - Date.parse(row.lastActivityAt)) / 86_400_000;
          if (Number.isFinite(age) && age > activityDays) continue;
        }
        found.push({
          url: row.url,
          title: row.title,
          lastActivityAt: row.lastActivityAt,
          openQuestion: /\?/.test(row.title),
        });
      }
    }
    return orderBoardThreads(found, terms).slice(0, 25);
  }

  override async readThreadMeta(session: BrowserSession) {
    return readThreadMetaFromSession(session, "woltlab");
  }

  override async lastPageUrl(
    _session: BrowserSession,
    thread: BoardThread,
  ): Promise<string | null> {
    return woltlabLastPageUrl(thread.url);
  }

  override async openReply(session: BrowserSession, thread: BoardThread): Promise<boolean> {
    const threadUrl = thread.url.replace(/\?action=firstNew$/, "");
    if (session.listAnchors) {
      await session.goto(threadUrl);
      if (await this.replySelector(session)) return true;
      const anchors = await session.listAnchors(REPLY_LINK);
      const reply = anchors.find((anchor) => /action=(?:reply|add)\b/.test(anchor.href));
      if (reply) {
        await session.goto(new URL(reply.href, await session.url()).href);
        if (await this.replySelector(session)) return true;
      }
    }
    return super.openReply(session, { ...thread, url: threadUrl });
  }

  override async fillReply(session: BrowserSession, body: string): Promise<void> {
    const field = await this.replySelector(session);
    if (!field) {
      await super.fillReply(session, body);
      return;
    }
    // The quick reply mounts CKEditor after the thread HTML arrives. Wait before writing.
    if (await session.exists("textarea.wysiwygTextarea")) {
      await session.waitFor(".ck-editor, .ck-content", { timeoutMs: 15_000 });
    }
    await session.fill(field, body);
  }

  override async submitReply(session: BrowserSession): Promise<ReplyResult> {
    if (!(await session.exists("textarea[name='text'], #text"))) return super.submitReply(session);
    const before = await listedPostIds(session);
    await session.click(REPLY_SUBMIT);
    const deadlineAt = Date.now() + 15_000;
    let permalink = woltlabPermalink(await session.url());
    while (!permalink && Date.now() < deadlineAt) {
      permalink = woltlabPermalink(await session.url());
      if (permalink) break;
      const created = newestWoltlabPostId(before, await listedPostIds(session));
      if (created !== null) permalink = woltlabPermalinkForPost(await session.url(), created);
      if (permalink) break;
      if ((await session.text(".innerError"))?.trim()) break;
      await session.waitFor("[data-rakazo-woltlab-wait]", { timeoutMs: 1_000 });
    }
    if (permalink) return { kind: "posted", permalink };
    const messages = await this.pageMessages(session);
    const inline = (await session.text(".innerError"))?.trim();
    if (inline) messages.push(inline);
    return { kind: "unknown", messages };
  }

  private async replySelector(session: BrowserSession): Promise<string | null> {
    for (const selector of REPLY_FIELD) {
      if (await session.exists(selector)) return selector;
    }
    return null;
  }
}

function cleanThreadUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    url.hash = "";
    if (/\/forum\/thread\//.test(url.pathname)) {
      url.search = "";
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

function threadIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return url;
  }
}

async function legacyTopicLinks(session: BrowserSession, base: string): Promise<BoardThread[]> {
  if (!session.listAnchors) return [];
  let anchors = await session.listAnchors(TOPIC_LINK);
  if (anchors.length === 0) anchors = await session.listAnchors("a.wbbTopicLink");
  const threads: BoardThread[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const url = cleanThreadUrl(anchor.href, base);
    if (!url) continue;
    const key = threadIdentity(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = anchor.text.replace(/\s+/g, " ").trim();
    threads.push({ url, title, openQuestion: /\?/.test(title) });
    if (threads.length >= 25) break;
  }
  return threads;
}

function woltlabBoards(
  html: string,
  base: string,
  terms: readonly string[],
): Array<{ url: string; name: string; score: number }> {
  const $ = load(html);
  const boards: Array<{ url: string; name: string; score: number; order: number }> = [];
  const seen = new Set<string>();
  $("a.wbbBoardNode__link, a.wbbBoardNode__subBoardLink").each((order, el) => {
    const href = $(el).attr("href");
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || !name) return;
    const id = /\/forum\/board\/(\d+)-/.exec(href)?.[1];
    if (!id || seen.has(id)) return;
    const score = warmupBoardScore(name, terms);
    if (score < 0) return;
    let url: string;
    try {
      url = new URL(href, base).href;
    } catch {
      return;
    }
    seen.add(id);
    boards.push({ url, name, score, order });
  });
  boards.sort((a, b) => b.score - a.score || a.order - b.order);
  return boards;
}

function woltlabIndexThreads(html: string, base: string): BoardThread[] {
  const $ = load(html);
  const threads: BoardThread[] = [];
  const seen = new Set<string>();
  $(".wbbBoardNode, .wbbBoardNode__subBoard").each((_, node) => {
    const name = $(node).find("a.wbbBoardNode__link, a.wbbBoardNode__subBoardLink").first().text();
    if (warmupBoardScore(name) < 0) return;
    const link = $(node).find("a.wbbTopicLink").first();
    const href = link.attr("href");
    const title = link.text().replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const url = cleanThreadUrl(href, base);
    if (!url) return;
    const key = threadIdentity(url);
    if (seen.has(key)) return;
    seen.add(key);
    const at = $(node).find("woltlab-core-date-time").last().attr("date") ?? null;
    threads.push({ url, title, lastActivityAt: at, openQuestion: /\?/.test(title) });
  });
  return threads;
}

function woltlabBoardRows(
  html: string,
  base: string,
): Array<{
  url: string;
  title: string;
  lastActivityAt: string | null;
  sticky: boolean;
  closed: boolean;
}> {
  const $ = load(html);
  const rows: Array<{
    url: string;
    title: string;
    lastActivityAt: string | null;
    sticky: boolean;
    closed: boolean;
  }> = [];
  $("ol.wbbThread").each((_, node) => {
    const row = $(node);
    const link = row.find("a.wbbTopicLink").first();
    const href = link.attr("href");
    const title = link.text().replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const url = cleanThreadUrl(href, base);
    if (!url) return;
    rows.push({
      url,
      title,
      lastActivityAt: row.find(".columnLastPost woltlab-core-date-time").attr("date") ?? null,
      sticky: row.attr("data-is-sticky") === "1",
      closed: row.attr("data-is-closed") === "1",
    });
  });
  return rows;
}

function orderBoardThreads(threads: BoardThread[], terms: readonly string[]): BoardThread[] {
  const seen = new Set<string>();
  const unique: BoardThread[] = [];
  for (const thread of threads) {
    const key = threadIdentity(thread.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(thread);
  }
  const hit = (title: string) =>
    warmupHealthTitle(title) ||
    WARMUP_BOARD_TERMS.some((term) => hasTerm(title, term)) ||
    terms.some((term) => hasTerm(title, term));
  unique.sort((a, b) => {
    const delta = Number(hit(b.title)) - Number(hit(a.title));
    if (delta !== 0) return delta;
    const aAt = Date.parse(a.lastActivityAt ?? "") || 0;
    const bAt = Date.parse(b.lastActivityAt ?? "") || 0;
    return bAt - aAt;
  });
  return unique;
}
