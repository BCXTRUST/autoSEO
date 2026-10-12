import type {
  LbCaptchaType,
  LbHostPlatform,
  LbHostStatus,
  LbHrefForNewMembers,
  LbRelDefault,
} from "@rakazo/contracts";
import { transitionHost } from "./host-state.js";

/**
 * Server-side host probe. Platform footprints are the DOM and URL markers in Appendix A.
 * No persona browser: the caller fetches the pages.
 */

export interface ProbePage {
  url: string;
  html: string;
}

export interface ProbeThread {
  url: string;
  title: string;
  excerpt: string;
}

export interface ProbeFacts {
  platform: LbHostPlatform;
  platformVersionHint: string | null;
  registerUrl: string | null;
  captchaType: LbCaptchaType | null;
  captchaUnsupported: boolean;
  hrefForNewMembers: LbHrefForNewMembers;
  relDefault: LbRelDefault;
  signatureLinks: boolean;
  minPostsForLinks: number | null;
  commercialLinksForbidden: boolean;
  rulesExcerpt: string;
  threads: ProbeThread[];
  score: number;
}

const REGISTER_PATH: Record<string, string> = {
  phpbb: "/ucp.php?mode=register",
  woltlab: "/register/",
  xenforo: "/register/",
  ips: "/register/",
  vbulletin: "/register.php",
  mybb: "/member.php?action=register",
  discourse: "/signup",
  flarum: "/register",
  nodebb: "/register",
  vanilla: "/entry/register",
};

const THREAD_PATH =
  /viewtopic\.php|\/forum\/thread\/|showthread\.php|\/t\/[^/]+\/\d+|\/threads\/|\/topic\/\d+|\/d\/\d+-|\/discussion\/\d+\//i;

