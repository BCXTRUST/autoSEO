import type { BrowserSession } from "@rakazo/adapter-kit";
import type { LbHostPlatform } from "@rakazo/contracts";
import type { ReferenceFormat } from "@rakazo/linkbuilder-core";
import { answerBoardQuestion, detectKnowledgeQuestion } from "./captcha.js";
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
import { holdSignupForm, releaseSignupForm } from "./driver.js";
import {
  classifyRegistration,
  postedSuccessfully,
  registrationClosed,
  relFromAttribute,
} from "./messages.js";
import { detectWidget } from "./widgets.js";

const LOGIN_FORM = "form#login, form#loginForm";
const LOGIN_SUBMIT =
  "form#login #submit, form#loginForm #submit, form#login input[type='submit'], form#loginForm input[type='submit']";
const LOGGED_OUT_LINK = "a.logout, a[href*='logout'], a[href*='Logout'], a[href*='logoff']";

/**
 * Selectors-and-URL driver shared by the forum platforms. Every page action goes through
 * `BrowserSession`, so the pacing policy on the Playwright session applies unchanged.
 */

export interface FieldRef {
  id: string;
  name: string;
}

export type CaptchaDoorKind = "image" | "recaptcha" | "hcaptcha" | "turnstile" | "ips" | "none";

export interface MarkupRoutes {
  index: string;
  register: string;
  login: string;
  activate: string;
  list: string;
  profile: string;
  captcha: string;
  json?: string;
  /** Thread view, including the public permalink when it shares this path. */
  thread: RegExp;
  reply: RegExp;
  permalink: RegExp;
}

export interface MarkupBoardConfig {
  platform: LbHostPlatform;
  bodyFormat: ReferenceFormat;
  allowEmoji: boolean;
  nofollowDefault: boolean;
  minPostsBeforeLink?: number;
  footprint: RegExp;
  /** Markup placed in the fixture layout. `detect` matches `footprint` against it. */
  footprintSample: string;
  paths: { register: string; login: string; profile: string; list: string };
  fields: {
    username: FieldRef;
    email: FieldRef;
    password: FieldRef;
    confirm: FieldRef;
    consent: FieldRef;
    captcha: FieldRef;
    body: FieldRef;
    bio: FieldRef;
    signature: FieldRef;
  };
  challenge: CaptchaDoorKind;
  tokenField: string;
  routes: MarkupRoutes;
  threadHref: string;
  replyHref: string;
  permalinkHref: (postId: number, postNumber: number) => string;
  permalink: (url: string) => string | null;
  /** DOM id of a post, matching the permalink fragment. Defaults to `post<id>`. */
  postElementId?: (postId: number) => string;
  /** Wrapper class on the fixture form, so the template can show the platform's markup. */
  formClass: string;
}

export interface BoardInput {
  platform: LbHostPlatform;
  bodyFormat: ReferenceFormat;
  allowEmoji: boolean;
  nofollowDefault: boolean;
  minPostsBeforeLink?: number;
  footprint: RegExp;
  footprintSample: string;
  paths: MarkupBoardConfig["paths"];
  fields: MarkupBoardConfig["fields"];
  challenge: CaptchaDoorKind;
  routes: MarkupRoutes;
  threadHref: string;
  replyHref: string;
  permalinkHref: (postId: number, postNumber: number) => string;
  permalink: (url: string) => string | null;
  /** DOM id of a post, matching the permalink fragment. Defaults to `post<id>`. */
  postElementId?: (postId: number) => string;
  formClass: string;
}

const TOKEN_FIELD: Record<CaptchaDoorKind, string> = {
  image: "",
  recaptcha: "g-recaptcha-response",
  hcaptcha: "h-captcha-response",
  turnstile: "cf-turnstile-response",
  ips: "cf-turnstile-response",
  none: "",
};

export function defineBoard(input: BoardInput): MarkupBoardConfig {
  return { ...input, tokenField: TOKEN_FIELD[input.challenge] };
}

