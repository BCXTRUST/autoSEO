import { type Actor, CampaignConfigInput, CampaignPublicationAction } from "@rakazo/contracts";
import { CampaignConflictError, CampaignNotFoundError, CampaignRuleError } from "./campaigns.js";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const CAMPAIGN_PUBLICATION_MAX_VERIFY_ATTEMPTS = 12;
export const CAMPAIGN_PUBLICATION_VERIFY_INTERVAL_MS = 10_000;
export const CAMPAIGN_PUBLICATION_DISPATCH_DEADLINE_MS = 60_000;
export const CAMPAIGN_PUBLICATION_DEADLINE_MS = 24 * 60 * 60 * 1_000;

const reservedStatuses = ["intent", "ambiguous", "submitted", "pending", "verified"];

export interface ReserveCampaignPublicationInput {
  campaignId: string;
  draftId: string;
  topicId: number;
  nonce: string;
  payloadHash: string;
  bodySnapshot: string;
  approvedDraftUpdatedAt: string;
  contentHash: string;
  expectedLink: string;
  allowNew?: boolean;
  now?: Date;
}

export type ReservedCampaignPublication = {
  action: ReturnType<typeof CampaignPublicationAction.parse>;
  dispatch: boolean;
};

const campaignScope = (actor: Actor, campaignId: string) => ({
  id: campaignId,
  workspaceId: actor.workspaceId,
  userId: actor.userId,
});

function safeError(value: string | null): string | null {
  if (!value) return null;
  const safeCodes = new Set([
    "publishing_disabled",
    "deployment_owner_required",
    "provider_not_configured",
    "daily_limit_reached",
    "campaign_inactive",
    "campaign_mode_unsupported",
    "draft_changed",
    "draft_not_approved",
    "duplicate_action_pending",
    "paused_before_dispatch",
    "provider_not_ready",
    "topic_unavailable",
    "submission_ambiguous",
    "provider_rejected",
    "provider_unavailable",
    "verification_pending",
    "verification_limit_reached",
    "verification_deadline_reached",
    "verification_not_found",
  ]);
  return safeCodes.has(value) ? value : "provider_unavailable";
}

