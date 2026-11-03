import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const testUrl = process.env.CAMPAIGN_PG_TEST_URL;
const describePostgres = testUrl ? describe : describe.skip;

describePostgres("authenticated campaign RPCs with PostgreSQL", () => {
  it("creates and schedules research work, returns snapshots, and denies unowned records", async () => {
    const { prisma, pool } = createDb(testUrl!);
    const suffix = randomUUID();
    const actor: Actor = {
      workspaceId: `campaign-api-ws-${suffix}`,
      userId: `campaign-api-user-${suffix}`,
      email: `${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const otherActor: Actor = {
      workspaceId: `other-${actor.workspaceId}`,
      userId: `other-${actor.userId}`,
      email: `other-${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const handler = new RPCHandler(
      createRouter({
        prisma,
        secrets: {},
        events: {},
        jobs: {},
        sandbox: {},
        home: {},
        artifacts: {},
        dataDir: "/tmp/campaign-api-test",
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          webOrigin: "http://127.0.0.1:5173",
          screenProxySecret: "test-only",
          sandboxProvider: "fake",
        },
      } as unknown as RouterDeps),
    );

    async function rpc(path: string, input?: unknown, requestActor: Actor | null = actor) {
      const request = new Request(`http://127.0.0.1/rpc/campaigns/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input ?? {} }),
      });
      return handler.handle(request, { prefix: "/rpc", context: { actor: requestActor } });
    }

    try {
      await prisma.user.create({
        data: { id: actor.userId, name: "Campaign API Test User", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: actor.workspaceId,
          name: "Campaign API Test Workspace",
          slug: suffix,
          createdAt: new Date(),
        },
      });

      const unauthenticated = await rpc("list", undefined, null);
      expect(unauthenticated.response.status).toBe(401);

      const config = {
        name: "API campaign",
        websiteUrl: "https://example.test/",
        language: "en",
        market: "US",
        objective: "Review factual community research.",
        dailyRegistrationLimit: 0,
        dailyPublicationLimit: 0,
        dailySpendLimitMicros: 0,
        requirePublicationReview: true,
      };
      const created = await rpc("create", { config, clientNonce: "api-create" });
      expect(created.response.status).toBe(200);
      const createdBody = (await created.response.json()) as {
        json: { id: string; status: string };
      };
      const campaignId = createdBody.json.id;
      expect(createdBody.json.status).toBe("draft");

      const item = await rpc("addItem", {
        campaignId,
        kind: "source",
        url: "https://community.example.test/discussion/1",
        title: "Relevant discussion",
        clientNonce: "api-add-source",
      });
      expect(item.response.status).toBe(200);
      const itemId = ((await item.response.json()) as { json: { id: string } }).json.id;

      const started = await rpc("control", {
        campaignId,
        action: "start",
        clientNonce: "api-start",
      });
      expect(started.response.status, await started.response.clone().text()).toBe(200);

      const snapshot = await rpc("get", { campaignId, afterSequence: 0 });
      expect(snapshot.response.status).toBe(200);
      const snapshotBody = (await snapshot.response.json()) as {
        json: {
          campaign: { status: string };
          items: { id: string; status: string; details: Record<string, unknown> }[];
          jobs: { operation: string; itemId: string | null }[];
          activities: { type: string }[];
        };
      };
      expect(snapshotBody.json.campaign.status).toBe("active");
      expect(snapshotBody.json.items.find((candidate) => candidate.id === itemId)?.status).toBe(
        "researching",
      );
      expect(
        snapshotBody.json.jobs.find(
          (job) => job.operation === "research_source" && job.itemId === itemId,
        ),
      ).toBeDefined();
      const catalogJob = snapshotBody.json.jobs.find((job) => job.operation === "catalog_page");
      expect(catalogJob).toBeDefined();
      expect(catalogJob?.itemId).not.toBe(itemId);
      expect(
        snapshotBody.json.items.find((candidate) => candidate.id === catalogJob?.itemId)?.details,
      ).toHaveProperty("catalog");
      expect(snapshotBody.json.activities.map((activity) => activity.type)).toEqual([
        "campaign_created",
        "item_added",
        "run_requested",
      ]);

      const crossWorkspace = await rpc("get", { campaignId, afterSequence: 0 }, otherActor);
      expect(crossWorkspace.response.status).toBe(404);

      const recovery = await rpc("recoverItem", {
        campaignId,
        itemId,
        action: "defer",
        clientNonce: "api-defer-source",
      });
      expect(recovery.response.status).toBe(200);
      expect(((await recovery.response.json()) as { json: { status: string } }).json.status).toBe(
        "deferred",
      );
      const unauthorizedRecovery = await rpc(
        "recoverItem",
        {
          campaignId,
          itemId,
          action: "retry",
          clientNonce: "other-actor-replay",
        },
        otherActor,
      );
      expect(unauthorizedRecovery.response.status).toBe(404);
      const publicationStatus = await rpc("publicationStatus", { campaignId });
      expect(publicationStatus.response.status).toBe(200);
      expect(
        ((await publicationStatus.response.json()) as { json: { status: string } }).json.status,
      ).toBe("not_configured");
      const publicationActions = await rpc("publicationActions", { campaignId });
      expect(publicationActions.response.status).toBe(200);
      expect(((await publicationActions.response.json()) as { json: unknown[] }).json).toEqual([]);

      const discoveryRunId = "d".repeat(64);
      const candidate = await prisma.campaignItem.create({
        data: {
          campaignId,
          kind: "opportunity",
          url: "https://community.example.test/discovery-candidate",
          title: "Observed API candidate",
          status: "needs_action",
          details: {
            discovery: {
              runId: discoveryRunId,
              rootUrl: "https://example.test/",
              purpose: "candidate",
              provider: "rss_search",
              query: "community discussion",
              sourceItemIds: [itemId],
              rank: 3,
              observedAt: new Date().toISOString(),
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "unreviewed",
              rulesLinks: [],
              platformHint: "unknown",
            },
          },
        },
      });
      await prisma.campaignJob.create({
        data: {
          campaignId,
          itemId: candidate.id,
          operation: "discovery_inspect",
          status: "succeeded",
          checkpoint: {
            discoveryRunId,
            discoveryRootUrl: "https://example.test/",
            discoveryPurpose: "inspect",
            candidateUrl: candidate.url,
            provider: "rss_search",
            query: "community discussion",
            sourceItemIds: [itemId],
            rank: 3,
          },
        },
      });
      const selected = await rpc("reviewOpportunity", {
        campaignId,
        itemId: candidate.id,
        expectedUpdatedAt: candidate.updatedAt.toISOString(),
        action: "select",
        clientNonce: "api-select-candidate",
      });
      expect(selected.response.status).toBe(200);
      expect(
        (
          (await selected.response.json()) as {
            json: { status: string; details: Record<string, unknown> };
          }
        ).json,
      ).toMatchObject({ status: "queued", details: { discovery: { disposition: "selected" } } });
      expect(
        await prisma.campaignJob.count({
          where: { campaignId, itemId: candidate.id, operation: "research_opportunity" },
        }),
      ).toBe(1);
    } finally {
      await prisma.organization.deleteMany({ where: { id: actor.workspaceId } });
      await prisma.user.deleteMany({ where: { id: actor.userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
