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

export async function detectWidget(session: BrowserSession): Promise<CaptchaChallenge> {
  for (const widget of WIDGETS) {
    if (!(await session.exists(widget.selector))) continue;
    const siteKey = (await session.attribute(widget.selector, widget.key))?.trim() || null;
    const enterprise = widget.type === "recaptcha_v2" && (await session.exists(ENTERPRISE_SCRIPT));
    return {
      kind: "widget",
      type: enterprise ? "recaptcha_enterprise" : widget.type,
      siteKey,
    };
  }
  const frames: ReadonlyArray<{ selector: string; type: TokenCaptchaType }> = [
    { selector: RECAPTCHA_FRAME, type: "recaptcha_v2" },
    { selector: TURNSTILE_FRAME, type: "turnstile" },
    { selector: HCAPTCHA_FRAME, type: "hcaptcha" },
  ];
  for (const frame of frames) {
    const src = await session.attribute(frame.selector, "src");
    if (!src) continue;
    return { kind: "widget", type: frame.type, siteKey: siteKeyFromFrame(src) };
  }
  return { kind: "none" };
}
