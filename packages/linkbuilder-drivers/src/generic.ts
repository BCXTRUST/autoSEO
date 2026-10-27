import type { BrowserSession, ClickableControl, FormFieldInfo } from "@rakazo/adapter-kit";
import {
  hasTerm,
  isMailSendFailure,
  WARMUP_BOARD_TERMS,
  warmupBoardScore,
  warmupHealthTitle,
} from "@rakazo/linkbuilder-core";
import { load } from "cheerio";
import { detectKnowledgeQuestion, looksLikeKnowledgeQuestion } from "./captcha.js";
import { acceptCookieWall } from "./cookie-wall.js";
import type {
  ActivationResult,
  BoardAccount,
  BoardDriver,
  BoardThread,
  CaptchaChallenge,
  LinkRuleProbe,
  ProfileInput,
  RegistrationPage,
  RegistrationResult,
  ReplyResult,
} from "./driver.js";
import { holdSignupForm, releaseSignupForm, UnmappedFormError } from "./driver.js";
import {
  adminActivationNotice,
  classifyRegistration,
  postedSuccessfully,
  registrationClosed,
  relFromAttribute,
  repliesClosed,
} from "./messages.js";
import {
  genericLastPageUrl,
  parseGermanPostDate,
  readThreadMetaFromSession,
} from "./thread-meta.js";
import { detectWidget } from "./widgets.js";

/**
 * Fallback for an unrecognised board. Fields are chosen from labels, autocomplete, names and
 * roles. A tie or a required field we cannot name parks the host; the mapper never guesses.
 */

export interface RegistrationProfile extends BoardAccount {
  givenName: string;
  familyName: string;
  birthday: { day: string; month: string; year: string };
  securityAnswer: string;
  language: string;
  timezone: string;
}

export interface RegistrationPark {
  reason: "unmapped" | "tie" | "unknown_required" | "missing_submit";
  label?: string;
}

interface FieldAction {
  selector: string;
  kind: "fill" | "click";
  value?: string;
  secret?: boolean;
}

type RegistrationPlan =
  | { ok: true; actions: FieldAction[]; submit: FormFieldInfo }
  | ({ ok: false } & RegistrationPark);

interface Rank {
  field: FormFieldInfo | null;
  tie: boolean;
}

const REGISTER_TEXT =
  /registrieren|registration|register|sign[\s-]?up|join|mitglied werden|konto (?:erstellen|anlegen)|create (?:an )?account|neu hier/i;
const LOGIN_TEXT = /log ?in|sign ?in|anmelden|einloggen/i;
const NOT_REGISTER = /unregister|login|log ?in|sign ?in|anmelden|suche|search/i;
/** The address is the registration page even when the visible words are not. */
const REGISTER_HREF =
  /mode=register|\/register\/?|\/signup|action=register|do=register|cmd=register/i;

function blob(field: FormFieldInfo): string {
  return `${field.name ?? ""} ${field.id ?? ""} ${field.label} ${field.group ?? ""} ${field.autocomplete ?? ""} ${field.placeholder ?? ""}`.toLowerCase();
}

function visible(fields: readonly FormFieldInfo[]): FormFieldInfo[] {
  return fields.filter((field) => !field.hidden && field.type !== "hidden");
}

function isSubmit(field: FormFieldInfo): boolean {
  if (field.type === "reset" || field.type === "button") return false;
  if (field.type === "submit") return true;
  if (field.tag !== "button") return false;
  return /register|registrier|sign ?up|anmeld|log ?in|reply|antworten|absenden|submit|erstellen/.test(
    blob(field),
  );
}

function pick(
  fields: readonly FormFieldInfo[],
  score: (field: FormFieldInfo) => number,
  minimum: number,
): Rank {
  let top: FormFieldInfo | null = null;
  let high = 0;
  let count = 0;
  for (const field of fields) {
    const value = score(field);
    if (value < minimum) continue;
    if (value > high) {
      high = value;
      top = field;
      count = 1;
    } else if (value === high) count += 1;
  }
  if (!top) return { field: null, tie: false };
  if (count > 1) {
    const required = fields.filter((field) => score(field) === high && field.required);
    if (required.length === 1) return { field: required[0] ?? null, tie: false };
    return { field: null, tie: true };
  }
  return { field: top, tie: false };
}

function except(fields: readonly FormFieldInfo[], used: ReadonlySet<string>): FormFieldInfo[] {
  return fields.filter((field) => !used.has(field.selector));
}

function textControl(field: FormFieldInfo): boolean {
  return (
    !isSubmit(field) &&
    field.type !== "password" &&
    field.type !== "email" &&
    field.type !== "checkbox" &&
    field.type !== "radio" &&
    field.type !== "hidden" &&
    field.tag !== "select"
  );
}

function scoreUsername(field: FormFieldInfo): number {
  if (!textControl(field)) return 0;
  let score = 0;
  if (field.autocomplete === "username") score += 4;
  if (/^(user_?name|login|nick|handle|name|form_name)$/.test((field.name ?? "").toLowerCase()))
    score += 3;
  if (/username|user name|benutzername|\bhandle\b|display name/.test(blob(field))) score += 2;
  return score;
}

function scoreDisplayName(field: FormFieldInfo): number {
  if (!textControl(field)) return 0;
  return /full name|real name|display name|your name|anzeigename|vor-? und nachname|vollst[aä]ndiger name/.test(
    blob(field),
  )
    ? 4
    : 0;
}

function scoreEmail(field: FormFieldInfo): number {
  if (/confirm|repeat|again|verify|erneut|wiederholen/.test(blob(field))) return 0;
  let score = 0;
  if (field.type === "email") score += 4;
  if (field.autocomplete === "email") score += 4;
  if (/e-?mail/.test(blob(field))) score += 3;
  return score;
}

function scoreEmailConfirm(field: FormFieldInfo): number {
  if (!/confirm|repeat|again|verify|erneut|wiederholen/.test(blob(field))) return 0;
  if (field.type === "email" || field.autocomplete === "email" || /e-?mail/.test(blob(field)))
    return 4;
  return 0;
}

