import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import {
  LbCaptchaDoorSchema,
  LbCaptchaOutcomeSchema,
  LbCaptchaTokenSchema,
  LbCaptchaTypeSchema,
  LbContentSchema,
  LbCostSummarySchema,
  LbDisclosureModeSchema,
  LbDraftQualityChecksSchema,
  LbDraftStatusSchema,
  LbHostPlatformSchema,
  LbHostStatusSchema,
  LbHrefForNewMembersSchema,
  LbLinkRatioSchema,
  LbLinkSlotSchema,
  LbMarketPolicySchema,
  LbMarketsSchema,
  LbModelLaneSchema,
  LbOperatorSettingsSchema,
  LbOperatorTicketReasonSchema,
  LbOperatorTicketStatusSchema,
  LbParkableHostStatusSchema,
  LbPersonaSchema,
  LbPlacementStatusSchema,
  LbProjectStatusSchema,
  LbProxyKindSchema,
  LbProxyLeaseStatusSchema,
  LbProxyPolicySchema,
  LbQuotasSchema,
  LbRegistrableDomainSchema,
  LbRelDefaultSchema,
  LbResponsibilityAckSchema,
  LbRunStatusSchema,
  LbRunStepCostsSchema,
  LbScheduleSchema,
  LbSpamRetrySchema,
  LbTargetSchema,
  LbThreadStatusSchema,
  LbTopicLaneSchema,
  LbWarmupSchema,
  LbWhyNotSchema,
} from "./link-builder.js";

const projectId = z.object({ projectId: Id });

export const LbActivitySchema = z.enum([
  "needs_operator",
  "paused",
  "overtime",
  "running",
  "out_of_window",
  "stopped",
  "draft",
  "idle",
]);

export const LbProjectPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .optional(),
  brandName: z.string().trim().min(1).max(80).optional(),
  allowedDomains: z.array(LbRegistrableDomainSchema).min(1).max(20).optional(),
  persona: LbPersonaSchema.optional(),
  /** Creates a local placeholder inbox when the project does not have one yet. */
  provisionMailbox: z.boolean().optional(),
  /** Write-only. Stored encrypted; never returned. */
  captchaToken: LbCaptchaTokenSchema.optional(),
  captchaLowBalanceCredits: z.number().int().min(0).optional(),
  quotas: LbQuotasSchema.optional(),
  schedule: LbScheduleSchema.optional(),
  topicLanes: z.array(LbTopicLaneSchema).max(20).optional(),
  markets: LbMarketsSchema.optional(),
  marketPolicy: LbMarketPolicySchema.optional(),
  disclosureMode: LbDisclosureModeSchema.optional(),
  linkRatio: LbLinkRatioSchema.optional(),
  proxyPolicy: LbProxyPolicySchema.optional(),
  countNofollow: z.boolean().optional(),
  targets: z.array(LbTargetSchema).max(100).optional(),
  facts: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  denyHosts: z.array(LbRegistrableDomainSchema).max(500).optional(),
  preferHosts: z.array(LbRegistrableDomainSchema).max(500).optional(),
  warmup: LbWarmupSchema.optional(),
  /** Short run change: "continue", "do 3 more registrations today", "increase the weekly limit to 10". */
  instruction: z.string().trim().min(1).max(200).optional(),
  spamRetry: LbSpamRetrySchema.optional(),
  content: LbContentSchema.optional(),
  operator: LbOperatorSettingsSchema.optional(),
  /** https endpoint for outbound alerts. Null clears it. The signing secret is write-only. */
  webhookUrl: z.string().max(500).nullable().optional(),
  webhookSecret: z.string().min(16).max(200).optional(),
});
export type LbProjectPatch = z.infer<typeof LbProjectPatchSchema>;

export const LbProjectCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .optional(),
  brandName: z.string().trim().min(1).max(80),
  allowedDomains: z.array(LbRegistrableDomainSchema).min(1).max(20),
  markets: LbMarketsSchema.optional(),
});

const LbRunCountersSchema = z.object({
  id: Id,
  date: z.string(),
  status: LbRunStatusSchema,
  newToday: z.number().int(),
  liveToday: z.number().int(),
  liveWeek: z.number().int(),
  uniqueHosts: z.number().int(),
  lastAction: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Page open on the team computer. The dashboard prefers this while the desktop is open. */
  currentUrl: z.string().nullable().optional(),
});