export function platformFromUrl(url: string): LbHostPlatform {
  const path = safePath(url);
  if (/\/forum\/thread\//i.test(path)) return "woltlab";
  if (/showthread\.php\?[^"'#]*\btid=/i.test(path)) return "mybb";
  if (/showthread\.php\?[^"'#]*\bt=/i.test(path)) return "vbulletin";
  if (/viewtopic\.php/i.test(path)) return "phpbb";
  if (/\/threads\/[^/]*\.\d+/i.test(path)) return "xenforo";
  if (/\/t\/[^/]+\/\d+/i.test(path)) return "discourse";
  if (/\/d\/\d+-/i.test(path)) return "flarum";
  if (/\/discussion\/\d+\//i.test(path)) return "vanilla";
  if (/\/topic\/\d+-[^/]+/i.test(path)) return "ips";
  if (/\/topic\/\d+\//i.test(path)) return "nodebb";
  return "unknown";
}

export function probePages(input: {
  homepageUrl: string;
  sampleUrl?: string;
  pages: readonly ProbePage[];
}): ProbeFacts {
  const html = input.pages.map((page) => page.html).join("\n");
  const urls = [input.homepageUrl, input.sampleUrl ?? "", ...input.pages.map((page) => page.url)];
  const blob = `${html}\n${urls.join("\n")}`;
  const platform = detectPlatform(html, blob);
  const unsupported = detectUnsupported(html);
  const captchaType = unsupported ? "unsupported" : detectCaptcha(html);
  const origin = originOf(input.homepageUrl);
  const registerUrl = findRegisterUrl(html, origin) ?? defaultRegister(origin, platform);
  const rulesExcerpt = excerptRules(html);
  const commercialLinksForbidden = commercialBan(rulesExcerpt) || commercialBan(html);
  const after = afterPosts(html);
  const posts = lowPostAnchors(html);
  let hrefForNewMembers: LbHrefForNewMembers = "unknown";
  let minPostsForLinks: number | null = null;
  if (commercialLinksForbidden || /\bno links allowed\b|keine links erlaubt/i.test(html)) {
    hrefForNewMembers = "no";
  } else if (after) {
    hrefForNewMembers = "after_n_posts";
    minPostsForLinks = after;
  } else if (posts.length > 0) {
    hrefForNewMembers = "yes";
  }
  const relDefault = relOf(posts);
  const signatureLinks = /signature links allowed|signaturlinks erlaubt/i.test(html);
  const threads = collectThreads(input.pages, origin);
  const score = qualityScore({
    platform,
    captchaType,
    hrefForNewMembers,
    rulesExcerpt,
  });
  return {
    platform,
    platformVersionHint: versionHint(html, platform),
    registerUrl,
    captchaType,
    captchaUnsupported: unsupported,
    hrefForNewMembers,
    relDefault,
    signatureLinks,
    minPostsForLinks,
    commercialLinksForbidden,
    rulesExcerpt,
    threads,
    score,
  };
}

export interface SettledProbe {
  status: LbHostStatus;
  reason: string | null;
  score: number;
}

/** Applies the host state machine: discovered, then qualified or a terminal reason. */
export function settleProbe(facts: ProbeFacts, fetched: boolean): SettledProbe {
  if (!fetched) {
    const state = transitionHost("discovered", "failed");
    return { status: state.status, reason: "fetch_failed", score: 0 };
  }
  if (facts.captchaUnsupported) {
    const state = transitionHost("discovered", "unsupported_captcha");
    return { status: state.status, reason: "unsupported_captcha", score: facts.score };
  }
  let state = transitionHost("discovered", "probe_succeeded");
  if (facts.commercialLinksForbidden || facts.hrefForNewMembers === "no") {
    state = transitionHost(state, "denied");
    return {
      status: state.status,
      reason: facts.commercialLinksForbidden ? "commercial_links_forbidden" : "links_forbidden",
      score: facts.score,
    };
  }
  if (facts.platform === "unknown" || facts.score < 0.7) {
    state = transitionHost(state, "failed");
    return {
      status: state.status,
      reason: facts.platform === "unknown" ? "unknown_platform" : "low_score",
      score: facts.score,
    };
  }
  state = transitionHost(state, "qualified");
  return { status: state.status, reason: null, score: facts.score };
}

/** HTML page that carries one platform's Appendix A footprint, for fixtures and probe tests. */
export function sampleForumHtml(input: {
  platform: LbHostPlatform;
  captcha?: LbCaptchaType | "funcaptcha" | "geetest" | "keycaptcha" | "none";
  commercialBan?: boolean;
  href?: "yes" | "after" | "no";
  minPosts?: number;
  rel?: "follow" | "nofollow" | "ugc";
  threadPath?: string;
  threadTitle?: string;
}): string {
  const captcha = input.captcha ?? "recaptcha_v2";
  const href = input.href ?? "yes";
  const rel = input.rel ?? "ugc";
  const threadPath = input.threadPath ?? defaultThreadPath(input.platform);
  const title = input.threadTitle ?? "Was hilft bei Rückenschmerzen?";
  const rules = input.commercialBan
    ? "Keine kommerziellen Links. Werbung verboten."
    : href === "after"
      ? `Links erst nach ${input.minPosts ?? 5} Beiträgen.`
      : href === "no"
        ? "Keine Links erlaubt."
        : "Signature links allowed. Hilfreiche Quellen sind willkommen.";
  return `<!doctype html><html><head><title>Forum</title>${platformHead(input.platform)}</head><body>
${platformBody(input.platform)}
<a href="${threadPath}">${title}</a>
<section id="rules">${rules}</section>
<article data-post-count="2"><a href="https://tips.example/dehnen" rel="${rel}">Dehnen</a></article>
<form id="register">${captchaMarkup(captcha)}</form>
</body></html>`;
}

function qualityScore(input: {
  platform: LbHostPlatform;
  captchaType: LbCaptchaType | null;
  hrefForNewMembers: LbHrefForNewMembers;
  rulesExcerpt: string;
}): number {
  let score = 0;
  if (input.platform !== "unknown") score += 0.45;
  if (input.captchaType && input.captchaType !== "unsupported") score += 0.2;
  else if (!input.captchaType) score += 0.15;
  if (input.hrefForNewMembers === "yes" || input.hrefForNewMembers === "after_n_posts")
    score += 0.25;
  else if (input.hrefForNewMembers === "unknown") score += 0.1;
  if (input.rulesExcerpt) score += 0.1;
  return Math.round(Math.min(1, score) * 100) / 100;
}

function detectPlatform(html: string, blob: string): LbHostPlatform {
  if (/data-ipsCaptcha-key|data-ips-hook|id=["']ipsLayout/i.test(html)) return "ips";
  if (/data-wsc=|\/wcf\//i.test(html)) return "woltlab";
  if (/data-xf-init/i.test(html)) return "xenforo";
  if (/id=["']confirm_code["']/i.test(html) && /viewtopic\.php/i.test(blob)) return "phpbb";
  if (/showthread\.php\?[^"'#]*\btid=/i.test(blob)) return "mybb";
  if (/showthread\.php\?[^"'#]*\bt=/i.test(blob)) return "vbulletin";
  if (
    /\/t\/[^/"']+\/\d+(?:\.json)?/i.test(blob) ||
    /data-discourse|discourse-version/i.test(html)
  ) {
    return "discourse";
  }
  if (/\/d\/\d+-[a-z0-9-]+/i.test(blob) || /id=["']flarum/i.test(html)) return "flarum";
  if (/\/discussion\/\d+\//i.test(blob) || /vanilla-forum/i.test(html)) return "vanilla";
  if (/nodebb/i.test(html) && /\/topic\/\d+\//i.test(blob)) return "nodebb";
  return platformFromUrl(blob);
}

function detectUnsupported(html: string): boolean {
  return /keycaptcha/i.test(html);
}

function detectCaptcha(html: string): LbCaptchaType | null {
  if (/recaptcha\/enterprise|data-enterprise/i.test(html)) return "recaptcha_enterprise";
  if (/grecaptcha\.execute|recaptcha\/api\.js\?render=/i.test(html)) return "recaptcha_v3";
  if (/g-recaptcha|google\.com\/recaptcha/i.test(html)) return "recaptcha_v2";
  if (/cf-turnstile|challenges\.cloudflare\.com/i.test(html)) return "turnstile";
  if (/h-captcha|hcaptcha\.com/i.test(html)) return "hcaptcha";
  if (/funcaptcha|arkoselabs/i.test(html)) return "funcaptcha";
  if (/geetest|gt_captcha/i.test(html)) return "geetest";
  if (/Bestätigungscode|id=["']confirm_code["']|captcha-image/i.test(html)) return "image_letters";
  if (/id=["']qa_answer["']|Sicherheitsfrage/i.test(html)) return "knowledge_question";
  if (/security check|Überprüfung/i.test(html)) return "security_check_label";
  return null;
}

function lowPostAnchors(html: string): { rel: string }[] {
  const found: { rel: string }[] = [];
  const pattern = /data-post-count="(\d+)"([^>]*)>([\s\S]*?)<\/(?:article|div|li)>/gi;
  for (const match of html.matchAll(pattern)) {
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count > 10) continue;
    const block = match[3] ?? "";
    const anchor = /<a\b[^>]*href=["']https?:[^"']+["'][^>]*>/i.exec(block);
    if (!anchor) continue;
    const rel = /rel=["']([^"']*)["']/i.exec(anchor[0]);
    found.push({ rel: rel?.[1] ?? "" });
  }
  return found;
}

function relOf(posts: { rel: string }[]): LbRelDefault {
  if (posts.length === 0) return "unknown";
  const rel = posts.map((post) => post.rel.toLowerCase()).join(" ");
  if (/\bnofollow\b|\bsponsored\b/.test(rel)) return "nofollow";
  if (/\bugc\b/.test(rel)) return "ugc";
  return "follow";
}

function afterPosts(html: string): number | null {
  const match =
    /(?:nach|ab|after)\s+(\d{1,4})\s+(?:beiträgen|beitragen|posts)/i.exec(html) ??
    /(\d{1,4})\s+(?:beiträgen|posts)[^.]{0,40}links/i.exec(html);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function commercialBan(text: string): boolean {
  return /keine kommerziellen links|keine werblichen links|werbung verboten|no commercial links|commercial links are (?:not allowed|forbidden)/i.test(
    text,
  );
}

function excerptRules(html: string): string {
  const section =
    /<(?:section|div)[^>]*id=["'](?:rules|faq|help)["'][^>]*>([\s\S]*?)<\/(?:section|div)>/i.exec(
      html,
    )?.[1];
  const text = (section ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 400);
}

function collectThreads(pages: readonly ProbePage[], origin: string): ProbeThread[] {
  const threads: ProbeThread[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of page.html.matchAll(pattern)) {
      const href = match[1] ?? "";
      if (!THREAD_PATH.test(href)) continue;
      const title = (match[2] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (title.length < 8) continue;
      const url = absolute(href, page.url || origin);
      if (seen.has(url)) continue;
      seen.add(url);
      threads.push({ url, title, excerpt: title });
    }
  }
  return threads.slice(0, 20);
}

function findRegisterUrl(html: string, origin: string): string | null {
  const match =
    /href=["']([^"']*(?:mode=register|\/register\/?|\/signup|action=register)[^"']*)["']/i.exec(
      html,
    );
  if (!match?.[1]) return null;
  return absolute(match[1], origin);
}

function defaultRegister(origin: string, platform: LbHostPlatform): string | null {
  const path = REGISTER_PATH[platform];
  return path ? `${origin}${path}` : null;
}

function versionHint(html: string, platform: LbHostPlatform): string | null {
  if (platform === "phpbb") return /phpBB\s*([0-9.]+)/i.exec(html)?.[1] ?? "3.x";
  if (platform === "xenforo") return "2.x";
  return null;
}

function platformHead(platform: LbHostPlatform): string {
  if (platform === "woltlab") return '<meta name="generator" content="WoltLab" data-wsc="6.1">';
  if (platform === "xenforo") return '<html data-xf-init="1">';
  if (platform === "ips") return '<meta data-ipsCaptcha-key="site-key">';
  if (platform === "discourse")
    return '<meta name="generator" content="Discourse" data-discourse="1">';
  if (platform === "flarum") return '<div id="flarum"></div>';
  if (platform === "nodebb") return '<meta name="generator" content="NodeBB">';
  if (platform === "vanilla") return '<meta name="generator" content="vanilla-forum">';
  if (platform === "phpbb") return '<meta name="generator" content="phpBB 3.3">';
  return "";
}

function platformBody(platform: LbHostPlatform): string {
  if (platform === "woltlab") return '<a href="/wcf/">WoltLab</a>';
  if (platform === "phpbb") return '<input id="confirm_code" name="confirm_code">';
  if (platform === "mybb") return '<a href="showthread.php?tid=1">thread</a>';
  if (platform === "vbulletin") return '<a href="showthread.php?t=1">thread</a>';
  return "";
}

function defaultThreadPath(platform: LbHostPlatform): string {
  switch (platform) {
    case "woltlab":
      return "/forum/thread/14-wirbel/";
    case "xenforo":
      return "/threads/ruecken.12/";
    case "ips":
      return "/topic/19-nacken/";
    case "vbulletin":
      return "/showthread.php?t=18";
    case "mybb":
      return "/showthread.php?tid=16";
    case "discourse":
      return "/t/rueckenschmerzen/13";
    case "flarum":
      return "/d/17-ruecken";
    case "nodebb":
      return "/topic/20/alltag";
    case "vanilla":
      return "/discussion/21/sport";
    default:
      return "/viewtopic.php?t=11";
  }
}

function captchaMarkup(captcha: string): string {
  if (captcha === "funcaptcha") return '<div class="funcaptcha" data-pkey="arkose"></div>';
  if (captcha === "geetest") return '<div class="geetest_captcha"></div>';
  if (captcha === "keycaptcha") return '<div id="keycaptcha"></div>';
  if (captcha === "turnstile") return '<div class="cf-turnstile" data-sitekey="0xsite"></div>';
  if (captcha === "hcaptcha") return '<div class="h-captcha" data-sitekey="h-site"></div>';
  if (captcha === "recaptcha_v3")
    return '<script src="https://www.google.com/recaptcha/api.js?render=site"></script>';
  if (captcha === "recaptcha_enterprise")
    return '<div class="g-recaptcha" data-sitekey="ent" data-enterprise="1"></div>';
  if (captcha === "image_letters")
    return '<img class="captcha-image" alt="Bestätigungscode"><input id="confirm_code">';
  if (captcha === "knowledge_question")
    return '<label>Sicherheitsfrage</label><input id="qa_answer">';
  if (captcha === "security_check_label") return "<p>Security Check</p>";
  if (captcha === "none") return "";
  if (captcha === "unsupported") return '<div class="funcaptcha"></div>';
  return '<div class="g-recaptcha" data-sitekey="site-key"></div>';
}

function originOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return href;
  }
}
