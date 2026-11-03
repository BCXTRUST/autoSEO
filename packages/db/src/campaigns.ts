import { createHash } from "node:crypto";
import {
  type Actor,
  Campaign,
  CampaignActivity,
  CampaignConfigInput,
  CampaignItem,
  CampaignJob,
  type CampaignMode,
  CampaignSnapshot,
} from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class CampaignNotFoundError extends Error {
  constructor() {
    super("Campaign or item not found");
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignConflictError extends Error {
  constructor(message = "Campaign changed; reload and try again") {
    super(message);
    this.name = "CampaignConflictError";
  }
}

export class CampaignCommandConflictError extends Error {
  constructor() {
    super("This client nonce was already used for a different campaign command");
    this.name = "CampaignCommandConflictError";
  }
}

export class CampaignRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignRuleError";
  }
}

type CampaignRow = {
  id: string;
  workspaceId: string;
  config: Prisma.JsonValue;
  status: string;
  mode: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

type CampaignItemRow = {
  id: string;
  campaignId: string;
  kind: string;
  url: string | null;
  title: string;
  body: string;
  status: string;
  details: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

const campaignWhere = (actor: Actor, campaignId: string) => ({
  id: campaignId,
  workspaceId: actor.workspaceId,
  userId: actor.userId,
});

function toCampaign(row: CampaignRow) {
  return Campaign.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    config: CampaignConfigInput.parse(row.config),
    status: row.status,
    mode: row.mode,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const safeDetailKeys = new Set([
  "label",
  "sourceIds",
  "rationale",
  "eligibility",
  "observedRules",
  "participationRequirements",
  "deferReason",
  "recoveryReason",
  "retryAfter",
  "evidenceIds",
  "reviewDecision",
  "approvalVersion",
  "approvedUpdatedAt",
  "evidence",
  "emailConfirmation",
  "effect",
  "verification",
  "catalog",
  "observedLinks",
  "discovery",
  "projectContext",
]);

function safeEvidence(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const safe: Record<string, string> = {};
    for (const key of ["id", "url", "title", "excerpt", "fetchedAt"] as const) {
      const candidate = (entry as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.length <= (key === "excerpt" ? 2_000 : 500)) {
        safe[key] = candidate;
      }
    }
    return Object.keys(safe).length ? [safe] : [];
  });
}

function safeHttpUrl(value: unknown, maxLength = 2_048): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeCatalog(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const catalog = value as Record<string, unknown>;
  const rootUrl = safeHttpUrl(catalog.rootUrl);
  const purposes = new Set(["guidance", "page"]);
  const categories = new Set([
    "guidance",
    "homepage",
    "app",
    "shop",
    "device",
    "article",
    "llm",
    "other",
  ]);
  const provenances = new Set(["conventional_probe", "configured_website", "observed_link"]);
  if (
    typeof catalog.runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(catalog.runId) ||
    !rootUrl ||
    typeof catalog.purpose !== "string" ||
    !purposes.has(catalog.purpose) ||
    typeof catalog.category !== "string" ||
    !categories.has(catalog.category) ||
    typeof catalog.provenance !== "string" ||
    !provenances.has(catalog.provenance) ||
    typeof catalog.depth !== "number" ||
    !Number.isSafeInteger(catalog.depth) ||
    catalog.depth < 0 ||
    catalog.depth > 2
  ) {
    return null;
  }
  return {
    runId: catalog.runId,
    rootUrl,
    purpose: catalog.purpose,
    category: catalog.category,
    provenance: catalog.provenance,
    depth: catalog.depth,
  };
}

function safeObservedLinks(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) return [];
  const categories = new Set(["homepage", "app", "shop", "device", "article", "llm", "other"]);
  return value.slice(0, 30).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const link = entry as Record<string, unknown>;
    const url = safeHttpUrl(link.url);
    if (
      !url ||
      typeof link.label !== "string" ||
      link.label.length === 0 ||
      link.label.length > 200 ||
      typeof link.category !== "string" ||
      !categories.has(link.category) ||
      link.status !== "candidate"
    ) {
      return [];
    }
    return [{ url, label: link.label, category: link.category, status: "candidate" }];
  });
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null;
}

function safeDiscovery(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const discovery = value as Record<string, unknown>;
  const rootUrl = safeHttpUrl(discovery.rootUrl);
  const purposes = new Set(["search", "candidate"]);
  const inspections = new Set(["pending", "observed", "unavailable"]);
  const dispositions = new Set(["unreviewed", "selected", "dismissed"]);
  if (
    typeof discovery.runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(discovery.runId) ||
    !rootUrl ||
    typeof discovery.purpose !== "string" ||
    !purposes.has(discovery.purpose) ||
    typeof discovery.provider !== "string" ||
    !/^[a-zA-Z0-9_-]{1,40}$/.test(discovery.provider) ||
    typeof discovery.query !== "string" ||
    discovery.query.trim().length === 0 ||
    discovery.query.length > 300 ||
    /\p{Cc}/u.test(discovery.query) ||
    !Array.isArray(discovery.sourceItemIds) ||
    typeof discovery.inspection !== "string" ||
    !inspections.has(discovery.inspection) ||
    discovery.eligibility !== "needs_review" ||
    typeof discovery.disposition !== "string" ||
    !dispositions.has(discovery.disposition)
  ) {
    return null;
  }
  const sourceItemIds = discovery.sourceItemIds
    .slice(0, 12)
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(id),
    );
  const safe: Record<string, unknown> = {
    runId: discovery.runId,
    rootUrl,
    purpose: discovery.purpose,
    provider: discovery.provider,
    query: discovery.query,
    sourceItemIds,
    inspection: discovery.inspection,
    eligibility: "needs_review",
    disposition: discovery.disposition,
  };
  if (discovery.rank !== undefined) {
    if (
      typeof discovery.rank !== "number" ||
      !Number.isSafeInteger(discovery.rank) ||
      discovery.rank < 1 ||
      discovery.rank > 100_000
    ) {
      return null;
    }
    safe.rank = discovery.rank;
  }
  if (discovery.observedAt !== undefined) {
    const observedAt = safeIsoTimestamp(discovery.observedAt);
    if (!observedAt) return null;
    safe.observedAt = observedAt;
  }
  if (discovery.rulesLinks !== undefined) {
    if (!Array.isArray(discovery.rulesLinks)) return null;
    safe.rulesLinks = discovery.rulesLinks.slice(0, 5).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const link = entry as Record<string, unknown>;
      const url = safeHttpUrl(link.url);
      if (
        !url ||
        typeof link.label !== "string" ||
        link.label.trim().length === 0 ||
        link.label.length > 200 ||
        /\p{Cc}/u.test(link.label)
      ) {
        return [];
      }
      return [{ url, label: link.label }];
    });
  }
  if (discovery.platformHint !== undefined) {
    if (discovery.platformHint !== "unknown" && discovery.platformHint !== "discourse") return null;
    safe.platformHint = discovery.platformHint;
  }
  return safe;
}

function safeProjectContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  const rootUrl = safeHttpUrl(context.rootUrl);
  const states = new Set(["available", "supplied", "missing"]);
  if (
    !rootUrl ||
    !(
      context.runId === null ||
      (typeof context.runId === "string" && /^[a-f0-9]{64}$/.test(context.runId))
    ) ||
    !Array.isArray(context.sourceIds) ||
    context.sourceIds.length > 3 ||
    typeof context.state !== "string" ||
    !states.has(context.state)
  ) {
    return null;
  }
  const sourceIds = context.sourceIds;
  if (
    !sourceIds.every(
      (id) =>
        typeof id === "string" && id.length > 0 && id.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(id),
    )
  ) {
    return null;
  }
  const hasSources = sourceIds.length > 0;
  if (
    (context.state === "missing" && (hasSources || context.runId !== null)) ||
    (context.state !== "missing" && (!hasSources || context.runId === null))
  ) {
    return null;
  }
  return { rootUrl, runId: context.runId, sourceIds, state: context.state };
}

function safeEmailConfirmation(value: unknown): Record<string, string | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confirmation = value as Record<string, unknown>;
  const allowedStatuses = new Set(["confirmed", "pending", "failed", "unavailable"]);
  if (
    typeof confirmation.status !== "string" ||
    !allowedStatuses.has(confirmation.status) ||
    confirmation.evidence !== "Synthetic confirmation fixture; no email was sent"
  ) {
    return null;
  }
  return { status: confirmation.status as string, synthetic: true };
}

function safeFixtureVerification(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const verification = value as Record<string, unknown>;
  if (
    verification.label !== "Controlled test" ||
    verification.method !== "independent_fixture_read" ||
    typeof verification.verifiedAt !== "string"
  ) {
    return null;
  }
  const date = new Date(verification.verifiedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== verification.verifiedAt)
    return null;
  return {
    label: "Controlled test",
    method: "independent_fixture_read",
    verifiedAt: verification.verifiedAt,
  };
}

function toSafeDetails(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (!safeDetailKeys.has(key)) continue;
    if (key === "evidence") safe[key] = safeEvidence(detail);
    else if (key === "emailConfirmation") {
      const confirmation = safeEmailConfirmation(detail);
      if (confirmation) safe[key] = confirmation;
    } else if (key === "verification") {
      const verification = safeFixtureVerification(detail);
      if (verification) safe[key] = verification;
    } else if (key === "effect") {
      if (detail === "local_fixture_only") safe[key] = detail;
    } else if (key === "catalog") {
      const catalog = safeCatalog(detail);
      if (catalog) safe[key] = catalog;
    } else if (key === "observedLinks") {
      safe[key] = safeObservedLinks(detail);
    } else if (key === "discovery") {
      const discovery = safeDiscovery(detail);
      if (discovery) safe[key] = discovery;
    } else if (key === "projectContext") {
      const projectContext = safeProjectContext(detail);
      if (projectContext) safe[key] = projectContext;
    } else if (typeof detail === "string" && detail.length <= (key === "label" ? 120 : 500))
      safe[key] = detail;
    else if (
      Array.isArray(detail) &&
      detail.length <= 50 &&
      detail.every((entry) => typeof entry === "string" && entry.length <= 200)
    ) {
      safe[key] = detail;
    }
  }
  return safe;
}

