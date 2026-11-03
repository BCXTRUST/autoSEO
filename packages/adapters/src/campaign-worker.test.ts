import { describe, expect, it, vi } from "vitest";
import { CampaignCatalogError } from "./campaign-catalog.js";
import { CampaignResearchError } from "./campaign-research.js";
import { createCampaignWorker } from "./campaign-worker.js";

function fixtureDb(mode = "research", maxAttempts = 1) {
  let nowMs = Date.now();
  const campaign: any = {
    id: "campaign-1",
    userId: "owner-1",
    status: "active",
    mode,
    config: {
      objective: "Discuss useful evidence",
      websiteUrl: "https://brand.example/",
      language: "en",
      market: "United States",
      dailySpendLimitMicros: 1_000,
    },
    eventSequence: 0,
  };
  const item: any = {
    id: "item-1",
    campaignId: campaign.id,
    kind: "opportunity",
    url: "https://example.org/community",
    title: "Supplied opportunity",
    body: "",
    status: "queued",
    details: {},
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  };
  const job: any = {
    id: "job-1",
    campaignId: campaign.id,
    itemId: item.id,
    operation: mode === "controlled" ? "controlled_fixture" : "research_opportunity",
    status: "queued",
    attemptCount: 0,
    maxAttempts,
    availableAt: new Date(nowMs),
    startedAt: null,
    deadlineAt: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    leaseFence: 0,
    checkpoint: {},
    createdAt: new Date(nowMs),
    item,
    campaign,
  };
  const items = new Map([[item.id, item]]);
  const projectCatalogRows: any[] = [];
  const events: any[] = [];
  let dailySpent = 0n;
  let failedPersistOperation: "update" | "upsert" | null = null;
  const rowCopy = () => ({
    ...job,
    item: job.itemId ? (items.get(job.itemId) ?? null) : null,
    campaign,
  });
  const matches = (value: any, where: any) => {
    for (const [key, expected] of Object.entries(where ?? {})) {
      if (key === "AND") {
        if (!(expected as any[]).every((clause) => matches(value, clause))) return false;
        continue;
      }
      if (key === "OR") {
        if (!(expected as any[]).some((clause) => matches(value, clause))) return false;
        continue;
      }
      if (["campaign", "item"].includes(key)) {
        if (!matches(value[key], expected)) return false;
        continue;
      }
      if (expected && typeof expected === "object" && !(expected instanceof Date)) {
        if (
          "lte" in expected &&
          !(
            value[key] &&
            new Date(value[key]).getTime() <= new Date((expected as any).lte).getTime()
          )
        )
          return false;
        if ("in" in expected && !(expected as any).in.includes(value[key])) return false;
        if ("not" in expected && value[key] === (expected as any).not) return false;
      } else if (value[key] !== expected) return false;
    }
    return true;
  };
  const apply = (target: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value)
        target[key] += (value as any).increment;
      else target[key] = value;
    }
  };
  const db: any = {
    $transaction: (operation: (tx: any) => unknown) => operation(db),
    $queryRaw: async (query: any, ...values: any[]) => {
      const sql = Array.isArray(query) ? query.join("?") : String(query?.sql ?? "");
      const queryValues = Array.isArray(query) ? values : (query?.values ?? []);
      if (sql.includes("catalog_page")) return projectCatalogRows;
      if (sql.includes("campaign_items")) {
        const approved = items.get(queryValues[0]);
        return approved?.status === "approved" &&
          approved.updatedAt.getTime() === new Date(queryValues[1]).getTime() &&
          approved.details.approvalVersion === queryValues[2] &&
          approved.details.approvedUpdatedAt === queryValues[3]
          ? [{ id: approved.id }]
          : [];
      }
      if (sql.includes("campaign_challenge_tasks")) return [{ spent: dailySpent }];
      return campaign.status === "active" ? [{ id: campaign.id }] : [];
    },
    campaign: {
      findUnique: async ({ select }: any) =>
        select?.userId || select?.config ? campaign : { status: campaign.status },
      findFirst: async ({ where }: any) =>
        campaign.status === where.status ? { id: campaign.id } : null,
      update: async ({ data }: any) => {
        campaign.eventSequence = (campaign.eventSequence ?? 0) + data.eventSequence.increment;
        return campaign;
      },
    },
    campaignJob: {
      findMany: async ({ where }: any) => (matches(job, where) ? [rowCopy()] : []),
      findUnique: async ({ select }: any) => {
        if (select?.leaseFence)
          return {
            leaseFence: job.leaseFence,
            leaseOwner: job.leaseOwner,
            status: job.status,
            checkpoint: job.checkpoint,
            attemptCount: job.attemptCount,
            maxAttempts: job.maxAttempts,
            startedAt: job.startedAt,
          };
        return select?.checkpoint ? { checkpoint: job.checkpoint } : rowCopy();
      },
      findFirst: async ({ where }: any) => (matches(job, where) ? { id: job.id } : null),
      updateMany: async ({ where, data }: any) => {
        if (!matches(job, where)) return { count: 0 };
        apply(job, data);
        return { count: 1 };
      },
    },
    campaignItem: {
      findMany: async ({ where }: any) =>
        [...items.values()].filter((entry) => where.id.in.includes(entry.id)),
      findUnique: async ({ where }: any) => items.get(where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const target = items.get(where.id);
        if (!target || !matches(target, where)) return { count: 0 };
        apply(target, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        if (failedPersistOperation === "update") {
          failedPersistOperation = null;
          throw new Error("simulated draft persistence failure");
        }
        const target = items.get(where.id);
        apply(target, data);
        return target;
      },
      upsert: async ({ where, create, update }: any) => {
        if (failedPersistOperation === "upsert" && create.kind === "draft") {
          failedPersistOperation = null;
          throw new Error("simulated draft persistence failure");
        }
        const existing = items.get(where.id);
        if (existing) apply(existing, update);
        else
          items.set(where.id, {
            createdAt: new Date(nowMs),
            updatedAt: new Date(nowMs),
            ...create,
          });
        return items.get(where.id);
      },
    },
    campaignEvent: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
  };
  return {
    db,
    campaign,
    job,
    item,
    items,
    events,
    setDailySpent(value: bigint) {
      dailySpent = value;
    },
    failResearchCompletionOnce(operation = "update" as const) {
      failedPersistOperation = operation;
    },
    addProjectSource() {
      const id = "official-homepage";
      const runId = "d".repeat(64);
      const rootUrl = "https://brand.example/";
      const fetchedAt = new Date(nowMs).toISOString();
      const evidence = {
        id,
        url: rootUrl,
        title: "Brand official homepage",
        excerpt: "Official product facts from the configured website.",
        fetchedAt,
      };
      items.set(id, {
        id,
        campaignId: campaign.id,
        kind: "source",
        url: rootUrl,
        title: evidence.title,
        body: evidence.excerpt,
        status: "verified",
        details: {
          catalog: {
            runId,
            rootUrl,
            purpose: "page",
            category: "homepage",
            provenance: "configured_website",
            depth: 1,
          },
          evidence: [evidence],
        },
      });
      projectCatalogRows.push({
        id,
        url: rootUrl,
        title: evidence.title,
        details: items.get(id).details,
        checkpoint: {
          catalogRunId: runId,
          catalogRootUrl: rootUrl,
          catalogContentType: "text/html",
          catalogProbe: false,
          catalogFetchedAt: fetchedAt,
        },
      });
      return id;
    },
    advance(ms: number) {
      nowMs += ms;
      return new Date(nowMs);
    },
    now: () => new Date(nowMs),
  };
}