export const LbProjectDetailSchema = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  status: LbProjectStatusSchema,
  brandName: z.string(),
  allowedDomains: z.array(z.string()),
  persona: LbPersonaSchema.nullable(),
  mailboxId: Id.nullable(),
  mailboxAddress: z.string().nullable(),
  captchaConfigured: z.boolean(),
  captchaLowBalanceCredits: z.number().int(),
  quotas: LbQuotasSchema.nullable(),
  schedule: LbScheduleSchema,
  topicLanes: z.array(LbTopicLaneSchema),
  markets: LbMarketsSchema,
  marketPolicy: LbMarketPolicySchema,
  disclosureMode: LbDisclosureModeSchema,
  responsibilityAck: LbResponsibilityAckSchema.nullable(),
  linkRatio: LbLinkRatioSchema,
  proxyPolicy: LbProxyPolicySchema,
  countNofollow: z.boolean(),
  targets: z.array(LbTargetSchema),
  facts: z.array(z.string()),
  denyHosts: z.array(z.string()),
  preferHosts: z.array(z.string()),
  warmup: LbWarmupSchema,
  content: LbContentSchema,
  operator: LbOperatorSettingsSchema,
  webhookUrl: z.string().nullable(),
  webhookConfigured: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type LbProjectDetail = z.infer<typeof LbProjectDetailSchema>;

export const LbProjectCardSchema = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  status: LbProjectStatusSchema,
  brandName: z.string(),
  activity: LbActivitySchema,
  activityLabel: z.string(),
  newToday: z.number().int(),
  liveToday: z.number().int(),
  liveWeek: z.number().int(),
  newPerDay: z.number().int(),
  livePerDay: z.number().int(),
  liveWeekCap: z.number().int().nullable(),
  runStatus: LbRunStatusSchema.nullable(),
  lastEvent: z.string().nullable(),
  operatorQueue: z.number().int(),
  /** One UI action that works without the desktop. Absent when the user cannot help. */
  operatorHelp: z
    .object({
      ticketId: Id,
      domain: z.string(),
      label: z.string(),
      action: z.enum(["skip", "continue"]),
    })
    .nullable()
    .optional(),
});
export type LbProjectCard = z.infer<typeof LbProjectCardSchema>;

export const LbProjectStatusViewSchema = z.object({
  projectId: Id,
  projectStatus: LbProjectStatusSchema,
  activity: LbActivitySchema,
  activityLabel: z.string(),
  run: LbRunCountersSchema.nullable(),
  whyNot: LbWhyNotSchema.nullable(),
  operatorQueue: z.number().int(),
  operatorHelp: z
    .object({
      ticketId: Id,
      domain: z.string(),
      label: z.string(),
      action: z.enum(["skip", "continue"]),
    })
    .nullable()
    .optional(),
  scheduleActive: z.boolean(),
  scheduleReason: z.string(),
  newPerDay: z.number().int(),
  livePerDay: z.number().int(),
  liveWeekCap: z.number().int().nullable(),
  lastEvent: z.string().nullable(),
  costs: z.object({ day: LbCostSummarySchema, week: LbCostSummarySchema }),
  stage: z.enum(["research", "register", "warmup", "place", "verify"]).optional(),
  credits: z
    .object({
      balance: z.number().int().min(0),
      payment: z.literal("stub"),
    })
    .optional(),
});
export type LbProjectStatusView = z.infer<typeof LbProjectStatusViewSchema>;

export const LbHostViewSchema = z.object({
  id: Id,
  registrableDomain: z.string(),
  homepageUrl: z.string(),
  platform: LbHostPlatformSchema,
  country: z.string(),
  language: z.string(),
  locale: z.string(),
  timezoneId: z.string(),
  status: LbHostStatusSchema,
  parkedFrom: LbParkableHostStatusSchema.nullable(),
  qualityScore: z.number(),
  topicTags: z.array(z.string()),
  captchaType: LbCaptchaTypeSchema.nullable(),
  hrefForNewMembers: LbHrefForNewMembersSchema,
  relDefault: LbRelDefaultSchema,
  signatureLinks: z.boolean(),
  minPostsForLinks: z.number().int().nullable(),
  registerUrl: z.string().nullable(),
  statusReason: z.string().nullable(),
});
export type LbHostView = z.infer<typeof LbHostViewSchema>;

