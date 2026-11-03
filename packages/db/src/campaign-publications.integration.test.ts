import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  dispatchCampaignPublication,
  listCampaignPublicationActions,
} from "./campaign-publications.js";
import { createDb } from "./client.js";

const testUrl = process.env.CAMPAIGN_PG_TEST_URL;
const describePostgres = testUrl ? describe : describe.skip;

describePostgres("campaign publication persistence with PostgreSQL", () => {
  it("never replays a successful POST when receipt persistence fails", async () => {
    const { prisma, pool } = createDb(testUrl!);
    const suffix = randomUUID();
    const workspaceId = `campaign-pub-ws-${suffix}`;
    const userId = `campaign-pub-user-${suffix}`;
    const actor: Actor = {
      workspaceId,
      userId,
      email: `${suffix}@example.test`,
      isDeploymentOwner: true,
    };
    let publishCount = 0;
    try {
      await prisma.user.create({
        data: { id: userId, name: "Publication Integration User", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Publication Integration Workspace",
          slug: suffix,
          createdAt: new Date(),
        },
      });
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId,
          userId,
          clientNonce: "publication-test",
          config: {
            name: "Publication integration",
            websiteUrl: "https://example.test/",
            language: "en",
            market: "US",
            objective: "Test a durable publication receipt.",
            dailyRegistrationLimit: 0,
            dailyPublicationLimit: 3,
            dailySpendLimitMicros: 0,
            requirePublicationReview: true,
          },
          status: "active",
          mode: "research",
          revision: 1,
          eventSequence: 1,
        },
      });
      const draft = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "draft",
          title: "Approved draft",
          body: "A reviewed contribution with a project link.",
          status: "approved",
        },
      });
      const action = await prisma.campaignPublicationAction.create({
        data: {
          campaignId: campaign.id,
          draftId: draft.id,
          nonce: "publication-nonce",
          payloadHash: "payload-hash",
          status: "intent",
          topicId: 17,
          bodySnapshot: draft.body,
          approvedDraftUpdatedAt: draft.updatedAt,
          contentHash: "content-hash",
          expectedLink: "https://example.test/",
          deadlineAt: new Date(Date.now() + 60_000),
        },
      });

      const result = await dispatchCampaignPublication(prisma, actor, {
        campaignId: campaign.id,
        actionId: action.id,
        expectedDraftUpdatedAt: draft.updatedAt.toISOString(),
        enabled: true,
        deploymentOwner: true,
        publish: async () => {
          publishCount += 1;
          return {
            status: "success",
            value: { postId: 42, topicId: 17, url: "invalid-receipt-url" },
          };
        },
      });

      expect(publishCount).toBe(1);
      expect(result).toMatchObject({ status: "ambiguous", safeError: "submission_ambiguous" });
      expect(
        await prisma.campaignPublicationAction.findUniqueOrThrow({ where: { id: action.id } }),
      ).toMatchObject({
        status: "ambiguous",
        providerPostId: null,
      });
      const replay = await dispatchCampaignPublication(prisma, actor, {
        campaignId: campaign.id,
        actionId: action.id,
        expectedDraftUpdatedAt: draft.updatedAt.toISOString(),
        enabled: true,
        deploymentOwner: true,
        publish: async () => {
          publishCount += 1;
          return {
            status: "success",
            value: { postId: 43, topicId: 17, url: "https://forum.example.test/t/topic/17/43" },
          };
        },
      });
      expect(replay.status).toBe("ambiguous");
      expect(publishCount).toBe(1);
      const events = await prisma.campaignEvent.findMany({ where: { campaignId: campaign.id } });
      expect(events.map((event) => event.type)).toContain("publication_blocked");

      const pendingAction = await prisma.campaignPublicationAction.create({
        data: {
          campaignId: campaign.id,
          draftId: draft.id,
          nonce: "expired-verification",
          payloadHash: "pending-payload-hash",
          status: "submitted",
          topicId: 17,
          bodySnapshot: draft.body,
          approvedDraftUpdatedAt: draft.updatedAt,
          contentHash: "pending-content-hash",
          expectedLink: "https://example.test/",
          providerPostId: 42,
          deadlineAt: new Date(Date.now() - 1),
          nextVerifyAt: new Date(Date.now() - 1),
        },
      });
      const listedActions = await listCampaignPublicationActions(prisma, actor, campaign.id);
      expect(listedActions.find((entry) => entry.id === pendingAction.id)).toMatchObject({
        status: "blocked",
        safeError: "verification_deadline_reached",
      });
    } finally {
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
