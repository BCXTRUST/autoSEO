import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/*
 * Link Builder shared vocabulary. Prisma stores these as String / Json columns; the SQL
 * migration mirrors every enum below as a CHECK constraint, so changing a list here needs a
 * migration too (packages/db/prisma/migrations/*_link_builder).
 */

export const LbProjectStatusSchema = z.enum(["draft", "active", "paused", "stopped", "archived"]);
export type LbProjectStatus = z.infer<typeof LbProjectStatusSchema>;

export const LbHostStatusSchema = z.enum([
  "discovered",
  "probed",
  "qualified",
  "registering",
  "pending_email",
  "pending_admin",
  "warming",
  "ready",
  "used",
  "denied",
  "spam_blocked",
  "unsupported_captcha",
  "parked_operator",
  "form_not_found",
  "off_topic",
  "dead",
]);
export type LbHostStatus = z.infer<typeof LbHostStatusSchema>;

/** Statuses a host can be parked from for an operator and resumed back into. */
export const LbParkableHostStatusSchema = LbHostStatusSchema.extract([
  "qualified",
  "registering",
  "pending_email",
  "pending_admin",
  "warming",
  "ready",
]);
export type LbParkableHostStatus = z.infer<typeof LbParkableHostStatusSchema>;

export const LbHostPlatformSchema = z.enum([
  "phpbb",
  "woltlab",
  "xenforo",
  "ips",
  "vbulletin",
  "mybb",
  "discourse",
  "flarum",
  "nodebb",
  "vanilla",
  "qa_other",
  "unknown",
]);
export type LbHostPlatform = z.infer<typeof LbHostPlatformSchema>;

export const LbHrefForNewMembersSchema = z.enum(["yes", "after_n_posts", "no", "unknown"]);
export type LbHrefForNewMembers = z.infer<typeof LbHrefForNewMembersSchema>;

export const LbRelDefaultSchema = z.enum(["follow", "nofollow", "ugc", "unknown"]);
export type LbRelDefault = z.infer<typeof LbRelDefaultSchema>;

export const LbRunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "overtime",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
export type LbRunStatus = z.infer<typeof LbRunStatusSchema>;

export const LbPlacementStatusSchema = z.enum([
  "pending",
  "live",
  "nofollow_live",
  "dead",
  "removed",
]);
export type LbPlacementStatus = z.infer<typeof LbPlacementStatusSchema>;

export const LbVerifyMethodSchema = z.enum(["logged_out_fetch", "logged_out_browser"]);
export type LbVerifyMethod = z.infer<typeof LbVerifyMethodSchema>;

export const LbThreadStatusSchema = z.enum(["candidate", "selected", "posted", "rejected"]);
export type LbThreadStatus = z.infer<typeof LbThreadStatusSchema>;

export const LbDraftStatusSchema = z.enum([
  "drafted",
  "approved",
  "posted",
  "pending_moderation",
  "discarded",
]);
export type LbDraftStatus = z.infer<typeof LbDraftStatusSchema>;

export const LbLinkSlotSchema = z.enum(["none", "inline", "signature"]);
export type LbLinkSlot = z.infer<typeof LbLinkSlotSchema>;

export const LbModelLaneSchema = z.enum(["draft", "classify", "fallback"]);
export type LbModelLane = z.infer<typeof LbModelLaneSchema>;

export const LbCaptchaTypeSchema = z.enum([
  "recaptcha_v2",
  "recaptcha_v3",
  "recaptcha_enterprise",
  "turnstile",
  "hcaptcha",
  "geetest",
  "funcaptcha",
  "image_letters",
  "knowledge_question",
  "security_check_label",
  "unsupported",
]);
export type LbCaptchaType = z.infer<typeof LbCaptchaTypeSchema>;

