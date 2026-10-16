import type { BrowserSession, TokenCaptchaType } from "@rakazo/adapter-kit";
import type { CaptchaChallenge } from "./driver.js";

/** Widget containers. The site key sits on the attribute named here (plan section 7.2). */
const WIDGETS: ReadonlyArray<{ selector: string; type: TokenCaptchaType; key: string }> = [
  { selector: ".g-recaptcha", type: "recaptcha_v2", key: "data-sitekey" },
  { selector: ".cf-turnstile", type: "turnstile", key: "data-sitekey" },
  { selector: "[data-xf-init='turnstile']", type: "turnstile", key: "data-sitekey" },
  { selector: ".h-captcha", type: "hcaptcha", key: "data-sitekey" },
  { selector: "[data-xf-init='h-captcha']", type: "hcaptcha", key: "data-sitekey" },
  { selector: "[data-ipsCaptcha-key]", type: "turnstile", key: "data-ipsCaptcha-key" },
  { selector: ".funcaptcha", type: "funcaptcha", key: "data-pkey" },
  { selector: ".geetest_captcha", type: "geetest", key: "data-gt" },
];

const ENTERPRISE_SCRIPT = "script[src*='recaptcha/enterprise']";
const RECAPTCHA_FRAME = "iframe[src*='recaptcha'][src*='k=']";
const TURNSTILE_FRAME = "iframe[src*='turnstile'][src*='k=']";
const HCAPTCHA_FRAME = "iframe[src*='hcaptcha'][src*='k=']";

function siteKeyFromFrame(src: string): string | null {
  try {
    return new URL(src, "https://invalid.example").searchParams.get("k");
  } catch {
    return null;
  }
}

function widgetTypeFromUrl(url: URL): TokenCaptchaType | null {
  const blob = `${url.hostname}${url.pathname}`.toLowerCase();
  if (blob.includes("hcaptcha")) return "hcaptcha";
  if (blob.includes("turnstile")) return "turnstile";
  if (blob.includes("recaptcha")) return "recaptcha_v2";
  return null;
}

/** Site key from markup when the live widget selectors do not see it. */
export function siteKeyFromMarkup(html: string): CaptchaChallenge | null {
  const data = /data-sitekey\s*=\s*["']([0-9A-Za-z_-]{8,200})["']/i.exec(html);
  if (data?.[1]) return { kind: "widget", type: "recaptcha_v2", siteKey: data[1] };
  const sources = [
    ...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/https?:[^"'\\\s<>]+/gi),
  ].map((match) => match[1] || match[0]);
  for (const raw of sources) {
    const decoded = raw.replace(/&amp;/g, "&").replace(/\\\//g, "/");
    let url: URL;
    try {
      url = new URL(decoded, "https://invalid.example");
    } catch {
      continue;
    }
    const type = widgetTypeFromUrl(url);
    const siteKey = url.searchParams.get("k");
    if (!type || !siteKey) continue;
    return { kind: "widget", type, siteKey };
  }
  return null;
}

async function siteKeyFromPage(session: BrowserSession): Promise<CaptchaChallenge | null> {
  if (!session.pageHtml) return null;
  try {
    return siteKeyFromMarkup(await session.pageHtml());
  } catch {
    return null;
  }
}

export async function detectWidget(session: BrowserSession): Promise<CaptchaChallenge> {
  let fallback: CaptchaChallenge | null = null;
  for (const widget of WIDGETS) {
    if (!(await session.exists(widget.selector))) continue;
    const siteKey = (await session.attribute(widget.selector, widget.key))?.trim() || null;
    const enterprise = widget.type === "recaptcha_v2" && (await session.exists(ENTERPRISE_SCRIPT));
    const found: CaptchaChallenge = {
      kind: "widget",
      type: enterprise ? "recaptcha_enterprise" : widget.type,
      siteKey,
    };
    if (siteKey) return found;
    fallback = fallback ?? found;
  }
  const frames: ReadonlyArray<{ selector: string; type: TokenCaptchaType }> = [
    { selector: RECAPTCHA_FRAME, type: "recaptcha_v2" },
    { selector: TURNSTILE_FRAME, type: "turnstile" },
    { selector: HCAPTCHA_FRAME, type: "hcaptcha" },
  ];
  for (const frame of frames) {
    const src = await session.attribute(frame.selector, "src");
    if (!src) continue;
    const siteKey = siteKeyFromFrame(src);
    const found: CaptchaChallenge = { kind: "widget", type: frame.type, siteKey };
    if (siteKey) return found;
    fallback = fallback ?? found;
  }
  return (await siteKeyFromPage(session)) ?? fallback ?? { kind: "none" };
}