function scorePassword(field: FormFieldInfo, kind: "register" | "login"): number {
  if (field.type !== "password") return 0;
  if (
    /confirm|repeat|again|match|password2|password-confirm|bestätig|wiederhol|_check\b/.test(
      blob(field),
    )
  )
    return 0;
  let score = 0;
  if (kind === "register" && field.autocomplete === "new-password") score += 4;
  if (kind === "login" && field.autocomplete === "current-password") score += 4;
  if (/password|passwort|secret|\bpass\b/.test(blob(field))) score += 3;
  return score;
}

function scoreConfirm(field: FormFieldInfo): number {
  if (field.type !== "password") return 0;
  return /confirm|repeat|again|match|password2|password-confirm|bestätig|wiederhol|_check\b/.test(
    blob(field),
  )
    ? 4
    : 0;
}

function scoreBody(field: FormFieldInfo): number {
  if (field.tag !== "textarea" && field.role !== "textbox") return 0;
  if (isCaptchaField(field)) return 0;
  if (
    /message|body|content|comment|\braw\b|reply|beitrag|nachricht|antwort|kommentar/.test(
      blob(field),
    )
  )
    return 4;
  return field.tag === "textarea" ? 2 : 0;
}

function scoreConsent(field: FormFieldInfo): number {
  if (field.type !== "checkbox") return 0;
  return /agree|terms|consent|rules|accept|agb|datenschutz|stimme|bedingungen|regeln/.test(
    blob(field),
  )
    ? 3
    : 0;
}

function scoreBio(field: FormFieldInfo): number {
  if (field.tag !== "textarea" && field.role !== "textbox") return 0;
  return /\bbio\b|about me|about/.test(blob(field)) ? 4 : 0;
}

function scoreSecurity(field: FormFieldInfo): number {
  if (!textControl(field)) return 0;
  if (looksLikeKnowledgeQuestion(field.label)) return 0;
  return /security question|secret question|sicherheitsfrage|security answer/.test(blob(field))
    ? 4
    : 0;
}

function scoreBirthday(field: FormFieldInfo, part: "day" | "month" | "year"): number {
  if (field.tag !== "select" && field.type !== "text" && field.type !== "number") return 0;
  const name = `${field.name ?? ""} ${field.id ?? ""}`.toLowerCase();
  const label = `${field.label} ${field.group ?? ""}`.toLowerCase();
  const birth = /birth|bday|geburt|dob/.test(`${name} ${label}`);
  if (!birth && !/birthday|geburtstag|date of birth/.test(label)) return 0;
  if (part === "day" && /(^|[^a-z])day([^a-z]|$)|(^|[^a-z])tag([^a-z]|$)/.test(name)) return 4;
  if (part === "month" && /month|monat/.test(name)) return 4;
  if (part === "year" && /year|jahr/.test(name)) return 4;
  if (
    part === "day" &&
    /birthday|geburtstag|date of birth/.test(label) &&
    !/month|year|monat|jahr/.test(name)
  ) {
    return 3;
  }
  return 0;
}

function scoreChoice(field: FormFieldInfo, kind: "language" | "timezone" | "gender"): number {
  if (field.tag !== "select" && field.type !== "radio") return 0;
  const pattern =
    kind === "language"
      ? /language|sprache/
      : kind === "timezone"
        ? /time ?zone|zeitzone/
        : /gender|geschlecht/;
  return pattern.test(blob(field)) ? 3 : 0;
}

function isCaptchaField(field: FormFieldInfo): boolean {
  const name = (field.name ?? "").toLowerCase();
  if (
    /confirm_code|qa_answer|captcha_answer|^verify$|g-recaptcha-response|h-captcha-response|cf-turnstile-response/.test(
      name,
    )
  ) {
    return true;
  }
  if (
    /confirmation code|bestätigungscode|sicherheitscode|überprüfungscode|ueberpruefungscode/.test(
      blob(field),
    ) &&
    textControl(field)
  )
    return true;
  return looksLikeKnowledgeQuestion(field.label) && scoreSecurity(field) === 0;
}

function pickSubmit(
  fields: readonly FormFieldInfo[],
  purpose: "register" | "login" | "reply",
): FormFieldInfo | null {
  const submits = fields.filter(isSubmit);
  if (submits.length === 1) return submits[0] ?? null;
  const hint =
    purpose === "register"
      ? /register|registrier|sign ?up|join|create|submit/
      : purpose === "login"
        ? /log ?in|sign ?in|anmelden|submit/
        : /reply|antworten|post|submit|comment/;
  const matched = submits.filter((field) => hint.test(blob(field)));
  if (matched.length === 1) return matched[0] ?? null;
  if (purpose === "reply") {
    const named = submits.filter((field) => /^(post|submit|reply)$/i.test(field.name ?? ""));
    if (named.length === 1) return named[0] ?? null;
  }
  return null;
}

function optionValue(field: FormFieldInfo, preferred: readonly string[]): string {
  const options = field.options?.filter((option) => option.value.trim() !== "") ?? [];
  for (const value of preferred) {
    if (options.length === 0 || options.some((option) => option.value === value)) return value;
  }
  return options[0]?.value ?? preferred[0] ?? "";
}

function newsletterOptOut(fields: readonly FormFieldInfo[]): Rank {
  const radios = fields.filter(
    (field) => field.type === "radio" && /newsletter|mailing|subscribe/.test(blob(field)),
  );
  const no = radios.filter((field) => /\bno\b|\bnein\b/.test(blob(field)) || field.value === "0");
  if (no.length === 1) return { field: no[0] ?? null, tie: false };
  if (no.length > 1) return { field: null, tie: true };
  return { field: null, tie: false };
}

function privacyYes(fields: readonly FormFieldInfo[]): Rank {
  const radios = fields.filter(
    (field) => field.type === "radio" && /privacy|terms|agree|consent/.test(blob(field)),
  );
  const yes = radios.filter((field) => /\byes\b|\bja\b/.test(blob(field)) || field.value === "1");
  if (yes.length === 1) return { field: yes[0] ?? null, tie: false };
  if (yes.length > 1) return { field: null, tie: true };
  return { field: null, tie: false };
}

function fill(field: FormFieldInfo, value: string, secret = false): FieldAction {
  return secret
    ? { selector: field.selector, kind: "fill", value, secret: true }
    : { selector: field.selector, kind: "fill", value };
}

function click(field: FormFieldInfo): FieldAction {
  return { selector: field.selector, kind: "click" };
}

