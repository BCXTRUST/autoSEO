import type { BrowserSession } from "@rakazo/adapter-kit";
import type { BoardThread, ReplyResult } from "./driver.js";
import { commonFields, defineBoard, field, MarkupBoardDriver } from "./markup-driver.js";

/** Canonical WoltLab permalink `/forum/thread/<id>-slug/?postID=<id>#post<id>`. */
export function woltlabPermalink(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const match = /\/forum\/thread\/(\d+)-([^/?#]+)\/?/.exec(parsed.pathname);
  if (!match) return null;
  const post = parsed.searchParams.get("postID") ?? /^#post(\d+)$/.exec(parsed.hash)?.[1];
  if (!post || !/^\d+$/.test(post)) return null;
  return `${parsed.origin}/forum/thread/${match[1]}-${match[2]}/?postID=${post}#post${post}`;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
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
  "form:has(#text) .formSubmit input[type='submit']",
  "form:has(#text) .formSubmit button",
  "form:has(textarea[name='text']) .formSubmit input[type='submit']",
  "form:has(textarea[name='text']) .formSubmit button",
  "form:has(#text) button[type='submit']",
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

  override async listThreads(session: BrowserSession, homepageUrl: string): Promise<BoardThread[]> {
    const listed = await super.listThreads(session, homepageUrl);
    if (listed.length > 0 || !session.listAnchors) return listed;
    let anchors = await session.listAnchors(TOPIC_LINK);
    if (anchors.length === 0) anchors = await session.listAnchors("a.wbbTopicLink");
    const threads: BoardThread[] = [];
    const seen = new Set<string>();
    const base = await session.url();
    for (const anchor of anchors) {
      let url: string;
      try {
        url = new URL(anchor.href, base).href.replace(/\?action=firstNew$/, "");
      } catch {
        continue;
      }
      if (!/\/forum\/thread\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      threads.push({ url, title: anchor.text, openQuestion: /\?/.test(anchor.text) });
      if (threads.length >= 25) break;
    }
    return threads;
  }

  override async openReply(session: BrowserSession, thread: BoardThread): Promise<boolean> {
    const threadUrl = thread.url.replace(/\?action=firstNew$/, "");
    if (session.listAnchors) {
      await session.goto(threadUrl);
      if (await this.replyReady(session)) return true;
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
    await session.fill(field, body);
  }

  override async submitReply(session: BrowserSession): Promise<ReplyResult> {
    if (!(await session.exists("textarea[name='text'], #text"))) return super.submitReply(session);
    await session.click(REPLY_SUBMIT);
    await session.waitFor("#message, .error, .innerError", { timeoutMs: 15_000 });
    const permalink = woltlabPermalink(await session.url());
    if (permalink) return { kind: "posted", permalink };
    return { kind: "unknown", messages: await this.pageMessages(session) };
  }

  private async replyReady(session: BrowserSession): Promise<boolean> {
    if (!session.isVisible) return false;
    return session.isVisible("#text, textarea[name='text']");
  }

  private async replySelector(session: BrowserSession): Promise<string | null> {
    for (const selector of REPLY_FIELD) {
      if (await session.exists(selector)) return selector;
    }
    return null;
  }
}
