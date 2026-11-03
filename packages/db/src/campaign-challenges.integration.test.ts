import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { reserveCampaignChallengeTask } from "./campaign-challenges.js";
import { CampaignNotFoundError, CampaignRuleError } from "./campaigns.js";
import { createDb } from "./client.js";

const testUrl = process.env.CAMPAIGN_PG_TEST_URL;
const describePostgres = testUrl ? describe : describe.skip;

const config = (dailySpendLimitMicros: number) => ({
  name: "Challenge budget integration",
  websiteUrl: "https://example.test/",
  language: "en",
  market: "US",
  objective: "Exercise durable challenge reservations.",
  dailyRegistrationLimit: 0,
  dailyPublicationLimit: 0,
  dailySpendLimitMicros,
  requirePublicationReview: true,
});

describePostgres("campaign challenge repositories with PostgreSQL", () => {
  it("serializes shared-budget reservations, nonce replays, ownership, and AI ledger spend", async () => {
    const { prisma, pool } = createDb(testUrl!);
    const suffix = randomUUID();
    const workspaceId = `challenge-ws-${suffix}`;
    const userId = `challenge-user-${suffix}`;
    const actor: Actor = {
      workspaceId,
      userId,
      email: `${suffix}@example.test`,
      isDeploymentOwner: true,
    };
    const otherActor: Actor = {
      ...actor,
      userId: `other-${userId}`,
      email: `other-${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const now = new Date();
    const makeInput = (
      campaignId: string,
      nonce: string,
      reservationMicros: number,
      payloadHash = "a".repeat(64),
    ) => ({
      campaignId,
      nonce,
      reservationMicros,
      payloadHash,
      deadlineAt: new Date(now.getTime() + 60_000),
      now,
    });

    try {
      await prisma.user.create({
        data: { id: userId, name: "Challenge Integration User", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Challenge Integration Workspace",
          slug: suffix,
          createdAt: now,
        },
      });

      const concurrencyCampaign = await prisma.campaign.create({
        data: {
          workspaceId,
          userId,
          clientNonce: "challenge-concurrency",
          config: config(10),
          status: "active",
          mode: "research",
        },
      });
      const concurrent = await Promise.allSettled([
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(concurrencyCampaign.id, "reserve-six-a", 6),
        ),
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(concurrencyCampaign.id, "reserve-six-b", 6, "b".repeat(64)),
        ),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);

      const identicalNonce = await Promise.all([
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(concurrencyCampaign.id, "same-nonce", 2, "c".repeat(64)),
        ),
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(concurrencyCampaign.id, "same-nonce", 2, "c".repeat(64)),
        ),
      ]);
      expect(identicalNonce[0]?.task.id).toBe(identicalNonce[1]?.task.id);
      expect(identicalNonce.filter((result) => result.created)).toHaveLength(1);
      expect(identicalNonce.filter((result) => !result.created)).toHaveLength(1);
      await expect(
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(concurrencyCampaign.id, "same-nonce", 2, "d".repeat(64)),
        ),
      ).rejects.toBeInstanceOf(CampaignRuleError);
      await expect(
        reserveCampaignChallengeTask(
          prisma,
          otherActor,
          makeInput(concurrencyCampaign.id, "same-nonce", 2, "c".repeat(64)),
        ),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);

      const draftingCampaign = await prisma.campaign.create({
        data: {
          workspaceId,
          userId,
          clientNonce: "challenge-ai-ledger",
          config: config(10),
          status: "active",
          mode: "research",
        },
      });
      const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        .toISOString()
        .slice(0, 10);
      await prisma.campaignJob.create({
        data: {
          campaignId: draftingCampaign.id,
          operation: "ai_draft",
          checkpoint: {
            aiState: "intent",
            aiReservedDay: utcDay,
            aiReservationMicros: "4",
            aiActualCostMicros: null,
          },
        },
      });
      await expect(
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(draftingCampaign.id, "challenge-seven", 7),
        ),
      ).rejects.toBeInstanceOf(CampaignRuleError);
      await expect(
        reserveCampaignChallengeTask(
          prisma,
          actor,
          makeInput(draftingCampaign.id, "challenge-six", 6),
        ),
      ).resolves.toMatchObject({ created: true, task: { reservationMicros: 6 } });
    } finally {
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