/** Maps a personal-name persona onto a form. A tie or an unnamed required field parks. */
export function planRegistration(
  fields: readonly FormFieldInfo[],
  profile: RegistrationProfile,
  options: { birthdayRequired?: boolean } = {},
): RegistrationPlan {
  const open = visible(fields);
  const used = new Set<string>();
  const take = (rank: Rank, label: string): RegistrationPark | null => {
    if (rank.tie) return { reason: "tie", label };
    if (rank.field) used.add(rank.field.selector);
    return null;
  };
  const username = pick(open, scoreUsername, 2);
  const usernamePark = take(username, username.field?.label || "username");
  if (usernamePark) return { ok: false, ...usernamePark };
  const email = pick(except(open, used), scoreEmail, 2);
  const emailPark = take(email, email.field?.label || "email");
  if (emailPark) return { ok: false, ...emailPark };
  const password = pick(except(open, used), (field) => scorePassword(field, "register"), 2);
  const passwordPark = take(password, password.field?.label || "password");
  if (passwordPark) return { ok: false, ...passwordPark };
  const submit = pickSubmit(open, "register");
  if (!username.field || !email.field || !password.field || !submit) {
    return { ok: false, reason: submit ? "unmapped" : "missing_submit" };
  }
  if (new Set([username.field.selector, email.field.selector, password.field.selector]).size < 3) {
    return { ok: false, reason: "tie", label: "username" };
  }

  const actions: FieldAction[] = [
    fill(username.field, profile.username),
    fill(email.field, profile.email),
    fill(password.field, profile.password, true),
  ];
  const confirm = pick(except(open, used), scoreConfirm, 2);
  const confirmPark = take(confirm, "password confirm");
  if (confirmPark) return { ok: false, ...confirmPark };
  if (confirm.field) actions.push(fill(confirm.field, profile.password, true));

  const emailConfirm = pick(except(open, used), scoreEmailConfirm, 2);
  const emailConfirmPark = take(emailConfirm, "email confirm");
  if (emailConfirmPark) return { ok: false, ...emailConfirmPark };
  if (emailConfirm.field) actions.push(fill(emailConfirm.field, profile.email));

  const display = pick(except(open, used), scoreDisplayName, 2);
  const displayPark = take(display, display.field?.label || "name");
  if (displayPark) return { ok: false, ...displayPark };
  if (display.field) {
    const name = [profile.givenName, profile.familyName].filter(Boolean).join(" ");
    actions.push(fill(display.field, name));
  }

  const consentFields = except(open, used).filter((field) => scoreConsent(field) >= 2);
  const requiredConsent = consentFields.filter((field) => field.required);
  if (consentFields.length > 1 && requiredConsent.length === 0) {
    return { ok: false, reason: "tie", label: "consent" };
  }
  for (const field of requiredConsent.length > 0 ? requiredConsent : consentFields) {
    used.add(field.selector);
    actions.push(click(field));
  }

  const newsletter = newsletterOptOut(except(open, used));
  const newsletterPark = take(newsletter, "newsletter");
  if (newsletterPark) return { ok: false, ...newsletterPark };
  if (newsletter.field) actions.push(click(newsletter.field));

  const privacy = privacyYes(except(open, used));
  const privacyPark = take(privacy, "privacy");
  if (privacyPark) return { ok: false, ...privacyPark };
  if (privacy.field) actions.push(click(privacy.field));

  const birthday: Array<["day" | "month" | "year", string]> = [
    ["day", profile.birthday.day],
    ["month", profile.birthday.month],
    ["year", profile.birthday.year],
  ];
  for (const [part, value] of birthday) {
    const ranked = pick(except(open, used), (field) => scoreBirthday(field, part), 2);
    const parked = take(ranked, `birthday ${part}`);
    if (parked) return { ok: false, ...parked };
    if (ranked.field && (ranked.field.required || options.birthdayRequired))
      actions.push(fill(ranked.field, optionValue(ranked.field, [value])));
  }

  const security = pick(except(open, used), scoreSecurity, 2);
  const securityPark = take(security, security.field?.label || "security question");
  if (securityPark) return { ok: false, ...securityPark };
  if (security.field?.required) actions.push(fill(security.field, profile.securityAnswer));

  for (const kind of ["language", "timezone", "gender"] as const) {
    const ranked = pick(except(open, used), (field) => scoreChoice(field, kind), 2);
    const parked = take(ranked, kind);
    if (parked) return { ok: false, ...parked };
    if (!ranked.field?.required) continue;
    const preferred =
      kind === "language"
        ? [profile.language, "en", "English"]
        : kind === "timezone"
          ? [profile.timezone, "Europe/Berlin"]
          : ["unspecified", "0", "n"];
    actions.push(fill(ranked.field, optionValue(ranked.field, preferred)));
  }

  const radioNames = new Set(
    open
      .filter((field) => used.has(field.selector) && field.type === "radio" && field.name)
      .map((field) => field.name),
  );
  for (const field of open) {
    if (!field.required || used.has(field.selector) || isSubmit(field) || isCaptchaField(field))
      continue;
    if (field.type === "radio" && field.name && radioNames.has(field.name)) continue;
    return {
      ok: false,
      reason: "unknown_required",
      label: field.label || field.name || field.id || "required",
    };
  }
  return { ok: true, actions, submit };
}

export function registrationProfile(
  account: BoardAccount & Partial<Omit<RegistrationProfile, keyof BoardAccount>>,
): RegistrationProfile {
  return {
    username: account.username,
    email: account.email,
    password: account.password,
    givenName: account.givenName ?? "Sophie",
    familyName: account.familyName ?? "Braun",
    birthday: account.birthday ?? { day: "15", month: "6", year: "1990" },
    securityAnswer: account.securityAnswer ?? "nordlicht",
    language: account.language ?? "en",
    timezone: account.timezone ?? "Europe/Berlin",
  };
}

function scoreCaptchaAnswer(field: FormFieldInfo): number {
  if (!textControl(field)) return 0;
  if (/^(confirm_code|captcha_answer|verify)$/.test((field.name ?? "").toLowerCase())) return 4;
  if (/confirmation code|bestätigungscode|sicherheitscode/.test(blob(field))) return 3;
  return 0;
}

