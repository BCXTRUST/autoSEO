import type { BrowserSession } from "@rakazo/adapter-kit";

/**
 * Accept buttons of common consent managers and board cookie notices, most specific first.
 * Only "accept necessary"/"accept" style buttons; never settings or reject dialogs that open more UI.
 */
export const COOKIE_ACCEPT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "button.fc-cta-consent",
  ".qc-cmp2-summary-buttons button[mode='primary']",
  "#didomi-notice-agree-button",
  ".cmplz-btn.cmplz-accept",
  ".cc-window .cc-allow",
  ".cc-window .cc-dismiss",
  "[data-cookie-accept]",
  "#cookie-consent button.accept",
  ".cookie-notice .button.accept",
  // phpBB boards that use the ca_accept cookie bar ("Ich stimme zu").
  "a[onclick*='ca_accept']",
  "a:has-text('Ich stimme zu')",
  "button:has-text('Ich stimme zu')",
  "button:has-text('Akzeptieren und weiter')",
] as const;

/** Visible accept labels. A paid or settings control is not an accept. */
const CONSENT_ACCEPT =
  /^(?:akzeptieren(?: und weiter)?|alle akzeptieren|alle cookies akzeptieren|cookies akzeptieren|zustimmen|einverstanden|ich stimme zu|accept(?: all| and continue)?|agree(?: and continue)?)$/i;
const CONSENT_REJECT =
  /werbefrei|ablehnen|einstellungen|contentpass|3[,.]99|reject|settings|manage|nur notwendige|necessary only/i;

export function consentAcceptText(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 80 || CONSENT_REJECT.test(value)) return false;
  return CONSENT_ACCEPT.test(value);
}

export type CookieWallResult = "accepted" | "none";

export async function acceptCookieWall(
  session: BrowserSession,
  selectors: readonly string[] = COOKIE_ACCEPT_SELECTORS,
): Promise<CookieWallResult> {
  if (session.clickConsent && (await session.clickConsent())) return "accepted";
  for (const selector of selectors) {
    if (!(await session.exists(selector))) continue;
    if (session.isVisible && !(await session.isVisible(selector))) continue;
    await session.click(selector);
    return "accepted";
  }
  return "none";
}