export const LbPlacementViewSchema = z.object({
  id: Id,
  hostId: Id,
  domain: z.string(),
  threadUrl: z.string(),
  postUrl: z.string(),
  targetUrl: z.string(),
  anchorText: z.string(),
  rel: z.array(z.string()),
  status: LbPlacementStatusSchema,
  counted: z.boolean(),
  verifiedAt: IsoDate.nullable(),
  snapshotArtifactId: Id.nullable(),
});
export type LbPlacementView = z.infer<typeof LbPlacementViewSchema>;

export const LbRunViewSchema = LbRunCountersSchema.extend({
  whyNot: LbWhyNotSchema.nullable(),
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
});
export type LbRunView = z.infer<typeof LbRunViewSchema>;

export const LbProxyLeaseViewSchema = z.object({
  id: Id,
  country: z.string(),
  kind: LbProxyKindSchema,
  providerId: z.string(),
  expiresAt: IsoDate.nullable(),
  status: LbProxyLeaseStatusSchema,
});
export type LbProxyLeaseView = z.infer<typeof LbProxyLeaseViewSchema>;

export const LbRunStepViewSchema = z.object({
  id: Id,
  stepIndex: z.number().int(),
  kind: z.string(),
  hostId: Id.nullable(),
  lastAction: z.string().nullable(),
  error: z.string().nullable(),
  costs: LbRunStepCostsSchema,
  /** Screenshots and snapshots of the step; read them with `linkBuilder.artifacts.get`. */
  artifactIds: z.array(Id),
  createdAt: IsoDate,
});
export type LbRunStepView = z.infer<typeof LbRunStepViewSchema>;

export const LbThreadViewSchema = z.object({
  id: Id,
  hostId: Id,
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  excerpt: z.string(),
  status: LbThreadStatusSchema,
  relevance: z.number(),
  openQuestion: z.boolean(),
  laneId: z.string().nullable(),
  rejectReason: z.string().nullable(),
});
export type LbThreadView = z.infer<typeof LbThreadViewSchema>;

export const LbDraftViewSchema = z.object({
  id: Id,
  threadCandidateId: Id,
  body: z.string(),
  status: LbDraftStatusSchema,
  linkSlot: LbLinkSlotSchema,
  modelLane: LbModelLaneSchema,
  modelId: z.string(),
  targetUrl: z.string().nullable(),
  anchorText: z.string().nullable(),
  confidence: z.number().nullable(),
  qualityChecks: LbDraftQualityChecksSchema,
});
export type LbDraftView = z.infer<typeof LbDraftViewSchema>;

export const LbCaptchaEventViewSchema = z.object({
  id: Id,
  hostId: Id.nullable(),
  domain: z.string().nullable(),
  type: LbCaptchaTypeSchema,
  door: LbCaptchaDoorSchema,
  outcome: LbCaptchaOutcomeSchema,
  buttonTextObserved: z.string().nullable(),
  attempt: z.number().int(),
  creditsCharged: z.number().int(),
  taskId: z.string().nullable(),
  createdAt: IsoDate,
});
export type LbCaptchaEventView = z.infer<typeof LbCaptchaEventViewSchema>;

export const LbOperatorTicketViewSchema = z.object({
  id: Id,
  projectId: Id,
  hostId: Id,
  domain: z.string(),
  runId: Id.nullable(),
  reason: LbOperatorTicketReasonSchema,
  screenUrl: z.string().nullable(),
  /** Latest screenshot of the host taken by the run that opened the ticket. */
  screenshotArtifactId: Id.nullable(),
  note: z.string().nullable(),
  status: LbOperatorTicketStatusSchema,
  expiresAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type LbOperatorTicketView = z.infer<typeof LbOperatorTicketViewSchema>;

export const LbArtifactViewSchema = z.object({
  id: Id,
  name: z.string(),
  mimeType: z.string(),
  contentBase64: z.string(),
});
export type LbArtifactView = z.infer<typeof LbArtifactViewSchema>;

export const LbProjectEventSchema = z.object({
  projectId: Id,
  cursor: z.string(),
});

const ticketAction = z.object({
  projectId: Id,
  ticketId: Id,
  note: z.string().trim().max(500).optional(),
});

export const LbCreditPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  credits: z.number().int().positive(),
  priceCents: z.number().int().positive(),
  currency: z.literal("eur"),
  recommended: z.boolean(),
});

