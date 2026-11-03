import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignDraftProvider,
  CampaignDraftSource,
} from "@rakazo/adapter-kit/campaign-drafting";
import { CampaignDraftError } from "@rakazo/adapter-kit/campaign-drafting";
import {
  CampaignSearchError,
  type CampaignSearchProvider,
  type CampaignSearchResponse,
  deriveCampaignSearchQueries,
} from "@rakazo/adapter-kit/campaign-search";
import type { CampaignActivity } from "@rakazo/contracts";
import { decideCampaignFailure, selectNextCampaignOpportunity } from "@rakazo/core";
import { getCampaignDailyReservedSpendMicros, type Prisma, type PrismaClient } from "@rakazo/db";
import {
  CampaignCatalogError,
  type CampaignCatalogPage,
  type CatalogRobotsRules,
  canonicalCatalogUrl,
  classifyCatalogPage,
  fetchCampaignCatalogPage,
  isCatalogUrlAllowed,
  parseCatalogRobots,
} from "./campaign-catalog.js";
import {
  type CampaignOpportunityInspection,
  CampaignOpportunityInspectionError,
  inspectCampaignOpportunity,
} from "./campaign-discovery.js";
import {
  CampaignResearchError,
  type CampaignResearchEvidence,
  researchCampaignUrl,
  validateCampaignResearchUrl,
} from "./campaign-research.js";

const POLL_MS = 1_000;
const CLAIM_BATCH = 64;
const MAX_PER_TICK = 3;
const MAX_SITE_PARKS_PER_TICK = 512;
const MAX_CATALOG_PAGES_PER_RUN = 12;
const MAX_CATALOG_DEPTH = 2;
const LEASE_MS = 20_000;
const STEP_BUDGET_MS = 5 * 60_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const DEFER_MS = 30_000;
const CONTROLLED_DEFER_MS = 1_000;
const EXECUTION_TIMEOUT_MS = 45_000;

type CampaignWorkerDb = PrismaClient;
type Researcher = (url: string, signal?: AbortSignal) => Promise<CampaignResearchEvidence>;
interface CatalogResearchOptions {
  allowedOrigin: string;
  allowedUrl?: (url: string) => boolean;
  signal?: AbortSignal;
}
type OpportunityInspector = (input: {
  url: string;
  signal?: AbortSignal;
  now?: () => Date;
}) => Promise<CampaignOpportunityInspection>;
interface CatalogTarget {
  url: string;
  label: string;
  category: ReturnType<typeof classifyCatalogPage>;
  depth: number;
  provenance: "conventional_probe" | "configured_website" | "observed_link";
}
type CatalogResearcher = (
  url: string,
  options: CatalogResearchOptions,
) => Promise<CampaignCatalogPage>;

interface WorkerOptions {
  prisma: CampaignWorkerDb;
  workerId?: string;
  research?: Researcher;
  catalogResearch?: CatalogResearcher;
  discovery?: {
    enabled: boolean;
    searchProviderId?: string;
    searchProvider?: CampaignSearchProvider;
    inspectOpportunity?: OpportunityInspector;
  };
  now?: () => Date;
  intervalMs?: number;
  maxPerTick?: number;
  executionTimeoutMs?: number;
  onError?: (code: "tick_failed") => void;
  aiDrafting?: {
    enabled: boolean;
    ownerUserId?: string;
    maxReservationMicros?: number;
    provider?: CampaignDraftProvider;
  };
}

interface JobRecord {
  id: string;
  campaignId: string;
  itemId: string | null;
  operation: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date;
  startedAt: Date | null;
  deadlineAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseFence: number;
  leaseOwner: string | null;
  checkpoint: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  item: {
    id: string;
    kind: string;
    url: string | null;
    title: string;
    body: string;
    status: string;
    details: unknown;
    updatedAt: Date;
  } | null;
  campaign: { id: string; userId: string; status: string; mode: string; config: unknown };
}

interface ProjectEvidence {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  fetchedAt: string;
}

interface ProjectContextSelection {
  rootUrl: string;
  runId: string | null;
  sourceIds: string[];
  projectSources: CampaignDraftSource[];
  evidence: ProjectEvidence[];
}

interface PersistedProjectContext
  extends Omit<ProjectContextSelection, "projectSources" | "evidence"> {
  state: "available" | "supplied" | "missing";
}

interface GeneratedDraft {
  body: string;
  rationale: string;
  sourceUrls: string[];
  aiState?: "ready" | "ambiguous";
  aiReservationMicros?: string | null;
  aiActualCostMicros?: string | null;
  jobStatus?: "succeeded" | "needs_action";
  projectContext: PersistedProjectContext;
  projectEvidence: ProjectEvidence[];
}

