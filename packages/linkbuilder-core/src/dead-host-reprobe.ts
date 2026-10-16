/**
 * Re-probe of a host already marked dead. The walk follows a register link, an optional
 * rules step, then a form. It never submits an account and never emits `failed`.
 */

export type DeadHostReprobeStatus = "qualified" | "form_not_found" | "dead";

export interface SignupPage {
  url: string;
  html: string;
}

const REGISTER_HREF =
  /href=["']([^"']*(?:mode=register|\/register\/?|\/signup|action=register)[^"']*)["']/gi;

const CLOSED =
  /registration (is )?(disabled|closed)|registrierung (ist )?(deaktiviert|geschlossen)/i;

const BLOCK_TEXT =
  /unusual traffic|ungewöhnlicher datenverkehr|just a moment|cf-browser-verification|attention required/i;

const SIGNUP_FIELD =
  /<(?:input|textarea|select)\b[^>]*(?:type=["'](?:email|password)["']|name=["'][^"']*(?:email|e-?mail|username|user_name|passwort|password|benutzer)[^"']*["']|id=["'][^"']*(?:email|username|password|passwort)[^"']*["'])/i;

const SEARCH_ONLY = /type=["']search["']|name=["'](?:q|s|search|query)["']/i;

const RULES_TEXT =
  /regeln|rules|bedingungen|terms of|nutzungsbedingungen|agb|einverstanden|zustimmen|i agree|accept the/i;

const CONTINUE_HREF =
  /<a\b[^>]*href=["']([^"']+)["'][^>]*>[^<]{0,80}(?:weiter|accept|agree|einverstanden|zustimmen|fortfahren|continue|next)[^<]{0,40}<\/a>/i;

export function classifySignupTrail(pages: readonly SignupPage[]): DeadHostReprobeStatus {
  if (pages.length === 0) return "dead";
  for (const page of pages) {
    if (pageBlocked(page.url, page.html) || registrationClosed(page.html)) return "dead";
    if (hasSignupForm(page.html) && signupPathReached(pages, page)) return "qualified";
  }
  return "form_not_found";
}

/** The next URL to fetch. Null when the trail has a verdict already or nowhere left to walk. */
export function nextSignupHop(pages: readonly SignupPage[]): string | null {
  if (pages.length === 0) return null;
  if (classifySignupTrail(pages) !== "form_not_found") return null;
  const latest = pages[pages.length - 1];
  if (!latest) return null;
  const seen = new Set(pages.map((page) => page.url));
  const register = firstRegisterUrl(pages);
  if (register && !seen.has(register)) return register;
  if (!register) return null;
  const next = continuationUrl(latest.html, latest.url);
  if (!next || seen.has(next)) return null;
  return next;
}

export async function walkDeadHostSignup(input: {
  homepageUrl: string;
  fetchPage: (url: string) => Promise<SignupPage | null>;
}): Promise<DeadHostReprobeStatus> {
  const pages: SignupPage[] = [];
  const seen = new Set<string>();
  let url: string | null = input.homepageUrl;
  for (let hop = 0; hop < 4 && url; hop += 1) {
    if (seen.has(url)) break;
    seen.add(url);
    const page = await input.fetchPage(url);
    if (!page) return pages.length === 0 ? "dead" : classifySignupTrail(pages);
    pages.push(page);
    const verdict = classifySignupTrail(pages);
    if (verdict !== "form_not_found") return verdict;
    url = nextSignupHop(pages);
  }
  return classifySignupTrail(pages);
}

function signupPathReached(pages: readonly SignupPage[], page: SignupPage): boolean {
  if (pages.some((item) => firstRegisterUrl([item]))) return true;
  return isRegisterUrl(page.url);
}

function firstRegisterUrl(pages: readonly SignupPage[]): string | null {
  for (const page of pages) {
    const match = page.html.matchAll(REGISTER_HREF);
    for (const item of match) {
      const href = item[1];
      if (!href) continue;
      const absolute = absoluteUrl(href, page.url);
      if (absolute) return absolute;
    }
  }
  return null;
}

function continuationUrl(html: string, base: string): string | null {
  if (!isRulesStep(html)) return null;
  const link = CONTINUE_HREF.exec(html)?.[1];
  if (link) {
    const absolute = absoluteUrl(link, base);
    if (absolute) return absolute;
  }
  const action = /<form\b[^>]*\baction=["']([^"']+)["']/i.exec(html)?.[1];
  if (!action) return null;
  return absoluteUrl(action, base);
}

function isRulesStep(html: string): boolean {
  if (hasSignupForm(html)) return false;
  return RULES_TEXT.test(html);
}

function hasSignupForm(html: string): boolean {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  for (const form of forms) {
    if (SEARCH_ONLY.test(form) && !SIGNUP_FIELD.test(form)) continue;
    if (SIGNUP_FIELD.test(form)) return true;
  }
  return false;
}

function registrationClosed(html: string): boolean {
  return CLOSED.test(strip(html));
}

function pageBlocked(url: string, html: string): boolean {
  if (sorryPath(url)) return true;
  const text = strip(html).toLowerCase();
  return BLOCK_TEXT.test(text);
}

function sorryPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path === "/sorry" || path.startsWith("/sorry/");
  } catch {
    return false;
  }
}

function isRegisterUrl(url: string): boolean {
  return /mode=register|\/register\/?|\/signup|action=register/i.test(url);
}

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function absoluteUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^javascript:/i.test(trimmed) ||
    /^mailto:/i.test(trimmed)
  ) {
    return null;
  }
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
