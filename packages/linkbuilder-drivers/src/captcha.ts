import {
  type AdapterContext,
  type BrowserSession,
  type CaptchaSolver,
  CaptchaSolverError,
  MIN_CAPTCHA_IMAGE_BYTES,
  type TokenCaptchaType,
} from "@rakazo/adapter-kit";
import type { LbHumanCheckboxState } from "@rakazo/contracts";
import {
  decideHelperAction,
  type HelperDecision,
  type HelperMemory,
  PAGE_HELPER_BUTTON_SELECTOR,
} from "@rakazo/linkbuilder-core";
import type { CaptchaChallenge } from "./driver.js";

export { PAGE_HELPER_BUTTON_SELECTOR };

/** Padding added when a tight captcha image is too small to send. */
export const CAPTCHA_CROP_PADDING_PX = 12;
/** Insets used when the solver cannot read the picture: closer, then closer again. */
export const CAPTCHA_CLOSER_INSET_PX = [8, 16] as const;
const MIN_WIDTH = 40;
const MIN_HEIGHT = 16;
const MIN_ASPECT = 1.5;
const MAX_ASPECT = 12;

export interface ImageCaptchaSolution {
  answer: string;
  credits: number;
  balance: number;
  taskId: string;
}

export type ImageCaptchaResult =
  | ({ ok: true } & ImageCaptchaSolution)
  | { ok: false; reason: "not_read" | "crop_rejected" };

const SECURITY_LABEL = /security check|überprüfung|captcha prüfung/i;
const QUESTION_MARK = /\?/;
const ARITHMETIC = /\d+\s*[+\-x×*/]\s*\d+/i;
const QUESTION_WORDS = /hauptstadt|capital of|wie heißt|what is|wie viel|how many/i;

const QUESTION_FIELDS: ReadonlyArray<{ input: string; label: string }> = [
  { input: "#qa_answer", label: "label[for='qa_answer']" },
  { input: "input[name='qa_answer']", label: "label[for='qa_answer']" },
  { input: "#question_answer", label: "label[for='question_answer']" },
];

/** A field is a knowledge question when it asks something or poses arithmetic. */
export function looksLikeKnowledgeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 400) return false;
  return QUESTION_MARK.test(trimmed) || ARITHMETIC.test(trimmed) || QUESTION_WORDS.test(trimmed);
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 8_000 || height > 8_000) return null;
  return { width, height };
}

/** True when a crop is large enough and shaped like a letter captcha. */
export function captchaCropAcceptable(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MIN_CAPTCHA_IMAGE_BYTES) return false;
  const size = pngDimensions(bytes);
  if (!size || size.width < MIN_WIDTH || size.height < MIN_HEIGHT) return false;
  const aspect = size.width / size.height;
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
}

export function captchaResponseField(type: TokenCaptchaType): string {
  if (type === "turnstile") return "cf-turnstile-response";
  if (type === "hcaptcha") return "h-captcha-response";
  if (type === "geetest") return "geetest_validate";
  if (type === "funcaptcha") return "fc-token";
  return "g-recaptcha-response";
}

/**
 * Question-style fields the phpBB Q&A plugin and similar boards use.
 * Returns null when the page has no such field.
 */
export async function detectKnowledgeQuestion(
  session: BrowserSession,
): Promise<Extract<CaptchaChallenge, { kind: "question" }> | null> {
  for (const field of QUESTION_FIELDS) {
    if (!(await session.exists(field.input))) continue;
    const label = (await session.text(field.label)) ?? "";
    const question = label.trim() || (await session.pageText());
    if (!looksLikeKnowledgeQuestion(question) && !label.trim()) continue;
    const text = looksLikeKnowledgeQuestion(label) ? label.trim() : question.trim().slice(0, 400);
    if (!text) continue;
    return { kind: "question", question: text, answerSelector: field.input };
  }
  return null;
}

/**
 * When the driver sees no captcha, a security-check label with the helper button is still
 * a captcha, and a knowledge field is answered through the solver.
 */
export async function enrichCaptchaChallenge(
  session: BrowserSession,
  challenge: CaptchaChallenge,
  buttonSelector: string,
): Promise<CaptchaChallenge> {
  if (challenge.kind !== "none") return challenge;
  const question = await detectKnowledgeQuestion(session);
  if (question) return question;
  const text = await session.pageText();
  if (SECURITY_LABEL.test(text) && (await session.exists(buttonSelector))) {
    return { kind: "widget", type: "recaptcha_v2", siteKey: null };
  }
  return challenge;
}

async function crop(
  session: BrowserSession,
  selector: string,
  options: { paddingPx?: number; insetPx?: number },
): Promise<Uint8Array> {
  if (options.insetPx && options.insetPx > 0) {
    return session.elementScreenshotPng(selector, { insetPx: options.insetPx });
  }
  if (options.paddingPx && options.paddingPx > 0) {
    return session.elementScreenshotPng(selector, { paddingPx: options.paddingPx });
  }
  return session.elementScreenshotPng(selector);
}

export { isSecretRegistrationPrompt } from "@rakazo/adapter-kit";

/** A registration-form click from an answer instruction. Login controls are refused. */
export function instructionClickSelector(instruction: string): string | null {
  const match = /^click\s+([^.!\n]+?)(?:\s+on\b.*)?$/i.exec(instruction.trim());
  if (!match) return null;
  const label = match[1]?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/.test(label)) return null;
  if (/login|sign in|anmelden|password/i.test(label)) return null;
  return `button:has-text("${label}"), input[type="submit"][value="${label}"]`;
}