function toCampaignItem(row: CampaignItemRow) {
  return CampaignItem.parse({
    id: row.id,
    campaignId: row.campaignId,
    kind: row.kind,
    url: row.url,
    title: row.title,
    body: row.body,
    status: row.status,
    details: toSafeDetails(row.details),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function safeLastError(value: string | null): string | null {
  if (!value) return null;
  if (/^\s*[[{]/.test(value))
    return "The step could not continue. Review the campaign activity for details.";
  const redacted = value
    .replace(
      /\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 500);
  return redacted;
}

function toCampaignJob(row: {
  id: string;
  itemId: string | null;
  operation: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  availableAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  deadlineAt: Date | null;
  lastError: string | null;
}) {
  return CampaignJob.parse({
    id: row.id,
    itemId: row.itemId,
    operation: row.operation,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    lastError: safeLastError(row.lastError),
  });
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value } as Record<string, unknown>;
}

function hashPayload(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function transaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withTransactionRetry(() =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
}

async function requireCampaign(
  source: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  campaignId: string,
) {
  const campaign = await source.campaign.findFirst({ where: campaignWhere(actor, campaignId) });
  if (!campaign) throw new CampaignNotFoundError();
  return campaign;
}

async function lockCampaign(tx: Prisma.TransactionClient, actor: Actor, campaignId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "campaigns" WHERE "id" = ${campaignId} AND "workspaceId" = ${actor.workspaceId} AND "userId" = ${actor.userId} FOR UPDATE`,
  );
  if (rows.length === 0) throw new CampaignNotFoundError();
}

function normalizedWebsiteIdentity(websiteUrl: string): string {
  const url = new URL(websiteUrl);
  url.hash = "";
  return url.href;
}

async function cancelSupersededCatalogJobs(
  tx: Prisma.TransactionClient,
  campaignId: string,
  previousRootUrl: string,
  nextRootUrl: string,
): Promise<string[]> {
  if (previousRootUrl === nextRootUrl) return [];
  const jobs = await tx.campaignJob.findMany({
    where: {
      campaignId,
      operation: {
        in: ["catalog_page", "discovery_search", "discovery_inspect", "research_opportunity"],
      },
      status: { notIn: ["succeeded", "cancelled"] },
    },
    select: { id: true, itemId: true, operation: true, checkpoint: true },
  });
  const canceledItemIds = new Set<string>();
  const reason = "This discovery item was canceled because the campaign website changed.";
  const uncertainModelReason =
    "The website changed while a model result may have been charged. Resolve the uncertain model result before retrying.";
  for (const job of jobs) {
    const checkpoint = jsonObject(job.checkpoint);
    const checkpointRootUrl =
      job.operation === "catalog_page" ? checkpoint.catalogRootUrl : checkpoint.discoveryRootUrl;
    if (typeof checkpointRootUrl !== "string") continue;
    try {
      if (normalizedWebsiteIdentity(checkpointRootUrl) !== previousRootUrl) continue;
    } catch {
      continue;
    }
    const hasUncertainModelResult =
      job.operation === "research_opportunity" &&
      ["intent", "ambiguous", "ready"].includes(String(checkpoint.aiState));
    if (hasUncertainModelResult && checkpoint.aiState === "ready") {
      checkpoint.aiState = "ambiguous";
    }
    const canceled = await tx.campaignJob.updateMany({
      where: { id: job.id, campaignId, status: { notIn: ["succeeded", "cancelled"] } },
      data: {
        status: hasUncertainModelResult ? "needs_action" : "cancelled",
        checkpoint: jsonInput(checkpoint),
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: { increment: 1 },
        lastError: hasUncertainModelResult
          ? "website_changed_uncertain_model_result"
          : "website_changed",
      },
    });
    if (canceled.count !== 1 || !job.itemId) continue;
    const item = await tx.campaignItem.findFirst({
      where: { id: job.itemId, campaignId },
    });
    if (!item || item.status === "verified") continue;
    await tx.campaignItem.update({
      where: { id: item.id },
      data: {
        status: hasUncertainModelResult ? "needs_action" : "failed",
        body: hasUncertainModelResult ? uncertainModelReason : reason,
        details: jsonInput({
          ...toSafeDetails(item.details),
          recoveryReason: hasUncertainModelResult ? uncertainModelReason : reason,
        }),
      },
    });
    canceledItemIds.add(item.id);
  }
  const items = await tx.campaignItem.findMany({
    where: { campaignId, kind: "opportunity" },
    select: { id: true, status: true, details: true },
  });
  const supersededReason =
    "This discovery candidate was dismissed because the campaign website changed.";
  for (const item of items) {
    const details = toSafeDetails(item.details);
    const discovery = details.discovery;
    if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) continue;
    const metadata = discovery as Record<string, unknown>;
    if (metadata.purpose !== "candidate" || metadata.disposition !== "unreviewed") continue;
    let candidateRoot: string;
    try {
      if (typeof metadata.rootUrl !== "string") continue;
      candidateRoot = normalizedWebsiteIdentity(metadata.rootUrl);
    } catch {
      continue;
    }
    if (candidateRoot !== previousRootUrl || item.status === "verified") continue;
    await tx.campaignItem.update({
      where: { id: item.id },
      data: {
        status: "failed",
        body: supersededReason,
        details: jsonInput({
          ...details,
          discovery: { ...metadata, disposition: "dismissed" },
          recoveryReason: supersededReason,
        }),
      },
    });
    canceledItemIds.add(item.id);
  }
  return [...canceledItemIds];
}

async function appendCampaignEvent(
  tx: Prisma.TransactionClient,
  actor: Actor,
  campaignId: string,
  input: { type: string; summary: string; stepId?: string },
  campaignChanges: Prisma.CampaignUpdateManyMutationInput = {},
  expectedRevision?: number,
) {
  const now = new Date();
  const changed = await tx.campaign.updateMany({
    where: {
      ...campaignWhere(actor, campaignId),
      ...(expectedRevision === undefined ? {} : { revision: expectedRevision }),
    },
    data: {
      ...campaignChanges,
      revision: { increment: 1 },
      eventSequence: { increment: 1 },
      updatedAt: now,
    },
  });
  if (changed.count !== 1) {
    const exists = await tx.campaign.findFirst({
      where: campaignWhere(actor, campaignId),
      select: { id: true },
    });
    if (!exists) throw new CampaignNotFoundError();
    throw new CampaignConflictError();
  }
  const campaign = await tx.campaign.findFirst({
    where: campaignWhere(actor, campaignId),
    select: { eventSequence: true },
  });
  if (!campaign) throw new CampaignNotFoundError();
  return tx.campaignEvent.create({
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

async function appendCreationEvent(
  tx: Prisma.TransactionClient,
  campaignId: string,
  mode: CampaignMode,
) {
  const occurredAt = new Date();
  await tx.campaignEvent.create({
    data: {
      campaignId,
      sequence: 1,
      type: "campaign_created",
      summary:
        mode === "controlled"
          ? "Controlled fixture campaign created."
          : "Research campaign created.",
      occurredAt,
    },
  });
}

async function existingCommand<T>(
  tx: Prisma.TransactionClient,
  campaignId: string,
  nonce: string,
  payloadHash: string,
): Promise<T | null> {
  const row = await tx.campaignCommand.findUnique({
    where: { campaignId_nonce: { campaignId, nonce } },
  });
  if (!row) return null;
  if (row.payloadHash !== payloadHash) throw new CampaignCommandConflictError();
  return row.result as T;
}

async function storeCommand(
  tx: Prisma.TransactionClient,
  campaignId: string,
  nonce: string,
  payloadHash: string,
  result: unknown,
) {
  await tx.campaignCommand.create({
    data: { campaignId, nonce, payloadHash, result: jsonInput(result) },
  });
}

async function replayCampaignCommand(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  nonce: string,
  payloadHash: string,
) {
  const row = await prisma.campaignCommand.findUnique({
    where: { campaignId_nonce: { campaignId, nonce } },
    include: { campaign: true },
  });
  if (
    !row ||
    row.campaign.workspaceId !== actor.workspaceId ||
    row.campaign.userId !== actor.userId
  ) {
    throw new CampaignNotFoundError();
  }
  if (row.payloadHash !== payloadHash) throw new CampaignCommandConflictError();
  return row.result;
}

function rethrowCommandRace(error: unknown): never {
  if (isUniqueViolation(error))
    throw new CampaignConflictError("A concurrent command already used this nonce");
  throw error;
}

export async function listCampaigns(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.campaign.findMany({
    where: { workspaceId: actor.workspaceId, userId: actor.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toCampaign);
}

export async function createCampaign(
  prisma: PrismaClient,
  actor: Actor,
  input: { config: unknown; mode: CampaignMode; clientNonce: string },
) {
  const config = CampaignConfigInput.parse(input.config);
  const payloadHash = hashPayload({ config, mode: input.mode });
  try {
    return await transaction(prisma, async (tx) => {
      const existing = await tx.campaign.findUnique({
        where: {
          workspaceId_userId_clientNonce: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            clientNonce: input.clientNonce,
          },
        },
      });
      if (existing) {
        if (hashPayload({ config: existing.config, mode: existing.mode }) !== payloadHash) {
          throw new CampaignCommandConflictError();
        }
        return toCampaign(existing);
      }
      const campaign = await tx.campaign.create({
        data: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          clientNonce: input.clientNonce,
          config: jsonInput(config),
          mode: input.mode,
          eventSequence: 1,
        },
      });
      await appendCreationEvent(tx, campaign.id, input.mode);
      return toCampaign(campaign);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.campaign.findUnique({
      where: {
        workspaceId_userId_clientNonce: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          clientNonce: input.clientNonce,
        },
      },
    });
    if (!existing) throw error;
    if (hashPayload({ config: existing.config, mode: existing.mode }) !== payloadHash) {
      throw new CampaignCommandConflictError();
    }
    return toCampaign(existing);
  }
}

export async function updateCampaignConfig(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; expectedRevision: number; config: unknown },
) {
  const config = CampaignConfigInput.parse(input.config);
  return transaction(prisma, async (tx) => {
    await lockCampaign(tx, actor, input.campaignId);
    const current = await requireCampaign(tx, actor, input.campaignId);
    const previousWebsiteIdentity = normalizedWebsiteIdentity(
      CampaignConfigInput.parse(current.config).websiteUrl,
    );
    const nextWebsiteIdentity = normalizedWebsiteIdentity(config.websiteUrl);
    const websiteChanged = previousWebsiteIdentity !== nextWebsiteIdentity;
    const canceledCatalogItems = await cancelSupersededCatalogJobs(
      tx,
      input.campaignId,
      previousWebsiteIdentity,
      nextWebsiteIdentity,
    );
    await appendCampaignEvent(
      tx,
      actor,
      input.campaignId,
      {
        type: "configuration_updated",
        summary:
          canceledCatalogItems.length > 0
            ? "Campaign configuration updated; unfinished catalog, discovery, and selected research work for the previous website was canceled."
            : "Campaign configuration updated.",
      },
      { config: jsonInput(config) },
      input.expectedRevision,
    );
    if (websiteChanged && current.status === "active" && current.mode === "research") {
      const runId = await ensureResearchCatalogBootstrap(tx, current, config.websiteUrl);
      await appendCampaignEvent(tx, actor, input.campaignId, {
        type: "item_added",
        summary: "Website catalog guidance queued for the updated website.",
        stepId: `catalog-source-${runId}`,
      });
    }
    for (const itemId of canceledCatalogItems) {
      await appendCampaignEvent(tx, actor, input.campaignId, {
        type: "item_updated",
        summary: "Catalog or discovery work canceled because the campaign website changed.",
        stepId: itemId,
      });
    }
    return toCampaign((await requireCampaign(tx, actor, input.campaignId)) as CampaignRow);
  });
}

export async function getCampaignSnapshot(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; afterSequence: number },
) {
  return prisma.$transaction(
    async (tx) => {
      const campaign = await tx.campaign.findFirst({
        where: campaignWhere(actor, input.campaignId),
      });
      if (!campaign) throw new CampaignNotFoundError();
      const [items, jobs, events] = await Promise.all([
        tx.campaignItem.findMany({
          where: { campaignId: campaign.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 200,
        }),
        tx.campaignJob.findMany({
          where: { campaignId: campaign.id },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: 200,
        }),
        tx.campaignEvent.findMany({
          where: {
            campaignId: campaign.id,
            sequence: { gt: input.afterSequence, lte: campaign.eventSequence },
          },
          orderBy: { sequence: "asc" },
          take: 101,
        }),
      ]);
      const selectedEvents = events.slice(0, 100);
      const activities = selectedEvents.map((event) =>
        CampaignActivity.parse({
          id: event.id,
          campaignId: event.campaignId,
          sequence: event.sequence,
          type: event.type,
          summary: event.summary,
          occurredAt: event.occurredAt.toISOString(),
          ...(event.stepId ? { stepId: event.stepId } : {}),
        }),
      );
      return CampaignSnapshot.parse({
        campaign: toCampaign(campaign),
        items: items.map(toCampaignItem),
        jobs: jobs.map(toCampaignJob),
        activities,
        observedAt: new Date().toISOString(),
        nextCursor: activities.at(-1)?.sequence ?? input.afterSequence,
        hasMore: events.length > 100,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function addCampaignItem(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    kind: "source" | "opportunity";
    url: string;
    title: string;
    clientNonce: string;
  },
) {
  const payloadHash = hashPayload(input);
  try {
    return await transaction(prisma, async (tx) => {
      const campaign = await requireCampaign(tx, actor, input.campaignId);
      const prior = await existingCommand<ReturnType<typeof CampaignItem.parse>>(
        tx,
        input.campaignId,
        input.clientNonce,
        payloadHash,
      );
      if (prior) return CampaignItem.parse(prior);
      let item = await tx.campaignItem.create({
        data: {
          campaignId: input.campaignId,
          kind: input.kind,
          url: input.url,
          title: input.title,
          status: "queued",
        },
      });
      if (campaign.status === "active") {
        const operation =
          campaign.mode === "controlled"
            ? "controlled_fixture"
            : input.kind === "source"
              ? "research_source"
              : "research_opportunity";
        await tx.campaignJob.create({
          data: {
            campaignId: campaign.id,
            itemId: item.id,
            operation,
            checkpoint: jsonInput(campaign.mode === "controlled" ? { stage: "research" } : {}),
          },
        });
        item = await tx.campaignItem.update({
          where: { id: item.id },
          data: { status: "researching" },
        });
      }
      await appendCampaignEvent(tx, actor, input.campaignId, {
        type: "item_added",
        summary: `${input.kind === "source" ? "Source" : "Opportunity"} added to the campaign.`,
        stepId: item.id,
      });
      const dto = toCampaignItem(item);
      await storeCommand(tx, input.campaignId, input.clientNonce, payloadHash, dto);
      return dto;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      return CampaignItem.parse(
        await replayCampaignCommand(
          prisma,
          actor,
          input.campaignId,
          input.clientNonce,
          payloadHash,
        ),
      );
    } catch (replayError) {
      rethrowCommandRace(replayError);
    }
  }
}

async function findCampaignItem(
  source: Prisma.TransactionClient,
  actor: Actor,
  campaignId: string,
  itemId: string,
) {
  const item = await source.campaignItem.findFirst({
    where: { id: itemId, campaignId },
  });
  if (!item) throw new CampaignNotFoundError();
  await requireCampaign(source, actor, campaignId);
  return item;
}

function clearReviewDetails(value: Prisma.JsonValue) {
  const details = toSafeDetails(value);
  delete details.reviewDecision;
  delete details.approvalVersion;
  delete details.approvedUpdatedAt;
  return details;
}

async function completeControlledReviewHandoff(
  tx: Prisma.TransactionClient,
  campaignId: string,
  draftId: string,
) {
  const reviewJobs = await tx.campaignJob.findMany({
    where: { campaignId, operation: "controlled_fixture", status: "waiting_review" },
    select: { id: true, itemId: true, checkpoint: true },
  });
  const transientReason =
    "The controlled fixture exhausted its one retry after a transient timeout; no further retry is scheduled.";

  for (const job of reviewJobs) {
    const checkpoint = jsonObject(job.checkpoint);
    if (checkpoint.draftId !== draftId) continue;
    const settled = await tx.campaignJob.updateMany({
      where: { id: job.id, campaignId, operation: "controlled_fixture", status: "waiting_review" },
      data: {
        status: "succeeded",
        checkpoint: jsonInput({ ...checkpoint, fixtureStage: "review_approved" }),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    if (settled.count !== 1) continue;

    const sourceIds = new Set<string>();
    if (typeof checkpoint.fixtureSourceId === "string") sourceIds.add(checkpoint.fixtureSourceId);
    if (job.itemId) sourceIds.add(job.itemId);
    for (const sourceId of sourceIds) {
      await tx.campaignItem.updateMany({
        where: { id: sourceId, campaignId, kind: { in: ["source", "opportunity"] } },
        data: { status: "verified" },
      });
    }
    if (typeof checkpoint.goodOpportunityId === "string") {
      await tx.campaignItem.updateMany({
        where: {
          id: checkpoint.goodOpportunityId,
          campaignId,
          kind: "opportunity",
        },
        data: { status: "verified" },
      });
    }
    if (typeof checkpoint.transientOpportunityId === "string") {
      const transient = await tx.campaignItem.findFirst({
        where: {
          id: checkpoint.transientOpportunityId,
          campaignId,
          kind: "opportunity",
        },
      });
      if (transient) {
        await tx.campaignItem.update({
          where: { id: transient.id },
          data: {
            status: "failed",
            body: transientReason,
            details: jsonInput({
              ...toSafeDetails(transient.details),
              deferReason: transientReason,
            }),
          },
        });
      }
    }
  }
}

export async function updateCampaignDraft(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; itemId: string; body: string; expectedUpdatedAt: string },
) {
  return transaction(prisma, async (tx) => {
    const existing = await findCampaignItem(tx, actor, input.campaignId, input.itemId);
    if (existing.kind !== "draft")
      throw new CampaignRuleError("Only campaign drafts can be edited");
    if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt)
      throw new CampaignConflictError();
    const updatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
    const changed = await tx.campaignItem.updateMany({
      where: {
        id: existing.id,
        campaignId: input.campaignId,
        kind: "draft",
        updatedAt: existing.updatedAt,
      },
      data: {
        body: input.body,
        status: "needs_action",
        details: jsonInput(clearReviewDetails(existing.details)),
        updatedAt,
      },
    });
    if (changed.count !== 1) throw new CampaignConflictError();
    await tx.campaignJob.updateMany({
      where: {
        campaignId: input.campaignId,
        itemId: existing.id,
        operation: "controlled_publish",
        status: "queued",
      },
      data: {
        status: "cancelled",
        lastError: "Draft changed after review; the previous approval was invalidated.",
      },
    });
    await appendCampaignEvent(tx, actor, input.campaignId, {
      type: "item_updated",
      summary: "Draft updated; prior review approval was cleared.",
      stepId: existing.id,
    });
    const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: existing.id } });
    return toCampaignItem(item);
  });
}

export async function reviewCampaignDraft(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    itemId: string;
    decision: "approve" | "reject";
    expectedUpdatedAt: string;
  },
) {
  return transaction(prisma, async (tx) => {
    const existing = await findCampaignItem(tx, actor, input.campaignId, input.itemId);
    if (existing.kind !== "draft")
      throw new CampaignRuleError("Only campaign drafts can be reviewed");
    if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt)
      throw new CampaignConflictError();
    const campaign = await requireCampaign(tx, actor, input.campaignId);
    const updatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
    const details = clearReviewDetails(existing.details);
    details.reviewDecision = input.decision === "approve" ? "approved" : "rejected";
    const approvalHash =
      input.decision === "approve" && campaign.mode === "controlled"
        ? hashPayload({
            body: existing.body,
            title: existing.title,
            url: existing.url,
            details: clearReviewDetails(existing.details),
            approvedUpdatedAt: updatedAt.toISOString(),
          })
        : null;
    if (approvalHash) {
      details.approvalVersion = approvalHash;
      details.approvedUpdatedAt = updatedAt.toISOString();
    }
    const changed = await tx.campaignItem.updateMany({
      where: {
        id: existing.id,
        campaignId: input.campaignId,
        kind: "draft",
        updatedAt: existing.updatedAt,
      },
      data: {
        status: input.decision === "approve" ? "approved" : "needs_action",
        details: jsonInput(details),
        updatedAt,
      },
    });
    if (changed.count !== 1) throw new CampaignConflictError();
    if (input.decision === "reject" || approvalHash) {
      await tx.campaignJob.updateMany({
        where: {
          campaignId: input.campaignId,
          itemId: existing.id,
          operation: "controlled_publish",
          status: "queued",
        },
        data: {
          status: "cancelled",
          lastError: "Draft approval changed; this queued fixture step was invalidated.",
        },
      });
    }
    if (approvalHash) {
      await completeControlledReviewHandoff(tx, input.campaignId, existing.id);
      await tx.campaignJob.create({
        data: {
          id: `controlled-publish-${existing.id}-${approvalHash.slice(0, 16)}`,
          campaignId: input.campaignId,
          itemId: existing.id,
          operation: "controlled_publish",
          status: "queued",
          checkpoint: jsonInput({
            approvalHash,
            approvedUpdatedAt: updatedAt.toISOString(),
          }),
        },
      });
    }
    await appendCampaignEvent(tx, actor, input.campaignId, {
      type: input.decision === "approve" ? "review_approved" : "review_rejected",
      summary:
        input.decision === "approve"
          ? campaign.mode === "controlled"
            ? "Draft approved for the controlled fixture workflow."
            : "Draft approved for later workflow review."
          : "Draft review rejected; the draft needs changes.",
      stepId: existing.id,
    });
    const item = await tx.campaignItem.findUniqueOrThrow({ where: { id: existing.id } });
    return toCampaignItem(item);
  });
}

export async function reviewCampaignOpportunity(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    itemId: string;
    expectedUpdatedAt: string;
    action: "select" | "dismiss";
    clientNonce: string;
  },
) {
  const nonce = `review-opportunity:${input.clientNonce}`;
  const payloadHash = hashPayload({
    itemId: input.itemId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    action: input.action,
  });
  try {
    return await transaction(prisma, async (tx) => {
      const campaign = await requireCampaign(tx, actor, input.campaignId);
      await lockCampaign(tx, actor, input.campaignId);
      const prior = await existingCommand<ReturnType<typeof CampaignItem.parse>>(
        tx,
        input.campaignId,
        nonce,
        payloadHash,
      );
      if (prior) return CampaignItem.parse(prior);

      const item = await tx.campaignItem.findFirst({
        where: { id: input.itemId, campaignId: input.campaignId },
      });
      if (!item) throw new CampaignNotFoundError();
      if (item.kind !== "opportunity")
        throw new CampaignRuleError("Only discovery candidates can be reviewed here");
      if (item.updatedAt.toISOString() !== input.expectedUpdatedAt)
        throw new CampaignConflictError("Candidate changed; reload before reviewing it");

      const details = toSafeDetails(item.details);
      const discovery = details.discovery;
      if (!discovery || typeof discovery !== "object" || Array.isArray(discovery))
        throw new CampaignRuleError("This opportunity is not a valid discovery candidate");
      const metadata = discovery as Record<string, unknown>;
      if (
        metadata.purpose !== "candidate" ||
        metadata.eligibility !== "needs_review" ||
        metadata.disposition !== "unreviewed"
      ) {
        throw new CampaignRuleError("This candidate has already been reviewed");
      }

      const inspectJob = await tx.campaignJob.findFirst({
        where: {
          campaignId: input.campaignId,
          itemId: item.id,
          operation: "discovery_inspect",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      if (input.action === "select") {
        if (campaign.mode !== "research" || campaign.status === "archived")
          throw new CampaignRuleError(
            "Only a non-archived research campaign can select a discovery candidate",
          );
        const currentWebsiteIdentity = normalizedWebsiteIdentity(
          CampaignConfigInput.parse(campaign.config).websiteUrl,
        );
        if (normalizedWebsiteIdentity(String(metadata.rootUrl)) !== currentWebsiteIdentity)
          throw new CampaignRuleError(
            "This candidate belongs to a previous campaign website and cannot be selected",
          );
        if (!inspectJob) throw new CampaignRuleError("Candidate inspection is not recorded yet");
        const inspectCheckpoint = jsonObject(inspectJob.checkpoint);
        if (
          inspectCheckpoint.discoveryRunId !== metadata.runId ||
          inspectCheckpoint.discoveryRootUrl !== metadata.rootUrl ||
          inspectCheckpoint.discoveryPurpose !== "inspect" ||
          inspectCheckpoint.candidateUrl !== item.url
        ) {
          throw new CampaignRuleError("Candidate inspection identity does not match the item");
        }
        if (metadata.inspection !== "observed" || inspectJob.status !== "succeeded")
          throw new CampaignRuleError(
            "Only candidates with a successful inspection can be selected for research",
          );
        if (item.status !== "needs_action")
          throw new CampaignRuleError("Candidate is not ready for a research selection");
        const existingResearch = await tx.campaignJob.findFirst({
          where: {
            campaignId: input.campaignId,
            itemId: item.id,
            operation: "research_opportunity",
          },
          select: { id: true },
        });
        if (existingResearch)
          throw new CampaignConflictError("This candidate already has a research job");

        const selectionVersion = hashPayload({
          campaignId: input.campaignId,
          itemId: item.id,
          runId: metadata.runId,
          expectedUpdatedAt: input.expectedUpdatedAt,
        });
        const nextDetails = {
          ...details,
          discovery: { ...metadata, disposition: "selected" },
        };
        const changed = await tx.campaignItem.updateMany({
          where: { id: item.id, campaignId: input.campaignId, updatedAt: item.updatedAt },
          data: {
            status: "queued",
            details: jsonInput(nextDetails),
            updatedAt: new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1)),
          },
        });
        if (changed.count !== 1) throw new CampaignConflictError();
        await tx.campaignJob.create({
          data: {
            id: `discovery-selection-${selectionVersion.slice(0, 40)}`,
            campaignId: input.campaignId,
            itemId: item.id,
            operation: "research_opportunity",
            status: "queued",
            checkpoint: jsonInput({
              discoverySelectionVersion: selectionVersion,
              discoveryRunId: metadata.runId,
              discoveryRootUrl: metadata.rootUrl,
              selectedSourceItemIds: metadata.sourceItemIds,
            }),
          },
        });
        await appendCampaignEvent(tx, actor, input.campaignId, {
          type: "item_updated",
          summary:
            "Discovery candidate selected for research. Selection does not authorize registration or publication.",
          stepId: item.id,
        });
      } else {
        const discoveryJobs = await tx.campaignJob.findMany({
          where: {
            campaignId: input.campaignId,
            itemId: item.id,
            operation: { in: ["discovery_inspect"] },
            status: { in: ["queued", "running", "deferred", "needs_action", "reconciling"] },
          },
        });
        for (const job of discoveryJobs) {
          const checkpoint = jsonObject(job.checkpoint);
          if (
            checkpoint.discoveryRunId !== metadata.runId ||
            checkpoint.discoveryRootUrl !== metadata.rootUrl ||
            checkpoint.discoveryPurpose !== "inspect" ||
            checkpoint.candidateUrl !== item.url
          ) {
            continue;
          }
          await tx.campaignJob.updateMany({
            where: {
              id: job.id,
              status: { in: ["queued", "running", "deferred", "needs_action", "reconciling"] },
            },
            data: {
              status: "cancelled",
              checkpoint: jsonInput({ ...checkpoint, discoveryOutcome: "dismissed" }),
              leaseOwner: null,
              leaseExpiresAt: null,
              leaseFence: { increment: 1 },
              lastError: "candidate_dismissed",
            },
          });
        }
        const nextDetails = {
          ...details,
          discovery: { ...metadata, disposition: "dismissed" },
        };
        const changed = await tx.campaignItem.updateMany({
          where: { id: item.id, campaignId: input.campaignId, updatedAt: item.updatedAt },
          data: {
            status: "failed",
            details: jsonInput(nextDetails),
            updatedAt: new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1)),
          },
        });
        if (changed.count !== 1) throw new CampaignConflictError();
        await appendCampaignEvent(tx, actor, input.campaignId, {
          type: "item_updated",
          summary: "Discovery candidate dismissed; no research or external action was started.",
          stepId: item.id,
        });
      }

      const updated = await tx.campaignItem.findFirst({
        where: { id: item.id, campaignId: input.campaignId },
      });
      if (!updated) throw new CampaignNotFoundError();
      const dto = toCampaignItem(updated);
      await storeCommand(tx, input.campaignId, nonce, payloadHash, dto);
      return dto;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      return CampaignItem.parse(
        await replayCampaignCommand(prisma, actor, input.campaignId, nonce, payloadHash),
      );
    } catch (replayError) {
      rethrowCommandRace(replayError);
    }
  }
}

async function controlCampaignInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { campaignId: string; action: "start" | "pause" | "resume"; clientNonce: string },
) {
  const current = await requireCampaign(tx, actor, input.campaignId);
  const payloadHash = hashPayload({ action: input.action });
  const prior = await existingCommand<ReturnType<typeof Campaign.parse>>(
    tx,
    input.campaignId,
    input.clientNonce,
    payloadHash,
  );
  if (prior) return Campaign.parse(prior);
  if (input.action === "pause") {
    if (current.status === "archived")
      throw new CampaignRuleError("Archived campaigns cannot be paused");
    if (current.status !== "paused") {
      await appendCampaignEvent(
        tx,
        actor,
        current.id,
        {
          type: "run_paused",
          summary: "Campaign paused; accepted external work remains subject to reconciliation.",
        },
        { status: "paused" },
      );
    }
  } else {
    if (current.status === "archived")
      throw new CampaignRuleError("Archived campaigns cannot be started");
    if (input.action === "start" && current.status !== "draft") {
      throw new CampaignRuleError("Only draft campaigns can be started");
    }
    if (input.action === "resume" && current.status !== "paused") {
      throw new CampaignRuleError("Only paused campaigns can be resumed");
    }

    const catalogRunId =
      current.mode === "research" ? await ensureResearchCatalogBootstrap(tx, current) : null;

    const candidateItems = await tx.campaignItem.findMany({
      where: {
        campaignId: current.id,
        kind: { in: ["source", "opportunity"] },
        status: { in: ["queued", "researching"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const eligibleItems = candidateItems.filter(
      (item) => !isCatalogItem(item.details) && shouldScheduleAsResearch(item.details),
    );
    const existingJobs =
      input.action === "resume"
        ? await tx.campaignJob.count({
            where: {
              campaignId: current.id,
              status: {
                in: [
                  "queued",
                  "running",
                  "waiting_external",
                  "waiting_review",
                  "deferred",
                  "needs_action",
                  "reconciling",
                ],
              },
            },
          })
        : 0;
    if (eligibleItems.length === 0 && existingJobs === 0 && catalogRunId === null)
      throw new CampaignRuleError("Add an eligible source or opportunity before starting");

    if (eligibleItems.length > 0 && current.mode === "controlled") {
      const item = eligibleItems[0]!;
      const existingJob = await tx.campaignJob.findFirst({
        where: { campaignId: current.id, itemId: item.id, operation: "controlled_fixture" },
      });
      if (!existingJob) {
        await tx.campaignJob.create({
          data: {
            campaignId: current.id,
            itemId: item.id,
            operation: "controlled_fixture",
            checkpoint: jsonInput({ stage: "research" }),
          },
        });
      }
      if (item.status === "queued") {
        await tx.campaignItem.updateMany({
          where: { id: item.id, status: "queued" },
          data: { status: "researching" },
        });
      }
    } else if (eligibleItems.length > 0) {
      for (const item of eligibleItems) {
        const operation = item.kind === "source" ? "research_source" : "research_opportunity";
        const existingJob = await tx.campaignJob.findFirst({
          where: {
            campaignId: current.id,
            itemId: item.id,
            operation,
          },
        });
        if (!existingJob)
          await tx.campaignJob.create({
            data: { campaignId: current.id, itemId: item.id, operation },
          });
        if (item.status === "queued") {
          await tx.campaignItem.updateMany({
            where: { id: item.id, status: "queued" },
            data: { status: "researching" },
          });
        }
      }
    }
    await appendCampaignEvent(
      tx,
      actor,
      current.id,
      { type: "run_requested", summary: "Research run requested." },
      { status: "active" },
    );
  }
  const updated = toCampaign((await requireCampaign(tx, actor, current.id)) as CampaignRow);
  await storeCommand(tx, current.id, input.clientNonce, payloadHash, updated);
  return updated;
}

function isCatalogItem(value: Prisma.JsonValue): boolean {
  return Object.hasOwn(jsonObject(value), "catalog");
}

function shouldScheduleAsResearch(value: Prisma.JsonValue): boolean {
  const details = jsonObject(value);
  if (Object.hasOwn(details, "catalog")) return false;
  if (!Object.hasOwn(details, "discovery")) return true;
  const discovery = safeDiscovery(details.discovery);
  return discovery?.purpose === "candidate" && discovery.disposition === "selected";
}

async function ensureResearchCatalogBootstrap(
  tx: Prisma.TransactionClient,
  campaign: CampaignRow,
  websiteUrl?: string,
): Promise<string> {
  const config = CampaignConfigInput.parse(campaign.config);
  const rootUrl = normalizedWebsiteIdentity(websiteUrl ?? config.websiteUrl);
  const runId = hashPayload({ campaignId: campaign.id, websiteUrl: rootUrl });
  const itemId = `catalog-source-${runId}`;
  const jobId = `catalog-job-${runId}`;
  const details = jsonInput({
    catalog: {
      runId,
      rootUrl,
      purpose: "guidance",
      category: "guidance",
      provenance: "conventional_probe",
      depth: 0,
    },
  });
  await tx.campaignItem.upsert({
    where: { id: itemId },
    create: {
      id: itemId,
      campaignId: campaign.id,
      kind: "source",
      url: new URL("/robots.txt", rootUrl).href,
      title: "Website crawl guidance",
      status: "researching",
      details,
    },
    update: {},
  });
  await tx.campaignJob.upsert({
    where: { id: jobId },
    create: {
      id: jobId,
      campaignId: campaign.id,
      itemId,
      operation: "catalog_page",
      checkpoint: jsonInput({
        catalogRunId: runId,
        catalogRootUrl: rootUrl,
        catalogPurpose: "guidance",
        catalogDepth: 0,
      }),
    },
    update: {},
  });
  return runId;
}

async function cancelCatalogRunChildren(
  tx: Prisma.TransactionClient,
  campaignId: string,
  runId: string,
  parentJobId: string,
) {
  const reason = "Website catalog crawling is blocked because guidance was skipped.";
  const jobs = await tx.campaignJob.findMany({
    where: {
      campaignId,
      operation: "catalog_page",
      status: { in: ["queued", "running", "deferred", "needs_action"] },
    },
    select: { id: true, itemId: true, checkpoint: true },
  });
  for (const job of jobs) {
    const checkpoint = jsonObject(job.checkpoint);
    if (job.id === parentJobId || checkpoint.catalogRunId !== runId) continue;
    const cancelled = await tx.campaignJob.updateMany({
      where: { id: job.id, status: { in: ["queued", "running", "deferred", "needs_action"] } },
      data: {
        status: "cancelled",
        checkpoint: jsonInput({
          ...checkpoint,
          catalogOutcome: "blocked",
          catalogSafeError: "guidance_skipped",
        }),
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: { increment: 1 },
        lastError: "guidance_skipped",
      },
    });
    if (cancelled.count !== 1 || !job.itemId) continue;
    const child = await tx.campaignItem.findFirst({
      where: {
        id: job.itemId,
        campaignId,
        status: { in: ["queued", "researching", "deferred", "needs_action"] },
      },
    });
    if (child) {
      await tx.campaignItem.update({
        where: { id: child.id },
        data: {
          status: "failed",
          body: reason,
          details: jsonInput({ ...toSafeDetails(child.details), recoveryReason: reason }),
        },
      });
    }
  }
}

export async function controlCampaign(
  prisma: PrismaClient,
  actor: Actor,
  input: { campaignId: string; action: "start" | "pause" | "resume"; clientNonce: string },
) {
  const payloadHash = hashPayload({ action: input.action });
  try {
    return await transaction(prisma, async (tx) => controlCampaignInTransaction(tx, actor, input));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      return Campaign.parse(
        await replayCampaignCommand(
          prisma,
          actor,
          input.campaignId,
          input.clientNonce,
          payloadHash,
        ),
      );
    } catch (replayError) {
      rethrowCommandRace(replayError);
    }
  }
}

export async function stopAllCampaigns(prisma: PrismaClient, actor: Actor, clientNonce: string) {
  const commandNonce = `stop-all:${clientNonce}`;
  return transaction(prisma, async (tx) => {
    const active = await tx.campaign.findMany({
      where: { workspaceId: actor.workspaceId, userId: actor.userId, status: "active" },
      select: { id: true },
    });
    for (const campaign of active) {
      await controlCampaignInTransaction(tx, actor, {
        campaignId: campaign.id,
        action: "pause",
        clientNonce: commandNonce,
      });
    }
    const priorCommands = await tx.campaignCommand.count({
      where: {
        nonce: commandNonce,
        campaign: { is: { workspaceId: actor.workspaceId, userId: actor.userId } },
      },
    });
    return { pausedCount: priorCommands };
  });
}

export async function recoverCampaignItem(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    campaignId: string;
    itemId: string;
    action: "retry" | "defer" | "skip";
    clientNonce: string;
  },
) {
  const nonce = `recover:${input.clientNonce}`;
  const payloadHash = hashPayload({ itemId: input.itemId, action: input.action });
  try {
    return await transaction(prisma, async (tx) => {
      const campaign = await requireCampaign(tx, actor, input.campaignId);
      const prior = await existingCommand<ReturnType<typeof CampaignItem.parse>>(
        tx,
        input.campaignId,
        nonce,
        payloadHash,
      );
      if (prior) return CampaignItem.parse(prior);
      if (campaign.mode !== "research")
        throw new CampaignRuleError("Only research items can be recovered manually");

      const item = await tx.campaignItem.findFirst({
        where: { id: input.itemId, campaignId: input.campaignId },
      });
      if (!item) throw new CampaignNotFoundError();
      const itemDetails = jsonObject(item.details);
      const hasCatalogMarker = Object.hasOwn(itemDetails, "catalog");
      const catalog = hasCatalogMarker ? safeCatalog(itemDetails.catalog) : null;
      if (hasCatalogMarker && (!catalog || item.kind !== "source"))
        throw new CampaignRuleError(
          "Catalog metadata is invalid; this item cannot be recovered safely",
        );
      const hasDiscoveryMarker = Object.hasOwn(itemDetails, "discovery");
      const discovery = hasDiscoveryMarker ? safeDiscovery(itemDetails.discovery) : null;
      if (hasDiscoveryMarker && !discovery)
        throw new CampaignRuleError(
          "Discovery metadata is invalid; this item cannot be recovered safely",
        );
      if (item.kind !== "source" && item.kind !== "opportunity")
        throw new CampaignRuleError("Only research sources and opportunities can be recovered");
      if (
        discovery &&
        ((discovery.purpose === "search" && item.kind !== "source") ||
          (discovery.purpose === "candidate" && item.kind !== "opportunity"))
      ) {
        throw new CampaignRuleError("Discovery metadata does not match this item kind");
      }
      if (discovery?.purpose === "candidate" && discovery.disposition === "dismissed")
        throw new CampaignRuleError("Dismissed discovery candidates cannot be recovered");

      const isCatalog = catalog !== null && discovery === null;
      const operation = discovery
        ? discovery.purpose === "search"
          ? "discovery_search"
          : discovery.disposition === "selected"
            ? "research_opportunity"
            : "discovery_inspect"
        : isCatalog
          ? "catalog_page"
          : item.kind === "source"
            ? "research_source"
            : "research_opportunity";
      const job = await tx.campaignJob.findFirst({
        where: { campaignId: input.campaignId, itemId: item.id, operation },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!job) throw new CampaignRuleError("This item has no recoverable research job");
      const checkpoint = jsonObject(job.checkpoint);
      const isDiscovery = discovery !== null;
      const isDiscoveryReadJob =
        isDiscovery && (operation === "discovery_search" || operation === "discovery_inspect");
      if (
        isCatalog &&
        (checkpoint.catalogRunId !== catalog.runId ||
          checkpoint.catalogRootUrl !== catalog.rootUrl ||
          checkpoint.catalogPurpose !== catalog.purpose ||
          checkpoint.catalogDepth !== catalog.depth)
      ) {
        throw new CampaignRuleError("Catalog job identity does not match this source item");
      }
      if (
        isDiscoveryReadJob &&
        discovery &&
        (checkpoint.discoveryRunId !== discovery.runId ||
          checkpoint.discoveryRootUrl !== discovery.rootUrl ||
          checkpoint.discoveryPurpose !== (discovery.purpose === "search" ? "search" : "inspect"))
      ) {
        throw new CampaignRuleError("Discovery job identity does not match this item");
      }
      const isGuidance = isCatalog && catalog.purpose === "guidance";
      const currentStatus = item.status;
      if (input.action === "retry") {
        if (!["queued", "deferred", "needs_action", "failed"].includes(job.status))
          throw new CampaignRuleError("This research job cannot be retried in its current state");
        if (!["queued", "deferred", "needs_action", "failed"].includes(currentStatus))
          throw new CampaignRuleError("This research item cannot be retried in its current state");
        if (checkpoint.aiState === "intent" || checkpoint.aiState === "ambiguous")
          throw new CampaignRuleError(
            "The model result is uncertain. Resolve the existing draft manually; retry will not repeat a paid request.",
          );
        delete checkpoint.retryExhausted;
        if (isCatalog) {
          delete checkpoint.catalogOutcome;
          delete checkpoint.catalogSafeError;
          delete checkpoint.catalogSummaryEmitted;
        }
        if (isDiscoveryReadJob) {
          delete checkpoint.discoveryOutcome;
          delete checkpoint.discoveryCandidateCount;
          delete checkpoint.discoverySafeError;
          delete checkpoint.discoveryRetryExhausted;
          delete checkpoint.discoveryCompletedAt;
        }
        const now = new Date();
        await tx.campaignJob.update({
          where: { id: job.id },
          data: {
            status: "queued",
            attemptCount: 0,
            availableAt: now,
            startedAt: null,
            heartbeatAt: null,
            deadlineAt: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseFence: { increment: 1 },
            lastError: null,
            checkpoint: jsonInput(checkpoint),
          },
        });
        const retryDetails = clearReviewDetails(item.details);
        if (isDiscoveryReadJob && discovery) {
          const discoveryDetails = retryDetails.discovery as Record<string, unknown>;
          retryDetails.discovery = { ...discoveryDetails, inspection: "pending" };
        }
        await tx.campaignItem.update({
          where: { id: item.id },
          data: { status: "queued", details: jsonInput(retryDetails) },
        });
      } else if (input.action === "defer") {
        if (!["queued", "deferred", "needs_action", "failed", "running"].includes(job.status))
          throw new CampaignRuleError("This research job cannot be deferred in its current state");
        if (
          !["queued", "deferred", "needs_action", "failed", "researching"].includes(currentStatus)
        )
          throw new CampaignRuleError("This research item cannot be deferred in its current state");
        const now = new Date();
        checkpoint.deferReason = "User requested a five-minute pause.";
        await tx.campaignJob.update({
          where: { id: job.id },
          data: {
            status: "deferred",
            availableAt: new Date(now.getTime() + 5 * 60_000),
            startedAt: null,
            heartbeatAt: null,
            deadlineAt: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseFence: { increment: 1 },
            checkpoint: jsonInput(checkpoint),
          },
        });
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: "deferred",
            details: jsonInput({
              ...toSafeDetails(item.details),
              deferReason: "User requested a five-minute pause.",
            }),
          },
        });
      } else {
        if (!["queued", "deferred", "needs_action", "failed", "running"].includes(job.status))
          throw new CampaignRuleError("This research job cannot be skipped in its current state");
        if (
          !["queued", "deferred", "needs_action", "failed", "researching"].includes(currentStatus)
        )
          throw new CampaignRuleError("This research item cannot be skipped in its current state");
        const catalogSafeError = isGuidance ? "guidance_skipped" : "catalog_page_skipped";
        if (isCatalog) {
          checkpoint.catalogOutcome = isGuidance ? "blocked" : "failed";
          checkpoint.catalogSafeError = catalogSafeError;
        }
        await tx.campaignJob.update({
          where: { id: job.id },
          data: {
            status: "cancelled",
            ...(isCatalog
              ? { checkpoint: jsonInput(checkpoint), lastError: catalogSafeError }
              : {}),
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseFence: { increment: 1 },
          },
        });
        const skippedDetails = toSafeDetails(item.details);
        if (isDiscoveryReadJob && discovery?.purpose === "candidate") {
          const discoveryDetails = skippedDetails.discovery as Record<string, unknown>;
          skippedDetails.discovery = { ...discoveryDetails, disposition: "dismissed" };
        }
        await tx.campaignItem.update({
          where: { id: item.id },
          data: {
            status: "failed",
            details: jsonInput({
              ...skippedDetails,
              recoveryReason: isGuidance
                ? "Website catalog crawling is blocked because guidance was skipped."
                : isCatalog
                  ? "Catalog page skipped by user."
                  : "Skipped by user.",
            }),
          },
        });
        if (isGuidance && catalog) {
          await cancelCatalogRunChildren(tx, input.campaignId, String(catalog.runId), job.id);
        }
      }

      await appendCampaignEvent(tx, actor, input.campaignId, {
        type: "item_updated",
        summary:
          isGuidance && input.action === "skip"
            ? "Website catalog guidance was skipped; catalog crawling is blocked and no pages will be fetched."
            : isCatalog && input.action === "retry"
              ? "Catalog page queued for a fresh fetch; its run identity and guidance rules were preserved."
              : isCatalog && input.action === "defer"
                ? "Catalog page deferred for five minutes."
                : isCatalog
                  ? "Catalog page skipped by the user."
                  : isDiscovery && input.action === "retry"
                    ? "Discovery job queued for a fresh read; provider and run identity were preserved."
                    : isDiscovery && input.action === "defer"
                      ? "Discovery job deferred for five minutes."
                      : isDiscovery
                        ? "Discovery result dismissed by the user."
                        : input.action === "retry"
                          ? "Research item queued for a fresh read attempt."
                          : input.action === "defer"
                            ? "Research item deferred for five minutes."
                            : "Research item skipped by the user.",
        stepId: item.id,
      });
      const updated = await tx.campaignItem.findFirst({
        where: { id: item.id, campaignId: input.campaignId },
      });
      if (!updated) throw new CampaignNotFoundError();
      const dto = toCampaignItem(updated);
      await storeCommand(tx, input.campaignId, nonce, payloadHash, dto);
      return dto;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      return CampaignItem.parse(
        await replayCampaignCommand(prisma, actor, input.campaignId, nonce, payloadHash),
      );
    } catch (replayError) {
      rethrowCommandRace(replayError);
    }
  }
}