function toDto(row: {
  id: string;
  campaignId: string;
  draftId: string;
  status: string;
  topicId: number;
  providerPostId: number | null;
  publicUrl: string | null;
  safeError: string | null;
  verificationAttempts: number;
  maxVerificationAttempts: number;
  deadlineAt: Date;
  nextVerifyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return CampaignPublicationAction.parse({
    id: row.id,
    campaignId: row.campaignId,
    draftId: row.draftId,
    status: row.status,
    topicId: row.topicId,
    providerPostId: row.providerPostId,
    publicUrl: row.publicUrl,
    safeError: safeError(row.safeError),
    verificationAttempts: row.verificationAttempts,
    maxVerificationAttempts: row.maxVerificationAttempts,
    deadlineAt: row.deadlineAt.toISOString(),
    nextVerifyAt: row.nextVerifyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function transaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
}

async function requireCampaign(
  tx: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  campaignId: string,
) {
  const campaign = await tx.campaign.findFirst({ where: campaignScope(actor, campaignId) });
  if (!campaign) throw new CampaignNotFoundError();
  return campaign;
}

async function lockCampaign(tx: Prisma.TransactionClient, actor: Actor, campaignId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "campaigns" WHERE "id" = ${campaignId} AND "workspaceId" = ${actor.workspaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
  );
  if (rows.length === 0) throw new CampaignNotFoundError();
}

async function appendPublicationEvent(
  tx: Prisma.TransactionClient,
  actor: Actor,
  campaignId: string,
  input: { type: string; summary: string; stepId?: string },
) {
  const now = new Date();
  const campaign = await tx.campaign.update({
    where: { id: campaignId },
    data: {
      revision: { increment: 1 },
      eventSequence: { increment: 1 },
      updatedAt: now,
    },
    select: { eventSequence: true, workspaceId: true, userId: true },
  });
  if (campaign.workspaceId !== actor.workspaceId || campaign.userId !== actor.userId) {
    throw new CampaignNotFoundError();
  }
  await tx.campaignEvent.create({
    data: {
      campaignId,
      sequence: campaign.eventSequence,
      type: input.type,
      summary: input.summary,
      stepId: input.stepId,
      occurredAt: now,
    },
  });
}

async function priorAction(
  tx: Prisma.TransactionClient,
  campaignId: string,
  nonce: string,
  payloadHash: string,
) {
  const action = await tx.campaignPublicationAction.findUnique({
    where: { campaignId_nonce: { campaignId, nonce } },
  });
  if (!action) return null;
  if (action.payloadHash !== payloadHash)
    throw new CampaignConflictError("This nonce was used for a different publication request");
  return action;
}

export async function reserveCampaignPublication(
  prisma: PrismaClient,
  actor: Actor,
  input: ReserveCampaignPublicationInput,
): Promise<ReservedCampaignPublication> {
  const now = input.now ?? new Date();
  const approvedAt = new Date(input.approvedDraftUpdatedAt);
  if (!Number.isFinite(approvedAt.getTime()))
    throw new CampaignRuleError("Draft approval time is invalid");
  return transaction(prisma, async (tx) => {
    // Scope and draft existence are checked before any idempotency replay.
    await requireCampaign(tx, actor, input.campaignId);
    const draft = await tx.campaignItem.findFirst({
      where: { id: input.draftId, campaignId: input.campaignId, kind: "draft" },
    });
    if (!draft) throw new CampaignNotFoundError();
    const existing = await priorAction(tx, input.campaignId, input.nonce, input.payloadHash);
    if (existing) return { action: toDto(existing), dispatch: false };
    if (input.allowNew === false) throw new CampaignRuleError("publishing_disabled");

    await lockCampaign(tx, actor, input.campaignId);
    const campaign = await requireCampaign(tx, actor, input.campaignId);
    const config = CampaignConfigInput.parse(campaign.config);
    if (campaign.status !== "active") throw new CampaignRuleError("campaign_inactive");
    if (campaign.mode !== "research") throw new CampaignRuleError("campaign_mode_unsupported");
    if (draft.status !== "approved" || jsonObject(draft.details).reviewDecision !== "approved") {
      throw new CampaignRuleError("draft_not_approved");
    }
    if (
      draft.updatedAt.toISOString() !== input.approvedDraftUpdatedAt ||
      draft.body !== input.bodySnapshot
    ) {
      throw new CampaignConflictError(
        "The approved draft changed; review it again before publishing",
      );
    }
    if (config.dailyPublicationLimit <= 0) throw new CampaignRuleError("daily_limit_reached");

    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const reservedToday = await tx.campaignPublicationAction.count({
      where: {
        campaignId: input.campaignId,
        createdAt: { gte: dayStart },
        status: { in: reservedStatuses },
      },
    });
    if (reservedToday >= config.dailyPublicationLimit)
      throw new CampaignRuleError("daily_limit_reached");

    const existingForDraft = await tx.campaignPublicationAction.findFirst({
      where: {
        campaignId: input.campaignId,
        draftId: input.draftId,
        status: { in: reservedStatuses },
      },
      select: { id: true },
    });
    if (existingForDraft) throw new CampaignRuleError("duplicate_action_pending");

    const action = await tx.campaignPublicationAction.create({
      data: {
        campaignId: input.campaignId,
        draftId: input.draftId,
        nonce: input.nonce,
        payloadHash: input.payloadHash,
        status: "intent",
        topicId: input.topicId,
        bodySnapshot: input.bodySnapshot,
        approvedDraftUpdatedAt: approvedAt,
        contentHash: input.contentHash,
        expectedLink: input.expectedLink,
        deadlineAt: new Date(now.getTime() + CAMPAIGN_PUBLICATION_DISPATCH_DEADLINE_MS),
        maxVerificationAttempts: CAMPAIGN_PUBLICATION_MAX_VERIFY_ATTEMPTS,
      },
    });
    await appendPublicationEvent(tx, actor, input.campaignId, {
      type: "publication_requested",
      summary: "A reviewed Discourse publication request was recorded.",
      stepId: input.draftId,
    });
    return { action: toDto(action), dispatch: true };
  });
}

export async function listCampaignPublicationActions(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
) {
  const now = new Date();
  await transaction(prisma, async (tx) => {
    await requireCampaign(tx, actor, campaignId);
    await lockCampaign(tx, actor, campaignId);
    const staleIntents = await tx.campaignPublicationAction.findMany({
      where: { campaignId, status: "intent", deadlineAt: { lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of staleIntents) {
      await tx.campaignPublicationAction.update({
        where: { id: row.id },
        data: { status: "ambiguous", safeError: "submission_ambiguous", nextVerifyAt: null },
      });
      await appendPublicationEvent(tx, actor, campaignId, {
        type: "publication_blocked",
        summary: "Publication receipt is unresolved; automatic resubmission is disabled.",
        stepId: row.draftId,
      });
    }
    const exhaustedVerification = await tx.campaignPublicationAction.findMany({
      where: {
        campaignId,
        status: { in: ["submitted", "pending"] },
        OR: [
          { deadlineAt: { lte: now } },
          { verificationAttempts: { gte: CAMPAIGN_PUBLICATION_MAX_VERIFY_ATTEMPTS } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of exhaustedVerification) {
      const limitReached = row.verificationAttempts >= row.maxVerificationAttempts;
      const expired = row.deadlineAt <= now;
      if (!limitReached && !expired) continue;
      await tx.campaignPublicationAction.update({
        where: { id: row.id },
        data: {
          status: "blocked",
          safeError: limitReached ? "verification_limit_reached" : "verification_deadline_reached",
          nextVerifyAt: null,
        },
      });
      await appendPublicationEvent(tx, actor, campaignId, {
        type: "publication_blocked",
        summary: limitReached
          ? "Public verification reached its bounded attempt limit and needs manual attention."
          : "The public verification window expired and needs manual attention.",
        stepId: row.draftId,
      });
    }
  });
  const rows = await prisma.campaignPublicationAction.findMany({
    where: { campaignId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 100,
  });
  return rows.map(toDto);
}

export async function getCampaignPublicationContext(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
) {
  const campaign = await requireCampaign(prisma, actor, campaignId);
  return {
    id: campaign.id,
    status: campaign.status,
    mode: campaign.mode,
    config: CampaignConfigInput.parse(campaign.config),
  };
}

export async function getCampaignPublicationDraft(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  draftId: string,
) {
  await requireCampaign(prisma, actor, campaignId);
  const draft = await prisma.campaignItem.findFirst({
    where: { id: draftId, campaignId, kind: "draft" },
  });
  if (!draft) throw new CampaignNotFoundError();
  return draft;
}

export type PublicationVerificationClaim =
  | { action: ReturnType<typeof CampaignPublicationAction.parse>; verify: false }
  | {
      action: ReturnType<typeof CampaignPublicationAction.parse>;
      verify: true;
      expectedLink: string;
      topicId: number;
      providerPostId: number;
    };

export async function claimCampaignPublicationVerification(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; actionId: string; now?: Date },
): Promise<PublicationVerificationClaim> {
  const now = input.now ?? new Date();
  return transaction(prisma, async (tx) => {
    await requireCampaign(tx, actor, input.campaignId);
    await lockCampaign(tx, actor, input.campaignId);
    const row = await tx.campaignPublicationAction.findFirst({
      where: { id: input.actionId, campaignId: input.campaignId },
    });
    if (!row) throw new CampaignNotFoundError();
    if (row.status === "intent" && row.deadlineAt <= now) {
      const action = await tx.campaignPublicationAction.update({
        where: { id: row.id },
        data: { status: "ambiguous", safeError: "submission_ambiguous", nextVerifyAt: null },
      });
      await appendPublicationEvent(tx, actor, input.campaignId, {
        type: "publication_blocked",
        summary: "Publication receipt is unresolved; automatic resubmission is disabled.",
        stepId: row.draftId,
      });
      return { action: toDto(action), verify: false };
    }
    if (row.status !== "submitted" && row.status !== "pending") {
      return { action: toDto(row), verify: false };
    }
    if (row.deadlineAt <= now) {
      const action = await tx.campaignPublicationAction.update({
        where: { id: row.id },
        data: { status: "blocked", safeError: "verification_deadline_reached", nextVerifyAt: null },
      });
      await appendPublicationEvent(tx, actor, input.campaignId, {
        type: "publication_blocked",
        summary: "Public verification reached its deadline without a confirmed result.",
        stepId: row.draftId,
      });
      return { action: toDto(action), verify: false };
    }
    if (row.verificationAttempts >= row.maxVerificationAttempts) {
      const action = await tx.campaignPublicationAction.update({
        where: { id: row.id },
        data: { status: "blocked", safeError: "verification_limit_reached", nextVerifyAt: null },
      });
      await appendPublicationEvent(tx, actor, input.campaignId, {
        type: "publication_blocked",
        summary: "Public verification reached its retry limit without a confirmed result.",
        stepId: row.draftId,
      });
      return { action: toDto(action), verify: false };
    }
    if (row.nextVerifyAt && row.nextVerifyAt > now) return { action: toDto(row), verify: false };
    const nextVerifyAt = new Date(now.getTime() + CAMPAIGN_PUBLICATION_VERIFY_INTERVAL_MS);
    const changed = await tx.campaignPublicationAction.updateMany({
      where: {
        id: row.id,
        campaignId: input.campaignId,
        status: row.status,
        verificationAttempts: row.verificationAttempts,
        nextVerifyAt: row.nextVerifyAt,
      },
      data: {
        verificationAttempts: { increment: 1 },
        nextVerifyAt,
      },
    });
    if (changed.count !== 1) {
      const current = await tx.campaignPublicationAction.findUniqueOrThrow({
        where: { id: row.id },
      });
      return { action: toDto(current), verify: false };
    }
    const claimed = await tx.campaignPublicationAction.findUniqueOrThrow({ where: { id: row.id } });
    await appendPublicationEvent(tx, actor, input.campaignId, {
      type: "publication_pending",
      summary: "An independent public verification check was scheduled.",
      stepId: row.draftId,
    });
    if (claimed.providerPostId === null) return { action: toDto(claimed), verify: false };
    return {
      action: toDto(claimed),
      verify: true,
      expectedLink: claimed.expectedLink,
      topicId: claimed.topicId,
      providerPostId: claimed.providerPostId,
    };
  });
}

export async function completeCampaignPublicationVerification(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    actionId: string;
    outcome: "verified" | "pending" | "not_verified" | "blocked";
    safeError?: string | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return transaction(prisma, async (tx) => {
    await requireCampaign(tx, actor, input.campaignId);
    await lockCampaign(tx, actor, input.campaignId);
    const row = await tx.campaignPublicationAction.findFirst({
      where: { id: input.actionId, campaignId: input.campaignId },
    });
    if (!row) throw new CampaignNotFoundError();
    if (row.status !== "submitted" && row.status !== "pending") return toDto(row);

    let status: string = "pending";
    let error = safeError(input.safeError ?? null);
    let nextVerifyAt: Date | null = new Date(
      now.getTime() + CAMPAIGN_PUBLICATION_VERIFY_INTERVAL_MS,
    );
    let event: { type: string; summary: string } | null = null;
    if (input.outcome === "verified") {
      status = "verified";
      error = null;
      nextVerifyAt = null;
      event = {
        type: "publication_verified",
        summary: "The public post and expected link were independently verified.",
      };
    } else if (
      input.outcome === "blocked" ||
      row.verificationAttempts >= row.maxVerificationAttempts ||
      row.deadlineAt <= now
    ) {
      status = "blocked";
      error =
        row.deadlineAt <= now ? "verification_deadline_reached" : "verification_limit_reached";
      nextVerifyAt = null;
      event = {
        type: "publication_blocked",
        summary: "Public verification could not confirm this publication within its bounds.",
      };
    } else {
      error =
        input.outcome === "not_verified"
          ? "verification_pending"
          : (error ?? "verification_pending");
      event = {
        type: "publication_pending",
        summary: "Anonymous verification has not confirmed the public post yet.",
      };
    }

    const action = await tx.campaignPublicationAction.update({
      where: { id: row.id },
      data: { status, safeError: error, nextVerifyAt },
    });
    if (event) {
      await appendPublicationEvent(tx, actor, input.campaignId, {
        ...event,
        stepId: row.draftId,
      });
    }
    return toDto(action);
  });
}

export async function markCampaignPublicationBlocked(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; actionId: string; safeError: string; summary: string },
) {
  return transaction(prisma, async (tx) => {
    await requireCampaign(tx, actor, input.campaignId);
    await lockCampaign(tx, actor, input.campaignId);
    const row = await tx.campaignPublicationAction.findFirst({
      where: { id: input.actionId, campaignId: input.campaignId },
    });
    if (!row) throw new CampaignNotFoundError();
    if (row.status !== "intent") return toDto(row);
    const action = await tx.campaignPublicationAction.update({
      where: { id: row.id },
      data: { status: "blocked", safeError: safeError(input.safeError), nextVerifyAt: null },
    });
    await appendPublicationEvent(tx, actor, input.campaignId, {
      type: "publication_blocked",
      summary: input.summary.slice(0, 500),
      stepId: row.draftId,
    });
    return toDto(action);
  });
}

export async function dispatchCampaignPublication(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    actionId: string;
    expectedDraftUpdatedAt: string;
    enabled: boolean;
    deploymentOwner: boolean;
    publish: () => Promise<
      | { status: "success"; value: { postId: number; topicId: number; url: string } }
      | { status: "ambiguous_submission"; code: string }
      | { status: "blocked"; code: string }
    >;
  },
) {
  let sideEffectStarted = false;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await requireCampaign(tx, actor, input.campaignId);
        await lockCampaign(tx, actor, input.campaignId);
        const [campaign, action] = await Promise.all([
          tx.campaign.findFirst({ where: campaignScope(actor, input.campaignId) }),
          tx.campaignPublicationAction.findFirst({
            where: { id: input.actionId, campaignId: input.campaignId },
          }),
        ]);
        if (!campaign || !action) throw new CampaignNotFoundError();
        if (action.status !== "intent") return toDto(action);
        const draft = await tx.campaignItem.findFirst({
          where: { id: action.draftId, campaignId: input.campaignId, kind: "draft" },
        });
        if (!draft) throw new CampaignNotFoundError();
        if (!input.enabled) {
          const blocked = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: { status: "blocked", safeError: "publishing_disabled" },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_blocked",
            summary: "Publishing was disabled before the external request started.",
            stepId: draft.id,
          });
          return toDto(blocked);
        }
        if (!input.deploymentOwner) {
          const blocked = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: { status: "blocked", safeError: "deployment_owner_required" },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_blocked",
            summary: "The shared Discourse account is reserved for the deployment owner.",
            stepId: draft.id,
          });
          return toDto(blocked);
        }
        if (campaign.status !== "active") {
          const blocked = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: { status: "blocked", safeError: "paused_before_dispatch" },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_blocked",
            summary: "The campaign was paused before the external request started.",
            stepId: draft.id,
          });
          return toDto(blocked);
        }
        if (action.deadlineAt <= new Date()) {
          const ambiguous = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: { status: "ambiguous", safeError: "submission_ambiguous", nextVerifyAt: null },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_blocked",
            summary: "The dispatch intent expired before a safe post request could begin.",
            stepId: draft.id,
          });
          return toDto(ambiguous);
        }
        if (
          draft.status !== "approved" ||
          draft.updatedAt.toISOString() !== input.expectedDraftUpdatedAt ||
          draft.updatedAt.toISOString() !== action.approvedDraftUpdatedAt.toISOString() ||
          draft.body !== action.bodySnapshot
        ) {
          const blocked = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: { status: "blocked", safeError: "draft_changed" },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_blocked",
            summary: "The approved draft changed before the publication request started.",
            stepId: draft.id,
          });
          return toDto(blocked);
        }

        // Hold the campaign row lock through the bounded POST so pause linearizes
        // before dispatch or after its persisted receipt.
        sideEffectStarted = true;
        const result = await input.publish();
        if (result.status === "success") {
          if (result.value.topicId !== action.topicId || result.value.postId <= 0) {
            const ambiguous = await tx.campaignPublicationAction.update({
              where: { id: action.id },
              data: { status: "ambiguous", safeError: "submission_ambiguous" },
            });
            await appendPublicationEvent(tx, actor, input.campaignId, {
              type: "publication_blocked",
              summary:
                "Discourse returned an unexpected receipt; automatic resubmission is disabled.",
              stepId: draft.id,
            });
            return toDto(ambiguous);
          }
          const submitted = await tx.campaignPublicationAction.update({
            where: { id: action.id },
            data: {
              status: "submitted",
              providerPostId: result.value.postId,
              publicUrl: result.value.url,
              safeError: null,
              deadlineAt: new Date(Date.now() + CAMPAIGN_PUBLICATION_DEADLINE_MS),
              nextVerifyAt: new Date(),
            },
          });
          await appendPublicationEvent(tx, actor, input.campaignId, {
            type: "publication_submitted",
            summary: "Discourse accepted the post; independent public verification is pending.",
            stepId: draft.id,
          });
          return toDto(submitted);
        }

        const ambiguous = result.status === "ambiguous_submission";
        const blocked = await tx.campaignPublicationAction.update({
          where: { id: action.id },
          data: {
            status: ambiguous ? "ambiguous" : "blocked",
            safeError: ambiguous
              ? "submission_ambiguous"
              : result.code === "provider_unavailable" || result.code === "network_error"
                ? "provider_unavailable"
                : "provider_rejected",
          },
        });
        await appendPublicationEvent(tx, actor, input.campaignId, {
          type: "publication_blocked",
          summary: ambiguous
            ? "The post result is uncertain; automatic resubmission is disabled."
            : "Discourse blocked the post request.",
          stepId: draft.id,
        });
        return toDto(blocked);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      },
    );
  } catch (error) {
    if (!sideEffectStarted) throw error;
    return markCampaignPublicationAmbiguous(prisma, actor, {
      campaignId: input.campaignId,
      actionId: input.actionId,
    }).catch(() => {
      throw error;
    });
  }
}

async function markCampaignPublicationAmbiguous(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; actionId: string },
) {
  return transaction(prisma, async (tx) => {
    await requireCampaign(tx, actor, input.campaignId);
    await lockCampaign(tx, actor, input.campaignId);
    const row = await tx.campaignPublicationAction.findFirst({
      where: { id: input.actionId, campaignId: input.campaignId },
    });
    if (!row) throw new CampaignNotFoundError();
    if (row.status !== "intent") return toDto(row);
    const action = await tx.campaignPublicationAction.update({
      where: { id: row.id },
      data: { status: "ambiguous", safeError: "submission_ambiguous", nextVerifyAt: null },
    });
    await appendPublicationEvent(tx, actor, input.campaignId, {
      type: "publication_blocked",
      summary:
        "Discourse may have accepted the post, but its receipt could not be stored. Do not resubmit.",
      stepId: row.draftId,
    });
    return toDto(action);
  });
}
