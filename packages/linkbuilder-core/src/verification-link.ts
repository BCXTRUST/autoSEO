export interface MailForLinkExtraction {
  subject: string;
  textBody: string;
  htmlBody?: string;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()[\]]+/gi;
const HREF = /href\s*=\s*["']([^"']+)["']/gi;
const ACTIVATION_HINT =
  /mode=activate|activat|confirm|verif|aktivier|bestätig|bestaetig|freischalt|validate/i;
const RESET_MAIL =
  /kennwort vergessen|passwort vergessen|forgot your password|reset your password|password reset|benutzerkonto abgelehnt/i;
const RESET_URL =
  /lost-?password|forgot-?password|new-?password|reset-?password|mode=sendpassword/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, "/");
}

function candidates(mail: MailForLinkExtraction): string[] {
  const found: string[] = [];
  for (const match of mail.htmlBody?.matchAll(HREF) ?? []) found.push(decodeEntities(match[1]!));
  for (const match of mail.textBody.matchAll(URL_IN_TEXT)) {
    found.push(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return found;
}

/**
 * The account activation link in a board's verification mail. Only links on `origin` count, so a
 * tracking redirect or a link to another site in the same mail is never opened.
 */
function sameBoard(linkHost: string, originHost: string): boolean {
  const link = linkHost.replace(/^www\./i, "").toLowerCase();
  const board = originHost.replace(/^www\./i, "").toLowerCase();
  return link === board || link.endsWith(`.${board}`);
}

export function extractVerificationLink(
  mail: MailForLinkExtraction,
  origin: string,
): string | null {
  if (RESET_MAIL.test(mail.subject)) return null;
  const expected = new URL(origin).hostname;
  const sameOrigin: string[] = [];
  for (const candidate of candidates(mail)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.username || url.password) continue;
    if (RESET_URL.test(`${url.pathname}${url.search}`)) continue;
    if (!sameBoard(url.hostname, expected)) continue;
    sameOrigin.push(url.href);
  }
  return sameOrigin.find((url) => ACTIVATION_HINT.test(url)) ?? null;
}

/** Whether a mail plausibly comes from the board, by sender domain or by a same-origin link. */
export function mailMentionsOrigin(mail: MailForLinkExtraction, origin: string): boolean {
  const expected = new URL(origin).origin;
  return candidates(mail).some((candidate) => {
    try {
      return new URL(candidate).origin === expected;
    } catch {
      return false;
    }
  });
}