/** XenForo prints these on every page. They are not the registration result. */
const BOARD_CHROME =
  /javascript ist deaktiviert|veralteten browser|please enable javascript|outdated browser/i;

const RESULT_SELECTORS =
  ".blockMessage--error, .formRow--error, .inputValidationError, .error, #message, .blockMessage";

/** A search box or a login form is not the registration form. */
async function registrationFormStillOpen(session: BrowserSession): Promise<boolean> {
  const fields = await fieldsIn(session, "form");
  if (!fields?.length) return false;
  return planRegistration(
    fields,
    registrationProfile({
      username: "member",
      email: "member@example.com",
      password: "password",
    }),
  ).ok;
}

async function fieldsIn(
  session: BrowserSession,
  selector: string,
): Promise<FormFieldInfo[] | null> {
  if (!session.formFields) return null;
  return session.formFields(selector);
}

const PHPBB_PROPERTY_KEEP = new Set([
  "deutschsprachig",
  "deutsche übersetzung",
  "supportforum",
  "phpbb-download",
]);

/** Kitchen classification for the "Obst / Gemüse" sortable, not the botanical one. */
const VEGETABLES = new Set([
  "zucchini",
  "paprika",
  "tomate",
  "karotte",
  "möhre",
  "gurke",
  "salat",
  "kohl",
  "zwiebel",
  "lauch",
  "kartoffel",
  "brokkoli",
  "blumenkohl",
  "spinat",
  "aubergine",
  "kürbis",
  "bohne",
  "erbse",
]);

/**
 * phpBB.de asks which properties belong on the board and which do not.
 * The decoys start in the matching list, so the submit is refused until they move.
 */
export async function arrangeSortableCaptcha(session: BrowserSession): Promise<void> {
  if (!session.listText || !session.drag) return;
  if (!(await session.exists("#sortable1")) || !(await session.exists("#sortable2"))) return;
  const page = ((await session.pageText()) ?? "").toLowerCase();
  const move = async (label: string) => {
    const escaped = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await session.drag(`#sortable1 li:text-is("${escaped}")`, "#sortable2");
  };
  if (page.includes("welche eigenschaften passen zu www.phpbb.de")) {
    const items = await session.listText("#sortable1 li");
    for (const item of items) {
      const label = item.replace(/\s+/g, " ").trim();
      if (!label || PHPBB_PROPERTY_KEEP.has(label.toLowerCase())) continue;
      await move(label);
    }
    return;
  }
  if (page.includes("obst") && page.includes("gemüse")) {
    const items = await session.listText("#sortable1 li");
    for (const item of items) {
      const label = item.replace(/\s+/g, " ").trim();
      if (!label || !VEGETABLES.has(label.toLowerCase())) continue;
      await move(label);
    }
  }
}