export const LbBillingOfferSchema = z.object({
  packages: z.array(LbCreditPackageSchema),
  entitled: z.boolean(),
  checkoutConnected: z.boolean(),
  balance: z.number().int().min(0),
  reason: z.string(),
});
export type LbBillingOffer = z.infer<typeof LbBillingOfferSchema>;

export const LbCheckoutResultSchema = z.object({
  charged: z.boolean(),
  entitled: z.boolean(),
  balance: z.number().int().min(0),
  reason: z.string(),
  checkoutUrl: z.string().nullable(),
});
export type LbCheckoutResult = z.infer<typeof LbCheckoutResultSchema>;

export const linkBuilderContract = {
  pages: {
    suggest: oc
      .input(
        z.object({
          url: z.string().trim().min(1).max(500),
          allowedDomains: z.array(LbRegistrableDomainSchema).min(1).max(20),
        }),
      )
      .output(z.object({ keyword: z.string().max(80), rule: z.string().max(300) })),
  },
  projects: {
    list: oc.output(z.array(LbProjectCardSchema)),
    get: oc.input(projectId).output(LbProjectDetailSchema),
    create: oc.input(LbProjectCreateInputSchema).output(LbProjectDetailSchema),
    update: oc.input(LbProjectPatchSchema.extend({ projectId: Id })).output(LbProjectDetailSchema),
    archive: oc.input(projectId).output(z.object({ ok: z.literal(true) })),
    start: oc.input(projectId).output(LbProjectDetailSchema),
    pause: oc.input(projectId).output(LbProjectDetailSchema),
    stop: oc.input(projectId).output(LbProjectDetailSchema),
    status: oc.input(projectId).output(LbProjectStatusViewSchema),
    /** Live team-computer stream for the dashboard. Proxied like the agent computer. */
    screen: oc.input(projectId).output(
      z.object({
        url: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
    seedDemo: oc.output(LbProjectDetailSchema),
  },
  billing: {
    offer: oc.output(LbBillingOfferSchema),
    checkout: oc
      .input(z.object({ packageId: z.string().trim().min(1).max(40) }))
      .output(LbCheckoutResultSchema),
  },
  credits: {
    buy: oc.input(projectId).output(
      z.object({
        balance: z.number().int().min(0),
        charged: z.boolean(),
        reason: z.string(),
      }),
    ),
  },
  hosts: {
    list: oc.input(projectId).output(z.array(LbHostViewSchema)),
  },
  proxyLeases: {
    list: oc.input(projectId).output(z.array(LbProxyLeaseViewSchema)),
  },
  placements: {
    list: oc.input(projectId).output(z.array(LbPlacementViewSchema)),
    verify: oc.input(z.object({ projectId: Id, placementId: Id })).output(LbPlacementViewSchema),
  },
  runs: {
    list: oc.input(projectId).output(z.array(LbRunViewSchema)),
    steps: oc.input(z.object({ projectId: Id, runId: Id })).output(z.array(LbRunStepViewSchema)),
  },
  threads: {
    list: oc.input(projectId).output(z.array(LbThreadViewSchema)),
  },
  drafts: {
    list: oc.input(projectId).output(z.array(LbDraftViewSchema)),
    approve: oc.input(z.object({ projectId: Id, draftId: Id })).output(LbDraftViewSchema),
    discard: oc.input(z.object({ projectId: Id, draftId: Id })).output(LbDraftViewSchema),
  },
  captcha: {
    events: oc.input(projectId).output(z.array(LbCaptchaEventViewSchema)),
  },
  operator: {
    tickets: oc
      .input(projectId.extend({ status: LbOperatorTicketStatusSchema.optional() }))
      .output(z.array(LbOperatorTicketViewSchema)),
    continue: oc.input(ticketAction).output(LbOperatorTicketViewSchema),
    skip: oc.input(ticketAction).output(LbOperatorTicketViewSchema),
  },
  artifacts: {
    get: oc.input(z.object({ projectId: Id, artifactId: Id })).output(LbArtifactViewSchema),
  },
  costs: {
    summary: oc
      .input(projectId.extend({ range: z.enum(["day", "week"]) }))
      .output(LbCostSummarySchema),
  },
  captell: {
    checkBalance: oc
      .input(z.object({ projectId: Id.optional(), token: LbCaptchaTokenSchema.optional() }))
      .output(z.object({ credits: z.number().int(), helperVersion: z.string() })),
  },
  subscribe: oc
    .input(projectId.extend({ cursor: z.string() }))
    .output(eventIterator(LbProjectEventSchema)),
};