/** Widget captchas answered with a token for a site key. */
export const LbTokenCaptchaTypeSchema = LbCaptchaTypeSchema.extract([
  "recaptcha_v2",
  "recaptcha_v3",
  "recaptcha_enterprise",
  "turnstile",
  "hcaptcha",
  "geetest",
  "funcaptcha",
]);
export type LbTokenCaptchaType = z.infer<typeof LbTokenCaptchaTypeSchema>;

export const LbCaptchaDoorSchema = z.enum(["https_api", "page_helper", "userscript", "operator"]);
export type LbCaptchaDoor = z.infer<typeof LbCaptchaDoorSchema>;

export const LbHumanCheckboxStateSchema = z.enum(["checked", "empty", "none"]);
export type LbHumanCheckboxState = z.infer<typeof LbHumanCheckboxStateSchema>;

export const LbCaptchaOutcomeSchema = z.enum([
  "placed_submitted",
  "no_token",
  "missing_site_key",
  "unsupported",
  "credits",
  "operator_parked",
  "operator_solved",
  "expired",
  "sandbox",
]);
export type LbCaptchaOutcome = z.infer<typeof LbCaptchaOutcomeSchema>;

export const LbOperatorTicketReasonSchema = z.enum([
  "captcha_unsolved",
  "two_factor",
  "missing_password",
  "admin_approval",
  "unknown_page_state",
  "unmapped_form",
]);
export type LbOperatorTicketReason = z.infer<typeof LbOperatorTicketReasonSchema>;

export const LbOperatorTicketStatusSchema = z.enum(["open", "resolved", "expired", "skipped"]);
export type LbOperatorTicketStatus = z.infer<typeof LbOperatorTicketStatusSchema>;

export const LbDisclosureModeSchema = z.enum([
  "undisclosed_persona",
  "disclosed_persona",
  "disclosed_brand",
  "drafts_only",
]);
export type LbDisclosureMode = z.infer<typeof LbDisclosureModeSchema>;

/** How work spreads across `markets[]`; `primary_first` moves on only when primary supply is short. */
export const LbMarketPolicySchema = z.enum(["primary_first", "all_markets", "primary_only"]);
export type LbMarketPolicy = z.infer<typeof LbMarketPolicySchema>;

export const LbProxyPolicySchema = z.enum(["static_isp_per_persona", "none"]);
export type LbProxyPolicy = z.infer<typeof LbProxyPolicySchema>;

export const LbProxyKindSchema = z.enum(["static_isp", "residential", "datacenter"]);
export type LbProxyKind = z.infer<typeof LbProxyKindSchema>;

export const LbProxyLeaseStatusSchema = z.enum(["active", "released", "expired"]);
export type LbProxyLeaseStatus = z.infer<typeof LbProxyLeaseStatusSchema>;

function canonicalLocale(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/** ISO 3166-1 alpha-2, upper case. Any country; there is no regional allow-list. */
export const LbCountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, "Expected ISO 3166-1 alpha-2");
export type LbCountryCode = z.infer<typeof LbCountryCodeSchema>;

/** Canonical BCP 47 tag (`de`, `pt-BR`, `zh-Hant-TW`); non-canonical spellings are rejected. */
const CanonicalBcp47 = z
  .string()
  .min(2)
  .max(35)
  .refine((tag) => canonicalLocale(tag) === tag, "Expected a canonical BCP 47 tag");

export const LbLanguageSchema = CanonicalBcp47;
export type LbLanguage = z.infer<typeof LbLanguageSchema>;

export const LbLocaleSchema = CanonicalBcp47;
export type LbLocale = z.infer<typeof LbLocaleSchema>;

/** Primary language subtag of a BCP 47 tag (`pt-BR` → `pt`). */
export function lbPrimaryLanguage(tag: string): string {
  return (tag.split("-")[0] ?? tag).toLowerCase();
}

/** German forms of address; ignored for every other language. */
export const LbRegisterSchema = z.enum(["du", "sie"]);
export type LbRegister = z.infer<typeof LbRegisterSchema>;