export function field(id: string, name = id): FieldRef {
  return { id, name };
}

export function commonFields(
  overrides: Partial<MarkupBoardConfig["fields"]> = {},
): MarkupBoardConfig["fields"] {
  return {
    username: field("username"),
    email: field("email"),
    password: field("password"),
    confirm: field("password_confirm"),
    consent: field("accept_terms"),
    captcha: field("captcha_answer"),
    body: field("message"),
    bio: field("bio"),
    signature: field("signature"),
    ...overrides,
  };
}

function href(path: string, base: string): string {
  return new URL(path, base).href;
}

function linkRule(text: string): Omit<LinkRuleProbe, "relDefault"> {
  const flat = text.replace(/\s+/g, " ");
  const afterPosts =
    /(?:links?|urls?)[^.]{0,80}?(?:until|before|after)[^.]{0,40}?(\d{1,4})\s*(?:posts?|beiträge)/i.exec(
      flat,
    ) ??
    /links?[^.]{0,60}?(?:ab|nach)\s*(\d{1,4})\s*beiträgen?/i.exec(flat) ??
    /(?:ab|nach)\s*(\d{1,4})\s*beiträgen?[^.]{0,60}?links?/i.exec(flat) ??
    /(\d{1,4})\s*(?:posts?|beiträge)[^.]{0,60}?(?:before|bevor)[^.]{0,40}?links?/i.exec(flat);
  if (afterPosts) return { hrefForNewMembers: "after_n_posts", minPosts: Number(afterPosts[1]) };
  if (
    /(?:new|neue) (?:members|users|mitglieder|benutzer)[^.]{0,80}?(?:cannot|may not|can't|dürfen keine|können keine)[^.]{0,40}?links?/i.test(
      flat,
    ) ||
    /trust level 0|tl0 cannot post links/i.test(flat)
  ) {
    return { hrefForNewMembers: "no", minPosts: null };
  }
  if (/new members may post links|links are allowed|links erlaubt/i.test(flat)) {
    return { hrefForNewMembers: "yes", minPosts: null };
  }
  return { hrefForNewMembers: "unknown", minPosts: null };
}

export class MarkupBoardDriver implements BoardDriver {
  readonly platform: LbHostPlatform;
  readonly bodyFormat: ReferenceFormat;
  readonly allowEmoji: boolean;
  readonly nofollowDefault: boolean;
  readonly minPostsBeforeLink?: number;
  readonly registerSubmitSelector = "form#register #submit";

  constructor(readonly config: MarkupBoardConfig) {
    this.platform = config.platform;
    this.bodyFormat = config.bodyFormat;
    this.allowEmoji = config.allowEmoji;
    this.nofollowDefault = config.nofollowDefault;
    this.minPostsBeforeLink = config.minPostsBeforeLink;
  }

  detect(html: string, url = ""): boolean {
    return this.config.footprint.test(`${html}\n${url}`);
  }

  registerUrl(homepageUrl: string): string {
    return href(this.config.paths.register, homepageUrl);
  }

  async openRegistration(session: BrowserSession, homepageUrl: string): Promise<RegistrationPage> {
    await releaseSignupForm(session);
    await session.goto(this.registerUrl(homepageUrl));
    const username = `#${this.config.fields.username.id}`;
    if (await session.waitFor(username, { timeoutMs: 10_000 })) return "form";
    return registrationClosed(await session.pageText()) ? "closed" : "unknown";
  }

  async fillRegistration(session: BrowserSession, account: BoardAccount): Promise<void> {
    await holdSignupForm(session);
    const fields = this.config.fields;
    await session.fill(`#${fields.username.id}`, account.username);
    await session.fill(`#${fields.email.id}`, account.email);
    await session.fill(`#${fields.password.id}`, account.password, { secret: true });
    if (await session.exists(`#${fields.confirm.id}`)) {
      await session.fill(`#${fields.confirm.id}`, account.password, { secret: true });
    }
    const consent = `#${fields.consent.id}`;
    if ((await session.exists(consent)) && (await session.attribute(consent, "checked")) === null) {
      await session.click(consent);
    }
  }

