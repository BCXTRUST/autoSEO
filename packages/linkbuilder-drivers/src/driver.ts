import type { BrowserSession, TokenCaptchaType } from "@rakazo/adapter-kit";
import type { LbHostPlatform, LbHrefForNewMembers, LbRelDefault } from "@rakazo/contracts";
import type { ReferenceFormat } from "@rakazo/linkbuilder-core";

/*
 * One driver per forum platform. Drivers only know page structure: selectors, URLs and the
 * board's own messages. Credentials, captcha solving, persistence and pacing live elsewhere, so
 * adding a platform is a selectors-and-messages change.
 */

export interface BoardAccount {
  username: string;
  password: string;
  email: string;
}

export interface BoardThread {
  url: string;
  title: string;
  replyCount?: number;
  /** ISO time of the last reply, when the board shows one. */
  lastActivityAt?: string | null;
  /** True when the title reads as an open question. */
  openQuestion?: boolean;
}

export type RegistrationPage = "form" | "closed" | "unknown" | "unmapped";

/** The generic driver refused to guess a form. The runner parks the host with this reason. */
export class UnmappedFormError extends Error {
  readonly reason = "unmapped_form" as const;

  constructor(form: string) {
    super(`unmapped_form:${form}`);
    this.name = "UnmappedFormError";
  }
}

export type RegistrationResult =
  | { kind: "pending_email" }
  | { kind: "pending_admin" }
  | { kind: "active" }
  | { kind: "captcha_rejected" }
  | { kind: "form_error"; messages: string[] }
  | { kind: "unknown"; messages: string[] };

export type ActivationResult = "active" | "pending_admin" | "unknown";

export type CaptchaChallenge =
  | { kind: "none" }
  | { kind: "image"; imageSelector: string; answerSelector: string }
  | { kind: "widget"; type: TokenCaptchaType; siteKey: string | null }
  | { kind: "question"; question: string; answerSelector: string };

export type ReplyResult =
  | { kind: "posted"; permalink: string }
  | { kind: "rejected"; messages: string[] }
  | { kind: "unknown"; messages: string[] };

export interface LinkRuleProbe {
  hrefForNewMembers: LbHrefForNewMembers;
  minPosts: number | null;
  /** `rel` sampled from a new member's link, or unknown when the page has no sample. */
  relDefault: LbRelDefault;
}

/** Profile text written after activation. The driver does not add an affiliation. */
export interface ProfileInput {
  bio: string;
  signature: string | null;
  /** Signature is written only when the caller already applied policy, warm-up and signatureLinks. */
  includeSignature: boolean;
}

export interface BoardDriver {
  readonly platform: LbHostPlatform;
  /** Markup the reply editor accepts, used when inserting the reference link. */
  readonly bodyFormat: ReferenceFormat;
  /** When false or omitted, a reply that contains emoji is rejected. */
  readonly allowEmoji?: boolean;
  /** Used when a page has no sample link to read `rel` from. */
  readonly nofollowDefault?: boolean;
  /**
   * Floor for link-free posts. Discourse forces this because TL0 cannot post links.
   * The runner uses the greater of this value and the project warm-up.
   */
  readonly minPostsBeforeLink?: number;
  /** True when `html` or `url` carries this platform's Appendix A footprint. */
  detect(html: string, url?: string): boolean;
  registerUrl(homepageUrl: string): string;
  /** Opens the registration form, accepting the board terms on the way. */
  openRegistration(session: BrowserSession, homepageUrl: string): Promise<RegistrationPage>;
  /** Fills the form without submitting it; password fields are filled as secrets. */
  fillRegistration(session: BrowserSession, account: BoardAccount): Promise<void>;
  detectCaptcha(session: BrowserSession): Promise<CaptchaChallenge>;
  /** The register form's submit control, clicked by the Page Helper loop after a token lands. */
  readonly registerSubmitSelector: string;
  submitRegistration(session: BrowserSession): Promise<RegistrationResult>;
  /**
   * Classifies the page after a registration submit without submitting anything, so a resumed
   * step can pick up where an operator left off.
   */
  readRegistrationResult(
    session: BrowserSession,
    options?: { waitMs?: number },
  ): Promise<RegistrationResult>;
  /** Reads the page reached through the activation link. */
  activationResult(session: BrowserSession): Promise<ActivationResult>;
  isLoggedIn(session: BrowserSession): Promise<boolean>;
  login(
    session: BrowserSession,
    homepageUrl: string,
    account: Pick<BoardAccount, "username" | "password">,
  ): Promise<boolean>;
  listThreads(session: BrowserSession, homepageUrl: string): Promise<BoardThread[]>;
  /**
   * Board search for the human problem. Omitted drivers fall back to the index.
   * Results use a stable topic URL so a later search with a new session id is the same thread.
   */
  searchThreads?(
    session: BrowserSession,
    homepageUrl: string,
    query: string,
  ): Promise<BoardThread[]>;
  /** Opens the reply editor for a thread; false when the thread is locked or replies are off. */
  openReply(session: BrowserSession, thread: BoardThread): Promise<boolean>;
  fillReply(session: BrowserSession, body: string): Promise<void>;
  submitReply(session: BrowserSession): Promise<ReplyResult>;
  /** Reads the board's rule for links by new members from rules, FAQ or editor text. */
  probeLinkRule(pageText: string): LinkRuleProbe;
  /** Same probe, plus `rel` from a new-member link on the current page when one is present. */
  probePageLinkRule?(session: BrowserSession): Promise<LinkRuleProbe>;
  /**
   * Sets the persona bio. Writes a signature only when `includeSignature` is set.
   * Returns false when the board has no profile form.
   */
  setProfile(session: BrowserSession, homepageUrl: string, profile: ProfileInput): Promise<boolean>;
  /** Board error and notice texts on the current page, for the captcha and form-error logic. */
  pageMessages(session: BrowserSession): Promise<string[]>;
}