/** Spam-filter rejections seen after a real submit; exactly one retry, then `spam_blocked`. */
export const LB_DEFAULT_SPAM_SENTENCES = [
  "Die Registrierung ist wegen Spamschutzmaßnahmen fehlgeschlagen.",
  "No soup for you!",
] as const;

export const LB_RESPONSIBILITY_ACK_TEXT_VERSION = "2026-10-05";

/** Shown under Start building. Acceptance is the click, not a checkbox. */
export const LB_RESPONSIBILITY_ACK_SENTENCE =
  "By starting, you confirm you're responsible for this content and its compliance in your markets.";

/** Captell seat token shape. The value is write-only and never returned by the API. */
export const LbCaptchaTokenSchema = z
  .string()
  .regex(/^ct_live_[A-Za-z0-9_-]{8,120}$/, "Expected a ct_live_ token");

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

function clockMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const LbRegistrableDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Expected a lowercase registrable domain");

function localeRegion(locale: string): string | undefined {
  return locale
    .split("-")
    .slice(1)
    .find((subtag) => /^([A-Z]{2}|\d{3})$/.test(subtag));
}

/**
 * One target market. Every session on a host from this market uses its country for the exit IP
 * and its locale and time zone for the browser, so the three always agree.
 */
export const LbMarketSchema = z
  .object({
    country: LbCountryCodeSchema,
    language: LbLanguageSchema,
    locale: LbLocaleSchema,
    timezoneId: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
  })
  .refine((market) => lbPrimaryLanguage(market.locale) === lbPrimaryLanguage(market.language), {
    message: "Locale language must match the market language",
    path: ["locale"],
  })
  .refine(
    (market) => {
      const region = localeRegion(market.locale);
      return region === undefined || region === market.country;
    },
    { message: "Locale region must match the market country", path: ["locale"] },
  );
export type LbMarket = z.infer<typeof LbMarketSchema>;

export const LB_DEFAULT_MARKET: LbMarket = {
  country: "DE",
  language: "de",
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
};

/** Ordered, first entry is the primary market; one entry per country and language. */
export const LbMarketsSchema = z
  .array(LbMarketSchema)
  .min(1)
  .max(20)
  .refine(
    (markets) =>
      new Set(markets.map((market) => `${market.country}:${market.language}`)).size ===
      markets.length,
    { message: "Each country and language pair may appear once" },
  );

export const LbPersonaSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().max(500).default(""),
  /** Defaults to the primary market's language when absent. */
  language: LbLanguageSchema.optional(),
  register: LbRegisterSchema.default("du"),
  /** Only used by the disclosed modes; empty in the default undisclosed mode. */
  disclosureText: z.string().max(200).optional(),
});
export type LbPersona = z.infer<typeof LbPersonaSchema>;

export const LbQuotasSchema = z
  .object({
    newPerDay: z.number().int().min(0).max(50),
    livePerDay: z.number().int().min(0).max(50),
    liveWeekCap: z.number().int().min(0).max(250).optional(),
    /** Fixed at one counted LIVE link per host in v1; the partial unique index enforces it. */
    maxLivePerHost: z.literal(1).default(1),
  })
  .refine((quotas) => quotas.liveWeekCap === undefined || quotas.liveWeekCap >= quotas.livePerDay, {
    message: "liveWeekCap must be at least livePerDay",
    path: ["liveWeekCap"],
  });
export type LbQuotas = z.infer<typeof LbQuotasSchema>;

export const LbScheduleSchema = z
  .object({
    timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
    weekdaysOnly: z.boolean().default(true),
    window: z
      .object({ start: ClockTime, end: ClockTime })
      .default({ start: "09:00", end: "22:00" })
      .refine((window) => clockMinutes(window.start) < clockMinutes(window.end), {
        message: "Window must start before it ends on the same day",
      }),
    overtimeUntilLiveMet: z.boolean().default(false),
    /** Local hour (exclusive) at which overtime stops; 24 means midnight. */
    hardStopHour: z.number().int().min(1).max(24).default(24),
    /** ISO time. While it is still ahead, Start and "continue" keep the run open. */
    resumeUntil: z.string().datetime({ offset: true }).optional(),
  })
  .refine((schedule) => schedule.hardStopHour * 60 >= clockMinutes(schedule.window.end), {
    message: "hardStopHour must not be before the window end",
    path: ["hardStopHour"],
  });
