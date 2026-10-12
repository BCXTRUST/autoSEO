import type { RegistrationResult } from "./driver.js";

/**
 * Board notices shared by the platform drivers. phpBB keeps its own copy so its fixture
 * behaviour stays as it was; these patterns match the same English and German phrases.
 */

const PENDING_EMAIL =
  /activation key has been sent|check your (?:e-mail|email)|confirmation (?:e-mail|email) has been sent|aktivierungs-?schlüssel|freischalten|(?:e-mail|email).{0,80}(?:aktivier|bestätig)|(?:e-mail|email) wurde .{0,120}gesendet|link in der (?:e-mail|email)|(?:e-mail|email) folgen|zugesandt wurde|registrierung ist (?:fast )?abgeschlossen|benutzer ist momentan inaktiv/i;
const PENDING_ADMIN =
  /administrator (must|will) (activate|approve)|activation by an administrator|(?:vom|von einem|durch einen) administrator (freigeschaltet|aktiviert)|bestätigung durch einen administrator|team freigeschaltet/i;
const ACTIVE =
  /account has (now )?been (created|activated|registered)|you (may|can) now (log ?in|login)|registrierung (war|ist) erfolgreich|konto wurde (aktiviert|erstellt)/i;
/**
 * A refused captcha or anti-bot question in the English and German stock phrases of phpBB,
 * WoltLab, XenForo and Discourse, plus the generic "captcha … incorrect" shape. A match means
 * the registration itself was fine and only the challenge has to be solved again.
 */
const CAPTCHA_REJECTED =
  /confirmation code you entered was incorrect|solution you provided was incorrect|bestätigungscode.*(falsch|nicht korrekt)|eingegebene antwort ist falsch|falsche antwort auf die frage|invalid answer to the question|answered the question incorrectly|frage falsch beantwortet|did not pass the security check|captcha prüfung fehlgeschlagen|(captcha|sicherheits(?:abfrage|code|frage|prüfung)|security check|verification).{0,40}(incorrect|invalid|failed|wrong|falsch|ungültig|fehlgeschlagen)/i;

export function captchaRejected(text: string): boolean {
  return CAPTCHA_REJECTED.test(text);
}

/** The registration form itself says an administrator has to activate the account. */
export function adminActivationNotice(text: string): boolean {
  return PENDING_ADMIN.test(text);
}

const POST_AWAITING_ADMIN =
  /awaiting (?:moderation|approval)|pending (?:moderation|approval)|(?:post|reply|message|beitrag|thema) (?:is |has been |wird )?(?:awaiting|wartet)|must be approved by (?:a |an )?(?:moderator|administrator)|wartet auf (?:die )?freigabe|muss .{0,80}(?:moderator|administrator) freigegeben|wird erst nach (?:der )?freischaltung sichtbar|your (?:post|reply|message) will be visible after/i;

/** The topic page says the site admin still has to approve this post. Not a registration notice. */
export function postAwaitingAdmin(text: string): boolean {
  return POST_AWAITING_ADMIN.test(text);
}

/** Which admin hold a verify page is showing, if it is a hold and not a missing post. */
export function adminHoldOnVerify(html: string): "registration" | "post" | null {
  if (postAwaitingAdmin(html)) return "post";
  if (adminActivationNotice(html)) return "registration";
  return null;
}
const REGISTRATION_CLOSED =
  /registration (is )?(disabled|closed)|registrierung (ist )?deaktiviert/i;
const POSTED =
  /posted successfully|erfolgreich (erstellt|gespeichert|eingetragen)|reply has been posted/i;
const REPLIES_CLOSED =
  /topic is locked|topic is closed|this thread is locked|replies are closed|you cannot reply|dieses thema ist gesperrt|thema ist geschlossen|keine weiteren antworten|kannst keine beiträge|cannot post (a |any )?repl/i;

const FIXABLE_FORM =
  /already (?:in use|taken|registered|exists)|username you entered is already|banned email|email address is banned|e-?mail .* (?:gesperrt|banned|not allowed)|password is required|passworts ist erforderlich|entering a password is required|please enter your birthday|please answer the security question|please choose a newsletter|gültige e-?mail/i;
const USERNAME_TAKEN =
  /already (?:in use|taken|registered|exists)|username you entered is already|benutzername .* vergeben/i;

export function registrationClosed(text: string): boolean {
  return REGISTRATION_CLOSED.test(text);
}

export function postedSuccessfully(text: string): boolean {
  return POSTED.test(text);
}

/** The topic page says replies are closed. Try another thread; do not park the board. */
export function repliesClosed(text: string): boolean {
  return REPLIES_CLOSED.test(text);
}

/** Username taken, a banned email, or a missing password: correct the form once, then give up. */
export function formErrorFixable(messages: readonly string[]): boolean {
  return FIXABLE_FORM.test(messages.join("\n"));
}

export function usernameTaken(messages: readonly string[]): boolean {
  return USERNAME_TAKEN.test(messages.join("\n"));
}

const USERNAME_FORMAT =
  /anderen namen|gewünschten format|does not match the required format|enter a different name|invalid username|benutzername .{0,40}(?:ungültig|format)/i;

/** The board rejected the shape of the username, not the captcha and not a taken name. */
export function usernameFormatRejected(messages: readonly string[]): boolean {
  return USERNAME_FORMAT.test(messages.join("\n"));
}

export function classifyRegistration(text: string, formStillOpen: boolean): RegistrationResult {
  if (CAPTCHA_REJECTED.test(text)) return { kind: "captcha_rejected" };
  if (PENDING_ADMIN.test(text)) return { kind: "pending_admin" };
  if (PENDING_EMAIL.test(text)) return { kind: "pending_email" };
  if (ACTIVE.test(text) && !formStillOpen) return { kind: "active" };
  const messages = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (formStillOpen) return { kind: "form_error", messages };
  return { kind: "unknown", messages };
}

export function relFromAttribute(rel: string | null): "follow" | "nofollow" | "ugc" | null {
  if (rel === null) return null;
  const value = rel.toLowerCase();
  if (/\bnofollow\b|\bsponsored\b/.test(value)) return "nofollow";
  if (/\bugc\b/.test(value)) return "ugc";
  return "follow";
}