/** Durable, database-backed campaign work. All effects in controlled mode are local fixture rows. */
export function createCampaignWorker(options: WorkerOptions) {
  const workerId = options.workerId ?? `campaign-worker-${randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const researcher =
    options.research ??
    ((url: string, signal?: AbortSignal) => researchCampaignUrl(url, { signal }));
  const catalogResearcher =
    options.catalogResearch ??
    ((url: string, catalogOptions: CatalogResearchOptions) =>
      fetchCampaignCatalogPage(url, catalogOptions));
  const opportunityInspector =
    options.discovery?.inspectOpportunity ??
    ((input: { url: string; signal?: AbortSignal; now?: () => Date }) =>
      inspectCampaignOpportunity(input));
  const intervalMs = options.intervalMs ?? POLL_MS;
  const maxPerTick = options.maxPerTick ?? MAX_PER_TICK;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let stopped = false;
  let activeController: AbortController | undefined;

  const tick = async () => {
    if (stopped) return;
    if (ticking) return ticking;
    ticking = (async () => {
      await seedPreviouslyDisabledDiscovery();
      await recoverExpiredJobs();
      const dueWhere = {
        OR: [
          { status: { in: ["queued", "deferred"] }, availableAt: { lte: now() } },
          { status: "running", leaseExpiresAt: { lte: now() } },
        ],
        campaign: { status: "active" },
      };
      const fetchCandidates = async () =>
        (await options.prisma.campaignJob.findMany({
          where: dueWhere,
          include: { item: true, campaign: true },
          orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: CLAIM_BATCH,
        })) as JobRecord[];
      let candidates = await fetchCandidates();
      const siteAvailabilityByKey = new Map<string, number>();
      const lastSiteByCampaign = new Map<string, string>();
      const loadedCampaignIds = new Set<string>();
      const loadCampaignContext = async (jobs: JobRecord[]) => {
        const campaignIds = [
          ...new Set(
            jobs
              .map((candidate) => candidate.campaignId)
              .filter((campaignId) => !loadedCampaignIds.has(campaignId)),
          ),
        ];
        await Promise.all(
          campaignIds.map(async (campaignId) => {
            const [breakers, lastStarted] = await Promise.all([
              options.prisma.$queryRaw<Array<{ siteKey: string; blockedUntil: string }>>`
              SELECT "checkpoint"->>'siteBlockedSite' AS "siteKey",
                     MAX("checkpoint"->>'siteBlockedUntil') AS "blockedUntil"
              FROM "campaign_jobs"
              WHERE "campaignId" = ${campaignId}
                AND "operation" IN ('research_source', 'research_opportunity', 'catalog_page', 'discovery_search', 'discovery_inspect')
                AND "checkpoint"->>'siteBlockedSite' IS NOT NULL
                AND "checkpoint"->>'siteBlockedUntil' >= ${now().toISOString()}
              GROUP BY "checkpoint"->>'siteBlockedSite'
              ORDER BY "checkpoint"->>'siteBlockedSite'
              LIMIT 256
            `,
              options.prisma.campaignJob.findFirst({
                where: {
                  campaignId,
                  operation: {
                    in: [
                      "research_source",
                      "research_opportunity",
                      "catalog_page",
                      "discovery_search",
                      "discovery_inspect",
                    ],
                  },
                  heartbeatAt: { not: null },
                  item: { url: { not: null } },
                },
                include: { item: true, campaign: true },
                orderBy: [{ heartbeatAt: "desc" }, { startedAt: "desc" }, { id: "desc" }],
              }),
            ]);
            for (const breaker of breakers) {
              const blockedUntil = Date.parse(breaker.blockedUntil);
              if (Number.isFinite(blockedUntil) && blockedUntil > now().getTime()) {
                siteAvailabilityByKey.set(`${campaignId}:${breaker.siteKey}`, blockedUntil);
              }
            }
            if (lastStarted?.item?.url) {
              lastSiteByCampaign.set(campaignId, campaignSiteKey(lastStarted as JobRecord));
            }
            loadedCampaignIds.add(campaignId);
          }),
        );
      };
      await loadCampaignContext(candidates);
      let completed = 0;
      let parkedCount = 0;
      const skipped = new Set<string>();
      while (completed < maxPerTick && !stopped) {
        const eligible = candidates.filter((candidate) => !skipped.has(candidate.id));
        if (eligible.length === 0) break;
        const blockedCandidates = eligible.filter((job) => {
          const blockedUntil = siteAvailabilityByKey.get(campaignSiteKey(job));
          return blockedUntil !== undefined && blockedUntil > now().getTime();
        });
        if (blockedCandidates.length > 0 && parkedCount < MAX_SITE_PARKS_PER_TICK) {
          const toPark = blockedCandidates.slice(0, MAX_SITE_PARKS_PER_TICK - parkedCount);
          await parkBlockedJobs(toPark, siteAvailabilityByKey);
          parkedCount += toPark.length;
          candidates = await fetchCandidates();
          await loadCampaignContext(candidates);
          skipped.clear();
          continue;
        }
        let candidate: JobRecord | undefined;
        for (const campaignId of new Set(eligible.map((job) => job.campaignId))) {
          const campaignCandidates = eligible.filter((job) => job.campaignId === campaignId);
          const picked = selectNextCampaignOpportunity({
            campaignStatus: "active",
            nowMs: now().getTime(),
            candidates: campaignCandidates.map((job) => ({
              id: job.id,
              siteKey: campaignSiteKey(job),
              status: job.status === "deferred" ? "deferred" : "queued",
              retryAtMs: job.status === "deferred" ? job.availableAt.getTime() : null,
              createdAtMs: Math.min(job.createdAt.getTime(), now().getTime()),
            })),
            siteAvailability: [...siteAvailabilityByKey].map(([siteKey, blockedUntilMs]) => ({
              siteKey,
              blockedUntilMs,
            })),
            lastSiteKey: lastSiteByCampaign.get(campaignId),
          });
          if (picked.action !== "select") continue;
          const selected = campaignCandidates.find((job) => job.id === picked.opportunityId);
          if (
            selected &&
            (!candidate ||
              selected.availableAt < candidate.availableAt ||
              (selected.availableAt.getTime() === candidate.availableAt.getTime() &&
                selected.createdAt < candidate.createdAt))
          ) {
            candidate = selected;
          }
        }
        if (!candidate) break;
        const claimed = await claim(candidate);
        if (!claimed) {
          skipped.add(candidate.id);
          continue;
        }
        completed += 1;
        await execute(claimed);
        lastSiteByCampaign.set(claimed.campaignId, campaignSiteKey(claimed));
        const latest = (await options.prisma.campaignJob.findUnique({
          where: { id: claimed.id },
          select: { checkpoint: true },
        })) as { checkpoint: unknown } | null;
        const latestCheckpoint = record(latest?.checkpoint);
        const blockedSite =
          typeof latestCheckpoint.siteBlockedSite === "string"
            ? latestCheckpoint.siteBlockedSite
            : null;
        const blockedUntil =
          typeof latestCheckpoint.siteBlockedUntil === "string"
            ? Date.parse(latestCheckpoint.siteBlockedUntil)
            : Number.NaN;
        if (blockedSite && Number.isFinite(blockedUntil) && blockedUntil > now().getTime()) {
          const key = `${claimed.campaignId}:${blockedSite}`;
          siteAvailabilityByKey.set(
            key,
            Math.max(siteAvailabilityByKey.get(key) ?? 0, blockedUntil),
          );
        }
        candidates = await fetchCandidates();
        await loadCampaignContext(candidates);
        skipped.clear();
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };

  async function seedPreviouslyDisabledDiscovery(): Promise<void> {
    const providerId = options.discovery?.searchProviderId;
    if (
      !options.discovery?.enabled ||
      !options.discovery.searchProvider ||
      !isSafeProviderId(providerId)
    )
      return;
    const candidates = await options.prisma.$queryRaw<Array<{ id: string; campaignId: string }>>`
      SELECT j."id", j."campaignId"
      FROM "campaign_jobs" j
      JOIN "campaigns" c ON c."id" = j."campaignId"
      WHERE j."operation" = 'catalog_page'
        AND j."checkpoint"->>'catalogPurpose' = 'guidance'
        AND j."checkpoint"->>'catalogSummaryEmitted' = 'true'
        AND j."checkpoint"->>'discoverySeeded' IS DISTINCT FROM 'true'
        AND j."checkpoint"->>'discoveryBootstrapOutcome' IN ('disabled', 'provider_unavailable')
        AND c."status" = 'active'
        AND c."config"->>'websiteUrl' = j."checkpoint"->>'catalogRootUrl'
      ORDER BY j."updatedAt" ASC, j."id" ASC
      LIMIT 8
    `;
    for (const candidate of candidates) {
      await options.prisma.$transaction(async (tx) => {
        const active = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "campaigns"
          WHERE "id" = ${candidate.campaignId} AND "status" = 'active'
          FOR UPDATE
        `;
        if (active.length !== 1) return;
        const current = (await tx.campaignJob.findUnique({
          where: { id: candidate.id },
          include: { item: true, campaign: true },
        })) as JobRecord | null;
        if (current?.status !== "succeeded") return;
        const runId = current.checkpoint.catalogRunId;
        if (typeof runId !== "string") return;
        const statuses = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "campaign_jobs"
          WHERE "campaignId" = ${candidate.campaignId}
            AND "operation" = 'catalog_page'
            AND "checkpoint"->>'catalogRunId' = ${runId}
          FOR UPDATE
        `;
        const terminal = new Set(["succeeded", "failed", "needs_action", "cancelled"]);
        if (!statuses.length || statuses.some((row) => !terminal.has(row.status))) return;
        await seedDiscoverySearchJobs(tx, current, runId);
      });
    }
  }

  async function parkBlockedJobs(
    jobs: JobRecord[],
    availability: Map<string, number>,
  ): Promise<void> {
    const byCampaign = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      if (
        !job.itemId ||
        ![
          "research_source",
          "research_opportunity",
          "catalog_page",
          "discovery_search",
          "discovery_inspect",
        ].includes(job.operation) ||
        !["queued", "deferred"].includes(job.status)
      )
        continue;
      const group = byCampaign.get(job.campaignId) ?? [];
      group.push(job);
      byCampaign.set(job.campaignId, group);
    }
    for (const [campaignId, group] of byCampaign) {
      await options.prisma.$transaction(async (tx) => {
        const active = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "campaigns"
          WHERE "id" = ${campaignId} AND "status" = 'active'
          FOR UPDATE
        `;
        if (active.length !== 1) return;
        let changed = 0;
        for (const job of group) {
          const blockedUntilMs = availability.get(campaignSiteKey(job));
          if (blockedUntilMs === undefined || blockedUntilMs <= now().getTime()) continue;
          const blockedUntil = new Date(blockedUntilMs);
          const parked = await tx.campaignJob.updateMany({
            where: {
              id: job.id,
              status: job.status,
              availableAt: { lte: now() },
            },
            data: {
              status: "deferred",
              availableAt: blockedUntil,
              lastError: "site_cooldown",
              checkpoint: {
                ...job.checkpoint,
                siteBlockedSite: siteKey(job),
                siteBlockedUntil: blockedUntil.toISOString(),
              } as Prisma.InputJsonObject,
            },
          });
          if (parked.count !== 1) continue;
          changed += 1;
          if (job.itemId) {
            await tx.campaignItem.updateMany({
              where: { id: job.itemId, status: { in: ["queued", "deferred"] } },
              data: { status: "deferred" },
            });
          }
        }
        if (changed > 0) {
          await appendEvent(
            tx,
            campaignId,
            "step_deferred",
            "Opportunities are deferred until their site cooldown expires.",
            null,
          );
        }
      });
    }
  }

  async function claim(candidate: JobRecord): Promise<JobRecord | undefined> {
    return options.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id: candidate.campaignId },
        select: { status: true },
      });
      if (campaign?.status !== "active") return undefined;
      const current = (await tx.campaignJob.findUnique({
        where: { id: candidate.id },
        include: { item: true, campaign: true },
      })) as JobRecord | null;
      if (!current || !["queued", "deferred", "running"].includes(current.status)) return undefined;
      if (current.status !== "running" && current.availableAt > now()) return undefined;
      if (current.status === "running" && current.leaseExpiresAt && current.leaseExpiresAt > now())
        return undefined;
      if (current.checkpoint.retryExhausted === true) {
        await finalizeExhaustedBeforeClaim(tx, current);
        return undefined;
      }
      const leaseFence = current.leaseFence + 1;
      const update = await tx.campaignJob.updateMany({
        where: { id: current.id, leaseFence: current.leaseFence, status: current.status },
        data: {
          status: "running",
          attemptCount: { increment: 1 },
          startedAt: current.startedAt ?? now(),
          heartbeatAt: now(),
          deadlineAt: current.deadlineAt ?? new Date(now().getTime() + STEP_BUDGET_MS),
          leaseExpiresAt: new Date(now().getTime() + LEASE_MS),
          leaseOwner: workerId,
          leaseFence,
          lastError: null,
        },
      });
      if (update.count !== 1) return undefined;
      const claimed = (await tx.campaignJob.findUnique({
        where: { id: current.id },
        include: { item: true, campaign: true },
      })) as JobRecord | null;
      if (!claimed) return undefined;
      if (current.itemId) {
        await tx.campaignItem.updateMany({
          where: { id: current.itemId, status: { in: ["queued", "deferred"] } },
          data: { status: "researching" },
        });
      }
      await appendEvent(
        tx,
        current.campaignId,
        "step_started",
        eventStartSummary(current.operation),
        current.itemId,
      );
      return claimed;
    });
  }

  async function finalizeExhaustedBeforeClaim(
    tx: Prisma.TransactionClient,
    job: JobRecord,
  ): Promise<void> {
    const isCatalog = job.operation === "catalog_page";
    const isGuidance = isCatalog && job.checkpoint.catalogPurpose === "guidance";
    const isDiscovery =
      job.operation === "discovery_search" || job.operation === "discovery_inspect";
    const jobStatus = isCatalog && !isGuidance ? "failed" : "needs_action";
    const current = await tx.campaignJob.findUnique({
      where: { id: job.id },
      select: { checkpoint: true },
    });
    const checkpoint = record(current?.checkpoint);
    const nextCheckpoint = {
      ...checkpoint,
      ...(isCatalog
        ? {
            catalogOutcome: isGuidance ? "blocked" : "failed",
            catalogSafeError: "retry_exhausted",
          }
        : {}),
      ...(isDiscovery
        ? { discoveryOutcome: "unavailable", discoverySafeError: "retry_exhausted" }
        : {}),
    };
    const update = await tx.campaignJob.updateMany({
      where: { id: job.id, status: job.status, leaseFence: job.leaseFence },
      data: {
        status: jobStatus,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: now(),
        lastError: "retry_exhausted",
        checkpoint: nextCheckpoint as Prisma.InputJsonObject,
      },
    });
    if (update.count !== 1) return;
    if (job.itemId) {
      await tx.campaignItem.updateMany({
        where: { id: job.itemId, status: { in: ["queued", "deferred", "researching"] } },
        data: { status: jobStatus },
      });
      if (isDiscovery) await markDiscoveryUnavailable(tx, job);
    }
    await appendEvent(
      tx,
      job.campaignId,
      isCatalog && !isGuidance ? "step_failed" : "step_blocked",
      job.operation.startsWith("controlled_")
        ? "Controlled test work needs attention after the retry limit."
        : isCatalog
          ? isGuidance
            ? "Website crawl guidance is unavailable after the retry limit; automatic crawling remains blocked."
            : "A catalog page remains unavailable after the retry limit."
          : isDiscovery
            ? "Community discovery work is unavailable after the retry limit and needs attention."
            : "Work needs attention after the retry limit.",
      job.itemId,
    );
    if (isCatalog) await appendCatalogSummaryIfSettled(tx, job, nextCheckpoint);
  }

  async function execute(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    activeController = controller;
    const heartbeat = setInterval(
      () => {
        void options.prisma.campaignJob
          .updateMany({
            where: {
              id: job.id,
              status: "running",
              leaseOwner: workerId,
              leaseFence: job.leaseFence,
            },
            data: { heartbeatAt: now(), leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
          })
          .catch(() => undefined);
      },
      Math.floor(LEASE_MS / 3),
    );
    const run = (async () => {
      try {
        if (job.campaign.mode === "controlled") {
          if (job.operation === "controlled_fixture") await controlledFixture(job);
          else if (job.operation === "controlled_publish") await controlledPublish(job);
          else await failUnsupported(job);
        } else if (job.operation === "catalog_page") {
          await processCatalogPage(job, controller.signal);
        } else if (job.operation === "discovery_search") {
          await processDiscoverySearch(job, controller.signal);
        } else if (job.operation === "discovery_inspect") {
          await processDiscoveryInspect(job, controller.signal);
        } else if (
          job.operation === "research_source" ||
          job.operation === "research_opportunity"
        ) {
          await researchItem(job, controller.signal);
        } else {
          await failUnsupported(job);
        }
      } catch (error) {
        await handleFailure(job, error);
      }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      const remainingDeadline = job.deadlineAt
        ? job.deadlineAt.getTime() - now().getTime()
        : EXECUTION_TIMEOUT_MS;
      timeout = setTimeout(
        () => {
          controller.abort();
          void timeOutJob(job)
            .catch(() => undefined)
            .finally(resolve);
        },
        Math.max(
          1,
          Math.min(options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS, remainingDeadline),
        ),
      );
    });
    await Promise.race([run, bounded]);
    if (timeout) clearTimeout(timeout);
    clearInterval(heartbeat);
    if (activeController === controller) activeController = undefined;
  }

  async function researchItem(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    if (!job.item?.url) {
      await finish(
        job,
        "needs_action",
        "step_blocked",
        "The supplied page URL needs attention.",
        "invalid_input",
      );
      return;
    }
    if (job.checkpoint.retryExhausted === true) {
      await finish(
        job,
        "needs_action",
        "step_blocked",
        "Research needs attention after the retry limit.",
      );
      return;
    }
    if (
      job.checkpoint.aiState === "intent" ||
      job.checkpoint.aiState === "ambiguous" ||
      job.checkpoint.aiState === "ready"
    ) {
      const saved = record(job.item.details);
      const savedEvidence = firstEvidence(saved.evidence);
      if (savedEvidence) {
        const checkpointContext = parsePersistedProjectContext(job.checkpoint.aiProjectContext);
        const checkpointEvidence = parseProjectEvidence(job.checkpoint.aiProjectEvidence);
        await completeResearch(
          job,
          {
            title: savedEvidence.title,
            text: savedEvidence.excerpt,
            url: savedEvidence.url,
            contentType: "text/plain",
            fetchedAt: savedEvidence.fetchedAt,
          },
          {
            body: sourceNotesBody(
              savedEvidence.title,
              savedEvidence.excerpt,
              "The previous model request has an uncertain result.",
            ),
            rationale:
              "A prior optional model request has an uncertain result; this source note is ready for manual editing.",
            sourceUrls: [savedEvidence.url],
            aiState: "ambiguous",
            aiReservationMicros:
              typeof job.checkpoint.aiReservationMicros === "string"
                ? job.checkpoint.aiReservationMicros
                : null,
            aiActualCostMicros:
              typeof job.checkpoint.aiActualCostMicros === "string"
                ? job.checkpoint.aiActualCostMicros
                : null,
            jobStatus: "needs_action",
            projectContext: checkpointContext ?? missingProjectContext(job),
            projectEvidence: checkpointEvidence,
          },
        );
      } else {
        await finish(
          job,
          "needs_action",
          "step_blocked",
          "A previous draft request has an uncertain result and needs manual review.",
          "ai_result_ambiguous",
        );
      }
      return;
    }
    const evidence = await researcher(job.item.url, signal);
    if (!(await isDispatchAllowed(job))) return;
    const excerpt = evidence.text.slice(0, 1_200);
    const evidenceEntry = {
      id: job.item.id,
      url: evidence.url,
      title: evidence.title,
      excerpt,
      fetchedAt: evidence.fetchedAt,
    };
    const projectContext = await selectProjectContext(job);
    const persisted = await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return false;
      await tx.campaignItem.update({
        where: { id: job.item!.id },
        data: {
          title: evidence.title.slice(0, 200),
          body: excerpt,
          details: {
            ...record(job.item!.details),
            evidence: [evidenceEntry],
          } as unknown as Prisma.InputJsonObject,
        },
      });
      return true;
    });
    if (!persisted) return;
    const draft = await generateDraft(job, evidence, projectContext, signal);
    await completeResearch(job, evidence, draft);
  }

  async function processCatalogPage(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    const runId = job.checkpoint.catalogRunId;
    const rootUrl = job.checkpoint.catalogRootUrl;
    const purpose = job.checkpoint.catalogPurpose;
    const depth = job.checkpoint.catalogDepth;
    if (
      typeof runId !== "string" ||
      !/^[a-f0-9]{64}$/.test(runId) ||
      typeof rootUrl !== "string" ||
      !job.item?.url ||
      (purpose !== "guidance" && purpose !== "page") ||
      typeof depth !== "number" ||
      !Number.isSafeInteger(depth) ||
      depth < 0 ||
      depth > MAX_CATALOG_DEPTH
    ) {
      await finishCatalogFailure(job, "invalid_checkpoint", true);
      return;
    }
    if (job.checkpoint.retryExhausted === true) {
      await finishCatalogFailure(job, "retry_exhausted", purpose === "guidance");
      return;
    }

    let allowedOrigin: string;
    try {
      allowedOrigin = validateCampaignResearchUrl(rootUrl).origin;
    } catch {
      await finishCatalogFailure(job, "invalid_root_url", true);
      return;
    }
    const rules = purpose === "guidance" ? null : catalogRules(job.checkpoint.catalogRules);
    if (purpose !== "guidance" && !rules) {
      await finishCatalogFailure(job, "guidance_missing", true);
      return;
    }
    let page: CampaignCatalogPage;
    try {
      page = await catalogResearcher(job.item.url, {
        allowedOrigin,
        signal,
        ...(rules ? { allowedUrl: (url) => isCatalogUrlAllowed(url, rules) } : {}),
      });
    } catch (error) {
      const catalogError =
        error instanceof CampaignCatalogError
          ? error
          : new CampaignCatalogError("transient", "fetch_failed");
      if (catalogError.safeCode === "page_absent" && purpose === "guidance") {
        page = {
          url: job.item.url,
          title: "Website crawl guidance",
          text: "No robots.txt rules were returned by the website.",
          contentType: "text/plain",
          fetchedAt: now().toISOString(),
          links: [],
          httpStatus: 404,
        };
      } else if (catalogError.safeCode === "page_absent") {
        await finishCatalogFailure(job, "page_absent", false);
        return;
      } else if (catalogError.safeCode === "page_forbidden") {
        await finishCatalogFailure(job, "page_forbidden", purpose === "guidance");
        return;
      } else if (catalogError.kind === "transient") {
        throw new CampaignResearchError("transient", catalogError.safeCode);
      } else {
        await finishCatalogFailure(job, catalogError.safeCode, purpose === "guidance");
        return;
      }
    }

    if (new URL(page.url).origin !== allowedOrigin) {
      await finishCatalogFailure(job, "origin_changed", purpose === "guidance");
      return;
    }

    if (purpose === "guidance") {
      let rules: CatalogRobotsRules;
      try {
        rules =
          page.httpStatus === 404 || page.httpStatus === 410
            ? { allow: [], disallow: [], sitemaps: [] }
            : parseCatalogRobots(page.robotsText ?? page.text, rootUrl);
      } catch (error) {
        const safeCode =
          error instanceof CampaignCatalogError ? error.safeCode : "guidance_parse_failed";
        await finishCatalogFailure(job, safeCode, true);
        return;
      }
      const targets = initialCatalogTargets(rootUrl, rules);
      await completeCatalogPage(job, page, "guidance", 0, rules, targets);
      return;
    }

    if (!rules) return;
    const category = classifyCatalogPage(job.item.url, job.item.title);
    const targets =
      depth < MAX_CATALOG_DEPTH
        ? page.links.map((link) => ({
            url: link.url,
            label: link.label,
            category: classifyCatalogPage(link.url, link.label),
            depth: depth + 1,
            provenance: "observed_link" as const,
          }))
        : [];
    await completeCatalogPage(job, page, category, depth, rules, targets);
  }

  async function processDiscoverySearch(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    const checkpoint = job.checkpoint;
    const runId = checkpoint.discoveryRunId;
    const rootUrl = checkpoint.discoveryRootUrl;
    const query = checkpoint.query;
    const sourceItemIds = safeStringArray(checkpoint.sourceItemIds, 12);
    const providerId = checkpoint.provider;
    if (
      typeof runId !== "string" ||
      !/^[a-f0-9]{64}$/.test(runId) ||
      typeof rootUrl !== "string" ||
      typeof query !== "string" ||
      query.length === 0 ||
      query.length > 300 ||
      !sourceItemIds.length ||
      !isSafeProviderId(providerId) ||
      providerId !== options.discovery?.searchProviderId
    ) {
      await finishDiscoveryUnavailable(job, "search_checkpoint_invalid");
      return;
    }
    if (checkpoint.retryExhausted === true) {
      await finishDiscoveryUnavailable(job, "retry_exhausted");
      return;
    }
    const provider = options.discovery?.enabled ? options.discovery.searchProvider : undefined;
    if (!provider) {
      await finishDiscoveryUnavailable(job, "search_provider_unavailable");
      return;
    }
    let rootHost: string;
    try {
      const root = validateCampaignResearchUrl(rootUrl);
      rootHost = root.hostname.toLowerCase();
    } catch {
      await finishDiscoveryUnavailable(job, "search_root_invalid");
      return;
    }

    let response: CampaignSearchResponse;
    try {
      response = await provider.search({ query, limit: 4, signal });
    } catch (error) {
      if (error instanceof CampaignSearchError && error.kind !== "transient") {
        await finishDiscoveryUnavailable(job, error.safeCode);
        return;
      }
      if (error instanceof CampaignSearchError) {
        throw new CampaignResearchError("transient", error.safeCode);
      }
      throw new CampaignResearchError("transient", "search_unavailable");
    }
    if (signal.aborted) throw new CampaignResearchError("transient", "search_aborted");
    if (
      response.query !== query ||
      response.provider !== providerId ||
      !Array.isArray(response.results)
    ) {
      await finishDiscoveryUnavailable(job, "search_response_invalid");
      return;
    }
    const observedAt = safeIsoDate(response.observedAt, now());
    const candidates = response.results.slice(0, 4).flatMap((result) => {
      const candidateUrl = canonicalDiscoveryUrl(result.url);
      if (!candidateUrl) return [];
      const parsed = new URL(candidateUrl);
      if (parsed.hostname.toLowerCase() === rootHost) return [];
      const title = safeDiscoveryText(result.title, 200);
      const snippet = safeDiscoveryText(result.snippet, 1_000);
      if (
        !title ||
        !snippet ||
        !Number.isSafeInteger(result.rank) ||
        result.rank <= 0 ||
        result.rank > 100_000
      )
        return [];
      const rank = result.rank;
      return [{ url: candidateUrl, title, snippet, rank }];
    });

    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const existingJobs = await tx.$queryRaw<Array<{ candidateUrl: string }>>`
        SELECT DISTINCT "checkpoint"->>'candidateUrl' AS "candidateUrl"
        FROM "campaign_jobs"
        WHERE "campaignId" = ${job.campaignId}
          AND "operation" = 'discovery_inspect'
          AND "checkpoint"->>'discoveryRunId' = ${runId}
          AND "checkpoint"->>'candidateUrl' IS NOT NULL
        ORDER BY "candidateUrl" ASC
      `;
      const existingUrls = new Set(existingJobs.map((row) => row.candidateUrl));
      const allowedCount = Math.max(0, 10 - existingUrls.size);
      let added = 0;
      for (const candidate of candidates) {
        if (existingUrls.has(candidate.url)) continue;
        if (added >= allowedCount) break;
        const suffix = stableHash(`${runId}\n${candidate.url}`);
        const candidateItemId = `discovery-candidate-${suffix}`;
        const inspectJobId = `discovery-inspect-${suffix}`;
        const discovery = {
          runId,
          rootUrl,
          purpose: "candidate",
          provider: providerId,
          query: query.slice(0, 300),
          sourceItemIds,
          rank: candidate.rank,
          observedAt,
          rulesLinks: [],
          platformHint: "unknown",
          inspection: "pending",
          eligibility: "needs_review",
          disposition: "unreviewed",
        };
        await tx.campaignItem.createMany({
          data: [
            {
              id: candidateItemId,
              campaignId: job.campaignId,
              kind: "opportunity",
              url: candidate.url,
              title: candidate.title,
              body: candidate.snippet,
              status: "queued",
              details: { discovery } as Prisma.InputJsonObject,
            },
          ],
          skipDuplicates: true,
        });
        await tx.campaignJob.createMany({
          data: [
            {
              id: inspectJobId,
              campaignId: job.campaignId,
              itemId: candidateItemId,
              operation: "discovery_inspect",
              status: "queued",
              checkpoint: {
                discoveryRunId: runId,
                discoveryRootUrl: rootUrl,
                discoveryPurpose: "inspect",
                candidateUrl: candidate.url,
                provider: providerId,
                query: query.slice(0, 300),
                sourceItemIds,
                rank: candidate.rank,
              } as Prisma.InputJsonObject,
            },
          ],
          skipDuplicates: true,
        });
        existingUrls.add(candidate.url);
        added += 1;
      }
      const source = await tx.campaignItem.findUnique({
        where: { id: job.itemId! },
        select: { details: true },
      });
      const details = record(source?.details);
      const discovery = record(details.discovery);
      await tx.campaignItem.updateMany({
        where: { id: job.itemId!, status: "researching" },
        data: {
          status: "verified",
          details: {
            ...details,
            discovery: {
              ...discovery,
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "unreviewed",
            },
          } as Prisma.InputJsonObject,
        },
      });
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const resultCount = candidates.length;
      await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: null,
          checkpoint: {
            ...record(current?.checkpoint),
            discoveryOutcome: resultCount === 0 ? "empty" : "complete",
            discoveryCandidateCount: resultCount,
            discoveryInsertedCount: added,
            discoveryCompletedAt: observedAt,
          } as Prisma.InputJsonObject,
        },
      });
      await appendEvent(
        tx,
        job.campaignId,
        "step_completed",
        resultCount === 0
          ? "Community search completed with no candidate results."
          : `Community search observed ${resultCount} candidate results; ${added} were queued for review.`,
        job.itemId,
      );
    });
  }

  async function processDiscoveryInspect(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    const checkpoint = job.checkpoint;
    const runId = checkpoint.discoveryRunId;
    const rootUrl = checkpoint.discoveryRootUrl;
    const candidateUrl = checkpoint.candidateUrl;
    if (
      typeof runId !== "string" ||
      !/^[a-f0-9]{64}$/.test(runId) ||
      typeof rootUrl !== "string" ||
      typeof candidateUrl !== "string" ||
      checkpoint.discoveryPurpose !== "inspect" ||
      !job.item ||
      job.item.url !== candidateUrl
    ) {
      await finishDiscoveryUnavailable(job, "inspection_checkpoint_invalid");
      return;
    }
    if (checkpoint.retryExhausted === true) {
      await finishDiscoveryUnavailable(job, "retry_exhausted");
      return;
    }
    let result: CampaignOpportunityInspection;
    try {
      result = await opportunityInspector({ url: candidateUrl, signal, now });
    } catch (error) {
      if (error instanceof CampaignOpportunityInspectionError && error.kind !== "transient") {
        await finishDiscoveryUnavailable(job, error.safeCode);
        return;
      }
      if (error instanceof CampaignOpportunityInspectionError) {
        throw new CampaignResearchError("transient", error.safeCode);
      }
      throw new CampaignResearchError("transient", "inspection_unavailable");
    }
    if (signal.aborted) throw new CampaignResearchError("transient", "inspection_aborted");
    let safeUrl: string;
    try {
      safeUrl = canonicalDiscoveryUrl(result.url) ?? "";
    } catch {
      safeUrl = "";
    }
    if (!safeUrl || new URL(safeUrl).origin !== new URL(candidateUrl).origin) {
      await finishDiscoveryUnavailable(job, "inspection_origin_invalid");
      return;
    }
    const title = safeDiscoveryText(result.title, 200);
    const excerpt = safeDiscoveryText(result.excerpt, 1_200);
    const observedAt = safeIsoDate(result.observedAt, now());
    if (!title || !excerpt) {
      await finishDiscoveryUnavailable(job, "inspection_evidence_missing");
      return;
    }
    const rulesLinks = result.rulesLinks.slice(0, 5).flatMap((link) => {
      const url = canonicalDiscoveryUrl(link.url);
      const label = safeDiscoveryText(link.label, 120);
      return url && label ? [{ url, label }] : [];
    });
    const platformHint = result.platformHint === "discourse" ? "discourse" : "unknown";
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const currentItem = await tx.campaignItem.findUnique({
        where: { id: job.item!.id },
        select: { details: true, status: true },
      });
      if (currentItem?.status !== "researching") return;
      const details = record(currentItem.details);
      const discovery = record(details.discovery);
      const evidence = { id: job.item!.id, url: safeUrl, title, excerpt, fetchedAt: observedAt };
      const itemUpdate = await tx.campaignItem.updateMany({
        where: { id: job.item!.id, status: "researching" },
        data: {
          title,
          body: excerpt,
          status: "needs_action",
          details: {
            ...details,
            discovery: {
              ...discovery,
              inspection: "observed",
              eligibility: "needs_review",
              disposition: "unreviewed",
              observedAt,
              rulesLinks,
              platformHint,
            },
            evidence: [evidence],
          } as Prisma.InputJsonObject,
        },
      });
      if (itemUpdate.count !== 1) return;
      const currentJob = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: "succeeded",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: null,
          checkpoint: {
            ...record(currentJob?.checkpoint),
            discoveryOutcome: "observed",
            discoveryCompletedAt: observedAt,
          } as Prisma.InputJsonObject,
        },
      });
      await appendEvent(
        tx,
        job.campaignId,
        "step_completed",
        "Community opportunity evidence was observed and needs human review.",
        job.itemId,
      );
    });
  }

  async function finishDiscoveryUnavailable(job: JobRecord, safeCode: string): Promise<void> {
    const code = /^[a-z0-9_]{1,64}$/.test(safeCode) ? safeCode : "discovery_unavailable";
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const updated = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: "needs_action",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: code,
          checkpoint: {
            ...record(current?.checkpoint),
            discoveryOutcome: "unavailable",
            discoverySafeError: code,
          } as Prisma.InputJsonObject,
        },
      });
      if (updated.count !== 1) return;
      if (job.itemId) {
        const item = await tx.campaignItem.findUnique({
          where: { id: job.itemId },
          select: { details: true },
        });
        const details = record(item?.details);
        const discovery = record(details.discovery);
        await tx.campaignItem.updateMany({
          where: { id: job.itemId, status: { in: ["queued", "researching"] } },
          data: {
            status: "needs_action",
            details: {
              ...details,
              discovery: {
                ...discovery,
                inspection: "unavailable",
                eligibility: "needs_review",
                disposition: "unreviewed",
              },
            } as Prisma.InputJsonObject,
          },
        });
      }
      await appendEvent(
        tx,
        job.campaignId,
        "step_blocked",
        job.operation === "discovery_search"
          ? "Community search is unavailable and needs attention."
          : "Community opportunity inspection is unavailable and needs attention.",
        job.itemId,
      );
    });
  }

  async function markDiscoveryUnavailable(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    _safeCode = "retry_exhausted",
  ): Promise<void> {
    if (!job.itemId || !job.operation.startsWith("discovery_")) return;
    const current = await tx.campaignItem.findUnique({
      where: { id: job.itemId },
      select: { details: true },
    });
    const details = record(current?.details);
    const discovery = record(details.discovery);
    await tx.campaignItem.updateMany({
      where: {
        id: job.itemId,
        status: { in: ["queued", "researching", "deferred", "needs_action"] },
      },
      data: {
        status: "needs_action",
        details: {
          ...details,
          discovery: {
            ...discovery,
            inspection: "unavailable",
            eligibility: "needs_review",
            disposition: "unreviewed",
          },
        } as Prisma.InputJsonObject,
      },
    });
  }

  async function completeCatalogPage(
    job: JobRecord,
    page: CampaignCatalogPage,
    category: string,
    depth: number,
    rules: CatalogRobotsRules,
    targets: CatalogTarget[],
  ): Promise<void> {
    const rootUrl = String(job.checkpoint.catalogRootUrl);
    const runId = String(job.checkpoint.catalogRunId);
    const guidance = job.checkpoint.catalogPurpose === "guidance";
    const observedLinks = safeObservedCatalogLinks(page.links, page.url);
    const excerpt = page.text.slice(0, 1_200);
    const evidence = {
      id: job.item!.id,
      url: page.url,
      title: page.title.slice(0, 200),
      excerpt,
      fetchedAt: page.fetchedAt,
    };
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const checkpoint = record(current?.checkpoint);
      const itemDetails = record(job.item!.details);
      const catalogDetails = record(itemDetails.catalog);
      const metadata = {
        runId,
        rootUrl,
        purpose: guidance ? "guidance" : "page",
        category,
        provenance:
          typeof catalogDetails.provenance === "string"
            ? catalogDetails.provenance
            : guidance
              ? "conventional_probe"
              : "observed_link",
        depth,
      };
      const observedRules = guidance
        ? [
            ...rules.allow.map((rule) => `Allow: ${rule}`),
            ...rules.disallow.map((rule) => `Disallow: ${rule}`),
            ...rules.sitemaps.map((url) => `Sitemap: ${url}`),
          ].slice(0, 50)
        : undefined;
      await tx.campaignItem.update({
        where: { id: job.item!.id },
        data: {
          title: (guidance ? "Website crawl guidance" : page.title).slice(0, 200),
          body: excerpt,
          status: "verified",
          details: {
            ...itemDetails,
            catalog: { ...catalogDetails, ...metadata },
            evidence: [evidence],
            observedLinks,
            ...(observedRules ? { observedRules } : {}),
          } as Prisma.InputJsonObject,
        },
      });

      const enqueueResult = await enqueueCatalogTargets(tx, job, targets, rules);
      const nextCheckpoint = {
        ...checkpoint,
        catalogOutcome:
          guidance && (page.httpStatus === 404 || page.httpStatus === 410)
            ? "guidance_absent"
            : "success",
        catalogCanonicalUrl: canonicalCatalogUrl(page.url, rootUrl) ?? job.item!.url,
        catalogFetchedAt: page.fetchedAt,
        catalogHttpStatus: page.httpStatus,
        catalogContentType: page.contentType,
        catalogProbe: catalogDetails.provenance === "conventional_probe",
        catalogObservedLinkCount: observedLinks.length,
        catalogSkippedCount: enqueueResult.skippedCount,
        catalogRules: serializeCatalogRules(rules),
        ...(enqueueResult.budgetExhausted ? { catalogBudgetExhausted: true } : {}),
      } as unknown as Prisma.InputJsonObject;
      const updated = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: "succeeded",
          checkpoint: nextCheckpoint,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: null,
        },
      });
      if (updated.count !== 1) return;
      await appendEvent(
        tx,
        job.campaignId,
        "step_completed",
        guidance && page.httpStatus === 404
          ? "Website guidance was absent; catalog discovery continued without declared robots rules."
          : `Catalog ${category} page recorded with ${observedLinks.length} observed link candidates.`,
        job.itemId,
      );
      await appendCatalogSummaryIfSettled(tx, job, nextCheckpoint);
    });
  }

  async function enqueueCatalogTargets(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    targets: CatalogTarget[],
    rules: CatalogRobotsRules,
  ): Promise<{ skippedCount: number; budgetExhausted: boolean }> {
    const runId = String(job.checkpoint.catalogRunId);
    const rootUrl = String(job.checkpoint.catalogRootUrl);
    const existing = await tx.$queryRaw<
      Array<{ id: string; checkpoint: Prisma.JsonValue; itemUrl: string | null }>
    >`
      SELECT j."id", j."checkpoint", i."url" AS "itemUrl"
      FROM "campaign_jobs" j
      LEFT JOIN "campaign_items" i ON i."id" = j."itemId"
      WHERE j."campaignId" = ${job.campaignId}
        AND j."operation" = 'catalog_page'
        AND j."checkpoint"->>'catalogRunId' = ${runId}
      FOR UPDATE OF j
    `;
    const knownUrls = new Set<string>();
    for (const entry of existing) {
      if (entry.itemUrl) {
        const canonical = canonicalCatalogUrl(entry.itemUrl, rootUrl);
        if (canonical) knownUrls.add(canonical);
      }
      const canonical = record(entry.checkpoint).catalogCanonicalUrl;
      if (typeof canonical === "string") knownUrls.add(canonical);
    }
    let totalUnique = existing.length;
    let skippedCount = 0;
    let budgetExhausted = false;
    for (const target of prioritizeCatalogTargets(targets)) {
      const canonical = canonicalCatalogUrl(target.url, rootUrl);
      if (!canonical) {
        skippedCount += 1;
        continue;
      }
      if (knownUrls.has(canonical)) continue;
      knownUrls.add(canonical);
      if (!isCatalogUrlAllowed(canonical, rules)) {
        skippedCount += 1;
        continue;
      }
      if (totalUnique >= MAX_CATALOG_PAGES_PER_RUN) {
        budgetExhausted = true;
        skippedCount += 1;
        continue;
      }
      const childHash = createHash("sha256")
        .update(JSON.stringify({ campaignId: job.campaignId, runId, url: canonical }))
        .digest("hex");
      const childItemId = `catalog-source-${childHash}`;
      const childJobId = `catalog-job-${childHash}`;
      const childDetails = {
        catalog: {
          runId,
          rootUrl,
          purpose: "page",
          category: target.category,
          provenance: target.provenance,
          depth: target.depth,
        },
      } as unknown as Prisma.InputJsonObject;
      const childCheckpoint = {
        catalogRunId: runId,
        catalogRootUrl: rootUrl,
        catalogPurpose: "page",
        catalogDepth: target.depth,
        catalogCanonicalUrl: canonical,
        catalogRules: serializeCatalogRules(rules),
      } as unknown as Prisma.InputJsonObject;
      await tx.campaignItem.upsert({
        where: { id: childItemId },
        create: {
          id: childItemId,
          campaignId: job.campaignId,
          kind: "source",
          url: canonical,
          title: target.label.slice(0, 200) || canonical,
          status: "queued",
          details: childDetails,
        },
        update: {},
      });
      await tx.campaignJob.upsert({
        where: { id: childJobId },
        create: {
          id: childJobId,
          campaignId: job.campaignId,
          itemId: childItemId,
          operation: "catalog_page",
          status: "queued",
          checkpoint: childCheckpoint,
        },
        update: {},
      });
      totalUnique += 1;
    }
    return { skippedCount, budgetExhausted };
  }

  async function finishCatalogFailure(
    job: JobRecord,
    safeCode: string,
    guidanceBlocked: boolean,
  ): Promise<void> {
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const checkpoint = record(current?.checkpoint);
      const skipped = safeCode === "robots_disallowed";
      const status = guidanceBlocked ? "needs_action" : skipped ? "succeeded" : "failed";
      const nextCheckpoint = {
        ...checkpoint,
        catalogOutcome: guidanceBlocked
          ? "blocked"
          : skipped
            ? "skipped"
            : safeCode === "page_absent"
              ? "not_found"
              : "failed",
        catalogSafeError: safeCode,
        ...(skipped
          ? { catalogSkippedCount: Number(checkpoint.catalogSkippedCount ?? 0) + 1 }
          : {}),
      } as Prisma.InputJsonObject;
      const updated = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status,
          checkpoint: nextCheckpoint,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: safeCode,
        },
      });
      if (updated.count !== 1) return;
      if (job.itemId) {
        await tx.campaignItem.updateMany({
          where: { id: job.itemId, status: { in: ["queued", "researching", "deferred"] } },
          data: { status: guidanceBlocked ? "needs_action" : "failed" },
        });
      }
      await appendEvent(
        tx,
        job.campaignId,
        guidanceBlocked ? "step_blocked" : skipped ? "step_completed" : "step_failed",
        guidanceBlocked
          ? "Website crawl guidance is unavailable or cannot be applied safely; automatic catalog crawling is blocked."
          : `Catalog page was ${skipped ? "skipped by robots rules" : `unavailable (${safeCode})`}.`,
        job.itemId,
      );
      await appendCatalogSummaryIfSettled(tx, job, nextCheckpoint);
    });
  }

  async function appendCatalogSummaryIfSettled(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    checkpointPatch: Record<string, unknown>,
  ): Promise<void> {
    const runId = checkpointPatch.catalogRunId;
    if (typeof runId !== "string") return;
    const rows = await tx.$queryRaw<
      Array<{ id: string; status: string; checkpoint: Prisma.JsonValue }>
    >`
      SELECT "id", "status", "checkpoint"
      FROM "campaign_jobs"
      WHERE "campaignId" = ${job.campaignId}
        AND "operation" = 'catalog_page'
        AND "checkpoint"->>'catalogRunId' = ${runId}
      FOR UPDATE
    `;
    const terminal = new Set(["succeeded", "failed", "needs_action", "cancelled"]);
    if (!rows.length || rows.some((row) => !terminal.has(row.status))) return;
    await seedDiscoverySearchJobs(tx, job, runId);
    if (rows.some((row) => record(row.checkpoint).catalogSummaryEmitted === true)) return;
    const successful = rows.filter((row) =>
      ["success", "guidance_absent"].includes(String(record(row.checkpoint).catalogOutcome)),
    ).length;
    const failed = rows.filter((row) =>
      ["failed", "blocked", "not_found"].includes(String(record(row.checkpoint).catalogOutcome)),
    ).length;
    const skipped = rows.reduce(
      (count, row) => count + Number(record(row.checkpoint).catalogSkippedCount ?? 0),
      0,
    );
    const guidanceBlocked = rows.some(
      (row) =>
        record(row.checkpoint).catalogPurpose === "guidance" &&
        record(row.checkpoint).catalogOutcome === "blocked",
    );
    const exhaustedBudget = rows.some(
      (row) => record(row.checkpoint).catalogBudgetExhausted === true,
    );
    const current = await tx.campaignJob.findUnique({
      where: { id: job.id },
      select: { checkpoint: true },
    });
    await tx.campaignJob.updateMany({
      where: { id: job.id, status: { in: [...terminal] } },
      data: {
        checkpoint: {
          ...record(current?.checkpoint),
          catalogSummaryEmitted: true,
        } as Prisma.InputJsonObject,
      },
    });
    await appendEvent(
      tx,
      job.campaignId,
      guidanceBlocked ? "step_blocked" : "step_completed",
      `Website catalog batch settled: ${successful} pages observed, ${failed} failed or unavailable, ${skipped} candidates skipped${exhaustedBudget ? `; the ${MAX_CATALOG_PAGES_PER_RUN}-page run limit was reached` : ""}.`,
      job.itemId,
    );
  }

  async function seedDiscoverySearchJobs(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    runId: string,
  ): Promise<void> {
    const rootUrl = String(job.checkpoint.catalogRootUrl ?? "");
    const guidance = await tx.$queryRaw<Array<{ id: string; checkpoint: Prisma.JsonValue }>>`
      SELECT "id", "checkpoint" FROM "campaign_jobs"
      WHERE "campaignId" = ${job.campaignId}
        AND "operation" = 'catalog_page'
        AND "checkpoint"->>'catalogRunId' = ${runId}
        AND "checkpoint"->>'catalogPurpose' = 'guidance'
      FOR UPDATE
    `;
    const guidanceRow = guidance[0];
    if (!guidanceRow) return;
    if (!options.discovery) return;
    const providerId = options.discovery?.searchProviderId;
    if (!options.discovery.enabled) {
      await recordDiscoveryBootstrap(
        tx,
        job,
        guidanceRow,
        "disabled",
        "Community discovery is disabled by worker configuration; no search queries were submitted.",
      );
      return;
    }
    if (!options.discovery.searchProvider || !isSafeProviderId(providerId)) {
      await recordDiscoveryBootstrap(
        tx,
        job,
        guidanceRow,
        "provider_unavailable",
        "Community search provider is unavailable; no search queries were submitted.",
      );
      return;
    }
    let rootOrigin: string;
    try {
      rootOrigin = validateCampaignResearchUrl(rootUrl).origin;
    } catch {
      await recordDiscoveryBootstrap(
        tx,
        job,
        guidanceRow,
        "root_invalid",
        "Community discovery could not use the configured website URL.",
      );
      return;
    }
    const existing = await tx.$queryRaw<Array<{ query: string }>>`
      SELECT "checkpoint"->>'query' AS "query" FROM "campaign_jobs"
      WHERE "campaignId" = ${job.campaignId}
        AND "operation" = 'discovery_search'
        AND "checkpoint"->>'discoveryRunId' = ${runId}
    `;
    const existingQueries = new Set(existing.map((row) => row.query));

    const sourceRows = await tx.$queryRaw<
      Array<{ id: string; url: string | null; title: string; body: string }>
    >`
      SELECT i."id", i."url", i."title", i."body"
      FROM "campaign_jobs" j
      JOIN "campaign_items" i ON i."id" = j."itemId"
      WHERE j."campaignId" = ${job.campaignId}
        AND j."operation" = 'catalog_page'
        AND j."status" = 'succeeded'
        AND j."checkpoint"->>'catalogRunId' = ${runId}
        AND j."checkpoint"->>'catalogContentType' IN ('text/html', 'text/plain')
        AND COALESCE(j."checkpoint"->>'catalogProbe', 'true') = 'false'
        AND i."status" = 'verified'
        AND i."url" IS NOT NULL
        AND i."details"->'catalog'->>'runId' = ${runId}
        AND i."details"->'catalog'->>'purpose' = 'page'
      ORDER BY j."createdAt" ASC, i."id" ASC
      LIMIT 12
    `;
    const sources = sourceRows.filter((source) => {
      try {
        return validateCampaignResearchUrl(source.url ?? "").origin === rootOrigin;
      } catch {
        return false;
      }
    });
    if (sources.length === 0) {
      await recordDiscoveryBootstrap(
        tx,
        job,
        guidanceRow,
        "no_eligible_evidence",
        "No verified official-site content pages were available to derive community searches.",
      );
      return;
    }
    const sourceItemIds = sources.map((source) => source.id).slice(0, 12);
    const queries = deriveCampaignSearchQueries({
      websiteUrl: rootUrl,
      sources: sources.flatMap((source) =>
        source.url ? [{ url: source.url, title: source.title, text: source.body }] : [],
      ),
    })
      .filter((query) => !existingQueries.has(query))
      .slice(0, Math.max(0, 3 - existingQueries.size));
    if (queries.length === 0) {
      if (existingQueries.size >= 3) return;
      await recordDiscoveryBootstrap(
        tx,
        job,
        guidanceRow,
        "no_eligible_evidence",
        "Verified official-site pages did not contain enough terms to derive a community search.",
      );
      return;
    }
    for (const query of queries) {
      const suffix = stableHash(`${runId}\n${query}`);
      const itemId = `discovery-source-${suffix}`;
      const jobId = `discovery-search-${suffix}`;
      const discovery = {
        runId,
        rootUrl,
        purpose: "search",
        provider: providerId,
        query: query.slice(0, 300),
        sourceItemIds,
        inspection: "pending",
        eligibility: "needs_review",
        disposition: "unreviewed",
      };
      await tx.campaignItem.createMany({
        data: [
          {
            id: itemId,
            campaignId: job.campaignId,
            kind: "source",
            url: rootUrl,
            title: `Community search: ${query}`.slice(0, 200),
            body: query,
            status: "queued",
            details: { discovery } as Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      await tx.campaignJob.createMany({
        data: [
          {
            id: jobId,
            campaignId: job.campaignId,
            itemId,
            operation: "discovery_search",
            status: "queued",
            checkpoint: {
              discoveryRunId: runId,
              discoveryRootUrl: rootUrl,
              discoveryPurpose: "search",
              provider: providerId,
              query: query.slice(0, 300),
              sourceItemIds,
              createdFromCatalogJobId: job.id,
            } as Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
    }
    const currentGuidance = await tx.campaignJob.findUnique({
      where: { id: guidanceRow.id },
      select: { checkpoint: true },
    });
    await tx.campaignJob.update({
      where: { id: guidanceRow.id },
      data: {
        checkpoint: {
          ...record(currentGuidance?.checkpoint),
          discoverySeeded: true,
          discoveryQueryCount: existingQueries.size + queries.length,
          discoverySourceItemIds: sourceItemIds,
          discoveryBootstrapOutcome: "seeded",
          discoveryBootstrapEventEmitted: true,
        } as Prisma.InputJsonObject,
      },
    });
    await appendEvent(
      tx,
      job.campaignId,
      "item_added",
      `Community discovery queued ${queries.length} search queries from verified website pages.`,
      guidanceRow.id,
    );
  }

  async function recordDiscoveryBootstrap(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    guidance: { id: string; checkpoint: Prisma.JsonValue },
    outcome: string,
    summary: string,
  ): Promise<void> {
    const current = await tx.campaignJob.findUnique({
      where: { id: guidance.id },
      select: { checkpoint: true },
    });
    const checkpoint = record(current?.checkpoint);
    await tx.campaignJob.update({
      where: { id: guidance.id },
      data: {
        checkpoint: {
          ...checkpoint,
          discoveryBootstrapOutcome: outcome,
          ...(!checkpoint.discoveryBootstrapEventEmitted
            ? { discoveryBootstrapEventEmitted: true }
            : {}),
        } as Prisma.InputJsonObject,
      },
    });
    if (!checkpoint.discoveryBootstrapEventEmitted) {
      await appendEvent(tx, job.campaignId, "step_completed", summary, guidance.id);
    }
  }

  async function generateDraft(
    job: JobRecord,
    evidence: CampaignResearchEvidence,
    projectContext: ProjectContextSelection,
    signal: AbortSignal,
  ): Promise<GeneratedDraft> {
    const source: CampaignDraftSource = {
      url: evidence.url,
      title: evidence.title,
      text: evidence.text.slice(0, 18_000),
    };
    const campaignConfig = record(job.campaign.config);
    const campaign = {
      objective: stringOrEmpty(campaignConfig.objective),
      websiteUrl: stringOrEmpty(campaignConfig.websiteUrl),
      language: stringOrEmpty(campaignConfig.language),
      market: stringOrEmpty(campaignConfig.market),
    };
    const provider = options.aiDrafting?.provider;
    const maxReservation = options.aiDrafting?.maxReservationMicros;
    if (
      options.aiDrafting?.enabled !== true ||
      !provider ||
      !options.aiDrafting.ownerUserId ||
      !Number.isSafeInteger(maxReservation) ||
      (maxReservation ?? 0) <= 0 ||
      !Object.values(campaign).every((value) => value.length > 0)
    ) {
      return deterministicDraft(evidence, projectContext);
    }
    const metadata = provider.describe();
    if (!metadata.configured || !metadata.pricingAvailable)
      return deterministicDraft(evidence, projectContext);
    let reservationMicros: number;
    try {
      const estimate = provider.estimateReservationMicros({
        campaign,
        source,
        projectSources: projectContext.projectSources,
        maxOutputTokens: 2_048,
      });
      reservationMicros = estimate.estimatedCostMicros;
      if (
        estimate.isEstimate !== true ||
        !Number.isSafeInteger(reservationMicros) ||
        reservationMicros <= 0 ||
        reservationMicros > maxReservation!
      ) {
        return deterministicDraft(evidence, projectContext);
      }
    } catch {
      return deterministicDraft(evidence, projectContext);
    }
    const reserved = await reserveAiDraft(job, reservationMicros, projectContext, evidence);
    if (reserved === "ambiguous") {
      return {
        ...deterministicDraft(evidence, projectContext),
        aiState: "ambiguous",
        aiReservationMicros: String(reservationMicros),
        aiActualCostMicros: null,
        jobStatus: "needs_action",
      };
    }
    if (!reserved) return deterministicDraft(evidence, await selectProjectContext(job));

    const suppliedContext = persistedProjectContext(projectContext, "supplied");

    let output: Awaited<ReturnType<CampaignDraftProvider["generate"]>>;
    try {
      output = await provider.generate({
        campaign,
        source,
        projectSources: projectContext.projectSources,
        maxCostMicros: reservationMicros,
        maxOutputTokens: 2_048,
        signal,
      });
    } catch (error) {
      const usage = error instanceof CampaignDraftError ? error.usage : null;
      if (error instanceof CampaignDraftError) {
        await persistAiOutcome(job, safeMicros(usage?.costMicros));
      }
      return {
        ...deterministicDraft(
          evidence,
          projectContext,
          "The optional model draft could not be confirmed.",
        ),
        aiState: "ambiguous",
        aiReservationMicros: String(reservationMicros),
        aiActualCostMicros: safeMicros(usage?.costMicros),
        jobStatus: "needs_action",
        projectContext: suppliedContext,
        projectEvidence: projectContext.evidence,
      };
    }
    await persistAiOutcome(job, safeMicros(output.usage.costMicros));
    const validOutput = isValidDraftOutput(output, [
      evidence.url,
      ...projectContext.projectSources.map((source) => source.url),
    ]);
    return {
      body: validOutput ? output.body.trim() : deterministicDraft(evidence, projectContext).body,
      rationale: validOutput
        ? output.rationale.slice(0, 2_000)
        : "The model response needs editing; source notes are shown for human review.",
      sourceUrls: validOutput ? output.sourceUrls : [evidence.url],
      aiState: "ready",
      aiReservationMicros: String(reservationMicros),
      aiActualCostMicros: safeMicros(output.usage.costMicros),
      projectContext: suppliedContext,
      projectEvidence: projectContext.evidence,
    };
  }

  async function selectProjectContext(job: JobRecord): Promise<ProjectContextSelection> {
    const currentCampaign = await options.prisma.campaign.findUnique({
      where: { id: job.campaignId },
      select: { config: true },
    });
    const currentRoot = stringOrEmpty(record(currentCampaign?.config).websiteUrl);
    return loadProjectContext(options.prisma, job, currentRoot || undefined);
  }

  async function projectContextStillValid(
    tx: Prisma.TransactionClient,
    job: JobRecord,
    selected: ProjectContextSelection,
    currentRootUrl: string,
  ): Promise<boolean> {
    const current = await loadProjectContext(tx, job, currentRootUrl);
    return (
      current.rootUrl === selected.rootUrl &&
      current.runId === selected.runId &&
      JSON.stringify(current.sourceIds) === JSON.stringify(selected.sourceIds) &&
      JSON.stringify(current.projectSources) === JSON.stringify(selected.projectSources)
    );
  }

  async function persistAiOutcome(job: JobRecord, actualCostMicros: string | null): Promise<void> {
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const checkpoint = record(current?.checkpoint);
      if (checkpoint.aiState !== "intent") return;
      await tx.campaignJob.updateMany({
        where: {
          id: job.id,
          status: "running",
          leaseOwner: workerId,
          leaseFence: job.leaseFence,
        },
        data: {
          checkpoint: {
            ...checkpoint,
            aiActualCostMicros: actualCostMicros,
          } as Prisma.InputJsonObject,
          heartbeatAt: now(),
        },
      });
    });
  }

  async function reserveAiDraft(
    job: JobRecord,
    reservationMicros: number,
    projectContext: ProjectContextSelection,
    targetEvidence: CampaignResearchEvidence,
  ): Promise<boolean | "ambiguous"> {
    const aiConfig = options.aiDrafting;
    if (!aiConfig?.ownerUserId) return false;
    const dayStart = new Date(now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayKey = dayStart.toISOString().slice(0, 10);
    return options.prisma.$transaction(
      async (tx) => {
        if (!(await fencedActive(tx, job))) return false;
        const [campaign, currentJob] = await Promise.all([
          tx.campaign.findUnique({
            where: { id: job.campaignId },
            select: { userId: true, config: true },
          }),
          tx.campaignJob.findUnique({ where: { id: job.id }, select: { checkpoint: true } }),
        ]);
        if (!campaign || campaign.userId !== aiConfig.ownerUserId) return false;
        const currentCheckpoint = record(currentJob?.checkpoint);
        if (currentCheckpoint.aiState === "intent") {
          return "ambiguous";
        }
        const config = record(campaign.config);
        let currentRootUrl: string;
        try {
          const parsedRoot = validateCampaignResearchUrl(stringOrEmpty(config.websiteUrl));
          parsedRoot.hash = "";
          currentRootUrl = parsedRoot.toString();
        } catch {
          return false;
        }
        let claimedRootUrl: string;
        try {
          const parsedRoot = validateCampaignResearchUrl(
            stringOrEmpty(record(job.campaign.config).websiteUrl),
          );
          parsedRoot.hash = "";
          claimedRootUrl = parsedRoot.toString();
        } catch {
          return false;
        }
        if (
          currentRootUrl !== claimedRootUrl ||
          currentRootUrl !== projectContext.rootUrl ||
          !(await projectContextStillValid(tx, job, projectContext, currentRootUrl))
        )
          return false;
        const dailyLimit = config.dailySpendLimitMicros;
        if (!Number.isSafeInteger(dailyLimit) || Number(dailyLimit) <= 0) return false;
        const spent = await getCampaignDailyReservedSpendMicros(tx, job.campaignId, dayStart);
        if (spent + BigInt(reservationMicros) > BigInt(Number(dailyLimit))) return false;
        const updated = await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            checkpoint: {
              ...currentCheckpoint,
              aiState: "intent",
              aiReservedDay: dayKey,
              aiReservationMicros: String(reservationMicros),
              aiActualCostMicros: null,
              aiProjectContext: persistedProjectContext(projectContext, "supplied"),
              aiProjectSources: projectContext.projectSources,
              aiProjectEvidence: projectContext.evidence,
            } as unknown as Prisma.InputJsonObject,
            heartbeatAt: now(),
          },
        });
        if (updated.count !== 1) return false;
        const currentItem = await tx.campaignItem.findUnique({
          where: { id: job.itemId! },
          select: { details: true },
        });
        const targetEntry = targetEvidenceEntry(job, targetEvidence);
        await tx.campaignItem.update({
          where: { id: job.itemId! },
          data: {
            details: {
              ...record(currentItem?.details),
              projectContext: persistedProjectContext(projectContext, "supplied"),
              evidence: [targetEntry, ...projectContext.evidence],
              evidenceIds: [targetEntry.id, ...projectContext.sourceIds],
            } as unknown as Prisma.InputJsonObject,
          },
        });
        return true;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async function completeResearch(
    job: JobRecord,
    evidence: CampaignResearchEvidence,
    generated: Awaited<ReturnType<typeof generateDraft>>,
  ): Promise<void> {
    const excerpt = evidence.text.slice(0, 1_200);
    const evidenceEntry = {
      id: job.item!.id,
      url: evidence.url,
      title: evidence.title,
      excerpt,
      fetchedAt: evidence.fetchedAt,
    };
    const draftId = `${job.id}-draft`;
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      await tx.campaignItem.update({
        where: { id: job.item!.id },
        data: {
          title: evidence.title.slice(0, 200),
          body: excerpt,
          status: generated.jobStatus === "needs_action" ? "needs_action" : "verified",
          details: {
            ...record(
              (
                await tx.campaignItem.findUnique({
                  where: { id: job.item!.id },
                  select: { details: true },
                })
              )?.details,
            ),
            projectContext: generated.projectContext,
            evidence: [evidenceEntry, ...generated.projectEvidence],
            evidenceIds: [evidenceEntry.id, ...generated.projectContext.sourceIds],
          } as unknown as Prisma.InputJsonObject,
        },
      });
      await tx.campaignItem.upsert({
        where: { id: draftId },
        create: {
          id: draftId,
          campaignId: job.campaignId,
          kind: "draft",
          url: evidence.url,
          title: `Draft suggestion: ${evidence.title}`.slice(0, 200),
          body: generated.body.slice(0, 20_000),
          status: "needs_action",
          details: {
            projectContext: generated.projectContext,
            evidence: [evidenceEntry, ...generated.projectEvidence],
            evidenceIds: [evidenceEntry.id, ...generated.projectContext.sourceIds],
            rationale: generated.rationale.slice(0, 2_000),
            reviewDecision: "awaiting_edit_and_human_approval",
          } as unknown as Prisma.InputJsonObject,
        },
        update: {},
      });
      const currentJob = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const checkpoint = {
        ...record(currentJob?.checkpoint),
        draftId,
        result: "research_complete",
        ...(generated.aiState
          ? {
              aiState: generated.aiState,
              aiReservationMicros: generated.aiReservationMicros ?? null,
              aiActualCostMicros: generated.aiActualCostMicros ?? null,
            }
          : {}),
      };
      await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: generated.jobStatus ?? "succeeded",
          checkpoint: checkpoint as Prisma.InputJsonObject,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: generated.aiState === "ambiguous" ? "ai_result_ambiguous" : null,
        },
      });
      await appendEvent(
        tx,
        job.campaignId,
        generated.jobStatus === "needs_action" ? "step_blocked" : "step_completed",
        generated.aiState === "ready"
          ? "Source research and a model-assisted draft are ready for human review."
          : generated.aiState === "ambiguous"
            ? "Source notes are ready; model drafting needs manual review after an uncertain result."
            : "Research completed; a source-based draft is waiting for human review.",
        job.item!.id,
      );
    });
  }

  async function controlledFixture(job: JobRecord): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    if (job.checkpoint.retryExhausted === true) {
      await finish(
        job,
        "needs_action",
        "step_blocked",
        "Controlled test work needs attention after the retry limit.",
        "worker_deadline_exceeded",
      );
      return;
    }
    const phase = job.checkpoint.fixtureStage;
    if (!phase) {
      const transientId = `${job.campaignId}-controlled-transient`;
      const goodId = `${job.campaignId}-controlled-good`;
      const sourceId = `${job.campaignId}-controlled-source`;
      const accountId = `${job.campaignId}-controlled-account`;
      const draftId = `${job.campaignId}-controlled-draft`;
      const retryAt = new Date(now().getTime() + CONTROLLED_DEFER_MS);
      await options.prisma.$transaction(async (tx) => {
        if (!(await fencedActive(tx, job))) return;
        await tx.campaignItem.upsert({
          where: { id: sourceId },
          create: {
            id: sourceId,
            campaignId: job.campaignId,
            kind: "source",
            url: "https://fixture.invalid/source",
            title: "Controlled test source",
            body: "Controlled test fixture evidence: a public page title and a short example passage.",
            status: "verified",
            details: {
              label: "Controlled test",
              evidence: [
                {
                  id: sourceId,
                  url: "https://fixture.invalid/source",
                  title: "Controlled test source",
                  excerpt:
                    "Controlled test fixture evidence: a public page title and a short example passage.",
                },
              ],
            } as Prisma.InputJsonObject,
          },
          update: {},
        });
        await tx.campaignItem.upsert({
          where: { id: accountId },
          create: {
            id: accountId,
            campaignId: job.campaignId,
            kind: "account",
            url: "https://fixture.invalid/community",
            title: "Controlled test account",
            body: "Fixture account record",
            status: "verified",
            details: {
              label: "Controlled test",
              emailConfirmation: {
                status: "confirmed",
                evidence: "Synthetic confirmation fixture; no email was sent",
              },
            } as Prisma.InputJsonObject,
          },
          update: {},
        });
        const transientRetryAt = new Date(retryAt.getTime() + CONTROLLED_DEFER_MS);
        await tx.campaignItem.upsert({
          where: { id: transientId },
          create: {
            id: transientId,
            campaignId: job.campaignId,
            kind: "opportunity",
            url: "https://fixture.invalid/timeout",
            title: "Controlled test transient opportunity",
            body: "Fixture opportunity with one deliberate transient timeout.",
            status: "deferred",
            details: {
              label: "Controlled test",
              deferReason: "Controlled test transient timeout",
              retryAfter: transientRetryAt.toISOString(),
            } as Prisma.InputJsonObject,
          },
          update: {
            status: "deferred",
            details: {
              label: "Controlled test",
              deferReason: "Controlled test transient timeout",
              retryAfter: transientRetryAt.toISOString(),
            } as Prisma.InputJsonObject,
          },
        });
        await tx.campaignItem.upsert({
          where: { id: goodId },
          create: {
            id: goodId,
            campaignId: job.campaignId,
            kind: "opportunity",
            url: "https://fixture.invalid/good",
            title: "Controlled test opportunity",
            body: "A deterministic fixture opportunity supported by the fixture source.",
            status: "ready",
            details: { label: "Controlled test", sourceId } as Prisma.InputJsonObject,
          },
          update: {},
        });
        await tx.campaignItem.upsert({
          where: { id: draftId },
          create: {
            id: draftId,
            campaignId: job.campaignId,
            kind: "draft",
            url: "https://fixture.invalid/good",
            title: "Controlled test draft",
            body: "Controlled test draft based only on the fixture source. Please review before local fixture publication.",
            status: "needs_action",
            details: {
              label: "Controlled test",
              sourceId,
              opportunityId: goodId,
              accountId,
              evidence: [
                {
                  id: sourceId,
                  url: "https://fixture.invalid/source",
                  title: "Controlled test source",
                  excerpt:
                    "Controlled test fixture evidence: a public page title and a short example passage.",
                },
              ],
              reviewDecision: "awaiting_human_approval",
            } as Prisma.InputJsonObject,
          },
          update: {},
        });
        await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "deferred",
            availableAt: retryAt,
            checkpoint: {
              ...job.checkpoint,
              fixtureStage: "transient_deferred",
              transientOpportunityId: transientId,
              goodOpportunityId: goodId,
              fixtureSourceId: sourceId,
              fixtureAccountId: accountId,
              draftId,
            },
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: "transient_timeout",
          },
        });
        await appendEvent(
          tx,
          job.campaignId,
          "step_deferred",
          "Controlled test opportunity timed out once; retry deferred so another fixture opportunity can proceed.",
          transientId,
        );
      });
      return;
    }
    if (phase === "transient_deferred") {
      const items = await options.prisma.campaignItem.findMany({
        where: {
          id: {
            in: [
              String(job.checkpoint.transientOpportunityId),
              String(job.checkpoint.goodOpportunityId),
            ],
          },
        },
        select: {
          id: true,
          kind: true,
          status: true,
          createdAt: true,
          details: true,
          updatedAt: true,
        },
      });
      const good = items.find(
        (item: { id: string }) => item.id === job.checkpoint.goodOpportunityId,
      );
      const transient = items.find(
        (item: { id: string }) => item.id === job.checkpoint.transientOpportunityId,
      );
      let candidates = [
        ...(good
          ? [
              {
                id: good.id,
                siteKey: "fixture.invalid",
                status: "queued" as const,
                retryAtMs: null,
                createdAtMs: good.createdAt.getTime(),
              },
            ]
          : []),
        ...(transient
          ? [
              {
                id: transient.id,
                siteKey: "fixture.invalid",
                status: "deferred" as const,
                retryAtMs: new Date(String(record(transient.details).retryAfter)).getTime(),
                createdAtMs: transient.createdAt.getTime(),
              },
            ]
          : []),
      ];
      let selected = selectNextCampaignOpportunity({
        campaignStatus: "active",
        nowMs: now().getTime(),
        candidates,
        siteAvailability: [],
      });
      const transientRetried =
        selected.action === "select" &&
        selected.opportunityId === job.checkpoint.transientOpportunityId;
      if (transientRetried && transient) {
        candidates = candidates.filter((candidate) => candidate.id !== transient.id);
        selected = selectNextCampaignOpportunity({
          campaignStatus: "active",
          nowMs: now().getTime(),
          candidates,
          siteAvailability: [],
        });
      }
      if (
        selected.action !== "select" ||
        selected.opportunityId !== job.checkpoint.goodOpportunityId
      ) {
        await options.prisma.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "deferred",
            availableAt: new Date(now().getTime() + CONTROLLED_DEFER_MS),
            checkpoint: job.checkpoint as Prisma.InputJsonObject,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        return;
      }
      if (!(await isDispatchAllowed(job))) return;
      await options.prisma.$transaction(async (tx) => {
        if (!(await fencedActive(tx, job))) return;
        await tx.campaignItem.update({
          where: { id: String(job.checkpoint.goodOpportunityId) },
          data: { status: "needs_action" },
        });
        await tx.campaignItem.update({
          where: { id: String(job.checkpoint.draftId) },
          data: { status: "needs_action" },
        });
        await tx.campaignItem.update({
          where: { id: String(job.checkpoint.transientOpportunityId) },
          data: {
            status: "needs_action",
            details: {
              label: "Controlled test",
              simulatedFailure: "transient_timeout",
              outcome: "deferred_once_then_good_opportunity_selected",
            },
          },
        });
        if (job.itemId)
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: "researching" },
            data: { status: "needs_action" },
          });
        await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "waiting_review",
            checkpoint: { ...job.checkpoint, fixtureStage: "waiting_review" },
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: null,
          },
        });
        await appendEvent(
          tx,
          job.campaignId,
          "step_completed",
          transientRetried
            ? "Controlled test retry timed out once; the good opportunity was selected and its draft is waiting for approval."
            : "Controlled test fixture is ready; its draft is waiting for human approval.",
          String(job.checkpoint.draftId),
        );
      });
      return;
    }
    await finish(job, "needs_action", "step_blocked", "Controlled test fixture needs attention.");
  }

  async function controlledPublish(job: JobRecord): Promise<void> {
    if (!(await isDispatchAllowed(job))) return;
    const draft = job.item;
    const checkpoint = job.checkpoint;
    if (
      draft?.status !== "approved" ||
      typeof checkpoint.approvalHash !== "string" ||
      typeof checkpoint.approvedUpdatedAt !== "string"
    ) {
      await finish(
        job,
        "needs_action",
        "step_blocked",
        "Controlled test approval changed; review is required again.",
      );
      return;
    }
    const details = record(draft.details);
    if (
      details.approvalVersion !== checkpoint.approvalHash ||
      details.approvedUpdatedAt !== checkpoint.approvedUpdatedAt ||
      draft.updatedAt.toISOString() !== checkpoint.approvedUpdatedAt
    ) {
      await finish(
        job,
        "needs_action",
        "step_blocked",
        "Controlled test approval version no longer matches the draft.",
      );
      return;
    }
    const phase = checkpoint.fixtureStage;
    if (!phase) {
      if (!(await isDispatchAllowed(job))) return;
      const publicationId = `${job.id}-publication`;
      await options.prisma.$transaction(async (tx) => {
        if (!(await fencedActive(tx, job))) return;
        if (
          !(await lockApprovedDraft(
            tx,
            draft.id,
            checkpoint.approvalHash as string,
            checkpoint.approvedUpdatedAt as string,
          ))
        ) {
          await tx.campaignJob.updateMany({
            where: {
              id: job.id,
              status: "running",
              leaseOwner: workerId,
              leaseFence: job.leaseFence,
            },
            data: {
              status: "needs_action",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: "approval_changed",
            },
          });
          return;
        }
        await tx.campaignItem.upsert({
          where: { id: publicationId },
          create: {
            id: publicationId,
            campaignId: job.campaignId,
            kind: "publication",
            url: "https://fixture.invalid/published",
            title: "Controlled test publication",
            body: draft.body,
            status: "submitted",
            details: {
              label: "Controlled test",
              sourceDraftId: draft.id,
              approvalHash: checkpoint.approvalHash,
              approvedUpdatedAt: checkpoint.approvedUpdatedAt,
              effect: "local_fixture_only",
            } as Prisma.InputJsonObject,
          },
          update: {},
        });
        await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "deferred",
            availableAt: new Date(now().getTime() + 100),
            checkpoint: { ...checkpoint, fixtureStage: "fixture_published", publicationId },
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: null,
          },
        });
        await appendEvent(
          tx,
          job.campaignId,
          "step_completed",
          "Controlled test draft was published to the local fixture.",
          publicationId,
        );
      });
      return;
    }
    if (phase === "fixture_published") {
      if (!(await isDispatchAllowed(job))) return;
      const publicationId = String(checkpoint.publicationId);
      await options.prisma.$transaction(async (tx) => {
        if (!(await fencedActive(tx, job))) return;
        if (
          !(await lockApprovedDraft(
            tx,
            draft.id,
            checkpoint.approvalHash as string,
            checkpoint.approvedUpdatedAt as string,
          ))
        ) {
          await tx.campaignJob.updateMany({
            where: {
              id: job.id,
              status: "running",
              leaseOwner: workerId,
              leaseFence: job.leaseFence,
            },
            data: {
              status: "needs_action",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: "approval_changed",
            },
          });
          return;
        }
        const observed = await tx.campaignItem.findUnique({ where: { id: publicationId } });
        const latestDraft = await tx.campaignItem.findUnique({ where: { id: draft.id } });
        if (
          !observed ||
          !latestDraft ||
          latestDraft.status !== "approved" ||
          record(latestDraft.details).approvalVersion !== checkpoint.approvalHash ||
          record(latestDraft.details).approvedUpdatedAt !== checkpoint.approvedUpdatedAt ||
          latestDraft.updatedAt.toISOString() !== checkpoint.approvedUpdatedAt
        ) {
          await tx.campaignJob.updateMany({
            where: {
              id: job.id,
              status: "running",
              leaseOwner: workerId,
              leaseFence: job.leaseFence,
            },
            data: {
              status: "needs_action",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: "approval_changed",
            },
          });
          return;
        }
        await tx.campaignItem.update({
          where: { id: publicationId },
          data: {
            status: "verified",
            details: {
              ...record(observed.details),
              verification: {
                label: "Controlled test",
                method: "independent_fixture_read",
                verifiedAt: now().toISOString(),
              },
            },
          },
        });
        await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "succeeded",
            checkpoint: { ...checkpoint, fixtureStage: "verified" },
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: null,
          },
        });
        await appendEvent(
          tx,
          job.campaignId,
          "step_completed",
          "Controlled test publication was independently verified in the local fixture.",
          publicationId,
        );
      });
      return;
    }
    await finish(
      job,
      "needs_action",
      "step_blocked",
      "Controlled test publication needs attention.",
    );
  }

  async function handleFailure(job: JobRecord, error: unknown): Promise<void> {
    const failureKind = error instanceof CampaignResearchError ? error.kind : "transient";
    const safeCode = error instanceof CampaignResearchError ? error.safeCode : "worker_error";
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: {
          status: true,
          leaseOwner: true,
          leaseFence: true,
          checkpoint: true,
          attemptCount: true,
          maxAttempts: true,
          startedAt: true,
        },
      });
      if (
        current?.status !== "running" ||
        current.leaseOwner !== workerId ||
        current.leaseFence !== job.leaseFence
      )
        return;

      const checkpoint = record(current.checkpoint);
      const aiState = checkpoint.aiState;
      if (aiState === "intent" || aiState === "ambiguous" || aiState === "ready") {
        const updated = await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "needs_action",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: "ai_result_ambiguous",
            checkpoint: { ...checkpoint, aiState: "ambiguous" } as Prisma.InputJsonObject,
          },
        });
        if (updated.count !== 1) return;
        if (job.itemId) {
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: { in: ["queued", "researching"] } },
            data: { status: "needs_action" },
          });
        }
        await appendEvent(
          tx,
          job.campaignId,
          "step_blocked",
          "A model request may have completed, but its draft could not be confirmed. Source notes need human review before retrying.",
          job.itemId,
        );
        return;
      }

      if (checkpoint.retryExhausted === true) {
        const updated = await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: "needs_action",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: safeCode,
            checkpoint: (job.operation.startsWith("discovery_")
              ? {
                  ...checkpoint,
                  discoveryOutcome: "unavailable",
                  discoverySafeError: safeCode,
                }
              : checkpoint) as Prisma.InputJsonObject,
          },
        });
        if (updated.count !== 1) return;
        if (job.itemId) {
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: { in: ["queued", "researching"] } },
            data: { status: "needs_action" },
          });
          await markDiscoveryUnavailable(tx, job);
        }
        await appendEvent(
          tx,
          job.campaignId,
          "step_blocked",
          "Work needs attention after the retry limit.",
          job.itemId,
        );
        return;
      }

      const decision = decideCampaignFailure({
        nowMs: now().getTime(),
        campaignStatus: "active",
        failureKind,
        effectState: "not_started",
        attemptNumber: current.attemptCount,
        maxAttempts: current.maxAttempts,
        stepStartedAtMs: (current.startedAt ?? now()).getTime(),
        stepTimeBudgetMs: STEP_BUDGET_MS,
        retryBaseMs: RETRY_BASE_MS,
        retryMaxMs: RETRY_MAX_MS,
        deferMs: DEFER_MS,
      });
      if (decision.action === "retry" || decision.action === "defer") {
        const retryAt = new Date(decision.retryAtMs);
        const retryCheckpoint = {
          ...checkpoint,
          siteBlockedSite: siteKey(job),
          siteBlockedUntil: retryAt.toISOString(),
          ...(decision.action === "defer" ? { retryExhausted: true } : {}),
        };
        const updated = await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: decision.action === "retry" ? "queued" : "deferred",
            availableAt: retryAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: safeCode,
            checkpoint: retryCheckpoint as Prisma.InputJsonObject,
          },
        });
        if (updated.count !== 1) return;
        if (job.itemId) {
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: { in: ["queued", "researching"] } },
            data: { status: "deferred" },
          });
        }
        await appendEvent(
          tx,
          job.campaignId,
          "step_deferred",
          decision.action === "retry"
            ? "Work will retry after a temporary error."
            : "Work is deferred after temporary errors.",
          job.itemId,
        );
        return;
      }
      if (decision.action === "needs_action" || decision.action === "fail") {
        const isDiscovery = job.operation.startsWith("discovery_");
        const jobStatus = decision.action === "fail" && !isDiscovery ? "failed" : "needs_action";
        const updated = await tx.campaignJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            leaseOwner: workerId,
            leaseFence: job.leaseFence,
          },
          data: {
            status: jobStatus,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now(),
            lastError: safeCode,
            checkpoint: (isDiscovery
              ? {
                  ...checkpoint,
                  discoveryOutcome: "unavailable",
                  discoverySafeError: safeCode,
                }
              : checkpoint) as Prisma.InputJsonObject,
          },
        });
        if (updated.count !== 1) return;
        if (job.itemId) {
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: { in: ["queued", "researching"] } },
            data: { status: jobStatus },
          });
          await markDiscoveryUnavailable(tx, job, safeCode);
        }
        await appendEvent(
          tx,
          job.campaignId,
          decision.action === "fail" ? "step_failed" : "step_blocked",
          "Work needs attention before it can continue.",
          job.itemId,
        );
      }
    });
  }

  async function failUnsupported(job: JobRecord) {
    await finish(
      job,
      "failed",
      "step_failed",
      "This campaign operation is not supported.",
      "operation_unsupported",
    );
  }

  async function finish(
    job: JobRecord,
    jobStatus: string,
    eventType: CampaignActivity["type"],
    summary: string,
    safeError?: string,
  ) {
    await options.prisma.$transaction(async (tx) => {
      if (!(await fencedActive(tx, job))) return;
      const write = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: jobStatus,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
          lastError: safeError ?? null,
        },
      });
      if (write.count !== 1) return;
      if (job.itemId && ["needs_action", "failed"].includes(jobStatus))
        await tx.campaignItem.updateMany({
          where: { id: job.itemId, status: { in: ["queued", "researching"] } },
          data: { status: jobStatus === "failed" ? "failed" : "needs_action" },
        });
      await appendEvent(tx, job.campaignId, eventType, summary, job.itemId);
    });
  }

  async function isDispatchAllowed(job: JobRecord): Promise<boolean> {
    const allowed = await options.prisma.campaign.findFirst({
      where: { id: job.campaignId, status: "active" },
      select: { id: true },
    });
    if (allowed) return true;
    await options.prisma.$transaction(async (tx) => {
      const released = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: "deferred",
          availableAt: now(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: now(),
        },
      });
      if (released.count === 1 && job.itemId)
        await tx.campaignItem.updateMany({
          where: { id: job.itemId, status: "researching" },
          data: { status: "deferred" },
        });
    });
    return false;
  }

  async function recoverExpiredJobs(): Promise<void> {
    const expired = (await options.prisma.campaignJob.findMany({
      where: {
        status: "running",
        OR: [{ leaseExpiresAt: { lte: now() } }, { deadlineAt: { lte: now() } }],
        campaign: { status: { in: ["active", "paused"] } },
      },
      include: { campaign: true, item: true },
      take: CLAIM_BATCH,
    })) as JobRecord[];
    for (const job of expired) {
      await options.prisma.$transaction(async (tx) => {
        const current = await tx.campaignJob.findUnique({
          where: { id: job.id },
          select: { leaseFence: true, leaseOwner: true, status: true, checkpoint: true },
        });
        if (current?.status !== "running" || current.leaseFence !== job.leaseFence) return;
        const deadlineExpired = job.deadlineAt != null && job.deadlineAt <= now();
        const nextStatus =
          job.campaign.status !== "active"
            ? "deferred"
            : deadlineExpired
              ? "needs_action"
              : "queued";
        const breakerUntil = new Date(now().getTime() + DEFER_MS);
        const updated = await tx.campaignJob.updateMany({
          where: { id: job.id, status: "running", leaseFence: job.leaseFence },
          data: {
            status: nextStatus,
            availableAt: now(),
            leaseOwner: null,
            leaseExpiresAt: null,
            leaseFence: { increment: 1 },
            lastError: deadlineExpired ? "worker_deadline_exceeded" : "worker_lease_expired",
            checkpoint: {
              ...record(current.checkpoint),
              siteBlockedSite: siteKey(job),
              siteBlockedUntil: breakerUntil.toISOString(),
            } as Prisma.InputJsonObject,
          },
        });
        if (updated.count !== 1) return;
        if (job.itemId) {
          const itemStatus =
            nextStatus === "needs_action"
              ? "needs_action"
              : nextStatus === "deferred"
                ? "deferred"
                : "queued";
          await tx.campaignItem.updateMany({
            where: { id: job.itemId, status: { in: ["queued", "researching", "deferred"] } },
            data: { status: itemStatus },
          });
        }
        const summary =
          nextStatus === "needs_action"
            ? "Work needs attention after the worker deadline expired."
            : nextStatus === "deferred"
              ? "Campaign is paused; expired work remains deferred."
              : "Expired worker lease recovered; work is safe to resume.";
        await appendEvent(
          tx,
          job.campaignId,
          nextStatus === "needs_action" ? "step_blocked" : "step_deferred",
          summary,
          job.itemId,
        );
      });
    }
  }

  async function timeOutJob(job: JobRecord): Promise<void> {
    await options.prisma.$transaction(async (tx) => {
      const nextStatus = "deferred";
      const retryExhausted = job.attemptCount >= job.maxAttempts;
      const deferredUntil = new Date(now().getTime() + DEFER_MS);
      const current = await tx.campaignJob.findUnique({
        where: { id: job.id },
        select: { checkpoint: true },
      });
      const updated = await tx.campaignJob.updateMany({
        where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
        data: {
          status: nextStatus,
          availableAt: deferredUntil,
          checkpoint: {
            ...record(current?.checkpoint),
            siteBlockedSite: siteKey(job),
            siteBlockedUntil: deferredUntil.toISOString(),
            ...(retryExhausted ? { retryExhausted: true } : {}),
          } as Prisma.InputJsonObject,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseFence: { increment: 1 },
          lastError: "worker_deadline_exceeded",
        },
      });
      if (updated.count !== 1) return;
      if (job.itemId)
        await tx.campaignItem.updateMany({
          where: { id: job.itemId, status: { in: ["queued", "researching"] } },
          data: { status: "deferred" },
        });
      await appendEvent(
        tx,
        job.campaignId,
        "step_deferred",
        "Work was deferred after the worker deadline expired.",
        job.itemId,
      );
    });
  }

  return {
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick().catch(() => reportTickError()), intervalMs);
      void tick().catch(() => reportTickError());
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      activeController?.abort();
      if (ticking) {
        await Promise.race([ticking, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }
    },
  };

  async function fencedActive(tx: Prisma.TransactionClient, job: JobRecord): Promise<boolean> {
    // Serialize this state transition against pause/archive updates, then acquire the job row
    // under the current lease fence before touching any related item.
    const campaign = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "campaigns" WHERE "id" = ${job.campaignId} AND "status" = 'active' FOR UPDATE`;
    if (campaign.length !== 1) return false;
    const lease = await tx.campaignJob.updateMany({
      where: { id: job.id, status: "running", leaseOwner: workerId, leaseFence: job.leaseFence },
      data: { heartbeatAt: now(), leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
    });
    return lease.count === 1;
  }

  async function lockApprovedDraft(
    tx: Prisma.TransactionClient,
    itemId: string,
    approvalHash: string,
    approvedUpdatedAt: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "campaign_items" WHERE "id" = ${itemId} AND "status" = 'approved' AND "updatedAt" = ${new Date(approvedUpdatedAt)} AND "details"->>'approvalVersion' = ${approvalHash} AND "details"->>'approvedUpdatedAt' = ${approvedUpdatedAt} FOR UPDATE`;
    return rows.length === 1;
  }

  async function appendEvent(
    tx: Prisma.TransactionClient,
    campaignId: string,
    type: CampaignActivity["type"],
    summary: string,
    stepId: string | null,
  ) {
    const campaign = await tx.campaign.update({
      where: { id: campaignId },
      data: { eventSequence: { increment: 1 } },
      select: { eventSequence: true },
    });
    await tx.campaignEvent.create({
      data: {
        campaignId,
        sequence: campaign.eventSequence,
        type,
        summary: summary.slice(0, 500),
        stepId,
      },
    });
  }

  function reportTickError() {
    if (options.onError) options.onError("tick_failed");
    else console.error("campaign worker tick failed");
  }
}