export function isLoginPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path === "/login" || path === "/login/" || path.endsWith("/login.php");
  } catch {
    return false;
  }
}

/**
 * Crops the captcha image and types the answer. A crop that is too small is expanded once.
 * An unreadable image is cropped closer and sent again, then closer a second time.
 * The image is the only thing sent to the solver.
 */
export async function solveImageCaptcha(
  session: BrowserSession,
  challenge: { imageSelector: string; answerSelector: string },
  solver: CaptchaSolver,
  context: AdapterContext,
): Promise<ImageCaptchaResult> {
  let image = await crop(session, challenge.imageSelector, {});
  if (!captchaCropAcceptable(image)) {
    image = await crop(session, challenge.imageSelector, { paddingPx: CAPTCHA_CROP_PADDING_PX });
    if (!captchaCropAcceptable(image)) return { ok: false, reason: "crop_rejected" };
  }
  const submitted = await submitImage(session, challenge.answerSelector, solver, context, image);
  if (submitted !== "not_read") return submitted;
  for (const insetPx of CAPTCHA_CLOSER_INSET_PX) {
    const closer = await crop(session, challenge.imageSelector, { insetPx });
    if (closer.byteLength < MIN_CAPTCHA_IMAGE_BYTES) continue;
    const again = await submitImage(session, challenge.answerSelector, solver, context, closer);
    if (again !== "not_read") return again;
  }
  return { ok: false, reason: "not_read" };
}

async function submitImage(
  session: BrowserSession,
  answerSelector: string,
  solver: CaptchaSolver,
  context: AdapterContext,
  image: Uint8Array,
): Promise<ImageCaptchaResult | "not_read"> {
  try {
    const result = await solver.solve({ type: "ImageToText", imagePng: image }, context);
    await session.fill(answerSelector, result.answer);
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof CaptchaSolverError && error.code === "not_read") return "not_read";
    throw error;
  }
}

/** Places a solver token into the widget field. The token is not logged. */
export async function placeCaptchaToken(
  session: BrowserSession,
  type: TokenCaptchaType,
  token: string,
): Promise<void> {
  const field = captchaResponseField(type);
  if (session.injectToken) {
    await session.injectToken(field, token);
    return;
  }
  await session.fill(`[name='${field}']`, token, { secret: true });
}

export interface PageHelperOptions {
  /** The helper's injected button; a helper-specific detail kept out of board drivers. */
  buttonSelector: string;
  submitSelector: string;
  humanCheckboxSelector?: string;
  imageGridSelector?: string;
  pageMessages(session: BrowserSession): Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock. Production passes `Date.now`; tests pass a fake clock. */
  now?: () => number;
  pollMs?: number;
  /** Safety bound on observe-act cycles; the helper machine itself bounds tries and timeouts. */
  maxCycles?: number;
}

export interface PageHelperRun {
  decision: HelperDecision;
  buttonText: string | null;
  humanCheckbox: LbHumanCheckboxState;
  imageGridOpen: boolean;
  cycles: number;
}

async function humanCheckboxState(
  session: BrowserSession,
  selector: string | undefined,
): Promise<LbHumanCheckboxState> {
  if (!selector || !(await session.exists(selector))) return "none";
  return (await session.exists(`${selector}:checked`)) ? "checked" : "empty";
}

const FINAL_ACTIONS = new Set<HelperDecision["action"]>([
  "submit",
  "stop_host",
  "park_operator",
  "pause_project",
  "form_error",
  "retry_after_spam_message",
]);

/**
 * Drives the in-page helper button with the core state machine: observe the label, perform the
 * single returned action, repeat. Submits only when the machine says so, and only inside the
 * placed-token TTL. Returns on submit or on any action the caller must handle.
 */
export async function runPageHelper(
  session: BrowserSession,
  options: PageHelperOptions,
): Promise<PageHelperRun> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const maxCycles = options.maxCycles ?? 400;
  let memory: Partial<HelperMemory> | undefined;
  let tries = 0;
  for (let cycle = 1; ; cycle += 1) {
    const buttonText = await session.text(options.buttonSelector);
    const humanCheckbox = await humanCheckboxState(session, options.humanCheckboxSelector);
    const imageGridOpen = options.imageGridSelector
      ? await session.exists(options.imageGridSelector)
      : false;
    const decision = decideHelperAction({
      buttonText,
      humanCheckbox,
      imageGridOpen,
      pageMessages: await options.pageMessages(session),
      nowMs: now(),
      tries,
      memory,
    });
    memory = decision.memory;
    tries = decision.tries;
    const run = { decision, buttonText, humanCheckbox, imageGridOpen, cycles: cycle };
    if (decision.action === "submit") {
      await session.click(options.submitSelector);
      return run;
    }
    if (FINAL_ACTIONS.has(decision.action)) return run;
    if (cycle >= maxCycles) {
      return {
        ...run,
        decision: {
          ...decision,
          action: "park_operator",
          reason: "unchanged_click_limit",
          outcome: "operator_parked",
          hostEvent: "parked",
        },
      };
    }
    if (decision.action === "click_place") await session.click(options.buttonSelector);
    else if (decision.action === "reload_once") await session.goto(await session.url());
    else await sleep(options.pollMs ?? 250);
  }
}