export type LbSchedule = z.infer<typeof LbScheduleSchema>;

export const LbTopicLaneSchema = z.object({
  id: Id,
  tag: z.string().trim().min(1).max(40),
  description: z.string().max(500),
  exampleQuestions: z.array(z.string().max(300)).max(20).default([]),
});
export type LbTopicLane = z.infer<typeof LbTopicLaneSchema>;

export const LbTargetSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  priority: z.number().int().min(1).max(100).default(50),
  description: z.string().max(300).default(""),
  keywordClusters: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
});
export type LbTarget = z.infer<typeof LbTargetSchema>;

export const LbLinkRatioSchema = z
  .object({ links: z.number().int().min(0), posts: z.number().int().min(1) })
  .refine((ratio) => ratio.links <= ratio.posts, { message: "links must not exceed posts" });
export type LbLinkRatio = z.infer<typeof LbLinkRatioSchema>;
export const LB_DEFAULT_LINK_RATIO: LbLinkRatio = { links: 1, posts: 3 };

export const LbWarmupSchema = z.object({
  minPostsBeforeLink: z.number().int().min(0).max(20).default(3),
  minAccountAgeHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(24),
  /** Newest foreign post may be this many days old. Omitted means 30. */
  activityDays: z.number().int().min(1).max(90).optional(),
});
export type LbWarmup = z.infer<typeof LbWarmupSchema>;

export const LbSpamRetrySchema = z.object({
  maxRetries: z.literal(1).default(1),
  sentences: z.array(z.string().trim().min(1).max(300)).default([...LB_DEFAULT_SPAM_SENTENCES]),
});
export type LbSpamRetry = z.infer<typeof LbSpamRetrySchema>;

/** What happens to a draft the fit check says is not facts-only. */
export const LbContentModeSchema = z.enum(["discard", "queue"]);
export type LbContentMode = z.infer<typeof LbContentModeSchema>;

export const LbModelLaneOverrideSchema = z.object({
  draft: z.string().trim().min(1).max(120).optional(),
  classify: z.string().trim().min(1).max(120).optional(),
  fallback: z.string().trim().min(1).max(120).optional(),
});
export type LbModelLaneOverride = z.infer<typeof LbModelLaneOverrideSchema>;

export const LbContentSchema = z.object({
  toneNotes: z.string().max(1000).default(""),
  bannedClaims: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  maxReplyChars: z.number().int().min(200).max(10_000).default(1200),
  /** `queue` sends a failed facts-only check to the drafts queue; `discard` drops it. */
  mode: LbContentModeSchema.default("discard"),
  /**
   * Newest post in the thread must be this recent. One month: a reply under a post
   * from last year does not get an answer.
   */
  threadActivityDays: z.number().int().min(1).max(3650).default(30),
  excludedLaneIds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** Per-project OpenRouter model ids. Deployment defaults apply when a lane is omitted. */
  modelLanes: LbModelLaneOverrideSchema.default({}),
});
export type LbContent = z.infer<typeof LbContentSchema>;

export const LbNotificationChannelSchema = z.enum(["push", "email"]);
export type LbNotificationChannel = z.infer<typeof LbNotificationChannelSchema>;

export const LbOperatorOnExpireSchema = z.enum(["skip", "requalify"]);
export type LbOperatorOnExpire = z.infer<typeof LbOperatorOnExpireSchema>;

export const LbOperatorSettingsSchema = z.object({
  parkedHostTtlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(48),
  /** Open operator tickets close after this many hours. */
  ticketTtlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(24),
  /** `skip` marks the host dead. `requalify` returns it to the qualified supply. */
  onExpire: LbOperatorOnExpireSchema.default("skip"),
  channels: z.array(LbNotificationChannelSchema).default(["push", "email"]),
});
export type LbOperatorSettings = z.infer<typeof LbOperatorSettingsSchema>;