  async detectCaptcha(session: BrowserSession): Promise<CaptchaChallenge> {
    const image = "img.captcha-image";
    if (this.config.challenge === "image" && (await session.exists(image))) {
      return {
        kind: "image",
        imageSelector: image,
        answerSelector: `#${this.config.fields.captcha.id}`,
      };
    }
    const question = await detectKnowledgeQuestion(session);
    if (question) return question;
    return detectWidget(session);
  }

  async submitRegistration(session: BrowserSession): Promise<RegistrationResult> {
    await session.click(this.registerSubmitSelector);
    await releaseSignupForm(session);
    return this.readRegistrationResult(session, { waitMs: 15_000 });
  }

  async readRegistrationResult(
    session: BrowserSession,
    options: { waitMs?: number } = {},
  ): Promise<RegistrationResult> {
    if (options.waitMs) {
      await session.waitFor("#message, .error", { timeoutMs: options.waitMs });
    }
    const messages = await this.pageMessages(session);
    const formStillOpen = await session.exists("form#register");
    return classifyRegistration(messages.join("\n"), formStillOpen);
  }

  async activationResult(session: BrowserSession): Promise<ActivationResult> {
    const text = (await this.pageMessages(session)).join("\n");
    const result = classifyRegistration(text, false);
    if (result.kind === "pending_admin") return "pending_admin";
    if (result.kind === "active") return "active";
    return "unknown";
  }

  async isLoggedIn(session: BrowserSession): Promise<boolean> {
    return session.exists(LOGGED_OUT_LINK);
  }

  async login(
    session: BrowserSession,
    homepageUrl: string,
    account: Pick<BoardAccount, "username" | "password">,
  ): Promise<boolean> {
    try {
      await session.goto(href(this.config.paths.login, homepageUrl));
    } catch {
      await session.goto(homepageUrl);
    }
    if (await this.isLoggedIn(session)) return true;
    if (!(await session.waitFor(LOGIN_FORM, { timeoutMs: 10_000 }))) return false;
    await this.submitLogin(session, account);
    if (await session.waitFor(LOGGED_OUT_LINK, { timeoutMs: 10_000 })) return true;
    // The question is missing on the first paint and the board asks for it after submit.
    if (await session.exists("#captchaAnswer")) {
      await this.submitLogin(session, account);
      if (await session.waitFor(LOGGED_OUT_LINK, { timeoutMs: 10_000 })) return true;
    }
    const detail = await this.loginFailure(session);
    if (detail) throw new Error(detail.slice(0, 240));
    return false;
  }

  private async submitLogin(
    session: BrowserSession,
    account: Pick<BoardAccount, "username" | "password">,
  ): Promise<void> {
    const fields = this.config.fields;
    await session.fill(`#${fields.username.id}`, account.username);
    await session.fill(`#${fields.password.id}`, account.password, { secret: true });
    // WoltLab copies the XSRF cookie into the hidden field after the page scripts run.
    await session.waitFor(".xsrfTokenInputHandled", { timeoutMs: 5_000 });
    await this.fillLoginQuestion(session);
    await session.click(LOGIN_SUBMIT);
  }

  private async fillLoginQuestion(session: BrowserSession): Promise<void> {
    if (!(await session.exists("#captchaAnswer"))) return;
    const label = ((await session.text("label[for='captchaAnswer']")) ?? "").trim();
    const answer = answerBoardQuestion(label);
    if (!answer) throw new Error((label || "Login question was not answered").slice(0, 180));
    await session.fill("#captchaAnswer", answer);
  }

