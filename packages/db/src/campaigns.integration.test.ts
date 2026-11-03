import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  addCampaignItem,
  CampaignCommandConflictError,
  CampaignConflictError,
  CampaignNotFoundError,
  CampaignRuleError,
  controlCampaign,
  createCampaign,
  getCampaignSnapshot,
  recoverCampaignItem,
  reviewCampaignDraft,
  reviewCampaignOpportunity,
  stopAllCampaigns,
  updateCampaignConfig,
  updateCampaignDraft,
} from "./campaigns.js";
import { createDb } from "./client.js";

const testUrl = process.env.CAMPAIGN_PG_TEST_URL;
const describePostgres = testUrl ? describe : describe.skip;
const config = {
  name: "Integration campaign",
  websiteUrl: "https://example.test/",
  language: "en",
  market: "US",
  objective: "Create useful, reviewed research notes.",
  dailyRegistrationLimit: 0,
  dailyPublicationLimit: 0,
  dailySpendLimitMicros: 0,
  requirePublicationReview: true,
};

describePostgres("campaign repositories with PostgreSQL", () => {
  it("persists scoped idempotent mutations, revision events, jobs and controlled approvals", async () => {
    const { prisma, pool } = createDb(testUrl!);
    const suffix = randomUUID();
    const workspaceId = `campaign-ws-${suffix}`;
    const userId = `campaign-user-${suffix}`;
    const actor: Actor = {
      workspaceId,
      userId,
      email: `${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const otherActor: Actor = {
      workspaceId: `other-${workspaceId}`,
      userId: `other-${userId}`,
      email: `other-${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const siblingActor: Actor = {
      workspaceId,
      userId: `sibling-${userId}`,
      email: `sibling-${suffix}@example.test`,
      isDeploymentOwner: false,
    };

    try {
      await prisma.user.create({
        data: { id: userId, name: "Campaign Integration User", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Campaign Integration Workspace",
          slug: suffix,
          createdAt: new Date(),
        },
      });

      const campaign = await createCampaign(prisma, actor, {
        config,
        mode: "research",
        clientNonce: "create-1",
      });
      const catalogOnly = await createCampaign(prisma, actor, {
        config: { ...config, websiteUrl: "https://catalog.example.test/research/page#initial" },
        mode: "research",
        clientNonce: "catalog-only-create",
      });
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "start",
        clientNonce: "catalog-only-start",
      });
      let catalogSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogOnly.id,
        afterSequence: 0,
      });
      expect(catalogSnapshot.campaign.status).toBe("active");
      expect(catalogSnapshot.items).toHaveLength(1);
      expect(catalogSnapshot.items[0]).toMatchObject({
        kind: "source",
        url: "https://catalog.example.test/robots.txt",
        title: "Website crawl guidance",
        status: "researching",
        details: {
          catalog: {
            purpose: "guidance",
            category: "guidance",
            provenance: "conventional_probe",
            rootUrl: "https://catalog.example.test/research/page",
            depth: 0,
            runId: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      expect(catalogSnapshot.jobs).toHaveLength(1);
      expect(catalogSnapshot.jobs[0]).toMatchObject({
        operation: "catalog_page",
        status: "queued",
        itemId: catalogSnapshot.items[0]?.id,
      });
      expect(catalogSnapshot.jobs.some((job) => job.operation === "research_source")).toBe(false);
      const catalogItem = catalogSnapshot.items[0]!;
      const catalogRunId = (catalogItem.details.catalog as { runId: string }).runId;
      await prisma.campaignItem.update({
        where: { id: catalogItem.id },
        data: {
          details: {
            catalog: {
              runId: catalogRunId,
              rootUrl: "https://catalog.example.test/research/page",
              purpose: "guidance",
              category: "guidance",
              provenance: "conventional_probe",
              depth: 0,
              rawHeaders: "must-not-leak",
            },
            observedLinks: [
              {
                url: "https://catalog.example.test/guide",
                label: "Public guide",
                category: "other",
                status: "candidate",
                responseBody: "must-not-leak",
              },
              {
                url: "javascript:alert(1)",
                label: "Unsafe URL",
                category: "other",
                status: "candidate",
              },
            ],
            rawProviderPayload: { authorization: "must-not-leak" },
          },
        },
      });
      catalogSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogOnly.id,
        afterSequence: 0,
      });
      expect(catalogSnapshot.items[0]?.details.catalog).toEqual({
        runId: catalogRunId,
        rootUrl: "https://catalog.example.test/research/page",
        purpose: "guidance",
        category: "guidance",
        provenance: "conventional_probe",
        depth: 0,
      });
      expect(catalogSnapshot.items[0]?.details.observedLinks).toEqual([
        {
          url: "https://catalog.example.test/guide",
          label: "Public guide",
          category: "other",
          status: "candidate",
        },
      ]);
      expect(catalogSnapshot.items[0]?.details).not.toHaveProperty("rawProviderPayload");
      const fragmentOnlyUpdate = await updateCampaignConfig(prisma, actor, {
        campaignId: catalogOnly.id,
        expectedRevision: catalogSnapshot.campaign.revision,
        config: {
          ...config,
          websiteUrl: "https://catalog.example.test/research/page#fragment-only-change",
        },
      });
      expect(fragmentOnlyUpdate.config.websiteUrl).toBe(
        "https://catalog.example.test/research/page#fragment-only-change",
      );
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: catalogSnapshot.jobs[0]!.id } }),
      ).toMatchObject({ status: "queued", leaseFence: 0 });
      catalogSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogOnly.id,
        afterSequence: 0,
      });
      const bootstrapJobId = catalogSnapshot.jobs[0]!.id;
      const blockedCheckpoint = {
        catalogRunId: catalogRunId,
        catalogRootUrl: "https://catalog.example.test/research/page",
        catalogPurpose: "guidance",
        catalogDepth: 0,
        catalogOutcome: "blocked",
        catalogSafeError: "page_forbidden",
        catalogSummaryEmitted: true,
        retryExhausted: true,
        catalogRules: { allow: [], disallow: [], sitemaps: [] },
      };
      await prisma.campaignJob.update({
        where: { id: bootstrapJobId },
        data: { status: "needs_action", attemptCount: 3, checkpoint: blockedCheckpoint },
      });
      await prisma.campaignItem.update({
        where: { id: catalogItem.id },
        data: { status: "needs_action" },
      });
      await expect(
        recoverCampaignItem(prisma, otherActor, {
          campaignId: catalogOnly.id,
          itemId: catalogItem.id,
          action: "retry",
          clientNonce: "catalog-retry-other-actor",
        }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
      const catalogRetry = await recoverCampaignItem(prisma, actor, {
        campaignId: catalogOnly.id,
        itemId: catalogItem.id,
        action: "retry",
        clientNonce: "catalog-guidance-retry",
      });
      expect(catalogRetry).toMatchObject({
        status: "queued",
        details: { catalog: { runId: catalogRunId } },
      });
      const retriedBootstrap = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: bootstrapJobId },
      });
      expect(retriedBootstrap).toMatchObject({
        operation: "catalog_page",
        status: "queued",
        itemId: catalogItem.id,
        attemptCount: 0,
        leaseFence: 1,
        checkpoint: {
          catalogRunId,
          catalogRootUrl: "https://catalog.example.test/research/page",
          catalogPurpose: "guidance",
          catalogDepth: 0,
          catalogRules: { allow: [], disallow: [], sitemaps: [] },
        },
      });
      expect(retriedBootstrap.checkpoint).not.toHaveProperty("catalogOutcome");
      expect(retriedBootstrap.checkpoint).not.toHaveProperty("catalogSafeError");
      expect(retriedBootstrap.checkpoint).not.toHaveProperty("catalogSummaryEmitted");
      expect(retriedBootstrap.checkpoint).not.toHaveProperty("retryExhausted");
      expect(
        await prisma.campaignJob.count({
          where: { campaignId: catalogOnly.id, operation: "research_source" },
        }),
      ).toBe(0);
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "pause",
        clientNonce: "catalog-only-pause-1",
      });
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "resume",
        clientNonce: "catalog-only-resume-1",
      });
      catalogSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogOnly.id,
        afterSequence: 0,
      });
      expect(catalogSnapshot.jobs).toHaveLength(1);
      expect(catalogSnapshot.jobs[0]?.id).toMatch(/^catalog-job-[a-f0-9]{64}$/);
      const oldVerifiedItem = await prisma.campaignItem.create({
        data: {
          campaignId: catalogOnly.id,
          kind: "source",
          url: "https://catalog.example.test/verified-history",
          title: "Previously verified catalog page",
          status: "verified",
          details: {
            catalog: {
              runId: catalogRunId,
              rootUrl: "https://catalog.example.test/research/page",
              purpose: "page",
              category: "article",
              provenance: "observed_link",
              depth: 1,
            },
          },
        },
      });
      const oldVerifiedJob = await prisma.campaignJob.create({
        data: {
          campaignId: catalogOnly.id,
          itemId: oldVerifiedItem.id,
          operation: "catalog_page",
          status: "succeeded",
          checkpoint: {
            catalogRunId,
            catalogRootUrl: "https://catalog.example.test/research/page",
            catalogPurpose: "page",
            catalogDepth: 1,
            catalogOutcome: "success",
          },
        },
      });
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "pause",
        clientNonce: "catalog-only-pause-2",
      });
      await updateCampaignConfig(prisma, actor, {
        campaignId: catalogOnly.id,
        expectedRevision: catalogSnapshot.campaign.revision + 1,
        config: { ...config, websiteUrl: "https://next-catalog.example.test/changed#new" },
      });
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "resume",
        clientNonce: "catalog-only-resume-2",
      });
      catalogSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogOnly.id,
        afterSequence: 0,
      });
      expect(catalogSnapshot.jobs.filter((job) => job.operation === "catalog_page")).toHaveLength(
        3,
      );
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: bootstrapJobId } }),
      ).toMatchObject({ status: "cancelled", leaseFence: 2, lastError: "website_changed" });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: oldVerifiedJob.id } }),
      ).toMatchObject({ status: "succeeded", leaseFence: 0 });
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: oldVerifiedItem.id } }),
      ).toMatchObject({ status: "verified" });
      expect(catalogSnapshot.items.map((item) => item.url).sort()).toEqual([
        "https://catalog.example.test/robots.txt",
        "https://catalog.example.test/verified-history",
        "https://next-catalog.example.test/robots.txt",
      ]);
      expect(catalogSnapshot.items.find((item) => item.id === catalogItem.id)?.status).toBe(
        "failed",
      );
      expect(catalogSnapshot.jobs.some((job) => job.operation === "research_source")).toBe(false);
      await controlCampaign(prisma, actor, {
        campaignId: catalogOnly.id,
        action: "pause",
        clientNonce: "catalog-only-pause-3",
      });
      const catalogSkip = await createCampaign(prisma, actor, {
        config: { ...config, websiteUrl: "https://skip-catalog.example.test/" },
        mode: "research",
        clientNonce: "catalog-skip-create",
      });
      await controlCampaign(prisma, actor, {
        campaignId: catalogSkip.id,
        action: "start",
        clientNonce: "catalog-skip-start",
      });
      const skipSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogSkip.id,
        afterSequence: 0,
      });
      const skipItem = skipSnapshot.items[0]!;
      const skipJob = skipSnapshot.jobs[0]!;
      const skipRunId = (skipItem.details.catalog as { runId: string }).runId;
      const childItem = await prisma.campaignItem.create({
        data: {
          campaignId: catalogSkip.id,
          kind: "source",
          url: "https://skip-catalog.example.test/home",
          title: "Catalog child page",
          status: "queued",
          details: {
            catalog: {
              runId: skipRunId,
              rootUrl: "https://skip-catalog.example.test/",
              purpose: "page",
              category: "homepage",
              provenance: "configured_website",
              depth: 1,
            },
          },
        },
      });
      const childJob = await prisma.campaignJob.create({
        data: {
          campaignId: catalogSkip.id,
          itemId: childItem.id,
          operation: "catalog_page",
          status: "queued",
          checkpoint: {
            catalogRunId: skipRunId,
            catalogRootUrl: "https://skip-catalog.example.test/",
            catalogPurpose: "page",
            catalogDepth: 1,
          },
        },
      });
      const skippedGuidance = await recoverCampaignItem(prisma, actor, {
        campaignId: catalogSkip.id,
        itemId: skipItem.id,
        action: "skip",
        clientNonce: "catalog-guidance-skip",
      });
      expect(skippedGuidance).toMatchObject({
        status: "failed",
        details: { recoveryReason: expect.stringContaining("catalog crawling is blocked") },
      });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: skipJob.id } }),
      ).toMatchObject({
        operation: "catalog_page",
        status: "cancelled",
        checkpoint: { catalogOutcome: "blocked", catalogSafeError: "guidance_skipped" },
      });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: childJob.id } }),
      ).toMatchObject({ status: "cancelled", lastError: "guidance_skipped" });
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: childItem.id } }),
      ).toMatchObject({ status: "failed" });
      expect(
        await prisma.campaignJob.count({
          where: { campaignId: catalogSkip.id, operation: "catalog_page", status: "queued" },
        }),
      ).toBe(0);
      const skippedSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: catalogSkip.id,
        afterSequence: 0,
      });
      expect(skippedSnapshot.activities.at(-1)?.summary).toContain("catalog crawling is blocked");
      await controlCampaign(prisma, actor, {
        campaignId: catalogSkip.id,
        action: "pause",
        clientNonce: "catalog-skip-pause",
      });

      const activeCatalog = await createCampaign(prisma, actor, {
        config: { ...config, websiteUrl: "https://active-old.example.test/" },
        mode: "research",
        clientNonce: "active-catalog-create",
      });
      await controlCampaign(prisma, actor, {
        campaignId: activeCatalog.id,
        action: "start",
        clientNonce: "active-catalog-start",
      });
      const activeSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: activeCatalog.id,
        afterSequence: 0,
      });
      const activeOldItem = activeSnapshot.items[0]!;
      const activeOldJob = activeSnapshot.jobs[0]!;
      await prisma.campaignItem.update({
        where: { id: activeOldItem.id },
        data: { status: "researching" },
      });
      await prisma.campaignJob.update({
        where: { id: activeOldJob.id },
        data: {
          status: "running",
          leaseOwner: "catalog-worker-under-test",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 3,
        },
      });
      const activeVerifiedItem = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "source",
          url: "https://active-old.example.test/history",
          title: "Verified old website page",
          status: "verified",
          details: {
            catalog: {
              runId: (activeOldItem.details.catalog as { runId: string }).runId,
              rootUrl: "https://active-old.example.test/",
              purpose: "page",
              category: "article",
              provenance: "observed_link",
              depth: 1,
            },
          },
        },
      });
      const activeVerifiedJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: activeVerifiedItem.id,
          operation: "catalog_page",
          status: "succeeded",
          checkpoint: {
            catalogRunId: (activeOldItem.details.catalog as { runId: string }).runId,
            catalogRootUrl: "https://active-old.example.test/",
            catalogPurpose: "page",
            catalogDepth: 1,
            catalogOutcome: "success",
          },
        },
      });
      const activeDiscoveryItem = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "source",
          url: "https://active-old.example.test/robots.txt",
          title: "Discovery search source",
          status: "researching",
          details: {
            discovery: {
              runId: (activeOldItem.details.catalog as { runId: string }).runId,
              rootUrl: "https://active-old.example.test/",
              purpose: "search",
              provider: "rss_search",
              query: "device overview",
              sourceItemIds: [],
              inspection: "pending",
              eligibility: "needs_review",
              disposition: "unreviewed",
            },
          },
        },
      });
      const activeDiscoveryJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: activeDiscoveryItem.id,
          operation: "discovery_search",
          status: "running",
          leaseOwner: "discovery-worker-under-test",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 7,
          checkpoint: {
            discoveryRunId: (activeOldItem.details.catalog as { runId: string }).runId,
            discoveryRootUrl: "https://active-old.example.test/",
            discoveryPurpose: "search",
            query: "device overview",
            sourceItemIds: [],
          },
        },
      });
      const oldObservedCandidate = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "opportunity",
          url: "https://active-old.example.test/observed-candidate",
          title: "Old website candidate",
          status: "needs_action",
          details: {
            discovery: {
              runId: (activeOldItem.details.catalog as { runId: string }).runId,
              rootUrl: "https://active-old.example.test/",
              purpose: "candidate",
              provider: "rss_search",
              query: "device overview",
              sourceItemIds: [activeDiscoveryItem.id],
              rank: 25,
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "unreviewed",
              platformHint: "discourse",
              rulesLinks: [{ url: "https://active-old.example.test/rules", label: "Rules" }],
            },
          },
        },
      });
      const oldObservedInspectJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: oldObservedCandidate.id,
          operation: "discovery_inspect",
          status: "succeeded",
          checkpoint: {
            discoveryRunId: (activeOldItem.details.catalog as { runId: string }).runId,
            discoveryRootUrl: "https://active-old.example.test/",
            discoveryPurpose: "inspect",
            candidateUrl: oldObservedCandidate.url,
          },
        },
      });
      const activeSelectedItem = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "opportunity",
          url: "https://active-old.example.test/selected-opportunity",
          title: "Selected discovery opportunity",
          status: "researching",
          details: {
            discovery: {
              runId: (activeOldItem.details.catalog as { runId: string }).runId,
              rootUrl: "https://active-old.example.test/",
              purpose: "candidate",
              provider: "rss_search",
              query: "device overview",
              sourceItemIds: [activeDiscoveryItem.id],
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "selected",
            },
          },
        },
      });
      const paidIntentCheckpoint = {
        aiState: "intent",
        aiReservationMicros: 777,
        aiReservedDay: "2026-11-02",
        discoveryRunId: (activeOldItem.details.catalog as { runId: string }).runId,
        discoveryRootUrl: "https://active-old.example.test/",
        selectedSourceItemIds: [activeDiscoveryItem.id],
      };
      const activeSelectedJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: activeSelectedItem.id,
          operation: "research_opportunity",
          status: "running",
          leaseOwner: "research-worker-under-test",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 3,
          checkpoint: paidIntentCheckpoint,
        },
      });
      const manualOpportunity = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "opportunity",
          url: "https://unrelated.example.test/opportunity",
          title: "Manual opportunity",
          status: "queued",
        },
      });
      const manualOpportunityJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: manualOpportunity.id,
          operation: "research_opportunity",
          status: "queued",
          checkpoint: { manualResearch: true },
        },
      });
      const readySelectedItem = await prisma.campaignItem.create({
        data: {
          campaignId: activeCatalog.id,
          kind: "opportunity",
          url: "https://active-old.example.test/ready-result",
          title: "Selected result with uncertain completion",
          status: "researching",
          details: {
            discovery: {
              runId: (activeOldItem.details.catalog as { runId: string }).runId,
              rootUrl: "https://active-old.example.test/",
              purpose: "candidate",
              provider: "rss_search",
              query: "device overview",
              sourceItemIds: [activeDiscoveryItem.id],
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "selected",
            },
          },
        },
      });
      const readySelectedJob = await prisma.campaignJob.create({
        data: {
          campaignId: activeCatalog.id,
          itemId: readySelectedItem.id,
          operation: "research_opportunity",
          status: "running",
          leaseOwner: "research-worker-under-test",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 2,
          checkpoint: {
            aiState: "ready",
            aiReservationMicros: 999,
            aiReservedDay: "2026-11-02",
            discoveryRunId: (activeOldItem.details.catalog as { runId: string }).runId,
            discoveryRootUrl: "https://active-old.example.test/",
            selectedSourceItemIds: [activeDiscoveryItem.id],
          },
        },
      });
      await updateCampaignConfig(prisma, actor, {
        campaignId: activeCatalog.id,
        expectedRevision: activeSnapshot.campaign.revision,
        config: { ...config, websiteUrl: "https://active-new.example.test/catalog" },
      });
      let activeChangedSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: activeCatalog.id,
        afterSequence: 0,
      });
      expect(activeChangedSnapshot.campaign.status).toBe("active");
      expect(
        activeChangedSnapshot.jobs.filter((job) => job.operation === "catalog_page"),
      ).toHaveLength(3);
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: activeOldJob.id } }),
      ).toMatchObject({
        status: "cancelled",
        leaseFence: 4,
        leaseOwner: null,
        lastError: "website_changed",
      });
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: activeOldItem.id } }),
      ).toMatchObject({ status: "failed" });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: activeDiscoveryJob.id } }),
      ).toMatchObject({ status: "cancelled", leaseFence: 8, leaseOwner: null });
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: activeDiscoveryItem.id } }),
      ).toMatchObject({ status: "failed" });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: activeSelectedJob.id } }),
      ).toMatchObject({
        status: "needs_action",
        leaseFence: 4,
        leaseOwner: null,
        lastError: "website_changed_uncertain_model_result",
        checkpoint: paidIntentCheckpoint,
      });
      const normalizedReadyJob = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: readySelectedJob.id },
      });
      expect(normalizedReadyJob).toMatchObject({
        status: "needs_action",
        leaseFence: 3,
        checkpoint: {
          aiState: "ambiguous",
          aiReservationMicros: 999,
          aiReservedDay: "2026-11-02",
        },
      });
      await expect(
        recoverCampaignItem(prisma, actor, {
          campaignId: activeCatalog.id,
          itemId: readySelectedItem.id,
          action: "retry",
          clientNonce: `ready-old-root-retry-${suffix}`,
        }),
      ).rejects.toBeInstanceOf(CampaignRuleError);
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: activeSelectedItem.id } }),
      ).toMatchObject({ status: "needs_action" });
      const dismissedOldCandidate = await prisma.campaignItem.findUniqueOrThrow({
        where: { id: oldObservedCandidate.id },
      });
      expect(dismissedOldCandidate).toMatchObject({ status: "failed" });
      expect(dismissedOldCandidate.details).toMatchObject({
        discovery: {
          disposition: "dismissed",
          inspection: "observed",
          rank: 25,
          platformHint: "discourse",
          rulesLinks: [{ label: "Rules" }],
        },
      });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: oldObservedInspectJob.id } }),
      ).toMatchObject({ status: "succeeded" });
      const dismissedCandidateUpdatedAt = dismissedOldCandidate.updatedAt.toISOString();
      await expect(
        reviewCampaignOpportunity(prisma, actor, {
          campaignId: activeCatalog.id,
          itemId: dismissedOldCandidate.id,
          expectedUpdatedAt: dismissedCandidateUpdatedAt,
          action: "select",
          clientNonce: `old-root-select-${suffix}`,
        }),
      ).rejects.toBeInstanceOf(CampaignRuleError);
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: manualOpportunityJob.id } }),
      ).toMatchObject({ status: "queued", leaseFence: 0, checkpoint: { manualResearch: true } });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: activeVerifiedJob.id } }),
      ).toMatchObject({ status: "succeeded", leaseFence: 0 });
      expect(
        await prisma.campaignItem.findUniqueOrThrow({ where: { id: activeVerifiedItem.id } }),
      ).toMatchObject({ status: "verified" });
      const activeNewJob = activeChangedSnapshot.jobs.find(
        (job) =>
          job.operation === "catalog_page" &&
          job.itemId !== activeOldItem.id &&
          job.itemId !== activeVerifiedItem.id,
      );
      expect(activeNewJob).toMatchObject({ operation: "catalog_page", status: "queued" });
      expect(
        activeChangedSnapshot.items.find((item) => item.id === activeNewJob?.itemId)?.url,
      ).toBe("https://active-new.example.test/robots.txt");
      expect(activeChangedSnapshot.jobs.some((job) => job.operation === "research_source")).toBe(
        false,
      );
      await updateCampaignConfig(prisma, actor, {
        campaignId: activeCatalog.id,
        expectedRevision: activeChangedSnapshot.campaign.revision,
        config: {
          ...config,
          websiteUrl: "https://active-new.example.test/catalog#fragment-only",
        },
      });
      activeChangedSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: activeCatalog.id,
        afterSequence: 0,
      });
      expect(
        activeChangedSnapshot.jobs.filter((job) => job.operation === "catalog_page"),
      ).toHaveLength(3);
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: activeNewJob!.id } }),
      ).toMatchObject({ status: "queued", leaseFence: 0 });
      await controlCampaign(prisma, actor, {
        campaignId: activeCatalog.id,
        action: "pause",
        clientNonce: "active-catalog-pause",
      });
      expect(campaign.status).toBe("draft");
      expect(campaign.revision).toBe(1);
      expect(
        await createCampaign(prisma, actor, { config, mode: "research", clientNonce: "create-1" }),
      ).toEqual(campaign);
      await expect(
        createCampaign(prisma, actor, {
          config: { ...config, name: "Different payload" },
          mode: "research",
          clientNonce: "create-1",
        }),
      ).rejects.toBeInstanceOf(CampaignCommandConflictError);

      const concurrentCreates = await Promise.all([
        createCampaign(prisma, actor, { config, mode: "research", clientNonce: "create-race" }),
        createCampaign(prisma, actor, { config, mode: "research", clientNonce: "create-race" }),
      ]);
      expect(concurrentCreates[0]?.id).toBe(concurrentCreates[1]?.id);
      const revisionRace = await Promise.allSettled([
        updateCampaignConfig(prisma, actor, {
          campaignId: concurrentCreates[0]!.id,
          expectedRevision: 1,
          config: { ...config, name: "Revision winner A" },
        }),
        updateCampaignConfig(prisma, actor, {
          campaignId: concurrentCreates[0]!.id,
          expectedRevision: 1,
          config: { ...config, name: "Revision winner B" },
        }),
      ]);
      expect(revisionRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(revisionRace.filter((result) => result.status === "rejected")).toHaveLength(1);

      const source = await addCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        kind: "source",
        url: "https://community.example.test/topic/1",
        title: "A useful discussion",
        clientNonce: "add-source-1",
      });
      expect(source.status).toBe("queued");
      expect(
        await addCampaignItem(prisma, actor, {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/topic/1",
          title: "A useful discussion",
          clientNonce: "add-source-1",
        }),
      ).toEqual(source);
      await expect(
        addCampaignItem(prisma, actor, {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/topic/2",
          title: "A different discussion",
          clientNonce: "add-source-1",
        }),
      ).rejects.toBeInstanceOf(CampaignCommandConflictError);
      await expect(
        addCampaignItem(prisma, otherActor, {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/topic/3",
          title: "Attempted cross-workspace add",
          clientNonce: "add-source-1",
        }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
      await expect(
        addCampaignItem(prisma, siblingActor, {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/topic/1",
          title: "A useful discussion",
          clientNonce: "add-source-1",
        }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);

      const controlledAccount = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "account",
          title: "Controlled test account",
          status: "verified",
          details: {
            label: "Controlled test",
            emailConfirmation: {
              status: "confirmed",
              evidence: "Synthetic confirmation fixture; no email was sent",
              token: "must-not-leak",
              rawProviderPayload: { email: "private@example.test", secret: "hidden" },
            },
            rawEmail: "private@example.test",
          },
        },
      });
      const malformedAccount = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "account",
          title: "Malformed confirmation record",
          status: "verified",
          details: {
            emailConfirmation: {
              status: ["confirmed"],
              evidence: "Synthetic confirmation fixture; no email was sent",
            },
          },
        },
      });
      const controlledPublication = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "publication",
          title: "Controlled test publication",
          body: "Fixture contribution",
          status: "verified",
          details: {
            label: "Controlled test",
            effect: "local_fixture_only",
            verification: {
              label: "Controlled test",
              method: "independent_fixture_read",
              verifiedAt: new Date().toISOString(),
              providerResponse: { token: "must-not-leak", body: "raw response" },
            },
            rawProviderPayload: { secret: "hidden" },
          },
        },
      });

      let snapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      const safeAccount = snapshot.items.find((item) => item.id === controlledAccount.id);
      expect(safeAccount?.details).toEqual({
        label: "Controlled test",
        emailConfirmation: { status: "confirmed", synthetic: true },
      });
      expect(snapshot.items.find((item) => item.id === malformedAccount.id)?.details).toEqual({});
      const safePublication = snapshot.items.find((item) => item.id === controlledPublication.id);
      expect(safePublication?.details).toMatchObject({
        label: "Controlled test",
        effect: "local_fixture_only",
        verification: {
          label: "Controlled test",
          method: "independent_fixture_read",
          verifiedAt: expect.any(String),
        },
      });
      expect(safePublication?.details).not.toHaveProperty("rawProviderPayload");
      expect(safePublication?.details.verification).not.toHaveProperty("providerResponse");
      expect(snapshot.activities.map((activity) => activity.sequence)).toEqual([1, 2]);
      expect(snapshot.nextCursor).toBe(2);
      await expect(
        updateCampaignConfig(prisma, actor, {
          campaignId: campaign.id,
          expectedRevision: 1,
          config: { ...config, name: "Stale update" },
        }),
      ).rejects.toBeInstanceOf(CampaignConflictError);
      const updated = await updateCampaignConfig(prisma, actor, {
        campaignId: campaign.id,
        expectedRevision: 2,
        config: { ...config, name: "Updated campaign" },
      });
      expect(updated.revision).toBe(3);

      await controlCampaign(prisma, actor, {
        campaignId: campaign.id,
        action: "start",
        clientNonce: "start-1",
      });
      snapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      expect(snapshot.jobs).toHaveLength(2);
      expect(snapshot.jobs.find((job) => job.operation === "research_source")).toMatchObject({
        operation: "research_source",
        status: "queued",
      });
      expect(snapshot.activities.map((activity) => activity.sequence)).toEqual([1, 2, 3, 4]);

      const activeOpportunity = await addCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        kind: "opportunity",
        url: "https://community.example.test/topic/2",
        title: "Another eligible discussion",
        clientNonce: "add-active-opportunity",
      });
      expect(activeOpportunity.status).toBe("researching");
      await prisma.campaignItem.updateMany({
        where: { campaignId: campaign.id },
        data: { status: "ready" },
      });

      const retryItem = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/recover-retry",
          title: "Retry source",
          status: "needs_action",
        },
      });
      const retryJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: retryItem.id,
          operation: "research_source",
          status: "needs_action",
          attemptCount: 3,
          startedAt: new Date(Date.now() - 60_000),
          deadlineAt: new Date(Date.now() + 60_000),
          leaseOwner: "stale-worker",
          leaseExpiresAt: new Date(Date.now() + 10_000),
          leaseFence: 4,
          checkpoint: { evidence: "preserved", retryExhausted: true },
        },
      });
      const retried = await recoverCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        itemId: retryItem.id,
        action: "retry",
        clientNonce: "retry-once",
      });
      expect(retried.status).toBe("queued");
      expect(
        await recoverCampaignItem(prisma, actor, {
          campaignId: campaign.id,
          itemId: retryItem.id,
          action: "retry",
          clientNonce: "retry-once",
        }),
      ).toEqual(retried);
      const resetJob = await prisma.campaignJob.findUniqueOrThrow({ where: { id: retryJob.id } });
      expect(resetJob).toMatchObject({
        status: "queued",
        attemptCount: 0,
        startedAt: null,
        deadlineAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: 5,
        checkpoint: { evidence: "preserved" },
      });
      await expect(
        recoverCampaignItem(prisma, siblingActor, {
          campaignId: campaign.id,
          itemId: retryItem.id,
          action: "retry",
          clientNonce: "retry-once",
        }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);

      const deferredItem = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "opportunity",
          url: "https://community.example.test/recover-defer",
          title: "Deferred opportunity",
          status: "researching",
        },
      });
      const deferredJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: deferredItem.id,
          operation: "research_opportunity",
          status: "running",
          attemptCount: 1,
          leaseOwner: "worker",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 2,
          checkpoint: { scrapeCheckpoint: "preserved" },
        },
      });
      const deferred = await recoverCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        itemId: deferredItem.id,
        action: "defer",
        clientNonce: "defer-once",
      });
      expect(deferred.status).toBe("deferred");
      const deferredRow = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: deferredJob.id },
      });
      expect(deferredRow.availableAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      expect(deferredRow).toMatchObject({
        status: "deferred",
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: 3,
        checkpoint: { scrapeCheckpoint: "preserved" },
      });

      const skippedItem = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/recover-skip",
          title: "Skipped source",
          status: "failed",
        },
      });
      const skippedJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: skippedItem.id,
          operation: "research_source",
          status: "failed",
        },
      });
      expect(
        await recoverCampaignItem(prisma, actor, {
          campaignId: campaign.id,
          itemId: skippedItem.id,
          action: "skip",
          clientNonce: "skip-once",
        }),
      ).toMatchObject({ status: "failed", details: { recoveryReason: "Skipped by user." } });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: skippedJob.id } }),
      ).toMatchObject({
        status: "cancelled",
        leaseFence: 1,
      });

      const ambiguousItem = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "source",
          url: "https://community.example.test/recover-ambiguous",
          title: "Ambiguous paid model result",
          status: "needs_action",
        },
      });
      await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: ambiguousItem.id,
          operation: "research_source",
          status: "needs_action",
          checkpoint: { aiState: "ambiguous", aiReservationMicros: "9000" },
        },
      });
      await expect(
        recoverCampaignItem(prisma, actor, {
          campaignId: campaign.id,
          itemId: ambiguousItem.id,
          action: "retry",
          clientNonce: "retry-ambiguous-paid",
        }),
      ).rejects.toThrow(/uncertain/);

      await controlCampaign(prisma, actor, {
        campaignId: campaign.id,
        action: "pause",
        clientNonce: "pause-1",
      });
      await controlCampaign(prisma, actor, {
        campaignId: campaign.id,
        action: "resume",
        clientNonce: "resume-1",
      });
      snapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      expect(snapshot.jobs).toHaveLength(7);
      await expect(
        getCampaignSnapshot(prisma, otherActor, { campaignId: campaign.id, afterSequence: 0 }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);

      const controlled = await createCampaign(prisma, actor, {
        config,
        mode: "controlled",
        clientNonce: "controlled-create",
      });
      const fixtureSource = await prisma.campaignItem.create({
        data: {
          campaignId: controlled.id,
          kind: "source",
          url: "https://fixture.invalid/source",
          title: "Controlled test source",
          status: "verified",
        },
      });
      const suppliedSource = await prisma.campaignItem.create({
        data: {
          campaignId: controlled.id,
          kind: "source",
          url: "https://fixture.invalid/supplied-source",
          title: "Supplied controlled source",
          status: "needs_action",
        },
      });
      const goodOpportunity = await prisma.campaignItem.create({
        data: {
          campaignId: controlled.id,
          kind: "opportunity",
          url: "https://fixture.invalid/good",
          title: "Controlled test opportunity",
          status: "needs_action",
        },
      });
      const transientOpportunity = await prisma.campaignItem.create({
        data: {
          campaignId: controlled.id,
          kind: "opportunity",
          url: "https://fixture.invalid/timeout",
          title: "Controlled test transient opportunity",
          body: "Fixture opportunity with a deliberate timeout.",
          status: "needs_action",
          details: {
            label: "Controlled test",
            simulatedFailure: "transient_timeout",
            outcome: "deferred_once_then_good_opportunity_selected",
          },
        },
      });
      const draft = await prisma.campaignItem.create({
        data: {
          campaignId: controlled.id,
          kind: "draft",
          title: "Reviewed fixture draft",
          body: "A local controlled fixture contribution.",
          status: "needs_action",
          details: { evidenceIds: ["evidence-1"], rationale: "Relevant to the discussion." },
        },
      });
      const reviewJob = await prisma.campaignJob.create({
        data: {
          campaignId: controlled.id,
          itemId: suppliedSource.id,
          operation: "controlled_fixture",
          status: "waiting_review",
          checkpoint: {
            fixtureStage: "waiting_review",
            fixtureSourceId: fixtureSource.id,
            goodOpportunityId: goodOpportunity.id,
            transientOpportunityId: transientOpportunity.id,
            draftId: draft.id,
          },
        },
      });
      await controlCampaign(prisma, actor, {
        campaignId: controlled.id,
        action: "pause",
        clientNonce: "controlled-pause-before-review",
      });
      const approved = await reviewCampaignDraft(prisma, actor, {
        campaignId: controlled.id,
        itemId: draft.id,
        decision: "approve",
        expectedUpdatedAt: draft.updatedAt.toISOString(),
      });
      expect(approved.status).toBe("approved");
      expect(approved.details).toMatchObject({
        reviewDecision: "approved",
        approvalVersion: expect.any(String),
      });
      const controlledSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: controlled.id,
        afterSequence: 0,
      });
      expect(controlledSnapshot.campaign.status).toBe("paused");
      expect(controlledSnapshot.jobs).toHaveLength(2);
      expect(
        controlledSnapshot.jobs.find((job) => job.operation === "controlled_fixture"),
      ).toMatchObject({
        id: reviewJob.id,
        status: "succeeded",
      });
      expect(
        controlledSnapshot.jobs.find((job) => job.operation === "controlled_publish"),
      ).toMatchObject({
        status: "queued",
      });
      const handedOffItems = await prisma.campaignItem.findMany({
        where: {
          campaignId: controlled.id,
          id: {
            in: [fixtureSource.id, suppliedSource.id, goodOpportunity.id, transientOpportunity.id],
          },
        },
        orderBy: [{ id: "asc" }],
      });
      expect(handedOffItems.find((item) => item.id === fixtureSource.id)?.status).toBe("verified");
      expect(handedOffItems.find((item) => item.id === suppliedSource.id)?.status).toBe("verified");
      expect(handedOffItems.find((item) => item.id === goodOpportunity.id)?.status).toBe(
        "verified",
      );
      const terminalTransient = handedOffItems.find((item) => item.id === transientOpportunity.id);
      expect(terminalTransient?.status).toBe("failed");
      expect(terminalTransient?.body).toContain("exhausted its one retry");
      expect(terminalTransient?.details).toMatchObject({
        deferReason: expect.stringContaining("no further retry"),
      });
      expect(controlledSnapshot.activities.at(-1)?.type).toBe("review_approved");
      await controlCampaign(prisma, actor, {
        campaignId: controlled.id,
        action: "resume",
        clientNonce: "controlled-resume-after-review",
      });
      const resumedSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: controlled.id,
        afterSequence: 0,
      });
      expect(resumedSnapshot.campaign.status).toBe("active");
      expect(
        resumedSnapshot.jobs.find((job) => job.operation === "controlled_publish")?.status,
      ).toBe("queued");
      const edited = await updateCampaignDraft(prisma, actor, {
        campaignId: controlled.id,
        itemId: draft.id,
        body: "A revised local fixture contribution.",
        expectedUpdatedAt: approved.updatedAt,
      });
      expect(edited.status).toBe("needs_action");
      expect(edited.details).not.toHaveProperty("approvalVersion");
      const editedSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: controlled.id,
        afterSequence: 0,
      });
      expect(
        editedSnapshot.jobs.find((job) => job.operation === "controlled_publish")?.status,
      ).toBe("cancelled");

      const stopTargets: string[] = [];
      for (const clientNonce of ["stop-target-a", "stop-target-b"]) {
        const target = await createCampaign(prisma, actor, {
          config,
          mode: "research",
          clientNonce,
        });
        await addCampaignItem(prisma, actor, {
          campaignId: target.id,
          kind: "source",
          url: "https://community.example.test/stop-target",
          title: "Stop target",
          clientNonce: `${clientNonce}-item`,
        });
        await controlCampaign(prisma, actor, {
          campaignId: target.id,
          action: "start",
          clientNonce: `${clientNonce}-start`,
        });
        stopTargets.push(target.id);
      }
      expect(await stopAllCampaigns(prisma, actor, "global-stop-1")).toEqual({ pausedCount: 4 });
      expect(await stopAllCampaigns(prisma, actor, "global-stop-1")).toEqual({ pausedCount: 4 });
      const stopped = await prisma.campaign.findMany({
        where: { id: { in: stopTargets }, workspaceId, userId },
        orderBy: { id: "asc" },
      });
      expect(stopped.map((row) => row.status)).toEqual(["paused", "paused"]);
    } finally {
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("persists discovery recovery, safe metadata, candidate review and tenant scope", async () => {
    const { prisma, pool } = createDb(testUrl!);
    const suffix = randomUUID();
    const workspaceId = `discovery-ws-${suffix}`;
    const userId = `discovery-user-${suffix}`;
    const actor: Actor = {
      workspaceId,
      userId,
      email: `${suffix}@example.test`,
      isDeploymentOwner: false,
    };
    const otherActor: Actor = {
      workspaceId: `other-${workspaceId}`,
      userId: `other-${userId}`,
      email: `other-${suffix}@example.test`,
      isDeploymentOwner: false,
    };

    try {
      await prisma.user.create({
        data: { id: userId, name: "Discovery Integration User", email: actor.email },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Discovery Integration Workspace",
          slug: suffix,
          createdAt: new Date(),
        },
      });
      const campaign = await createCampaign(prisma, actor, {
        config,
        mode: "research",
        clientNonce: "discovery-create",
      });
      await controlCampaign(prisma, actor, {
        campaignId: campaign.id,
        action: "start",
        clientNonce: "discovery-start",
      });
      await controlCampaign(prisma, actor, {
        campaignId: campaign.id,
        action: "pause",
        clientNonce: "discovery-pause",
      });
      const rootSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      const rootItem = rootSnapshot.items[0]!;
      const catalog = rootItem.details.catalog;
      const runId = (catalog as { runId: string }).runId;
      const rootUrl = "https://example.test/";
      const query = "wireless router guide";
      const sourceDiscovery = {
        runId,
        rootUrl,
        purpose: "search",
        provider: "rss_search",
        query,
        sourceItemIds: [rootItem.id],
        inspection: "unavailable",
        eligibility: "needs_review",
        disposition: "unreviewed",
        rawProviderPayload: { token: "never-expose" },
      };
      await prisma.campaignItem.update({
        where: { id: rootItem.id },
        data: {
          status: "needs_action",
          details: {
            catalog: {
              runId,
              rootUrl,
              purpose: "guidance",
              category: "guidance",
              provenance: "conventional_probe",
              depth: 0,
            },
            discovery: sourceDiscovery,
            projectContext: {
              rootUrl,
              runId,
              sourceIds: [rootItem.id],
              state: "supplied",
              privatePayload: { authorization: "must-not-leak" },
            },
            evidence: [
              {
                id: rootItem.id,
                url: "https://example.test/official-source",
                title: "Official source",
                excerpt: "Relevant project evidence.",
                fetchedAt: new Date().toISOString(),
                headers: { authorization: "must-not-leak" },
              },
            ],
          },
        },
      });
      const searchJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: rootItem.id,
          operation: "discovery_search",
          status: "needs_action",
          attemptCount: 3,
          checkpoint: {
            discoveryRunId: runId,
            discoveryRootUrl: rootUrl,
            discoveryPurpose: "search",
            query,
            sourceItemIds: [rootItem.id],
            discoveryOutcome: "unavailable",
            discoveryCandidateCount: 0,
            discoverySafeError: "search_failed",
            discoveryRetryExhausted: true,
            discoveryCompletedAt: new Date().toISOString(),
          },
        },
      });
      await expect(
        recoverCampaignItem(prisma, otherActor, {
          campaignId: campaign.id,
          itemId: rootItem.id,
          action: "retry",
          clientNonce: "foreign-discovery-retry",
        }),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
      const searchRetry = await recoverCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        itemId: rootItem.id,
        action: "retry",
        clientNonce: "discovery-search-retry",
      });
      expect(searchRetry).toMatchObject({
        status: "queued",
        details: {
          projectContext: { rootUrl, runId, sourceIds: [rootItem.id], state: "supplied" },
          evidence: [
            {
              id: rootItem.id,
              url: "https://example.test/official-source",
              title: "Official source",
              excerpt: "Relevant project evidence.",
            },
          ],
          discovery: {
            runId,
            rootUrl,
            purpose: "search",
            provider: "rss_search",
            inspection: "pending",
            disposition: "unreviewed",
          },
        },
      });
      expect(searchRetry.details.projectContext).not.toHaveProperty("privatePayload");
      expect((searchRetry.details.evidence as unknown[])[0]).not.toHaveProperty("headers");
      expect(searchRetry.details.discovery).not.toHaveProperty("rawProviderPayload");
      const malformedContextItem = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "source",
          url: "https://example.test/malformed-context",
          title: "Malformed project context",
          status: "queued",
          details: {
            projectContext: {
              rootUrl: "https://private:credentials@example.test/",
              runId,
              sourceIds: [rootItem.id],
              state: "supplied",
              token: "must-not-leak",
            },
          },
        },
      });
      const contextSnapshot = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      expect(
        contextSnapshot.items.find((item) => item.id === malformedContextItem.id)?.details,
      ).not.toHaveProperty("projectContext");
      const retriedSearchJob = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: searchJob.id },
      });
      expect(retriedSearchJob).toMatchObject({
        operation: "discovery_search",
        status: "queued",
        itemId: rootItem.id,
        attemptCount: 0,
        checkpoint: {
          discoveryRunId: runId,
          discoveryRootUrl: rootUrl,
          discoveryPurpose: "search",
          query,
          sourceItemIds: [rootItem.id],
        },
      });
      for (const key of [
        "discoveryOutcome",
        "discoveryCandidateCount",
        "discoverySafeError",
        "discoveryRetryExhausted",
        "discoveryCompletedAt",
      ]) {
        expect(retriedSearchJob.checkpoint).not.toHaveProperty(key);
      }
      expect(
        await prisma.campaignJob.count({
          where: { campaignId: campaign.id, itemId: rootItem.id, operation: "research_source" },
        }),
      ).toBe(0);

      const retryCandidate = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "opportunity",
          url: "https://example.test/retry-candidate",
          title: "Retry candidate",
          status: "failed",
          details: {
            discovery: {
              runId,
              rootUrl,
              purpose: "candidate",
              provider: "rss_search",
              query,
              sourceItemIds: [rootItem.id],
              rank: 15,
              observedAt: new Date().toISOString(),
              inspection: "unavailable",
              eligibility: "needs_review",
              disposition: "unreviewed",
              rulesLinks: [{ url: "https://example.test/rules", label: "Participation rules" }],
              platformHint: "discourse",
              rawProviderPayload: { secret: "never-expose" },
            },
          },
        },
      });
      const inspectRetryJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: retryCandidate.id,
          operation: "discovery_inspect",
          status: "failed",
          checkpoint: {
            discoveryRunId: runId,
            discoveryRootUrl: rootUrl,
            discoveryPurpose: "inspect",
            candidateUrl: retryCandidate.url,
            provider: "rss_search",
            query,
            sourceItemIds: [rootItem.id],
            rank: 15,
            discoveryOutcome: "unavailable",
            discoverySafeError: "inspection_failed",
            discoveryRetryExhausted: true,
          },
        },
      });
      const candidateRetry = await recoverCampaignItem(prisma, actor, {
        campaignId: campaign.id,
        itemId: retryCandidate.id,
        action: "retry",
        clientNonce: "discovery-inspect-retry",
      });
      expect(candidateRetry).toMatchObject({
        status: "queued",
        details: {
          discovery: {
            runId,
            purpose: "candidate",
            rank: 15,
            inspection: "pending",
            disposition: "unreviewed",
          },
        },
      });
      expect(candidateRetry.details.discovery).not.toHaveProperty("rawProviderPayload");
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: inspectRetryJob.id } }),
      ).toMatchObject({
        operation: "discovery_inspect",
        status: "queued",
        checkpoint: {
          discoveryRunId: runId,
          discoveryRootUrl: rootUrl,
          discoveryPurpose: "inspect",
          candidateUrl: retryCandidate.url,
          rank: 15,
        },
      });
      expect(
        await prisma.campaignJob.count({
          where: {
            campaignId: campaign.id,
            itemId: retryCandidate.id,
            operation: "research_opportunity",
          },
        }),
      ).toBe(0);

      const selectedCandidate = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "opportunity",
          url: "https://example.test/selected-candidate",
          title: "Observed opportunity",
          status: "needs_action",
          details: {
            discovery: {
              runId,
              rootUrl,
              purpose: "candidate",
              provider: "rss_search",
              query,
              sourceItemIds: [rootItem.id],
              rank: 25,
              observedAt: new Date().toISOString(),
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "unreviewed",
              rulesLinks: [{ url: "https://example.test/rules", label: "Rules" }],
              platformHint: "discourse",
              responsePayload: { secret: "never-expose" },
            },
          },
        },
      });
      const selectedInspectJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: selectedCandidate.id,
          operation: "discovery_inspect",
          status: "succeeded",
          checkpoint: {
            discoveryRunId: runId,
            discoveryRootUrl: rootUrl,
            discoveryPurpose: "inspect",
            candidateUrl: selectedCandidate.url,
            provider: "rss_search",
            query,
            sourceItemIds: [rootItem.id],
            rank: 25,
            discoveryOutcome: "observed",
          },
        },
      });
      await expect(
        reviewCampaignOpportunity(prisma, actor, {
          campaignId: campaign.id,
          itemId: selectedCandidate.id,
          expectedUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
          action: "select",
          clientNonce: "stale-discovery-select",
        }),
      ).rejects.toBeInstanceOf(CampaignConflictError);
      const selectInput = {
        campaignId: campaign.id,
        itemId: selectedCandidate.id,
        expectedUpdatedAt: selectedCandidate.updatedAt.toISOString(),
        action: "select" as const,
        clientNonce: "discovery-select-once",
      };
      const selected = await reviewCampaignOpportunity(prisma, actor, selectInput);
      expect(selected).toMatchObject({
        status: "queued",
        details: { discovery: { disposition: "selected", inspection: "observed", rank: 25 } },
      });
      expect(selected.details.discovery).not.toHaveProperty("responsePayload");
      expect(await reviewCampaignOpportunity(prisma, actor, selectInput)).toEqual(selected);
      await expect(
        reviewCampaignOpportunity(prisma, otherActor, selectInput),
      ).rejects.toBeInstanceOf(CampaignNotFoundError);
      await expect(
        reviewCampaignOpportunity(prisma, actor, {
          ...selectInput,
          expectedUpdatedAt: selected.updatedAt,
          clientNonce: "discovery-select-again",
        }),
      ).rejects.toBeInstanceOf(CampaignRuleError);
      expect(
        await prisma.campaignJob.count({
          where: {
            campaignId: campaign.id,
            itemId: selectedCandidate.id,
            operation: "research_opportunity",
          },
        }),
      ).toBe(1);
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: selectedInspectJob.id } }),
      ).toMatchObject({ status: "succeeded" });
      const pausedState = await getCampaignSnapshot(prisma, actor, {
        campaignId: campaign.id,
        afterSequence: 0,
      });
      expect(pausedState.campaign.status).toBe("paused");
      expect(
        pausedState.jobs.find(
          (job) => job.itemId === selectedCandidate.id && job.operation === "research_opportunity",
        )?.status,
      ).toBe("queued");

      const dismissedCandidate = await prisma.campaignItem.create({
        data: {
          campaignId: campaign.id,
          kind: "opportunity",
          url: "https://example.test/dismissed-candidate",
          title: "Pending candidate",
          status: "researching",
          details: {
            discovery: {
              runId,
              rootUrl,
              purpose: "candidate",
              provider: "rss_search",
              query,
              sourceItemIds: [rootItem.id],
              rank: 26,
              inspection: "pending",
              eligibility: "needs_review",
              disposition: "unreviewed",
            },
          },
        },
      });
      const dismissedInspectJob = await prisma.campaignJob.create({
        data: {
          campaignId: campaign.id,
          itemId: dismissedCandidate.id,
          operation: "discovery_inspect",
          status: "running",
          leaseOwner: "discovery-inspector",
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseFence: 4,
          checkpoint: {
            discoveryRunId: runId,
            discoveryRootUrl: rootUrl,
            discoveryPurpose: "inspect",
            candidateUrl: dismissedCandidate.url,
            provider: "rss_search",
            query,
            sourceItemIds: [rootItem.id],
            rank: 26,
          },
        },
      });
      const dismissed = await reviewCampaignOpportunity(prisma, actor, {
        campaignId: campaign.id,
        itemId: dismissedCandidate.id,
        expectedUpdatedAt: dismissedCandidate.updatedAt.toISOString(),
        action: "dismiss",
        clientNonce: "discovery-dismiss-once",
      });
      expect(dismissed).toMatchObject({
        status: "failed",
        details: { discovery: { disposition: "dismissed", inspection: "pending" } },
      });
      expect(
        await prisma.campaignJob.findUniqueOrThrow({ where: { id: dismissedInspectJob.id } }),
      ).toMatchObject({ status: "cancelled", leaseFence: 5, leaseOwner: null });
      expect(
        await prisma.campaignJob.count({
          where: {
            campaignId: campaign.id,
            itemId: dismissedCandidate.id,
            operation: "research_opportunity",
          },
        }),
      ).toBe(0);
      await expect(
        reviewCampaignOpportunity(prisma, actor, {
          campaignId: campaign.id,
          itemId: dismissedCandidate.id,
          expectedUpdatedAt: dismissed.updatedAt,
          action: "select",
          clientNonce: "discovery-reselect-dismissed",
        }),
      ).rejects.toBeInstanceOf(CampaignRuleError);
    } finally {
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
