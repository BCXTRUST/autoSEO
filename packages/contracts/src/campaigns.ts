import * as z from "zod";

export const CampaignStatus = z.enum(["draft", "active", "paused", "archived"]);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const CampaignMode = z.enum(["research", "controlled"]);
export type CampaignMode = z.infer<typeof CampaignMode>;

export const CampaignStepStatus = z.enum([
  "queued",
  "running",
  "waiting_external",
  "waiting_review",
  "deferred",
  "needs_action",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
]);
export type CampaignStepStatus = z.infer<typeof CampaignStepStatus>;

export const CampaignFailureKind = z.enum([
  "transient",
  "authentication",
  "budget",
  "unsupported",
  "ineligible",
  "invalid_input",
  "ambiguous_submission",
  "permanent",
]);
export type CampaignFailureKind = z.infer<typeof CampaignFailureKind>;

const SafeNonnegativeInteger = z.number().int().nonnegative().safe();
const CampaignName = z.string().trim().min(1).max(120);
export const CampaignHttpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) URL without embedded credentials");

export const CampaignConfigInput = z
  .object({
    name: CampaignName,
    websiteUrl: CampaignHttpUrl,
    language: z.string().trim().min(2).max(35),
    market: z.string().trim().min(2).max(100),
    objective: z.string().trim().min(1).max(2000),
    /** Zero disables registration actions for this campaign. */
    dailyRegistrationLimit: z.number().int().min(0).max(1000),
    /** Zero disables publication actions for this campaign. */
    dailyPublicationLimit: z.number().int().min(0).max(1000),
    /** Zero disables paid spend for this campaign. */
    dailySpendLimitMicros: SafeNonnegativeInteger,
    requirePublicationReview: z.literal(true),
  })
  .strict();
export type CampaignConfigInput = z.infer<typeof CampaignConfigInput>;

export const Campaign = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    config: CampaignConfigInput,
    status: CampaignStatus,
    mode: CampaignMode,
    revision: z.number().int().positive().safe(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Campaign = z.infer<typeof Campaign>;

export const CampaignActivity = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    sequence: z.number().int().positive().safe(),
    type: z.enum([
      "campaign_created",
      "configuration_updated",
      "status_changed",
      "step_started",
      "step_deferred",
      "step_blocked",
      "step_completed",
      "step_failed",
      "item_added",
      "item_updated",
      "run_requested",
      "run_paused",
      "review_approved",
      "review_rejected",
      "worker_waiting",
      "publication_requested",
      "publication_submitted",
      "publication_pending",
      "publication_verified",
      "publication_blocked",
    ]),
    summary: z.string().trim().min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
    stepId: z.string().min(1).optional(),
  })
  .strict();
export type CampaignActivity = z.infer<typeof CampaignActivity>;

export const CampaignItemKind = z.enum([
  "source",
  "opportunity",
  "account",
  "draft",
  "publication",
]);
export type CampaignItemKind = z.infer<typeof CampaignItemKind>;

export const CampaignItemStatus = z.enum([
  "queued",
  "researching",
  "deferred",
  "needs_action",
  "ready",
  "approved",
  "submitted",
  "verified",
  "failed",
]);
export type CampaignItemStatus = z.infer<typeof CampaignItemStatus>;

export const CampaignItem = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    kind: CampaignItemKind,
    url: CampaignHttpUrl.nullable(),
    title: z.string().max(200),
    body: z.string().max(20_000),
    status: CampaignItemStatus,
    details: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CampaignItem = z.infer<typeof CampaignItem>;

export const CampaignJob = z
  .object({
    id: z.string().min(1),
    itemId: z.string().min(1).nullable(),
    operation: z.string().min(1),
    status: CampaignStepStatus,
    attemptCount: z.number().int().nonnegative().safe(),
    maxAttempts: z.number().int().positive().safe(),
    availableAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    heartbeatAt: z.iso.datetime({ offset: true }).nullable(),
    deadlineAt: z.iso.datetime({ offset: true }).nullable(),
    lastError: z.string().max(500).nullable(),
  })
  .strict();
export type CampaignJob = z.infer<typeof CampaignJob>;

export const CampaignChallengeTask = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    status: z.enum(["creating", "submitted", "ready", "failed", "ambiguous"]),
    reservationMicros: SafeNonnegativeInteger,
    actualCostMicros: SafeNonnegativeInteger.nullable(),
    pollAttempts: SafeNonnegativeInteger,
    maxPollAttempts: z.number().int().positive().safe(),
    deadlineAt: z.iso.datetime({ offset: true }),
    nextPollAt: z.iso.datetime({ offset: true }).nullable(),
    safeError: z
      .enum([
        "ambiguous_creation",
        "provider_unavailable",
        "provider_task_failed",
        "poll_limit_reached",
        "poll_deadline_exceeded",
      ])
      .nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CampaignChallengeTask = z.infer<typeof CampaignChallengeTask>;

export const CampaignChallengeStatus = z
  .object({
    configured: z.boolean(),
    paidTasksEnabled: z.boolean(),
    supportedTypes: z.tuple([z.literal("image-to-text")]),
    balanceUsd: z.number().finite().nonnegative().nullable(),
    status: z.enum(["not_configured", "ready", "disabled", "unavailable"]),
    error: z.string().max(200).nullable(),
    tasks: z.array(CampaignChallengeTask).max(50),
  })
  .strict();

export const CampaignChallengeResult = z
  .object({
    taskId: z.string().min(1),
    solution: z.string().min(1).max(500),
    application: z.literal("manual_only"),
  })
  .strict();

export const CampaignSnapshot = z
  .object({
    campaign: Campaign,
    items: z.array(CampaignItem).max(200),
    jobs: z.array(CampaignJob).max(200),
    activities: z.array(CampaignActivity).max(100),
    observedAt: z.iso.datetime({ offset: true }),
    nextCursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
  })
  .strict();
export type CampaignSnapshot = z.infer<typeof CampaignSnapshot>;

export const CampaignPublicationActionStatus = z.enum([
  "intent",
  "submitted",
  "pending",
  "verified",
  "ambiguous",
  "blocked",
  "failed",
]);
export type CampaignPublicationActionStatus = z.infer<typeof CampaignPublicationActionStatus>;

export const CampaignPublicationAction = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    draftId: z.string().min(1),
    status: CampaignPublicationActionStatus,
    topicId: z.number().int().positive().safe(),
    providerPostId: z.number().int().positive().safe().nullable(),
    publicUrl: CampaignHttpUrl.nullable(),
    safeError: z.string().max(200).nullable(),
    verificationAttempts: z.number().int().nonnegative().safe(),
    maxVerificationAttempts: z.number().int().positive().safe(),
    deadlineAt: z.iso.datetime({ offset: true }),
    nextVerifyAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CampaignPublicationAction = z.infer<typeof CampaignPublicationAction>;

export const CampaignPublicationStatus = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
    status: z.enum(["not_configured", "disabled", "ready", "unavailable"]),
    baseUrl: CampaignHttpUrl.nullable(),
    account: z.string().max(100).nullable(),
    error: z.string().max(200).nullable(),
    actions: z.array(CampaignPublicationAction).max(100),
  })
  .strict();
export type CampaignPublicationStatus = z.infer<typeof CampaignPublicationStatus>;