/** XenForo keeps the register button on a short timer. Clicking early does not submit. */
async function waitForRegisterTimer(session: BrowserSession): Promise<void> {
  if (!(await session.exists("#js-regTimer"))) return;
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const text = ((await session.text("#js-regTimer")) ?? "").toLowerCase();
    if (text && !/warte|sekunde|\bwait\b/.test(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function registerControlScore(control: ClickableControl, allowBodySubmit: boolean): number {
  const text = control.text.replace(/\s+/g, " ").trim();
  const href = control.href ?? "";
  if (!text || text.length > 80) return 0;
  if (/nicht einverstanden|not agree|do not agree|decline|abbrechen|cancel/.test(text)) return 0;
  const hrefHit = REGISTER_HREF.test(href);
  if ((NOT_REGISTER.test(text) || !REGISTER_TEXT.test(text)) && !hrefHit) return 0;
  const submitsForm =
    (control.tag === "input" || control.tag === "button") &&
    (control.type === "submit" || control.type === null || control.type === "button") &&
    control.tag !== "a";
  // A submit on a page that already asks for a password is the form itself, not the way in.
  if (submitsForm && !control.inHeader && !allowBodySubmit) return 0;
  let score = 2;
  if (hrefHit) score += 4;
  if (
    /^(registrieren|register|sign ?up|konto erstellen|mitglied werden|jetzt mitmachen)\b/i.test(
      text,
    )
  ) {
    score += 3;
  } else if (REGISTER_TEXT.test(text)) {
    score += 2;
  }
  if (control.inHeader) score += 2;
  if (control.tag === "a" || control.role === "link" || control.role === "menuitem") score += 2;
  return score;
}

/** Opens the register address shown on the page. A click is not required. */
async function followRegisterHref(session: BrowserSession): Promise<boolean> {
  if (!session.clickables) return false;
  const here = await session.url();
  const controls = await session.clickables();
  let bestHref: string | null = null;
  let bestScore = 0;
  for (const control of controls) {
    if (!control.href || !REGISTER_HREF.test(control.href)) continue;
    const score = registerControlScore(control, true);
    if (score <= bestScore) continue;
    bestHref = control.href;
    bestScore = score;
  }
  if (!bestHref) return false;
  let absolute: string;
  try {
    absolute = new URL(bestHref, here).href;
  } catch {
    return false;
  }
  if (absolute === here) return false;
  try {
    await session.goto(absolute);
  } catch {
    return false;
  }
  return true;
}

/** Clicks the register link a person would use. Returns false when that link is not on the page. */
async function clickRegisterControl(session: BrowserSession): Promise<boolean> {
  if (!session.clickables) return false;
  const fields = await fieldsIn(session, "form");
  const allowBodySubmit = !fields?.some((field) => field.type === "password");
  const controls = await session.clickables();
  let best: ClickableControl | null = null;
  let bestScore = 0;
  for (const control of controls) {
    const score = registerControlScore(control, allowBodySubmit);
    if (score > bestScore) {
      best = control;
      bestScore = score;
    }
  }
  if (!best) best = accountSibling(controls);
  if (!best) return false;
  await session.click(best.selector);
  return true;
}

/**
 * Boards put the way in beside the login link and name it however they like.
 * When that pair is the only extra header link, it is the register control.
 */
function accountSibling(controls: readonly ClickableControl[]): ClickableControl | null {
  const login = controls.find((control) => control.inHeader && LOGIN_TEXT.test(control.text));
  if (!login) return null;
  const siblings = controls.filter((control) => {
    if (!control.inHeader || control === login || control.tag !== "a") return false;
    const text = control.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 40) return false;
    if (NOT_REGISTER.test(text) || LOGIN_TEXT.test(text)) return false;
    if (
      /faq|regeln|rules|search|suche|home|startseite|forum|members|mitglieder|kalender|calendar|impressum|datenschutz|privacy|hilfe|help|kontakt/i.test(
        text,
      )
    ) {
      return false;
    }
    return true;
  });
  return siblings.length === 1 ? (siblings[0] ?? null) : null;
}

async function ensureOnSite(session: BrowserSession, homepageUrl: string): Promise<void> {
  let current = "about:blank";
  try {
    current = await session.url();
  } catch {
    current = "about:blank";
  }
  let sameOrigin = false;
  try {
    sameOrigin = new URL(current).origin === new URL(homepageUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) await session.goto(homepageUrl);
}

async function followAnchor(
  session: BrowserSession,
  selectors: readonly string[],
  accept: RegExp,
  reject: RegExp,
): Promise<boolean> {
  for (const selector of selectors) {
    if (!(await session.exists(selector))) continue;
    const text = ((await session.text(selector)) ?? "").trim();
    if (!accept.test(text) || reject.test(text)) continue;
    const href = await session.attribute(selector, "href");
    if (!href) continue;
    await session.goto(new URL(href, await session.url()).href);
    return true;
  }
  return false;
}

async function detectImageCaptcha(session: BrowserSession): Promise<CaptchaChallenge | null> {
  const images = [
    "img[src*='mode=confirm']",
    "img.captcha-image",
    ".captchaContainer img",
    "img[src*='GetCaptcha']",
    "img[alt*='Confirmation code']",
  ];
  let imageSelector: string | null = null;
  for (const selector of images) {
    if (await session.exists(selector)) {
      imageSelector = selector;
      break;
    }
  }
  if (!imageSelector) return null;
  const fields = await fieldsIn(session, "form");
  const answer = fields ? pick(visible(fields), scoreCaptchaAnswer, 2).field : null;
  if (answer) return { kind: "image", imageSelector, answerSelector: answer.selector };
  if (await session.exists("#confirm_code"))
    return { kind: "image", imageSelector, answerSelector: "#confirm_code" };
  return null;
}

async function detectQuestionField(session: BrowserSession): Promise<CaptchaChallenge | null> {
  const fields = await fieldsIn(session, "form");
  if (!fields) return null;
  for (const field of visible(fields)) {
    if (!textControl(field) || !looksLikeKnowledgeQuestion(field.label)) continue;
    if (scoreSecurity(field) > 0) continue;
    return { kind: "question", question: field.label.trim(), answerSelector: field.selector };
  }
  return null;
}

export class GenericFormDriver implements BoardDriver {
  readonly platform = "unknown" as const;
  readonly bodyFormat = "plain" as const;
  readonly allowEmoji = false;
  readonly nofollowDefault = true;
  private submitSelector: string | null = null;
  private replySelector: { body: string; submit: string } | null = null;
  lastPark: RegistrationPark | null = null;

  get registerSubmitSelector(): string {
    return this.submitSelector ?? "form [data-unmapped-submit]";
  }

  detect(): boolean {
    return false;
  }

  registerUrl(homepageUrl: string): string {
    return new URL("/register", homepageUrl).href;
  }

  async openRegistration(session: BrowserSession, homepageUrl: string): Promise<RegistrationPage> {
    this.lastPark = null;
    await releaseSignupForm(session);
    await ensureOnSite(session, homepageUrl);
    // Same shape as the computer agent: look at this page, take one step, look again.
    // The words and the path differ on every board, so there is no fixed click sequence.
    const entries = [
      new URL("/register", homepageUrl).href,
      new URL("/register/", homepageUrl).href,
      new URL("/community/register/", homepageUrl).href,
      new URL("/profile/register", homepageUrl).href,
      new URL("/forum/register/", homepageUrl).href,
      new URL("/core/register/", homepageUrl).href,
      new URL("/ucp.php?mode=register", homepageUrl).href,
    ];
    let entryIndex = 0;
    let previous = "";
    for (let step = 0; step < 12; step += 1) {
      // Each navigation uses the session timeout. A snapshot here can sit on the
      // homepage until the worker step budget fires, so the path only navigates.
      const here = await session.url();
      const text = await session.pageText();
      const signature = `${here}\n${text.slice(0, 500)}`;
      if (signature === previous) break;
      previous = signature;
      if (registrationClosed(text)) return "closed";
      if ((await acceptCookieWall(session)) === "accepted") {
        previous = "";
        continue;
      }
      if ((await this.mapOpenRegistration(session)) === "form") return "form";
      if (await this.acceptTermsGate(session)) continue;
      if (await followRegisterHref(session)) {
        previous = "";
        continue;
      }
      const beforeClick = `${await session.url()}\n${(await session.pageText()).slice(0, 500)}`;
      if (await clickRegisterControl(session)) {
        const afterClick = `${await session.url()}\n${(await session.pageText()).slice(0, 500)}`;
        if (afterClick !== beforeClick) {
          previous = "";
          continue;
        }
      }
      if (entryIndex < entries.length) {
        const entry = entries[entryIndex] ?? "";
        entryIndex += 1;
        if (here !== entry) {
          try {
            await session.goto(entry);
          } catch {
            continue;
          }
          continue;
        }
      }
      break;
    }
    if (registrationClosed(await session.pageText())) return "closed";
    const page = await this.mapOpenRegistration(session);
    if (page === "form") return "form";
    this.lastPark = this.lastPark ?? { reason: "unmapped" };
    return page === "closed" ? "closed" : "unknown";
  }

  /** Classifies the current page without navigating. */
  async mapOpenRegistration(session: BrowserSession): Promise<RegistrationPage> {
    const fields = await fieldsIn(session, "form");
    if (!fields) {
      this.submitSelector = null;
      this.lastPark = { reason: "unmapped" };
      return "unmapped";
    }
    const plan = planRegistration(
      fields,
      registrationProfile({
        username: "member",
        email: "member@example.com",
        password: "password",
      }),
    );
    if (!plan.ok) {
      this.submitSelector = null;
      this.lastPark = { reason: plan.reason, label: plan.label };
      return "unmapped";
    }
    this.submitSelector = plan.submit.selector;
    this.lastPark = null;
    return "form";
  }

  async fillRegistration(
    session: BrowserSession,
    account: BoardAccount,
    options: { birthdayRequired?: boolean } = {},
  ): Promise<void> {
    await holdSignupForm(session);
    const fields = await fieldsIn(session, "form");
    const birthdayRequired =
      options.birthdayRequired ||
      /please enter (?:your birthday|a valid date of birth)/i.test(
        (await this.pageMessages(session)).join("\n"),
      );
    const plan = fields
      ? planRegistration(fields, registrationProfile(account), { birthdayRequired })
      : null;
    if (!plan?.ok) throw new UnmappedFormError("register");
    this.submitSelector = plan.submit.selector;
    for (const action of plan.actions) {
      if (action.kind === "click") {
        if ((await session.attribute(action.selector, "checked")) === null)
          await session.click(action.selector);
        continue;
      }
      await session.fill(
        action.selector,
        action.value ?? "",
        action.secret ? { secret: true } : undefined,
      );
    }
    const filled = new Set(
      plan.actions.filter((action) => action.kind === "fill").map((action) => action.selector),
    );
    for (const field of fields ?? []) {
      if (filled.has(field.selector) || isCaptchaField(field)) continue;
      if (!textControl(field) || !field.label.includes("*")) continue;
      const current = (await session.attribute(field.selector, "value"))?.trim();
      if (current) continue;
      await session.fill(field.selector, "keine");
    }
  }

  async detectCaptcha(session: BrowserSession): Promise<CaptchaChallenge> {
    const image = await detectImageCaptcha(session);
    if (image) return image;
    const known = await detectKnowledgeQuestion(session);
    if (known) return known;
    const question = await detectQuestionField(session);
    if (question) return question;
    return detectWidget(session);
  }

  async submitRegistration(session: BrowserSession): Promise<RegistrationResult> {
    if (!this.submitSelector) throw new UnmappedFormError("register");
    await arrangeSortableCaptcha(session);
    await waitForRegisterTimer(session);
    await session.click(this.submitSelector);
    await releaseSignupForm(session);
    return this.readRegistrationResult(session, { waitMs: 15_000 });
  }

  async readRegistrationResult(
    session: BrowserSession,
    options: { waitMs?: number } = {},
  ): Promise<RegistrationResult> {
    if (options.waitMs) {
      await session.waitFor("#message, .error, .blockMessage--error, .formRow--error", {
        timeoutMs: options.waitMs,
      });
    }
    const messages = await this.pageMessages(session);
    return classifyRegistration(messages.join("\n"), await registrationFormStillOpen(session));
  }

  async activationResult(session: BrowserSession): Promise<ActivationResult> {
    const messages = (await this.pageMessages(session)).join("\n");
    const classified = classifyRegistration(messages, false);
    if (classified.kind === "pending_admin") return "pending_admin";
    if (await this.isLoggedIn(session)) return "active";
    const fields = await fieldsIn(session, "form");
    const login = fields ? mapLogin(fields) : null;
    const register = fields
      ? planRegistration(
          fields,
          registrationProfile({
            username: "member",
            email: "member@example.com",
            password: "password",
          }),
        )
      : null;
    const error = ((await session.text(".error")) ?? "").trim();
    if (login && !register?.ok && !error) return "active";
    const result = classifyRegistration((await this.pageMessages(session)).join("\n"), false);
    if (result.kind === "pending_admin") return "pending_admin";
    if (result.kind === "active") return "active";
    return "unknown";
  }

  async isLoggedIn(session: BrowserSession): Promise<boolean> {
    return session.exists(LOGGED_IN_SELECTOR);
  }

  async login(
    session: BrowserSession,
    homepageUrl: string,
    account: Pick<BoardAccount, "username" | "password">,
  ): Promise<boolean> {
    if (await this.isLoggedIn(session)) return true;
    if (!(await this.onLoginForm(session))) {
      const opened = await this.openLogin(session, homepageUrl);
      if (!opened) {
        if (await this.isLoggedIn(session)) return true;
        throw new UnmappedFormError("login");
      }
    }
    const fields = await fieldsIn(session, "form");
    const mapped = fields ? mapLogin(fields) : null;
    if (!mapped) throw new UnmappedFormError("login");
    await session.fill(mapped.identity.selector, account.username);
    await session.fill(mapped.password.selector, account.password, { secret: true });
    await session.click(mapped.submit.selector);
    return session.waitFor(LOGGED_IN_SELECTOR, { timeoutMs: 10_000 });
  }

  async readThreadMeta(session: BrowserSession) {
    return readThreadMetaFromSession(session, "markup");
  }

  async lastPageUrl(session: BrowserSession, _thread: BoardThread): Promise<string | null> {
    const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
    const current = await session.url().catch(() => "");
    if (!html || !current) return null;
    return genericLastPageUrl(html, current);
  }

  async listThreads(
    session: BrowserSession,
    homepageUrl: string,
    topic?: { terms: string[]; activityDays?: number },
  ): Promise<BoardThread[]> {
    await session.goto(homepageUrl);
    const home = await collectThreads(session);
    const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
    const base = await session.url().catch(() => homepageUrl);
    const sections = html ? genericSections(html, base, topic?.terms ?? []) : [];
    const found = [...home];
    const activityDays = topic?.activityDays ?? 30;
    for (const section of sections.slice(0, 3)) {
      try {
        await session.goto(section);
      } catch {
        continue;
      }
      const page = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
      const pageUrl = await session.url().catch(() => section);
      found.push(...genericSectionRows(page, pageUrl, activityDays));
    }
    const merged = orderListedThreads(dedupeThreads(found), topic?.terms ?? []);
    if (merged.length > 0) return merged.slice(0, 25);
    const forum = await session.attribute("a.forumtitle, a[href*='viewforum']", "href");
    if (!forum) return [];
    await session.goto(new URL(forum, await session.url()).href);
    return collectThreads(session);
  }

  async openReply(session: BrowserSession, thread: BoardThread): Promise<boolean> {
    await session.goto(thread.url);
    if (!(await this.replyReady(session))) {
      const followed = await followAnchor(
        session,
        [
          "a.reply",
          "a[href*='mode=reply']",
          "a[href*='add-reply']",
          "a[href*='/reply']",
          "a[href*='/forum/post/']",
        ],
        /reply|antworten|antwort|post a reply/i,
        /quote|edit|zitat/i,
      );
      if (!followed) {
        const href = await session.attribute(
          "a.reply, a[href*='mode=reply'], a[href*='add-reply']",
          "href",
        );
        if (href) await session.goto(new URL(href, await session.url()).href);
      }
    }
    if (!(await this.replyReady(session))) {
      if (repliesClosed(await session.pageText())) return false;
      throw new UnmappedFormError("reply");
    }
    return true;
  }

  async fillReply(session: BrowserSession, body: string): Promise<void> {
    if (!this.replySelector) throw new UnmappedFormError("reply");
    await session.fill(this.replySelector.body, body);
  }

  async submitReply(session: BrowserSession): Promise<ReplyResult> {
    if (!this.replySelector) throw new UnmappedFormError("reply");
    const before = await session.url();
    await session.click(this.replySelector.submit);
    await session.waitFor("#message, .error", { timeoutMs: 15_000 });
    const messages = await this.pageMessages(session);
    const href = await session.attribute("#message a.permalink, #message a[href]", "href");
    if (href && postedSuccessfully(messages.join("\n"))) {
      return { kind: "posted", permalink: new URL(href, await session.url()).href };
    }
    const after = await session.url();
    if (/\/forum\/topic\//i.test(after) && after !== before) {
      return { kind: "posted", permalink: after };
    }
    if (await this.replyReady(session)) return { kind: "rejected", messages };
    if (postedSuccessfully(messages.join("\n"))) {
      return { kind: "posted", permalink: after };
    }
    return { kind: "unknown", messages };
  }

  probeLinkRule(pageText: string): LinkRuleProbe {
    const flat = pageText.replace(/\s+/g, " ");
    const after =
      /links?[^.]{0,80}?(?:after|until|before)\s+(\d{1,4})\s+posts?/i.exec(flat) ??
      /(?:after|until|before)\s+(\d{1,4})\s+posts?[^.]{0,40}links?/i.exec(flat);
    if (after) {
      return {
        hrefForNewMembers: "after_n_posts",
        minPosts: Number(after[1]),
        relDefault: "unknown",
      };
    }
    return { hrefForNewMembers: "unknown", minPosts: null, relDefault: "unknown" };
  }

  async probePageLinkRule(session: BrowserSession): Promise<LinkRuleProbe> {
    const base = this.probeLinkRule(await session.pageText());
    const rel = relFromAttribute(await session.attribute("a.memberLink", "rel"));
    if (rel) return { ...base, relDefault: rel };
    return { ...base, relDefault: "nofollow" };
  }

  async setProfile(
    session: BrowserSession,
    homepageUrl: string,
    profile: ProfileInput,
  ): Promise<boolean> {
    await session.goto(new URL("/account", homepageUrl).href);
    const fields = await fieldsIn(session, "form");
    const bio = fields ? pick(fields, scoreBio, 2).field : null;
    if (!bio) return false;
    await session.fill(bio.selector, profile.bio);
    const signature = fields?.find(
      (field) => field.tag === "textarea" && /signature/.test(blob(field)),
    );
    if (signature) {
      await session.fill(
        signature.selector,
        profile.includeSignature ? (profile.signature ?? "") : "",
      );
    }
    const submit = fields ? pickSubmit(fields, "register") : null;
    if (submit) await session.click(submit.selector);
    return true;
  }

  async pageMessages(session: BrowserSession): Promise<string[]> {
    const listed = session.listText ? await session.listText(RESULT_SELECTORS) : [];
    const raw = listed.length > 0 ? listed : [(await session.text(RESULT_SELECTORS)) ?? ""];
    const seen = new Set<string>();
    const messages: string[] = [];
    for (const item of raw) {
      const text = item.replace(/\s+/g, " ").trim();
      if (!text || text.length > 600 || BOARD_CHROME.test(text) || seen.has(text)) continue;
      seen.add(text);
      messages.push(text);
    }
    return messages;
  }

  /** True when the open form tells the reader an administrator must activate the account. */
  async formRequiresAdmin(session: BrowserSession): Promise<boolean> {
    return adminActivationNotice(await session.pageText());
  }

  private async acceptTermsGate(session: BrowserSession): Promise<boolean> {
    const fields = await fieldsIn(session, "form");
    if (!fields?.length) return false;
    const plan = planRegistration(
      fields,
      registrationProfile({
        username: "member",
        email: "member@example.com",
        password: "password",
      }),
    );
    if (plan.ok) return false;
    if (fields.some((field) => field.type === "password" || field.type === "email")) return false;
    const agree = fields.filter((field) => {
      if (!isSubmit(field)) return false;
      const text = blob(field);
      if (
        /do not|not agree|not_agreed|disagree|decline|nicht zustimm|nicht einverstanden|nicht akzept/.test(
          text,
        )
      )
        return false;
      return /agree|akzeptier|zustimm|ich stimme|accept|einverstanden/.test(text);
    });
    if (agree.length !== 1) return false;
    await session.click(agree[0]!.selector);
    return true;
  }

  private async onLoginForm(session: BrowserSession): Promise<boolean> {
    const fields = await fieldsIn(session, "form");
    if (!fields) return false;
    return (
      mapLogin(fields) !== null &&
      !planRegistration(
        fields,
        registrationProfile({
          username: "member",
          email: "member@example.com",
          password: "password",
        }),
      ).ok
    );
  }

  private async openLogin(session: BrowserSession, homepageUrl: string): Promise<boolean> {
    const guesses = [
      ...new Set([
        new URL("/login", homepageUrl).href,
        new URL("/login/", homepageUrl).href,
        new URL("/profile/logon", homepageUrl).href,
        new URL("/profile/login", homepageUrl).href,
        new URL("ucp.php?mode=login", homepageUrl).href,
      ]),
    ];
    for (const url of guesses) {
      try {
        await session.goto(url);
      } catch {
        continue;
      }
      if (await this.isLoggedIn(session)) return true;
      if (await this.onLoginForm(session)) return true;
    }
    try {
      await session.goto(homepageUrl);
    } catch {
      return false;
    }
    const followed = await followAnchor(
      session,
      ["a[href*='mode=login']", "a[href*='logon']", "a[href*='/login']", "a[href*='login']"],
      LOGIN_TEXT,
      /logout|register|registrieren/i,
    );
    return followed && (await this.onLoginForm(session));
  }

  private async replyReady(session: BrowserSession): Promise<boolean> {
    const fields = await fieldsIn(session, "form");
    const body = fields ? pick(visible(fields), scoreBody, 2) : null;
    const submit = fields ? pickSubmit(fields, "reply") : null;
    if (body?.tie || !body?.field || !submit) {
      this.replySelector = null;
      return false;
    }
    this.replySelector = { body: body.field.selector, submit: submit.selector };
    return true;
  }
}

function mapLogin(fields: readonly FormFieldInfo[]): {
  identity: FormFieldInfo;
  password: FormFieldInfo;
  submit: FormFieldInfo;
} | null {
  const open = visible(fields);
  const username = pick(open, scoreUsername, 2);
  const email = pick(open, scoreEmail, 2);
  const identity = username.tie ? null : (username.field ?? (email.tie ? null : email.field));
  const password = pick(open, (field) => scorePassword(field, "login"), 2);
  const submit = pickSubmit(open, "login");
  if (!identity || password.tie || !password.field || !submit) return null;
  if (identity.selector === password.field.selector) return null;
  return { identity, password: password.field, submit };
}

function anchorsToThreads(
  found: readonly { text: string; href: string }[],
  base: string,
): BoardThread[] {
  const threads: BoardThread[] = [];
  for (const item of found) {
    const title = item.text.replace(/\s+/g, " ").trim();
    if (!title || !item.href || isMailSendFailure(title)) continue;
    threads.push({
      url: new URL(item.href, base).href,
      title,
      openQuestion: /\?/.test(title),
    });
    if (threads.length >= 20) break;
  }
  return threads;
}

const LOGGED_IN_SELECTOR =
  "a.logout, a[href*='logout'], a[href*='Logout'], a[href*='logoff'], a[href*='Logoff']";

const THREAD_LINK_SELECTORS = [
  "#threads a",
  "li.thread a.threadTitle",
  "a.topictitle",
  "li.row a.topictitle",
  "a[href*='thread-']",
  "a[href*='/forum/topic/']",
];

async function collectThreads(session: BrowserSession): Promise<BoardThread[]> {
  if (session.listAnchors) {
    try {
      const base = await session.url();
      for (const selector of THREAD_LINK_SELECTORS) {
        const threads = anchorsToThreads(await session.listAnchors(selector), base);
        if (threads.length > 0) return threads;
      }
      return [];
    } catch {
      // The sandbox runner that is already open may not know this read yet.
    }
  }
  const patterns = [
    (index: number) => `#threads a:nth-of-type(${index})`,
    (index: number) => `li.thread:nth-of-type(${index}) a.threadTitle`,
    (index: number) => `li.row:nth-of-type(${index}) a.topictitle`,
  ];
  let pattern: ((index: number) => string) | null = null;
  for (const candidate of patterns) {
    if (await session.exists(candidate(1))) {
      pattern = candidate;
      break;
    }
  }
  if (!pattern) return [];
  const threads: BoardThread[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const selector = pattern(index);
    const href = await session.attribute(selector, "href");
    if (href === null) break;
    const title = ((await session.text(selector)) ?? "").trim();
    if (!title) continue;
    threads.push({
      url: new URL(href, await session.url()).href,
      title,
      openQuestion: /\?/.test(title),
    });
  }
  return threads;
}

const SECTION_HREF = /\/forum\/topics\/\d+\/|viewforum\.php\?f=\d+|\/forum\/board\//i;

function genericSections(html: string, base: string, terms: readonly string[]): string[] {
  const $ = load(html);
  const scored: Array<{ url: string; score: number; order: number }> = [];
  const seen = new Set<string>();
  $("a[href]").each((order, el) => {
    const href = $(el).attr("href") ?? "";
    if (!SECTION_HREF.test(href)) return;
    const name = $(el).text().replace(/\s+/g, " ").trim();
    const score = warmupBoardScore(name, terms);
    if (score <= 0) return;
    let url: string;
    try {
      url = new URL(href, base).href;
    } catch {
      return;
    }
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    scored.push({ url, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((row) => row.url);
}

function genericSectionRows(html: string, base: string, activityDays: number): BoardThread[] {
  const $ = load(html);
  const now = new Date();
  const threads: BoardThread[] = [];
  $("tr").each((_, node) => {
    const row = $(node);
    const link = row.find("td.title a[href*='/forum/topic/']").first();
    const href = link.attr("href");
    const title = link.text().replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const dated = parseGermanPostDate(row.find("td.last").text(), now, "Europe/Berlin");
    if (dated) {
      const age = (now.getTime() - Date.parse(dated)) / 86_400_000;
      if (Number.isFinite(age) && age > activityDays) return;
    }
    let url: string;
    try {
      url = new URL(href, base).href;
    } catch {
      return;
    }
    threads.push({ url, title, lastActivityAt: dated, openQuestion: /\?/.test(title) });
  });
  return threads;
}

function threadListKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return url;
  }
}

function dedupeThreads(threads: BoardThread[]): BoardThread[] {
  const byKey = new Map<string, BoardThread>();
  const order: string[] = [];
  for (const thread of threads) {
    const key = threadListKey(thread.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, thread);
      order.push(key);
      continue;
    }
    if (!existing.lastActivityAt && thread.lastActivityAt) byKey.set(key, thread);
  }
  return order.flatMap((key) => {
    const thread = byKey.get(key);
    return thread ? [thread] : [];
  });
}

function orderListedThreads(threads: BoardThread[], terms: readonly string[]): BoardThread[] {
  const hit = (title: string) =>
    warmupHealthTitle(title) ||
    WARMUP_BOARD_TERMS.some((term) => hasTerm(title, term)) ||
    terms.some((term) => hasTerm(title, term));
  return [...threads].sort((a, b) => {
    const delta = Number(hit(b.title)) - Number(hit(a.title));
    if (delta !== 0) return delta;
    const aAt = Date.parse(a.lastActivityAt ?? "") || 0;
    const bAt = Date.parse(b.lastActivityAt ?? "") || 0;
    return bAt - aAt;
  });
}