describe("durable campaign worker", () => {
  it("defers a transient timeout once, then parks it for human action without infinite retries", async () => {
    const state = fixtureDb();
    const research = vi.fn(async () => {
      throw new CampaignResearchError("transient", "fetch_timeout");
    });
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      research,
      now: state.now,
    });

    await worker.tick();
    expect(state.job.status).toBe("deferred");
    expect(state.job.checkpoint.retryExhausted).toBe(true);
    expect(state.job.lastError).toBe("fetch_timeout");
    expect(state.item.status).toBe("deferred");
    state.advance(30_000);
    await worker.tick();

    expect(state.job.status).toBe("needs_action");
    expect(research).toHaveBeenCalledTimes(1);
    expect(state.job.attemptCount).toBe(state.job.maxAttempts);
    expect(state.events.filter((event) => event.type === "step_started")).toHaveLength(1);
    expect(state.events.every((event) => !event.summary.includes("fetch_timeout"))).toBe(true);
  });

  it("persists controlled fixture rows once and waits for review", async () => {
    const state = fixtureDb("controlled");
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      now: state.now,
    });

    await worker.tick();
    expect(state.job.status).toBe("deferred");
    // Simulate a worker restart or slow poll after both the one retry and the fixture job are due.
    state.advance(60_000);
    await worker.tick();
    await worker.tick();

    expect(state.job.status).toBe("waiting_review");
    expect([...state.items.values()].filter((entry) => entry.kind === "draft")).toHaveLength(1);
    expect(
      [...state.items.values()].filter((entry) => entry.kind === "account")[0].details
        .emailConfirmation.status,
    ).toBe("confirmed");
    expect(state.events.some((event) => event.summary.startsWith("Controlled test"))).toBe(true);
  });

  it("does no new work while the campaign is paused", async () => {
    const state = fixtureDb();
    state.campaign.status = "paused";
    const research = vi.fn();
    const worker = createCampaignWorker({ prisma: state.db, research, now: state.now });
    await worker.tick();
    expect(research).not.toHaveBeenCalled();
    expect(state.job.attemptCount).toBe(0);
  });

  it("keeps catalog crawling blocked until a failed guidance probe is retried successfully", async () => {
    const state = fixtureDb();
    const runId = "a".repeat(64);
    const rootUrl = "https://example.org/";
    state.job.operation = "catalog_page";
    state.job.checkpoint = {
      catalogRunId: runId,
      catalogRootUrl: rootUrl,
      catalogPurpose: "guidance",
      catalogDepth: 0,
    };
    state.item.url = "https://example.org/robots.txt";
    state.item.title = "Website crawl guidance";
    state.item.details = {
      catalog: {
        runId,
        rootUrl,
        purpose: "guidance",
        category: "guidance",
        provenance: "conventional_probe",
        depth: 0,
      },
    };
    const catalogResearch = vi
      .fn()
      .mockRejectedValueOnce(new CampaignCatalogError("unsupported", "page_forbidden"))
      .mockResolvedValueOnce({
        url: "https://example.org/robots.txt",
        title: "robots.txt",
        text: "User-agent: AutoSEO\nDisallow: /\n",
        robotsText: "User-agent: AutoSEO\nDisallow: /\n",
        contentType: "text/plain" as const,
        fetchedAt: state.now().toISOString(),
        links: [],
        httpStatus: 200,
      });
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: vi.fn((_input: { projectSources?: unknown[] }) => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      })),
      generate: vi.fn(),
    };
    const aiDrafting = {
      enabled: true,
      ownerUserId: "owner-1",
      maxReservationMicros: 200,
      provider,
    };

    await createCampaignWorker({
      prisma: state.db,
      workerId: "guidance-fail-worker",
      now: state.now,
      catalogResearch,
      aiDrafting,
      maxPerTick: 1,
    }).tick();

    expect(state.job.status).toBe("needs_action");
    expect(state.item.status).toBe("needs_action");
    expect(state.job.checkpoint).toMatchObject({
      catalogOutcome: "blocked",
      catalogSafeError: "page_forbidden",
    });
    expect(catalogResearch).toHaveBeenCalledTimes(1);
    expect(provider.generate).not.toHaveBeenCalled();

    state.job.status = "queued";
    state.job.attemptCount = 0;
    state.job.availableAt = state.now();
    state.job.checkpoint = {
      catalogRunId: runId,
      catalogRootUrl: rootUrl,
      catalogPurpose: "guidance",
      catalogDepth: 0,
    };
    state.item.status = "queued";
    await createCampaignWorker({
      prisma: state.db,
      workerId: "guidance-retry-worker",
      now: state.now,
      catalogResearch,
      aiDrafting,
      maxPerTick: 1,
    }).tick();

    expect(catalogResearch).toHaveBeenCalledTimes(2);
    expect(catalogResearch.mock.calls[1]?.[1]).toMatchObject({
      allowedOrigin: "https://example.org",
    });
    expect(state.job.status).toBe("succeeded");
    expect(state.item.status).toBe("verified");
    expect(state.job.checkpoint).toMatchObject({
      catalogOutcome: "success",
      catalogRules: { allow: [], disallow: ["/"], sitemaps: [] },
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect([...state.items.values()].filter((entry) => entry.kind === "draft")).toHaveLength(0);
  });

  it("fences a catalog response after its configured website is changed", async () => {
    const state = fixtureDb();
    const runId = "c".repeat(64);
    const rootUrl = "https://example.org/";
    state.job.operation = "catalog_page";
    state.job.checkpoint = {
      catalogRunId: runId,
      catalogRootUrl: rootUrl,
      catalogPurpose: "guidance",
      catalogDepth: 0,
    };
    state.item.kind = "source";
    state.item.url = "https://example.org/robots.txt";
    state.item.title = "Website crawl guidance";
    state.item.status = "researching";
    state.item.details = {
      catalog: {
        runId,
        rootUrl,
        purpose: "guidance",
        category: "guidance",
        provenance: "conventional_probe",
        depth: 0,
      },
    };
    const research = vi.fn(async () => {
      state.campaign.config.websiteUrl = "https://new.example.org/";
      state.job.status = "cancelled";
      state.job.leaseOwner = null;
      state.job.leaseFence += 1;
      state.item.status = "failed";
      state.item.body = "This catalog page was canceled because the campaign website changed.";
      return {
        url: state.item.url,
        title: "robots.txt",
        text: "User-agent: AutoSEO\nAllow: /\n",
        robotsText: "User-agent: AutoSEO\nAllow: /\n",
        contentType: "text/plain" as const,
        fetchedAt: state.now().toISOString(),
        links: [],
        httpStatus: 200,
      };
    });
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "old-root-worker",
      now: state.now,
      catalogResearch: research,
    });

    await worker.tick();

    expect(research).toHaveBeenCalledTimes(1);
    expect(state.job.status).toBe("cancelled");
    expect(state.job.leaseFence).toBe(2);
    expect(state.item.status).toBe("failed");
    expect(state.item.body).toContain("website changed");
    expect([...state.items.values()]).toHaveLength(1);
  });

  it("aborts a hung researcher at the execution deadline and fences its late result", async () => {
    const state = fixtureDb();
    let signal: AbortSignal | undefined;
    const researcher = vi.fn((_url: string, received?: AbortSignal) => {
      signal = received;
      return new Promise<any>(() => undefined);
    });
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      research: researcher,
      now: state.now,
      executionTimeoutMs: 10,
    });
    await worker.tick();
    expect(signal?.aborted).toBe(true);
    expect(state.job.status).toBe("deferred");
    expect(state.job.leaseFence).toBe(2);
  });

  it("recovers an expired lease and continues from the persisted job", async () => {
    const state = fixtureDb("research", 3);
    state.job.status = "running";
    state.job.leaseOwner = "dead-worker";
    state.job.leaseFence = 7;
    state.job.leaseExpiresAt = new Date(state.now().getTime() - 1);
    state.job.deadlineAt = new Date(state.now().getTime() + 60_000);
    const research = vi.fn(async () => ({
      title: "Real source title",
      text: "A factual excerpt from the supplied page.",
      url: "https://example.org/community",
      contentType: "text/html" as const,
      fetchedAt: state.now().toISOString(),
    }));
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "new-worker",
      research,
      now: state.now,
    });
    await worker.tick();
    expect(state.job.status).toBe("succeeded");
    expect(state.job.leaseFence).toBe(9);
    expect(
      [...state.items.values()].some(
        (entry) => entry.kind === "draft" && entry.status === "needs_action",
      ),
    ).toBe(true);
  });

  it("does not persist a research result if the campaign pauses during the fetch", async () => {
    const state = fixtureDb("research", 3);
    let resolveResearch!: (value: any) => void;
    const research = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveResearch = resolve;
        }),
    );
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      research,
      now: state.now,
    });
    const ticking = worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.campaign.status = "paused";
    resolveResearch({
      title: "Real source title",
      text: "A factual excerpt.",
      url: "https://example.org/community",
      contentType: "text/html",
      fetchedAt: state.now().toISOString(),
    });
    await ticking;
    expect(state.job.status).toBe("deferred");
    expect([...state.items.values()].filter((entry) => entry.kind === "draft")).toHaveLength(0);
  });

  it("reserves the shared daily budget before one model call and persists actual cost", async () => {
    const state = fixtureDb("research", 3);
    state.addProjectSource();
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: vi.fn((_input: { projectSources?: unknown[] }) => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      })),
      generate: vi.fn(async (_input: { projectSources?: unknown[] }) => ({
        body: "A useful source-based answer.",
        rationale: "The supplied page discusses this topic.",
        sourceUrls: ["https://example.org/community"],
        usage: { inputTokens: 100, outputTokens: 20, costMicros: 70 },
      })),
    };
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      now: state.now,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html",
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: { enabled: true, ownerUserId: "owner-1", maxReservationMicros: 200, provider },
    });
    await worker.tick();

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.generate.mock.calls[0]?.[0]).toMatchObject({
      maxCostMicros: 100,
      maxOutputTokens: 2_048,
    });
    expect(provider.generate.mock.calls[0]?.[0].projectSources).toEqual(
      provider.estimateReservationMicros.mock.calls[0]?.[0].projectSources,
    );
    expect(provider.generate.mock.calls[0]?.[0].projectSources).toHaveLength(1);
    expect(state.item.details.projectContext).toMatchObject({
      state: "supplied",
      sourceIds: ["official-homepage"],
    });
    expect(state.job.status).toBe("succeeded");
    expect(state.job.checkpoint).toMatchObject({
      aiState: "ready",
      aiReservationMicros: "100",
      aiActualCostMicros: "70",
    });
    expect(state.job.checkpoint.aiReservedDay).toBe(state.now().toISOString().slice(0, 10));
    expect(state.item.status).toBe("verified");
    expect([...state.items.values()].find((entry) => entry.kind === "draft")?.body).toBe(
      "A useful source-based answer.",
    );
  });

  it("does not reserve or call the model with project evidence made stale before reservation", async () => {
    const state = fixtureDb("research", 3);
    state.addProjectSource();
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: vi.fn(() => {
        state.campaign.config.websiteUrl = "https://new-brand.example/";
        return {
          estimatedCostMicros: 100,
          estimatedInputTokens: 100,
          maxOutputTokens: 2_048,
          isEstimate: true as const,
        };
      }),
      generate: vi.fn(),
    };
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "stale-grounding-worker",
      now: state.now,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html",
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: { enabled: true, ownerUserId: "owner-1", maxReservationMicros: 200, provider },
    });
    await worker.tick();

    expect(provider.generate).not.toHaveBeenCalled();
    expect(state.job.checkpoint.aiState).toBeUndefined();
    expect(state.item.details.projectContext).toMatchObject({ state: "missing", sourceIds: [] });
  });

  it("keeps target-only model drafting available when no verified project references exist", async () => {
    const state = fixtureDb("research", 3);
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: vi.fn((_input: { projectSources?: unknown[] }) => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      })),
      generate: vi.fn(async (_input: { projectSources?: unknown[] }) => ({
        body: "A target-only draft with explicit source notes.",
        rationale: "Based on the supplied opportunity page.",
        sourceUrls: ["https://example.org/community"],
        usage: { inputTokens: 100, outputTokens: 20, costMicros: 70 },
      })),
    };
    await createCampaignWorker({
      prisma: state.db,
      workerId: "target-only-worker",
      now: state.now,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html",
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: { enabled: true, ownerUserId: "owner-1", maxReservationMicros: 200, provider },
    }).tick();

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.estimateReservationMicros.mock.calls[0]?.[0].projectSources).toEqual([]);
    expect(provider.generate.mock.calls[0]?.[0].projectSources).toEqual([]);
    expect(state.item.details.projectContext).toMatchObject({
      state: "missing",
      runId: null,
      sourceIds: [],
    });
  });

  it("never repeats a successful paid call when draft persistence fails", async () => {
    const state = fixtureDb("research", 3);
    state.addProjectSource();
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: vi.fn(() => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      })),
      generate: vi.fn(async () => {
        expect(state.item.details.projectContext).toMatchObject({
          state: "supplied",
          sourceIds: ["official-homepage"],
        });
        expect(state.item.details.evidence).toHaveLength(2);
        expect(state.job.checkpoint.aiProjectContext).toMatchObject({
          state: "supplied",
          sourceIds: ["official-homepage"],
        });
        state.failResearchCompletionOnce();
        return {
          body: "A useful source-based answer.",
          rationale: "The supplied page discusses this topic.",
          sourceUrls: ["https://example.org/community"],
          usage: { inputTokens: 100, outputTokens: 20, costMicros: 70 },
        };
      }),
    };
    const options = {
      prisma: state.db,
      now: state.now,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html" as const,
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: {
        enabled: true,
        ownerUserId: "owner-1",
        maxReservationMicros: 200,
        provider,
      },
    };

    await createCampaignWorker({ ...options, workerId: "first-paid-worker" }).tick();

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(state.job.status).toBe("needs_action");
    expect(state.job.lastError).toBe("ai_result_ambiguous");
    expect(state.job.checkpoint).toMatchObject({
      aiState: "ambiguous",
      aiReservedDay: state.now().toISOString().slice(0, 10),
      aiReservationMicros: "100",
      aiActualCostMicros: "70",
    });
    expect(state.item.status).toBe("needs_action");
    expect(state.item.details.projectContext).toMatchObject({
      state: "supplied",
      sourceIds: ["official-homepage"],
    });
    expect(state.item.details.evidence.map((entry: any) => entry.id)).toEqual([
      "item-1",
      "official-homepage",
    ]);
    expect([...state.items.values()].filter((entry) => entry.kind === "draft")).toHaveLength(0);

    state.advance(60_000);
    await createCampaignWorker({ ...options, workerId: "restarted-paid-worker" }).tick();

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(state.job.status).toBe("needs_action");
    expect(state.job.checkpoint).toMatchObject({
      aiState: "ambiguous",
      aiReservedDay: state.now().toISOString().slice(0, 10),
      aiReservationMicros: "100",
      aiActualCostMicros: "70",
      aiProjectContext: { state: "supplied", sourceIds: ["official-homepage"] },
    });
  });

  it("falls back to source notes without calling a model when the shared daily budget is full", async () => {
    const state = fixtureDb("research", 3);
    state.setDailySpent(950n);
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: () => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      }),
      generate: vi.fn(),
    };
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      now: state.now,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html",
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: { enabled: true, ownerUserId: "owner-1", maxReservationMicros: 200, provider },
    });
    await worker.tick();

    expect(provider.generate).not.toHaveBeenCalled();
    expect(state.job.status).toBe("succeeded");
    expect(state.job.checkpoint.aiState).toBeUndefined();
    expect([...state.items.values()].find((entry) => entry.kind === "draft")?.body).toContain(
      "Source notes for review",
    );
  });

  it("does not repeat a paid call when an intent checkpoint outlives the worker", async () => {
    const state = fixtureDb("research", 3);
    state.addProjectSource();
    const provider = {
      describe: () => ({
        providerId: "fake",
        modelId: "priced",
        modelName: "Priced fake",
        configured: true,
        pricingAvailable: true,
      }),
      estimateReservationMicros: () => ({
        estimatedCostMicros: 100,
        estimatedInputTokens: 100,
        maxOutputTokens: 2_048,
        isEstimate: true as const,
      }),
      generate: vi.fn(() => new Promise<any>(() => undefined)),
    };
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      now: state.now,
      executionTimeoutMs: 10,
      research: async () => ({
        title: "Page title",
        text: "A cited factual excerpt.",
        url: "https://example.org/community",
        contentType: "text/html",
        fetchedAt: state.now().toISOString(),
      }),
      aiDrafting: { enabled: true, ownerUserId: "owner-1", maxReservationMicros: 200, provider },
    });
    await worker.tick();
    expect(state.job.checkpoint.aiState).toBe("intent");
    state.job.checkpoint.aiActualCostMicros = "35";
    state.advance(30_000);
    await worker.tick();

    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(state.job.status).toBe("needs_action");
    expect(state.job.checkpoint).toMatchObject({
      aiState: "ambiguous",
      aiReservationMicros: "100",
      aiActualCostMicros: "35",
    });
    expect(
      [...state.items.values()].some(
        (entry) => entry.kind === "draft" && entry.body.includes("Source notes"),
      ),
    ).toBe(true);
  });

  it("publishes and independently verifies one local fixture after a matching human approval", async () => {
    const state = fixtureDb("controlled");
    const worker = createCampaignWorker({
      prisma: state.db,
      workerId: "test-worker",
      now: state.now,
    });
    await worker.tick();
    state.advance(60_000);
    await worker.tick();
    const draftId = state.job.checkpoint.draftId as string;
    const draft = state.items.get(draftId)!;
    const approvedUpdatedAt = state.now().toISOString();
    const approvalHash = "approved-draft-hash";
    draft.status = "approved";
    draft.updatedAt = new Date(approvedUpdatedAt);
    draft.details = { ...draft.details, approvalVersion: approvalHash, approvedUpdatedAt };
    state.job.operation = "controlled_publish";
    state.job.itemId = draftId;
    state.job.status = "queued";
    state.job.availableAt = state.now();
    state.job.checkpoint = { approvalHash, approvedUpdatedAt };

    await worker.tick();
    expect(state.job.status).toBe("deferred");
    state.advance(100);
    await worker.tick();
    await worker.tick();

    const publications = [...state.items.values()].filter((entry) => entry.kind === "publication");
    expect(publications).toHaveLength(1);
    expect(publications[0].status).toBe("verified");
    expect(publications[0].url).toBe("https://fixture.invalid/published");
    expect(state.job.status).toBe("succeeded");
  });
});