  private async loginFailure(session: BrowserSession): Promise<string> {
    const messages = [
      (await session.text(".formError")) ?? "",
      (await session.text(".innerError")) ?? "",
      ...(await this.pageMessages(session)),
    ]
      .map((message) => message.trim())
      .filter(Boolean);
    const specific = messages.find((message) =>
      /kennwort ist falsch|bitte fülle dieses eingabefeld/i.test(message),
    );
    return specific ?? messages[0] ?? "";
  }

  async listThreads(session: BrowserSession, homepageUrl: string): Promise<BoardThread[]> {
    await session.goto(href(this.config.paths.list, homepageUrl));
    const threads: BoardThread[] = [];
    for (let index = 1; index <= 25; index += 1) {
      const link = `li.thread:nth-of-type(${index}) a.threadTitle`;
      const topicHref = await session.attribute(link, "href");
      if (topicHref === null) break;
      const title = ((await session.text(link)) ?? "").trim();
      const activity = await session.attribute(
        `li.thread:nth-of-type(${index}) time.lastActivity`,
        "datetime",
      );
      const replies = await session.text(`li.thread:nth-of-type(${index}) span.replies`);
      threads.push({
        url: href(topicHref, await session.url()),
        title,
        replyCount: replies ? Number.parseInt(replies, 10) || 0 : undefined,
        lastActivityAt: activity,
        openQuestion: /\?/.test(title),
      });
    }
    return threads;
  }

  async openReply(session: BrowserSession, thread: BoardThread): Promise<boolean> {
    await session.goto(thread.url);
    const reply = await session.attribute("a.reply", "href");
    if (reply) await session.goto(href(reply, await session.url()));
    return session.waitFor(`#${this.config.fields.body.id}`, { timeoutMs: 10_000 });
  }

  async fillReply(session: BrowserSession, body: string): Promise<void> {
    await session.fill(`#${this.config.fields.body.id}`, body);
  }

  async submitReply(session: BrowserSession): Promise<ReplyResult> {
    await session.click("form#reply #submit");
    await session.waitFor("#message, .error", { timeoutMs: 15_000 });
    const messages = await this.pageMessages(session);
    const direct = this.config.permalink(await session.url());
    if (direct && postedSuccessfully(messages.join("\n")))
      return { kind: "posted", permalink: direct };
    const posted = await session.attribute("#message a.permalink", "href");
    const permalink = posted ? this.config.permalink(href(posted, await session.url())) : null;
    if (permalink && postedSuccessfully(messages.join("\n"))) return { kind: "posted", permalink };
    if (await session.exists(`#${this.config.fields.body.id}`))
      return { kind: "rejected", messages };
    return { kind: "unknown", messages };
  }

  probeLinkRule(pageText: string): LinkRuleProbe {
    return { ...linkRule(pageText), relDefault: "unknown" };
  }

  async probePageLinkRule(session: BrowserSession): Promise<LinkRuleProbe> {
    const base = this.probeLinkRule(await session.pageText());
    const rel = relFromAttribute(await session.attribute("a.memberLink", "rel"));
    if (rel) return { ...base, relDefault: rel };
    if (this.nofollowDefault) return { ...base, relDefault: "nofollow" };
    return base;
  }

  async setProfile(
    session: BrowserSession,
    homepageUrl: string,
    profile: ProfileInput,
  ): Promise<boolean> {
    await session.goto(href(this.config.paths.profile, homepageUrl));
    const bio = `#${this.config.fields.bio.id}`;
    if (!(await session.exists(bio))) return false;
    await session.fill(bio, profile.bio);
    const signature = `#${this.config.fields.signature.id}`;
    if (await session.exists(signature)) {
      await session.fill(signature, profile.includeSignature ? (profile.signature ?? "") : "");
    }
    if (await session.exists("form#profile #submit")) await session.click("form#profile #submit");
    return true;
  }

  async pageMessages(session: BrowserSession): Promise<string[]> {
    const error = await session.text(".error");
    const panel = await session.text("#message");
    return [error, panel].map((text) => text?.trim() ?? "").filter(Boolean);
  }
}
