import { randomUUID } from "node:crypto";
import { createDb, getCampaignSnapshot, type Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { CampaignCatalogError } from "./campaign-catalog.js";
import { CampaignOpportunityInspectionError } from "./campaign-discovery.js";
import { createCampaignWorker } from "./campaign-worker.js";

const databaseUrl = process.env.CAMPAIGN_PG_TEST_URL;
const describePostgres = databaseUrl ? describe.sequential : describe.skip;

describePostgres("campaign worker PostgreSQL progress and recovery", () => {
  it("defers a timed-out opportunity, completes the next one, and preserves both across restart", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const suffix = randomUUID();
    const userId = `campaign-worker-user-${suffix}`;
    const workspaceId = `campaign-worker-workspace-${suffix}`;
    const campaignId = `campaign-worker-${suffix}`;
    const timestamp = new Date();
    const config = {
      name: "Worker integration campaign",
      websiteUrl: "https://brand.example/",
      language: "en",
      market: "US",
      objective: "Create useful, reviewed research notes.",
      dailyRegistrationLimit: 0,
      dailyPublicationLimit: 0,
      dailySpendLimitMicros: 0,
      requirePublicationReview: true,
    };
    let clockMs = timestamp.getTime();
    const calls: string[] = [];

    try {
      await prisma.user.create({
        data: { id: userId, name: "Worker Integration User", email: `${suffix}@example.test` },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Worker Integration Workspace",
          slug: suffix,
          createdAt: timestamp,
        },
      });
      await prisma.campaign.create({
        data: {
          id: campaignId,
          workspaceId,
          userId,
          clientNonce: `worker-${suffix}`,
          config,
          status: "active",
          mode: "research",
        },
      });

      const transientItem = await prisma.campaignItem.create({
        data: {
          campaignId,
          kind: "opportunity",
          url: "https://timeout.example.test/discussion",
          title: "Transient opportunity",
          status: "queued",
        },
      });
      const goodItem = await prisma.campaignItem.create({
        data: {
          campaignId,
          kind: "opportunity",
          url: "https://good.example.test/discussion",
          title: "Good opportunity",
          status: "queued",
        },
      });
      const blockedItemData = Array.from({ length: 70 }, (_, index) => ({
        id: `${campaignId}-blocked-item-${index}`,
        campaignId,
        kind: "opportunity",
        url: `https://timeout.example.test/sibling-${index}`,
        title: `Same-site opportunity ${index}`,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      await prisma.campaignItem.createMany({ data: blockedItemData });
      const firstJob = await prisma.campaignJob.create({
        data: {
          availableAt: timestamp,
          createdAt: timestamp,
          campaignId,
          itemId: transientItem.id,
          operation: "research_opportunity",
          status: "queued",
          maxAttempts: 1,
        },
      });
      await prisma.campaignJob.createMany({
        data: blockedItemData.map((item, index) => ({
          id: `${campaignId}-blocked-job-${index}`,
          campaignId,
          itemId: item.id,
          operation: "research_opportunity",
          status: "queued",
          availableAt: timestamp,
          createdAt: new Date(timestamp.getTime() + index + 1),
          maxAttempts: 1,
        })),
      });
      const goodJob = await prisma.campaignJob.create({
        data: {
          availableAt: timestamp,
          createdAt: new Date(timestamp.getTime() + 100),
          campaignId,
          itemId: goodItem.id,
          operation: "research_opportunity",
          status: "queued",
        },
      });
      clockMs = timestamp.getTime() + 1_000;

      const researcher = async (
        url: string,
      ): Promise<
        | never
        | {
            title: string;
            text: string;
            url: string;
            contentType: "text/plain";
            fetchedAt: string;
          }
      > => {
        calls.push(url);
        if (url === transientItem.url) {
          // Model a provider that never returns; the worker's per-execution deadline must fence it.
          return new Promise(() => {});
        }
        return {
          title: "Useful discussion with cited facts",
          text: "The supplied public page states that participants can submit examples and discuss evidence.",
          url,
          contentType: "text/plain",
          fetchedAt: new Date(clockMs).toISOString(),
        };
      };

      const worker = createCampaignWorker({
        prisma,
        workerId: `integration-worker-${suffix}`,
        research: researcher,
        now: () => new Date(clockMs),
        maxPerTick: 3,
        executionTimeoutMs: 1_000,
      });
      await worker.tick();

      const [deferredJob, completedJob, completedDraft, eventCountAfterProgress] =
        await Promise.all([
          prisma.campaignJob.findUniqueOrThrow({ where: { id: firstJob.id } }),
          prisma.campaignJob.findUniqueOrThrow({ where: { id: goodJob.id } }),
          prisma.campaignItem.findUnique({ where: { id: `${goodJob.id}-draft` } }),
          prisma.campaignEvent.count({ where: { campaignId } }),
        ]);
      expect(deferredJob).toMatchObject({
        status: "deferred",
        attemptCount: 1,
        leaseOwner: null,
        checkpoint: { retryExhausted: true },
      });
      expect(completedJob).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        checkpoint: { result: "research_complete", draftId: `${goodJob.id}-draft` },
      });
      expect(completedDraft).toMatchObject({
        status: "needs_action",
        details: { reviewDecision: "awaiting_edit_and_human_approval" },
      });
      expect(calls).toEqual([
        "https://timeout.example.test/discussion",
        "https://good.example.test/discussion",
      ]);
      const parkedBeforeRestart = await prisma.campaignJob.findMany({
        where: { campaignId, itemId: { in: blockedItemData.map((item) => item.id) } },
      });
      expect(parkedBeforeRestart).toHaveLength(70);
      expect(
        parkedBeforeRestart.every((job) => job.status === "deferred" && job.attemptCount === 0),
      ).toBe(true);
      expect(
        parkedBeforeRestart.every(
          (job) => (job.checkpoint as { siteBlockedUntil?: string }).siteBlockedUntil,
        ),
      ).toBe(true);

      const lateSameSiteItem = await prisma.campaignItem.create({
        data: {
          campaignId,
          kind: "opportunity",
          url: "https://timeout.example.test/added-during-cooldown",
          title: "Same-site opportunity added during cooldown",
          status: "queued",
        },
      });
      const lateSameSiteJob = await prisma.campaignJob.create({
        data: {
          campaignId,
          itemId: lateSameSiteItem.id,
          operation: "research_opportunity",
          status: "queued",
          availableAt: timestamp,
          maxAttempts: 1,
        },
      });

      await worker.stop();
      const restarted = createCampaignWorker({
        prisma,
        workerId: `integration-restarted-worker-${suffix}`,
        research: researcher,
        now: () => new Date(clockMs),
        maxPerTick: 1,
        executionTimeoutMs: 1_000,
      });
      await restarted.tick();
      await restarted.stop();
      const lateSameSiteAfterRestart = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: lateSameSiteJob.id },
      });
      expect(lateSameSiteAfterRestart).toMatchObject({
        status: "deferred",
        attemptCount: 0,
        lastError: "site_cooldown",
      });
      expect(calls).toHaveLength(2);

      clockMs = Math.max(deferredJob.availableAt.getTime(), clockMs) + 1;
      const recovered = createCampaignWorker({
        prisma,
        workerId: `integration-recovered-worker-${suffix}`,
        research: researcher,
        now: () => new Date(clockMs),
        maxPerTick: 1,
        executionTimeoutMs: 1_000,
      });
      await recovered.tick();
      await recovered.stop();

      const [finalFirstJob, finalGoodJob, drafts, finalEvents, parkedAfterRestart] =
        await Promise.all([
          prisma.campaignJob.findUniqueOrThrow({ where: { id: firstJob.id } }),
          prisma.campaignJob.findUniqueOrThrow({ where: { id: goodJob.id } }),
          prisma.campaignItem.findMany({ where: { campaignId, kind: "draft" } }),
          prisma.campaignEvent.count({ where: { campaignId } }),
          prisma.campaignJob.findMany({
            where: { campaignId, itemId: { in: blockedItemData.map((item) => item.id) } },
            include: { item: true },
          }),
        ]);
      expect(finalFirstJob).toMatchObject({
        status: "needs_action",
        attemptCount: 1,
        checkpoint: { retryExhausted: true },
      });
      expect(finalGoodJob).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
        checkpoint: { result: "research_complete", draftId: `${goodJob.id}-draft` },
      });
      expect(drafts).toHaveLength(2);
      expect(finalEvents).toBeGreaterThan(eventCountAfterProgress);
      expect(parkedAfterRestart).toHaveLength(70);
      const progressedSibling = parkedAfterRestart.filter((job) => job.status === "succeeded");
      expect(progressedSibling).toHaveLength(1);
      expect(progressedSibling[0]).toMatchObject({
        attemptCount: 1,
        checkpoint: { result: "research_complete" },
      });
      expect(progressedSibling[0]?.item?.url).toMatch(
        /^https:\/\/timeout\.example\.test\/sibling-[0-9]+$/u,
      );
      const unresolvedSiblings = parkedAfterRestart.filter((job) => job.status !== "succeeded");
      expect(
        unresolvedSiblings.every((job) => job.status === "deferred" && job.attemptCount === 0),
      ).toBe(true);
      const expectedDraftIds = [`${goodJob.id}-draft`, `${progressedSibling[0]!.id}-draft`].sort();
      expect(drafts.map((draft) => draft.id).sort()).toEqual(expectedDraftIds);
      expect(calls).toHaveLength(3);
      expect(calls.filter((url) => url === transientItem.url)).toHaveLength(1);
      expect(new Set(calls).size).toBe(3);
      expect(calls[2]).toBe(progressedSibling[0]?.item?.url);
    } finally {
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("restarts catalog discovery with exact robots rules, stable deduplication, and a 12-page budget", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const suffix = randomUUID();
    const userId = `catalog-worker-user-${suffix}`;
    const workspaceId = `catalog-worker-workspace-${suffix}`;
    const campaignId = `catalog-worker-${suffix}`;
    const runId = "b".repeat(64);
    const rootUrl = "https://catalog.example.test/";
    const timestamp = new Date();
    const clockMs = timestamp.getTime() + 1_000;
    const calls: string[] = [];
    const modelProvider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: () => ({
        estimatedCostMicros: 10,
        estimatedInputTokens: 10,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      }),
      generate: vi.fn(),
    };
    const blockedUrl = "https://catalog.example.test/app/blocked";
    let blockedCalls = 0;
    const discoveredLinks = [
      ["/products/router", "Router product"],
      ["/app/dashboard", "App dashboard"],
      ["/app/blocked", "Restricted app page"],
      ["/devices/node", "Mesh device"],
      ["/articles/setup-guide", "Setup article"],
      ["/articles/networking", "Network article"],
      ["/about", "About the company"],
      ["/company", "Company profile"],
      ["/products/accessory", "Accessory product"],
      ["/articles/faq", "FAQ article"],
      ["/llms.txt", "LLM guidance"],
      ["https://external.example.test/shop", "External shop candidate"],
    ].map(([path, label]) => ({ url: new URL(path!, rootUrl).toString(), label: label! }));
    const page = (
      url: string,
      title: string,
      text: string,
      links: Array<{ url: string; label: string }> = [],
      contentType: "text/html" | "text/plain" | "application/xml" = "text/html",
    ) => ({
      url,
      title,
      text,
      contentType,
      fetchedAt: new Date(clockMs).toISOString(),
      links,
      httpStatus: 200,
    });
    const catalogResearch = async (
      url: string,
      options: { allowedOrigin: string; allowedUrl?: (url: string) => boolean },
    ) => {
      expect(options.allowedOrigin).toBe("https://catalog.example.test");
      if (url.endsWith("/robots.txt")) expect(options.allowedUrl).toBeUndefined();
      else expect(options.allowedUrl?.(url)).toBe(true);
      calls.push(url);
      if (url === "https://catalog.example.test/robots.txt") {
        return {
          ...page(url, "robots.txt", "User-agent: AutoSEO\nAllow: /\n", [], "text/plain"),
          robotsText: "User-agent: AutoSEO\nAllow: /\n",
        };
      }
      if (url === rootUrl) {
        return page(
          url,
          "Catalog Fixture Home",
          "Catalog fixture homepage for a mesh router service.",
          discoveredLinks,
        );
      }
      if (url === "https://catalog.example.test/llms.txt") {
        throw new CampaignCatalogError("unsupported", "page_absent");
      }
      if (url === "https://catalog.example.test/sitemap.xml") {
        return page(
          url,
          "Catalog sitemap",
          "Fixture sitemap listing product and article pages.",
          discoveredLinks.slice(0, 10),
          "application/xml",
        );
      }
      if (url === blockedUrl && blockedCalls++ === 0) {
        throw new CampaignCatalogError("unsupported", "page_forbidden");
      }
      if (discoveredLinks.some((link) => link.url === url)) {
        const label = discoveredLinks.find((link) => link.url === url)?.label ?? "Catalog page";
        return page(
          url,
          label,
          url === blockedUrl
            ? "Catalog fixture recovered after an explicit human retry."
            : `Catalog fixture facts for ${label.toLowerCase()}.`,
        );
      }
      throw new CampaignCatalogError("transient", "fixture_unavailable");
    };

    try {
      await prisma.user.create({
        data: { id: userId, name: "Catalog Worker User", email: `${suffix}@example.test` },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Catalog Worker Workspace",
          slug: suffix,
          createdAt: timestamp,
        },
      });
      await prisma.campaign.create({
        data: {
          id: campaignId,
          workspaceId,
          userId,
          clientNonce: `catalog-${suffix}`,
          config: {
            name: "Catalog Worker Campaign",
            websiteUrl: rootUrl,
            language: "en",
            market: "US",
            objective: "Create a factual public website catalog.",
            dailyRegistrationLimit: 0,
            dailyPublicationLimit: 0,
            dailySpendLimitMicros: 1_000,
            requirePublicationReview: true,
          },
          status: "active",
          mode: "research",
        },
      });
      const itemId = `catalog-source-${runId}`;
      const jobId = `catalog-job-${runId}`;
      await prisma.campaignItem.create({
        data: {
          id: itemId,
          campaignId,
          kind: "source",
          url: "https://catalog.example.test/robots.txt",
          title: "Website crawl guidance",
          status: "researching",
          details: {
            catalog: {
              runId,
              rootUrl,
              purpose: "guidance",
              category: "guidance",
              provenance: "conventional_probe",
              depth: 0,
            },
          },
        },
      });
      await prisma.campaignJob.create({
        data: {
          id: jobId,
          campaignId,
          itemId,
          operation: "catalog_page",
          status: "queued",
          availableAt: timestamp,
          createdAt: timestamp,
          checkpoint: {
            catalogRunId: runId,
            catalogRootUrl: rootUrl,
            catalogPurpose: "guidance",
            catalogDepth: 0,
          },
        },
      });

      const workerOptions = {
        prisma,
        now: () => new Date(clockMs),
        catalogResearch,
        discovery: { enabled: false },
        aiDrafting: {
          enabled: true,
          ownerUserId: userId,
          maxReservationMicros: 100,
          provider: modelProvider,
        },
        maxPerTick: 3,
      };
      const firstWorker = createCampaignWorker({
        ...workerOptions,
        workerId: `catalog-first-${suffix}`,
        maxPerTick: 1,
      });
      await firstWorker.tick();
      await firstWorker.stop();
      const guidanceJob = await prisma.campaignJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(guidanceJob).toMatchObject({
        status: "succeeded",
        checkpoint: {
          catalogRules: { allow: ["/"], disallow: [], sitemaps: [] },
        },
      });

      const restartedWorker = createCampaignWorker({
        ...workerOptions,
        workerId: `catalog-restarted-${suffix}`,
      });
      for (let tick = 0; tick < 10; tick += 1) await restartedWorker.tick();
      await restartedWorker.stop();
      const settledGuidanceJob = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(settledGuidanceJob.checkpoint).toMatchObject({
        discoveryBootstrapOutcome: "disabled",
        discoveryBootstrapEventEmitted: true,
      });

      const runJobs = await prisma.campaignJob.findMany({
        where: { campaignId, operation: "catalog_page" },
        include: { item: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(runJobs).toHaveLength(12);
      expect(new Set(runJobs.map((job) => job.item?.url)).size).toBe(12);
      expect(
        runJobs.every((job) => ["succeeded", "failed", "needs_action"].includes(job.status)),
      ).toBe(true);
      expect(
        runJobs.some(
          (job) => (job.checkpoint as { catalogBudgetExhausted?: boolean }).catalogBudgetExhausted,
        ),
      ).toBe(true);
      expect(runJobs.find((job) => job.item?.url === blockedUrl)).toMatchObject({
        status: "failed",
        checkpoint: { catalogOutcome: "failed", catalogSafeError: "page_forbidden" },
      });
      expect(runJobs.some((job) => job.item?.url === "https://external.example.test/shop")).toBe(
        false,
      );
      const homepage = runJobs.find((job) => job.item?.url === rootUrl)?.item;
      expect(homepage).toMatchObject({
        status: "verified",
        title: "Catalog Fixture Home",
        details: {
          catalog: {
            purpose: "page",
            category: "homepage",
            provenance: "configured_website",
            depth: 1,
          },
        },
      });
      const homepageObservedLinks =
        (
          homepage?.details as
            | { observedLinks?: Array<{ url: string; status: string }> }
            | undefined
        )?.observedLinks ?? [];
      expect(homepageObservedLinks).toContainEqual({
        url: "https://external.example.test/shop",
        label: "External shop candidate",
        category: "shop",
        status: "candidate",
      });
      expect(calls.every((url) => new URL(url).origin === "https://catalog.example.test")).toBe(
        true,
      );
      expect(calls).toContain(blockedUrl);
      expect(blockedCalls).toBe(1);
      expect(modelProvider.generate).not.toHaveBeenCalled();
      const summaryEvents = await prisma.campaignEvent.count({
        where: { campaignId, summary: { startsWith: "Website catalog batch settled:" } },
      });
      expect(summaryEvents).toBe(1);
      expect(
        await prisma.campaignEvent.count({
          where: {
            campaignId,
            summary:
              "Community discovery is disabled by worker configuration; no search queries were submitted.",
          },
        }),
      ).toBe(1);
      const catalogSnapshot = await getCampaignSnapshot(
        prisma,
        { userId, workspaceId, email: `${suffix}@example.test`, isDeploymentOwner: false },
        { campaignId, afterSequence: 0 },
      );
      expect(
        catalogSnapshot.activities.some(
          (activity) =>
            activity.summary ===
            "Community discovery is disabled by worker configuration; no search queries were submitted.",
        ),
      ).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(12);
    } finally {
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("seeds three evidence-grounded searches and caps distinct inspected candidates at ten across restart", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const suffix = randomUUID();
    const userId = `discovery-worker-user-${suffix}`;
    const workspaceId = `discovery-worker-workspace-${suffix}`;
    const campaignId = `discovery-worker-${suffix}`;
    const timestamp = new Date();
    const clockMs = timestamp.getTime() + 2_000;
    const rootUrl = "https://discovery.example.test/";
    const runId = "c".repeat(64);
    const catalogCalls: string[] = [];
    const searchCalls: string[] = [];
    const inspectionCalls: string[] = [];
    const queryOrdinal = new Map<string, number>();
    let blockedCandidateCount = 0;
    let homepageFailures = 0;
    const sourceLinks = [
      { url: "https://discovery.example.test/products/router", label: "Acme Mesh Router Product" },
      { url: "https://discovery.example.test/products/camera", label: "Acme Mesh Camera" },
      { url: "https://discovery.example.test/guides/wifi", label: "Acme WiFi Setup Guide" },
    ];
    const page = (
      url: string,
      title: string,
      text: string,
      links: Array<{ url: string; label: string }> = [],
      contentType: "text/html" | "text/plain" | "application/xml" = "text/html",
    ) => ({
      url,
      title,
      text,
      contentType,
      fetchedAt: new Date(clockMs).toISOString(),
      links,
      httpStatus: 200,
    });
    const catalogResearch = async (
      url: string,
      request: { allowedOrigin: string; allowedUrl?: (candidate: string) => boolean },
    ) => {
      expect(request.allowedOrigin).toBe("https://discovery.example.test");
      catalogCalls.push(url);
      if (url.endsWith("/robots.txt")) {
        const robotsText = "User-agent: AutoSEO\nAllow: /\n";
        return { ...page(url, "robots.txt", robotsText, [], "text/plain"), robotsText };
      }
      expect(request.allowedUrl?.(url)).toBe(true);
      if (url === "https://discovery.example.test/llms.txt" || url.endsWith("/sitemap.xml")) {
        throw new CampaignCatalogError("unsupported", "page_absent");
      }
      if (url === rootUrl) {
        if (homepageFailures++ === 0) {
          throw new CampaignCatalogError("unsupported", "page_forbidden");
        }
        return page(
          url,
          "Acme Home Router Service",
          "Acme home router service with mesh product information.",
          sourceLinks,
        );
      }
      const link = sourceLinks.find((entry) => entry.url === url);
      if (link) return page(url, link.label, `Verified source page facts for ${link.label}.`);
      throw new CampaignCatalogError("unsupported", "fixture_unavailable");
    };
    const searchProvider = {
      async search(request: { query: string; limit: number }) {
        searchCalls.push(request.query);
        let ordinal = queryOrdinal.get(request.query);
        if (ordinal === undefined) {
          ordinal = queryOrdinal.size;
          queryOrdinal.set(request.query, ordinal);
        }
        return {
          query: request.query,
          provider: "fixture-search",
          observedAt: new Date(clockMs).toISOString(),
          results: Array.from({ length: Math.min(4, request.limit) }, (_, index) => {
            const number = ordinal! * 4 + index;
            return {
              url: `https://community.discovery.example.test/topics/candidate-${number}`,
              title: `Community candidate ${number}`,
              snippet: `Observed search snippet for candidate ${number}.`,
              rank: index + 1,
            };
          }),
        };
      },
    };
    const inspectOpportunity = async (input: { url: string; now?: () => Date }) => {
      inspectionCalls.push(input.url);
      if (blockedCandidateCount++ === 0) {
        throw new CampaignOpportunityInspectionError("unavailable", "robots_disallowed");
      }
      return {
        url: input.url,
        title: `Inspected ${new URL(input.url).pathname.split("/").at(-1)}`,
        excerpt: "Fixture evidence was read from one public candidate page.",
        observedAt: new Date(clockMs).toISOString(),
        rulesLinks: [
          { url: `${new URL(input.url).origin}/guidelines`, label: "Community guidelines" },
        ],
        platformHint: "unknown" as const,
        eligibility: "needs_review" as const,
        evidenceKind: "observed_page" as const,
      };
    };
    const modelProvider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: () => ({
        estimatedCostMicros: 10,
        estimatedInputTokens: 10,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      }),
      generate: vi.fn(),
    };

    try {
      await prisma.user.create({
        data: { id: userId, name: "Discovery Worker User", email: `${suffix}@example.test` },
      });
      await prisma.organization.create({
        data: {
          id: workspaceId,
          name: "Discovery Worker Workspace",
          slug: suffix,
          createdAt: timestamp,
        },
      });
      await prisma.campaign.create({
        data: {
          id: campaignId,
          workspaceId,
          userId,
          clientNonce: `discovery-${suffix}`,
          config: {
            name: "Discovery Worker Campaign",
            websiteUrl: rootUrl,
            language: "en",
            market: "US",
            objective: "Find reviewed community evidence from official page facts.",
            dailyRegistrationLimit: 0,
            dailyPublicationLimit: 0,
            dailySpendLimitMicros: 1_000,
            requirePublicationReview: true,
          },
          status: "active",
          mode: "research",
        },
      });
      const guidanceItemId = `discovery-guidance-${runId}`;
      const guidanceJobId = `discovery-guidance-job-${runId}`;
      await prisma.campaignItem.create({
        data: {
          id: guidanceItemId,
          campaignId,
          kind: "source",
          url: "https://discovery.example.test/robots.txt",
          title: "Website crawl guidance",
          status: "researching",
          details: {
            catalog: {
              runId,
              rootUrl,
              purpose: "guidance",
              category: "guidance",
              provenance: "conventional_probe",
              depth: 0,
            },
          },
        },
      });
      await prisma.campaignJob.create({
        data: {
          id: guidanceJobId,
          campaignId,
          itemId: guidanceItemId,
          operation: "catalog_page",
          status: "queued",
          availableAt: timestamp,
          createdAt: timestamp,
          checkpoint: {
            catalogRunId: runId,
            catalogRootUrl: rootUrl,
            catalogPurpose: "guidance",
            catalogDepth: 0,
          },
        },
      });
      const workerOptions = {
        prisma,
        now: () => new Date(clockMs),
        catalogResearch,
        discovery: {
          enabled: true,
          searchProviderId: "fixture-search",
          searchProvider,
          inspectOpportunity,
        },
        aiDrafting: {
          enabled: true,
          ownerUserId: userId,
          maxReservationMicros: 100,
          provider: modelProvider,
        },
        maxPerTick: 3,
        executionTimeoutMs: 1_000,
      };
      const firstWorker = createCampaignWorker({
        ...workerOptions,
        workerId: `discovery-first-${suffix}`,
        maxPerTick: 1,
      });
      await firstWorker.tick();
      await firstWorker.stop();
      expect(
        await prisma.campaignJob.count({ where: { campaignId, operation: "discovery_search" } }),
      ).toBe(0);

      const seedingWorker = createCampaignWorker({
        ...workerOptions,
        workerId: `discovery-seeding-${suffix}`,
        maxPerTick: 1,
      });
      let catalogPending = 1;
      for (let tick = 0; tick < 20 && catalogPending > 0; tick += 1) {
        await seedingWorker.tick();
        catalogPending = await prisma.campaignJob.count({
          where: {
            campaignId,
            operation: "catalog_page",
            status: { in: ["queued", "running", "deferred"] },
          },
        });
      }
      await seedingWorker.stop();
      expect(catalogPending).toBe(0);
      expect(
        await prisma.campaignJob.count({ where: { campaignId, operation: "discovery_search" } }),
      ).toBe(0);
      const guidanceJob = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: guidanceJobId },
      });
      expect(guidanceJob.checkpoint).toMatchObject({
        discoveryBootstrapOutcome: "no_eligible_evidence",
        discoveryBootstrapEventEmitted: true,
      });
      expect(
        await prisma.campaignEvent.count({
          where: {
            campaignId,
            summary:
              "No verified official-site content pages were available to derive community searches.",
          },
        }),
      ).toBe(1);

      const failedHomeItem = await prisma.campaignItem.findFirstOrThrow({
        where: { campaignId, url: rootUrl },
      });
      const failedHomeJob = await prisma.campaignJob.findFirstOrThrow({
        where: { campaignId, operation: "catalog_page", itemId: failedHomeItem.id },
      });
      const retryCheckpoint = { ...(failedHomeJob.checkpoint as Record<string, unknown>) };
      delete retryCheckpoint.catalogOutcome;
      delete retryCheckpoint.catalogSafeError;
      delete retryCheckpoint.catalogSummaryEmitted;
      await prisma.campaignItem.update({
        where: { id: failedHomeItem.id },
        data: { status: "queued" },
      });
      await prisma.campaignJob.update({
        where: { id: failedHomeJob.id },
        data: {
          status: "queued",
          attemptCount: 0,
          availableAt: new Date(clockMs),
          startedAt: null,
          heartbeatAt: null,
          deadlineAt: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          lastError: null,
          checkpoint: retryCheckpoint as Prisma.InputJsonObject,
        },
      });
      const recoveryWorker = createCampaignWorker({
        ...workerOptions,
        workerId: `discovery-recovery-${suffix}`,
        maxPerTick: 1,
      });
      let searchJobCount = 0;
      for (let tick = 0; tick < 20 && searchJobCount < 3; tick += 1) {
        await recoveryWorker.tick();
        searchJobCount = await prisma.campaignJob.count({
          where: { campaignId, operation: "discovery_search" },
        });
      }
      await recoveryWorker.stop();
      expect(searchJobCount).toBe(3);
      expect(
        await prisma.campaignEvent.count({
          where: {
            campaignId,
            summary:
              "No verified official-site content pages were available to derive community searches.",
          },
        }),
      ).toBe(1);
      const seededGuidanceJob = await prisma.campaignJob.findUniqueOrThrow({
        where: { id: guidanceJobId },
      });
      expect(seededGuidanceJob.checkpoint).toMatchObject({
        discoverySeeded: true,
        discoveryQueryCount: 3,
      });

      const restarted = createCampaignWorker({
        ...workerOptions,
        workerId: `discovery-restarted-${suffix}`,
      });
      for (let tick = 0; tick < 20; tick += 1) await restarted.tick();
      await restarted.stop();

      const [searchJobs, inspectJobs, candidateItems, allSourceItems] = await Promise.all([
        prisma.campaignJob.findMany({
          where: { campaignId, operation: "discovery_search" },
          include: { item: true },
        }),
        prisma.campaignJob.findMany({
          where: { campaignId, operation: "discovery_inspect" },
          include: { item: true },
        }),
        prisma.campaignItem.findMany({ where: { campaignId, kind: "opportunity" } }),
        prisma.campaignItem.findMany({
          where: { campaignId, kind: "source", id: { not: guidanceItemId } },
        }),
      ]);
      expect(searchJobs).toHaveLength(3);
      expect(searchJobs.every((job) => job.status === "succeeded")).toBe(true);
      expect(
        searchJobs.every(
          (job) =>
            (job.checkpoint as { discoveryOutcome?: string }).discoveryOutcome === "complete",
        ),
      ).toBe(true);
      expect(
        new Set(searchJobs.map((job) => (job.checkpoint as { query: string }).query)).size,
      ).toBe(3);
      expect(searchCalls).toHaveLength(3);
      expect(inspectJobs).toHaveLength(10);
      expect(
        new Set(inspectJobs.map((job) => (job.checkpoint as { candidateUrl: string }).candidateUrl))
          .size,
      ).toBe(10);
      expect(inspectionCalls).toHaveLength(10);
      expect(candidateItems).toHaveLength(10);
      expect(candidateItems.filter((item) => item.status === "needs_action")).toHaveLength(10);
      expect(
        candidateItems.every((item) => {
          const discovery = (item.details as { discovery?: Record<string, unknown> }).discovery;
          return (
            discovery?.purpose === "candidate" &&
            discovery.provider === "fixture-search" &&
            discovery.eligibility === "needs_review" &&
            discovery.disposition === "unreviewed"
          );
        }),
      ).toBe(true);
      const sourceItems = allSourceItems.filter(
        (item) =>
          (item.details as { discovery?: { purpose?: string } }).discovery?.purpose === "search",
      );
      expect(sourceItems).toHaveLength(3);
      expect(inspectJobs.filter((job) => job.status === "needs_action")).toHaveLength(1);
      expect(
        inspectJobs.filter(
          (job) =>
            (job.checkpoint as { discoveryOutcome?: string }).discoveryOutcome === "observed",
        ),
      ).toHaveLength(9);
      expect(
        candidateItems
          .filter(
            (item) =>
              (item.details as { discovery?: { inspection?: string } }).discovery?.inspection ===
              "observed",
          )
          .every(
            (item) =>
              (
                (item.details as { discovery?: { rulesLinks?: unknown[] } }).discovery
                  ?.rulesLinks ?? []
              ).length === 1,
          ),
      ).toBe(true);
      expect(
        candidateItems.filter(
          (item) =>
            (item.details as { discovery?: { inspection?: string } }).discovery?.inspection ===
            "unavailable",
        ),
      ).toHaveLength(1);
      expect(modelProvider.generate).not.toHaveBeenCalled();
      expect(await prisma.campaignItem.count({ where: { campaignId, kind: "draft" } })).toBe(0);
      expect(
        catalogCalls.every((url) => new URL(url).origin === "https://discovery.example.test"),
      ).toBe(true);
      const discoverySnapshot = await getCampaignSnapshot(
        prisma,
        { userId, workspaceId, email: `${suffix}@example.test`, isDeploymentOwner: false },
        { campaignId, afterSequence: 0 },
      );
      expect(
        discoverySnapshot.activities.some(
          (activity) =>
            activity.type === "item_added" &&
            activity.summary.startsWith("Community discovery queued 3 search queries"),
        ),
      ).toBe(true);
    } finally {
      await prisma.campaign.deleteMany({ where: { id: campaignId } });
      await prisma.organization.deleteMany({ where: { id: workspaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