/** Recorded when the customer clicks Start building; never shown in posts or profiles. */
export const LbResponsibilityAckSchema = z.object({
  acceptedAt: IsoDate,
  acceptedByUserId: Id,
  textVersion: z.string().min(1),
});
export type LbResponsibilityAck = z.infer<typeof LbResponsibilityAckSchema>;

/** Every config field a project carries, validated before it is persisted or started. */
export const LbProjectConfigSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  brandName: z.string().trim().min(1).max(80),
  allowedDomains: z.array(LbRegistrableDomainSchema).min(1).max(20),
  persona: LbPersonaSchema,
  mailboxId: Id.optional(),
  captchaSecretId: Id.optional(),
  captchaLowBalanceCredits: z.number().int().min(0).default(500),
  quotas: LbQuotasSchema,
  schedule: LbScheduleSchema,
  topicLanes: z.array(LbTopicLaneSchema).max(40).default([]),
  markets: LbMarketsSchema.default(() => [{ ...LB_DEFAULT_MARKET }]),
  marketPolicy: LbMarketPolicySchema.default("primary_first"),
  disclosureMode: LbDisclosureModeSchema.default("undisclosed_persona"),
  linkRatio: LbLinkRatioSchema.default(LB_DEFAULT_LINK_RATIO),
  proxyPolicy: LbProxyPolicySchema.default("static_isp_per_persona"),
  countNofollow: z.boolean().default(true),
  targets: z.array(LbTargetSchema).max(100).default([]),
  facts: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  denyHosts: z.array(LbRegistrableDomainSchema).max(500).default([]),
  preferHosts: z.array(LbRegistrableDomainSchema).max(500).default([]),
  warmup: LbWarmupSchema.default({ minPostsBeforeLink: 3, minAccountAgeHours: 24 }),
  spamRetry: LbSpamRetrySchema.default({
    maxRetries: 1,
    sentences: [...LB_DEFAULT_SPAM_SENTENCES],
  }),
  content: LbContentSchema.default(() => ({
    toneNotes: "",
    bannedClaims: [],
    maxReplyChars: 1200,
    mode: "discard" as const,
    threadActivityDays: 30,
    excludedLaneIds: [],
    modelLanes: {},
  })),
  operator: LbOperatorSettingsSchema.default({
    parkedHostTtlHours: 48,
    ticketTtlHours: 24,
    onExpire: "skip",
    channels: ["push", "email"],
  }),
});
export type LbProjectConfig = z.infer<typeof LbProjectConfigSchema>;
export type LbProjectConfigInput = z.input<typeof LbProjectConfigSchema>;

/** Fields the wizard must have before Start building is allowed. Captell stays on the deployment. */
export const LbProjectStartableSchema = LbProjectConfigSchema.extend({
  mailboxId: Id,
  topicLanes: z.array(LbTopicLaneSchema).min(1).max(40),
});

export const LbDraftQualityChecksSchema = z.object({
  factsOnly: z.boolean(),
  noBannedClaims: z.boolean(),
  registerMatches: z.boolean(),
  lengthOk: z.boolean(),
  singleLink: z.boolean(),
  notTestimonial: z.boolean(),
  issues: z.array(z.string()).default([]),
});
export type LbDraftQualityChecks = z.infer<typeof LbDraftQualityChecksSchema>;

/** Structured model jobs from plan section 9. The drafter never decides whether to promote. */
export const LbThreadRelevanceSchema = z.object({
  relevance: z.number().min(0).max(1),
  openQuestion: z.boolean(),
  reasons: z.array(z.string().max(300)).max(12).default([]),
});
export type LbThreadRelevance = z.infer<typeof LbThreadRelevanceSchema>;

