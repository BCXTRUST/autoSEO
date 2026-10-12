import { xenforoBoard } from "../xenforo.js";
import { startMarkupFixture } from "./board-fixture.js";
import { type CustomForumJourney, startCustomForumFixture } from "./custom-forum-fixture.js";
import { type FixtureMail, startPhpbbFixture } from "./phpbb-fixture.js";

/**
 * Offline registration boards for the generic flow. Each one is a different captcha and
 * a different way the confirmation mail finishes. Stock phpBB and XenForo drivers cover
 * the boards whose markup they already understand.
 */

export type RegistrationCaptchaKind =
  | "phpbb_image"
  | "phpbb_qa"
  | "recaptcha_v2"
  | "hcaptcha"
  | "turnstile";

export type RegistrationActivationMode = "mail_logs_in" | "mail_login_form" | "admin";

export type RegistrationDriver = "phpbb" | "xenforo" | null;

export interface RegistrationFixtureSpec {
  id: string;
  captcha: RegistrationCaptchaKind;
  activation: RegistrationActivationMode;
  driver: RegistrationDriver;
}

export const registrationFixtureCatalog: readonly RegistrationFixtureSpec[] = [
  {
    id: "phpbb-prosilver",
    captcha: "phpbb_image",
    activation: "mail_logs_in",
    driver: "phpbb",
  },
  {
    id: "phpbb-custom-theme",
    captcha: "phpbb_qa",
    activation: "mail_login_form",
    driver: "phpbb",
  },
  {
    id: "xenforo-2",
    captcha: "recaptcha_v2",
    activation: "mail_logs_in",
    driver: "xenforo",
  },
  {
    id: "custom-php",
    captcha: "hcaptcha",
    activation: "mail_login_form",
    driver: null,
  },
  {
    id: "admin-activation",
    captcha: "turnstile",
    activation: "admin",
    driver: "phpbb",
  },
];

export interface RegistrationBoard {
  id: string;
  origin: string;
  captcha: RegistrationCaptchaKind;
  activation: RegistrationActivationMode;
  /** Image and Q&A answer. Empty when the captcha is a widget token. */
  captchaAnswer: string;
  approve(username: string): boolean;
  close(): Promise<void>;
}

const IMAGE_ANSWER = "K7XQ2";
const QUESTION_ANSWER = "berlin";

interface MailOptions {
  deliverMail(mail: FixtureMail): void | Promise<void>;
}

export async function startPhpbbProsilverFixture(options: MailOptions): Promise<RegistrationBoard> {
  const board = await startPhpbbFixture({
    boardName: "Prosilver Fixture",
    challenge: "image",
    captchaAnswer: IMAGE_ANSWER,
    activation: "email",
    activationLanding: "session",
    deliverMail: options.deliverMail,
  });
  return {
    id: "phpbb-prosilver",
    origin: board.origin,
    captcha: "phpbb_image",
    activation: "mail_logs_in",
    captchaAnswer: IMAGE_ANSWER,
    approve: (username) => board.approve(username),
    close: () => board.close(),
  };
}

export async function startPhpbbCustomThemeFixture(
  options: MailOptions,
): Promise<RegistrationBoard> {
  const board = await startPhpbbFixture({
    boardName: "Custom Theme Fixture",
    challenge: "question",
    question: "Wie heißt die Hauptstadt von Deutschland?",
    questionAnswer: QUESTION_ANSWER,
    extraRequired: true,
    activation: "email",
    activationLanding: "login",
    deliverMail: options.deliverMail,
  });
  return {
    id: "phpbb-custom-theme",
    origin: board.origin,
    captcha: "phpbb_qa",
    activation: "mail_login_form",
    captchaAnswer: QUESTION_ANSWER,
    approve: (username) => board.approve(username),
    close: () => board.close(),
  };
}

export async function startXenforo2Fixture(options: MailOptions): Promise<RegistrationBoard> {
  const board = await startMarkupFixture(xenforoBoard, {
    boardName: "XenForo 2 Fixture",
    activation: "email",
    activationLanding: "session",
    deliverMail: options.deliverMail,
  });
  return {
    id: "xenforo-2",
    origin: board.origin,
    captcha: "recaptcha_v2",
    activation: "mail_logs_in",
    captchaAnswer: "",
    approve: () => false,
    close: () => board.close(),
  };
}

export async function startCustomPhpBoardFixture(options: MailOptions): Promise<RegistrationBoard> {
  const journey: CustomForumJourney = {
    captcha: "hcaptcha",
    activation: "login",
    deliverMail: options.deliverMail,
  };
  const board = await startCustomForumFixture(journey);
  return {
    id: "custom-php",
    origin: board.origin,
    captcha: "hcaptcha",
    activation: "mail_login_form",
    captchaAnswer: "",
    approve: () => false,
    close: () => board.close(),
  };
}

export async function startAdminActivationFixture(
  options: MailOptions,
): Promise<RegistrationBoard> {
  const board = await startPhpbbFixture({
    boardName: "Admin Activation Fixture",
    challenge: "widget",
    widget: "turnstile",
    activation: "admin",
    deliverMail: options.deliverMail,
  });
  return {
    id: "admin-activation",
    origin: board.origin,
    captcha: "turnstile",
    activation: "admin",
    captchaAnswer: "",
    approve: (username) => board.approve(username),
    close: () => board.close(),
  };
}