function siteKey(job: JobRecord): string {
  if (job.operation === "discovery_search") {
    const provider =
      typeof job.checkpoint.provider === "string" ? job.checkpoint.provider : "search";
    return `search-provider:${provider}`;
  }
  if (job.item?.url) {
    try {
      return new URL(job.item.url).hostname.toLowerCase();
    } catch {
      /* malformed URL is handled by research */
    }
  }
  return job.campaignId;
}

function campaignSiteKey(job: JobRecord): string {
  return `${job.campaignId}:${siteKey(job)}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
}

function safeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, limit);
}

function canonicalDiscoveryUrl(value: string): string | null {
  try {
    const url = validateCampaignResearchUrl(value);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function safeDiscoveryText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeIsoDate(value: unknown, fallback: Date): string {
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return fallback.toISOString();
}

function catalogRules(value: unknown): CatalogRobotsRules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rules = value as Record<string, unknown>;
  const toRules = (candidate: unknown): string[] | null => {
    if (
      !Array.isArray(candidate) ||
      candidate.length > 100 ||
      candidate.some((entry) => typeof entry !== "string" || entry.length > 2_048)
    )
      return null;
    return [...candidate] as string[];
  };
  const allow = toRules(rules.allow);
  const disallow = toRules(rules.disallow);
  const sitemaps = toRules(rules.sitemaps);
  if (!allow || !disallow || !sitemaps) return null;
  return {
    allow,
    disallow,
    sitemaps,
  };
}

function serializeCatalogRules(rules: CatalogRobotsRules): CatalogRobotsRules {
  const safe = catalogRules(rules);
  if (!safe) throw new CampaignCatalogError("unsupported", "robots_rules_invalid");
  return safe;
}

function initialCatalogTargets(rootUrl: string, rules: CatalogRobotsRules): CatalogTarget[] {
  const root = validateCampaignResearchUrl(rootUrl);
  const targets: CatalogTarget[] = [
    {
      url: rootUrl,
      label: "Website homepage",
      category: "homepage",
      depth: 1,
      provenance: "configured_website",
    },
    {
      url: new URL("/llms.txt", root).toString(),
      label: "LLM guidance",
      category: "llm",
      depth: 1,
      provenance: "conventional_probe",
    },
  ];
  const sitemaps = rules.sitemaps.length
    ? rules.sitemaps.slice(0, 8)
    : [new URL("/sitemap.xml", root).toString()];
  for (const url of sitemaps) {
    targets.push({
      url,
      label: "Website sitemap",
      category: "other",
      depth: 1,
      provenance: "conventional_probe",
    });
  }
  return targets;
}

function prioritizeCatalogTargets(targets: CatalogTarget[]): CatalogTarget[] {
  return targets
    .map((target, index) => ({ target, index }))
    .sort(
      (left, right) =>
        catalogCategoryPriority(left.target.category) -
          catalogCategoryPriority(right.target.category) || left.index - right.index,
    )
    .map(({ target }) => target);
}

function safeObservedCatalogLinks(
  links: CampaignCatalogPage["links"],
  pageUrl: string,
): Array<{
  url: string;
  label: string;
  category: ReturnType<typeof classifyCatalogPage>;
  status: "candidate";
}> {
  const candidates = new Map<
    string,
    {
      url: string;
      label: string;
      category: ReturnType<typeof classifyCatalogPage>;
      status: "candidate";
    }
  >();
  for (const link of links) {
    try {
      const url = validateCampaignResearchUrl(new URL(link.url, pageUrl).toString());
      url.hash = "";
      const canonical = url.toString();
      const label = link.label.replace(/\s+/g, " ").trim().slice(0, 200) || canonical;
      candidates.set(canonical, {
        url: canonical,
        label,
        category: classifyCatalogPage(canonical, label),
        status: "candidate",
      });
    } catch {
      // Unsafe or malformed links are not exposed as candidates.
    }
  }
  return [...candidates.values()]
    .sort(
      (left, right) =>
        catalogCategoryPriority(left.category) - catalogCategoryPriority(right.category),
    )
    .slice(0, 30)
    .map(({ url, label, category, status }) => ({ url, label, category, status }));
}

function catalogCategoryPriority(category: CatalogTarget["category"]): number {
  switch (category) {
    case "homepage":
      return 0;
    case "app":
    case "shop":
    case "device":
      return 1;
    case "article":
    case "llm":
      return 2;
    case "other":
      return 3;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeMicros(value: unknown): string | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null;
}

async function loadProjectContext(
  db: PrismaClient | Prisma.TransactionClient,
  job: JobRecord,
  rootUrlOverride?: string,
): Promise<ProjectContextSelection> {
  const config = record(job.campaign.config);
  let rootUrl: string;
  try {
    const parsed = validateCampaignResearchUrl(rootUrlOverride ?? stringOrEmpty(config.websiteUrl));
    parsed.hash = "";
    rootUrl = parsed.toString();
  } catch {
    return { rootUrl: "", runId: null, sourceIds: [], projectSources: [], evidence: [] };
  }
  const expectedRun =
    typeof job.checkpoint.discoveryRunId === "string"
      ? job.checkpoint.discoveryRunId
      : typeof job.checkpoint.catalogRunId === "string"
        ? job.checkpoint.catalogRunId
        : null;
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      url: string | null;
      title: string;
      details: Prisma.JsonValue;
      checkpoint: Prisma.JsonValue;
    }>
  >`
    SELECT i."id", i."url", i."title", i."details", j."checkpoint"
    FROM "campaign_jobs" j
    JOIN "campaign_items" i ON i."id" = j."itemId"
    WHERE j."campaignId" = ${job.campaignId}
      AND j."operation" = 'catalog_page'
      AND j."status" = 'succeeded'
      AND j."checkpoint"->>'catalogRootUrl' = ${rootUrl}
      AND j."checkpoint"->>'catalogContentType' IN ('text/html', 'text/plain')
      AND COALESCE(j."checkpoint"->>'catalogProbe', 'true') = 'false'
      AND i."status" = 'verified'
      AND i."details"->'catalog'->>'purpose' = 'page'
    ORDER BY j."createdAt" DESC, i."id" ASC
    LIMIT 100
  `;
  const eligible = rows.flatMap((row) => {
    const checkpoint = record(row.checkpoint);
    const runId = checkpoint.catalogRunId;
    const details = record(row.details);
    const catalog = record(details.catalog);
    if (
      typeof runId !== "string" ||
      !/^[a-f0-9]{64}$/.test(runId) ||
      catalog.runId !== runId ||
      typeof row.url !== "string"
    ) {
      return [];
    }
    let observedUrl: string;
    try {
      const parsed = validateCampaignResearchUrl(row.url);
      if (parsed.origin !== new URL(rootUrl).origin) return [];
      parsed.hash = "";
      observedUrl = canonicalCatalogUrl(parsed.toString(), rootUrl) ?? parsed.toString();
    } catch {
      return [];
    }
    const entry = firstEvidence(details.evidence);
    if (!entry || entry.url !== observedUrl || !entry.excerpt.trim()) return [];
    const title = entry.title.trim().slice(0, 200);
    const text = entry.excerpt.trim().slice(0, 1_200);
    if (!title || !text) return [];
    return [
      {
        id: row.id,
        runId,
        url: observedUrl,
        title,
        text,
        evidence: {
          id: row.id,
          url: observedUrl,
          title,
          excerpt: text,
          fetchedAt: entry.fetchedAt,
        },
        category: catalog.category,
        provenance: catalog.provenance,
        createdAt: String(checkpoint.catalogFetchedAt ?? ""),
      },
    ];
  });
  const selectedRun = expectedRun ?? eligible[0]?.runId ?? null;
  const currentRun = eligible.filter((source) => source.runId === selectedRun);
  const byCanonicalUrl = new Map<string, (typeof currentRun)[number]>();
  for (const source of currentRun) {
    if (!byCanonicalUrl.has(source.url)) byCanonicalUrl.set(source.url, source);
  }
  const projectSources = [...byCanonicalUrl.values()]
    .sort((left, right) => {
      const priority = (row: (typeof currentRun)[number]) =>
        row.provenance === "configured_website" && row.category === "homepage"
          ? 0
          : row.category === "app" || row.category === "shop" || row.category === "device"
            ? 1
            : row.category === "article" || row.category === "llm"
              ? 2
              : 3;
      return priority(left) - priority(right) || left.url.localeCompare(right.url);
    })
    .slice(0, 3);
  return {
    rootUrl,
    runId: projectSources.length > 0 ? selectedRun : null,
    sourceIds: projectSources.map((source) => source.id),
    projectSources: projectSources.map(({ url, title, text }) => ({ url, title, text })),
    evidence: projectSources.map((source) => source.evidence),
  };
}

function persistedProjectContext(
  selection: ProjectContextSelection,
  state: PersistedProjectContext["state"],
): PersistedProjectContext {
  const hasSources = selection.sourceIds.length > 0 && Boolean(selection.runId);
  if (!hasSources)
    return { rootUrl: selection.rootUrl, runId: null, sourceIds: [], state: "missing" };
  return {
    rootUrl: selection.rootUrl,
    runId: selection.runId,
    sourceIds: selection.sourceIds,
    state,
  };
}

function missingProjectContext(job: JobRecord): PersistedProjectContext {
  return persistedProjectContext(
    {
      rootUrl: stringOrEmpty(record(job.campaign.config).websiteUrl),
      runId: null,
      sourceIds: [],
      projectSources: [],
      evidence: [],
    },
    "missing",
  );
}

function parsePersistedProjectContext(value: unknown): PersistedProjectContext | undefined {
  const row = record(value);
  if (
    typeof row.rootUrl !== "string" ||
    (row.runId !== null && typeof row.runId !== "string") ||
    !Array.isArray(row.sourceIds) ||
    !row.sourceIds.every((id) => typeof id === "string") ||
    !["available", "supplied", "missing"].includes(String(row.state))
  )
    return undefined;
  return {
    rootUrl: row.rootUrl,
    runId: row.runId as string | null,
    sourceIds: row.sourceIds as string[],
    state: row.state as PersistedProjectContext["state"],
  };
}

function parseProjectEvidence(value: unknown): ProjectEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const row = record(entry);
      if (
        [row.id, row.url, row.title, row.excerpt, row.fetchedAt].some(
          (part) => typeof part !== "string",
        )
      )
        return [];
      return [
        {
          id: String(row.id),
          url: String(row.url),
          title: String(row.title).slice(0, 200),
          excerpt: String(row.excerpt).slice(0, 1_200),
          fetchedAt: String(row.fetchedAt),
        },
      ];
    })
    .slice(0, 3);
}

function targetEvidenceEntry(job: JobRecord, evidence: CampaignResearchEvidence): ProjectEvidence {
  return {
    id: job.item!.id,
    url: evidence.url,
    title: evidence.title.slice(0, 200),
    excerpt: evidence.text.slice(0, 1_200),
    fetchedAt: evidence.fetchedAt,
  };
}

function sourceNotesBody(title: string, excerpt: string, note?: string): string {
  return [
    "Source notes for review:",
    "",
    `Page title: “${title}”`,
    `Source text: “${excerpt.slice(0, 1_200)}”`,
    ...(note ? ["", note] : []),
    "",
    "Edit and verify all claims before use. This is not a testimonial or a verified publication.",
  ]
    .join("\n")
    .slice(0, 20_000);
}

function deterministicDraft(
  evidence: CampaignResearchEvidence,
  selection: ProjectContextSelection,
  note?: string,
): GeneratedDraft {
  return {
    body: sourceNotesBody(evidence.title, evidence.text, note),
    rationale:
      "Deterministic source notes are provided because optional model drafting is disabled, unavailable, or outside the configured reservation.",
    sourceUrls: [evidence.url],
    projectContext: persistedProjectContext(selection, "available"),
    projectEvidence: selection.evidence,
  };
}

function firstEvidence(
  value: unknown,
): { title: string; url: string; excerpt: string; fetchedAt: string } | undefined {
  if (!Array.isArray(value)) return undefined;
  const entry = value[0];
  if (!entry || typeof entry !== "object") return undefined;
  const row = entry as Record<string, unknown>;
  if ([row.title, row.url, row.excerpt, row.fetchedAt].some((field) => typeof field !== "string"))
    return undefined;
  return {
    title: row.title as string,
    url: row.url as string,
    excerpt: row.excerpt as string,
    fetchedAt: row.fetchedAt as string,
  };
}

function isValidDraftOutput(
  output: unknown,
  expectedSourceUrls: string[],
): output is {
  body: string;
  rationale: string;
  sourceUrls: string[];
  usage: { inputTokens: number; outputTokens: number; costMicros: number | null };
} {
  if (!output || typeof output !== "object") return false;
  const value = output as Record<string, unknown>;
  const usage =
    value.usage && typeof value.usage === "object"
      ? (value.usage as Record<string, unknown>)
      : undefined;
  return Boolean(
    typeof value.body === "string" &&
      value.body.trim().length > 0 &&
      value.body.length <= 20_000 &&
      typeof value.rationale === "string" &&
      value.rationale.length <= 2_000 &&
      Array.isArray(value.sourceUrls) &&
      value.sourceUrls.length > 0 &&
      value.sourceUrls.every(
        (url) => typeof url === "string" && expectedSourceUrls.includes(url),
      ) &&
      usage &&
      Number.isSafeInteger(usage.inputTokens) &&
      Number(usage.inputTokens) >= 0 &&
      Number.isSafeInteger(usage.outputTokens) &&
      Number(usage.outputTokens) >= 0 &&
      (usage.costMicros === null ||
        (Number.isSafeInteger(usage.costMicros) && Number(usage.costMicros) >= 0)),
  );
}

function eventStartSummary(operation: string): string {
  if (operation === "controlled_fixture" || operation === "controlled_publish")
    return "Controlled test work started.";
  if (operation === "discovery_search")
    return "Community search started from verified catalog evidence.";
  if (operation === "discovery_inspect") return "Community opportunity inspection started.";
  if (operation === "catalog_page") return "Website catalog page inspection started.";
  return operation === "research_source"
    ? "Research started for the supplied source."
    : "Research started for the supplied opportunity.";
}