const DRAFT_BODY_KEYS = [
  "body",
  "text",
  "reply",
  "message",
  "answer",
  "response",
  "content",
] as const;

export const LbDraftReplySchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    const record = { ...(value as Record<string, unknown>) };
    const named = DRAFT_BODY_KEYS.map((key) => record[key]).find(
      (item) => typeof item === "string",
    );
    if (typeof record.body !== "string" && typeof named === "string") record.body = named;
    if (record.linkSlot === undefined) record.linkSlot = "none";
    if (record.targetUrlIndex === undefined) record.targetUrlIndex = null;
    if (record.anchorText === undefined) record.anchorText = null;
    if (typeof record.confidence !== "number") record.confidence = 0.6;
    return record;
  },
  z.object({
    body: z.string().max(10_000),
    linkSlot: LbLinkSlotSchema,
    targetUrlIndex: z.number().int().min(0).nullable(),
    anchorText: z.string().max(80).nullable(),
    confidence: z.number().min(0).max(1),
  }),
);
export type LbDraftReply = z.infer<typeof LbDraftReplySchema>;

export const LbFitCheckSchema = z.object({
  fitsThread: z.boolean(),
  soundsLikeAd: z.boolean(),
  factsOnly: z.boolean(),
  issues: z.array(z.string().max(300)).max(20),
});
export type LbFitCheck = z.infer<typeof LbFitCheckSchema>;

export const LbAlertKindSchema = z.enum([
  "project.paused",
  "captcha.needs_operator",
  "placement.live",
  "run.finished",
]);
export type LbAlertKind = z.infer<typeof LbAlertKindSchema>;

export const LbCostKindSchema = z.enum([
  "captell_credits",
  "model_tokens",
  "search_query",
  "proxy_lease_day",
]);
export type LbCostKind = z.infer<typeof LbCostKindSchema>;

export const LbCostSummarySchema = z.object({
  captellCredits: z.number().int().min(0),
  modelTokens: z.number().int().min(0),
  searchQueries: z.number().int().min(0),
  proxyLeaseDays: z.number().int().min(0),
});
export type LbCostSummary = z.infer<typeof LbCostSummarySchema>;

export const EMPTY_COST_SUMMARY: LbCostSummary = {
  captellCredits: 0,
  modelTokens: 0,
  searchQueries: 0,
  proxyLeaseDays: 0,
};

export const LbRunStepCostsSchema = z.object({
  credits: z.number().int().min(0).default(0),
  tokens: z.number().int().min(0).default(0),
  bytes: z.number().int().min(0).default(0),
  ms: z.number().int().min(0).default(0),
});
export type LbRunStepCosts = z.infer<typeof LbRunStepCostsSchema>;

export const LbWhyNotReasonSchema = z.enum([
  "host_supply_exhausted",
  "warmup_pending",
  "pending_email",
  "pending_admin",
  "operator_parked",
  "spam_filtered",
  "unsupported_captcha",
  "captcha_balance_low",
  "model_errors",
  "proxy_degraded",
  "new_quota_reached",
  "week_cap_reached",
]);
export type LbWhyNotReason = z.infer<typeof LbWhyNotReasonSchema>;

/** End-of-window explanation shown whenever the LIVE quota was not met. */
export const LbWhyNotSchema = z.object({
  supply: z.object({ qualified: z.number().int().min(0), ready: z.number().int().min(0) }),
  parked: z.number().int().min(0),
  spamBlocked: z.number().int().min(0),
  unsupportedCaptcha: z.number().int().min(0),
  pendingEmail: z.number().int().min(0),
  pendingAdmin: z.number().int().min(0),
  modelErrors: z.number().int().min(0),
  modelRefusals: z.number().int().min(0),
  captchaBalance: z.number().int().nullable(),
  proxy: z.enum(["ok", "degraded"]),
  reasons: z.array(LbWhyNotReasonSchema),
});
export type LbWhyNot = z.infer<typeof LbWhyNotSchema>;
