import type { AdapterContext, SearchProvider } from "@rakazo/adapter-kit";
import {
  type LbLanguage,
  LbMarketPolicySchema,
  LbMarketsSchema,
  LbTopicLaneSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  discoverHosts,
  discoveryDue,
  isMailSendFailure,
  localDateKey,
  marketKey,
  registrableDomain,
} from "@rakazo/linkbuilder-core";
import { recordCost } from "./link-builder-costs.js";

const DISCOVER_RETRY_MS = 15 * 60 * 1000;

const adapter: AdapterContext = {
  operationId: "lb-discover",
  traceId: "lb-discover",
  workspaceId: "system",
  userId: "system",
  signal: new AbortController().signal,
};

/** True on the first pass after start, then once per local day from 03:00. */
export function shouldDiscover(last: Date | null, now: Date, timeZone: string): boolean {
  return discoveryDue(last, now, timeZone);
}

/**
 * Nightly and on-start discovery for active projects. Search and fetch are injected so tests
 * stay offline. Probe fetches are limited to the host the search result already named.
 */
export async function discoverDueProjects(input: {
  prisma: PrismaClient;
  search: SearchProvider;
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  now: Date;
}): Promise<number> {
  const projects = await input.prisma.lbProject.findMany({
    where: { status: "active", archivedAt: null },
  });
  let found = 0;
  for (const project of projects) {
    const schedule = project.schedule as { timezone?: string } | null;
    const timeZone = schedule?.timezone || "Europe/Berlin";
    if (!shouldDiscover(project.lastDiscoveredAt, input.now, timeZone)) continue;
    const markets = LbMarketsSchema.safeParse(project.markets);
    const lanes = LbTopicLaneSchema.array().safeParse(project.topicLanes);
    const policy = LbMarketPolicySchema.safeParse(project.marketPolicy);
    if (lanes.success && lanes.data.length === 0) {
      await recordDiscoveryFailure(
        input.prisma,
        project,
        input.now,
        "no topic lanes",
        "No topics to search",
      );
      continue;
    }
    if (!markets.success || !lanes.success || !policy.success) {
      await input.prisma.lbProject.update({
        where: { id: project.id },
        data: { lastDiscoveredAt: input.now },
      });
      continue;
    }
    if (await discoveryHeld(input.prisma, project.id, input.now)) continue;
    let stopAfterPartial = false;
    const hosts = await input.prisma.lbHost.findMany({
      where: { projectId: project.id },
      select: { registrableDomain: true, status: true, country: true, language: true },
    });
    const supply: Record<string, number> = {};
    for (const host of hosts) {
      if (host.status !== "qualified" && host.status !== "ready") continue;
      const key = marketKey({
        country: host.country,
        language: host.language as LbLanguage,
      });
      supply[key] = (supply[key] ?? 0) + 1;
    }
    const quotas = project.quotas as { livePerDay?: number } | null;
    let discovered: Awaited<ReturnType<typeof discoverHosts>>;
    try {
      discovered = await discoverHosts({
        lanes: lanes.data,
        markets: markets.data,
        policy: policy.data,
        supply,
        need: Math.max(1, quotas?.livePerDay ?? 1),
        denyHosts: project.denyHosts,
        usedHosts: hosts
          .filter((host) => host.status === "used")
          .map((host) => host.registrableDomain),
        depth: 100,
        search: async (request) => {
          if (stopAfterPartial) return [];
          const results = await input.search.search(request, {
            ...adapter,
            workspaceId: project.workspaceId,
          });
          const notice = partialNoticeOf(input.search);
          if (notice) {
            stopAfterPartial = true;
            await recordPartialResults(input.prisma, project, input.now, notice);
          }
          await recordCost(input.prisma, {
            workspaceId: project.workspaceId,
            projectId: project.id,
            kind: "search_query",
            quantity: 1,
            sourceKey: `search:${project.id}:${localDateKey(input.now, timeZone)}:${request.query}`,
            occurredAt: input.now,
          });
          return results;
        },
        fetchText: (url) =>
          fetchProbeText(url, {
            fetchImpl: input.fetchImpl ?? fetch,
            allowPrivate: input.allowPrivate ?? false,
          }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "search failed";
      await recordDiscoveryFailure(
        input.prisma,
        project,
        input.now,
        message,
        `Search failed: ${message}`,
      );
      continue;
    }
    for (const host of discovered) {
      const existing = await input.prisma.lbHost.findUnique({
        where: {
          workspaceId_projectId_registrableDomain: {
            workspaceId: project.workspaceId,
            projectId: project.id,
            registrableDomain: host.registrableDomain,
          },
        },
      });
      if (existing && existing.status !== "discovered") continue;
      const data = {
        homepageUrl: host.homepageUrl,
        platform: host.facts.platform,
        platformVersionHint: host.facts.platformVersionHint,
        language: host.market.language,
        country: host.market.country,
        locale: host.market.locale,
        timezoneId: host.market.timezoneId,
        topicTags: host.topicTags,
        qualityScore: host.score,
        hrefForNewMembers: host.facts.hrefForNewMembers,
        relDefault: host.facts.relDefault,
        signatureLinks: host.facts.signatureLinks,
        minPostsForLinks: host.facts.minPostsForLinks,
        registerUrl: host.facts.registerUrl,
        captchaType: host.facts.captchaType,
        status: host.status,
        statusReason: host.reason,
        lastProbeAt: input.now,
        notes: host.facts.rulesExcerpt || null,
      };
      const row = existing
        ? await input.prisma.lbHost.update({ where: { id: existing.id }, data })
        : await input.prisma.lbHost.create({
            data: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              registrableDomain: host.registrableDomain,
              ...data,
            },
          });
      found += host.status === "qualified" ? 1 : 0;
      for (const thread of host.facts.threads) {
        if (isMailSendFailure(thread.title)) continue;
        await input.prisma.lbThreadCandidate.upsert({
          where: { hostId_url: { hostId: row.id, url: thread.url } },
          create: {
            workspaceId: project.workspaceId,
            projectId: project.id,
            hostId: row.id,
            url: thread.url,
            title: thread.title,
            excerpt: thread.excerpt,
            laneId: host.laneIds[0] ?? null,
            openQuestion: thread.title.trim().endsWith("?"),
            status: "candidate",
          },
          update: { title: thread.title, excerpt: thread.excerpt },
        });
      }
    }
    await input.prisma.lbProject.update({
      where: { id: project.id },
      data: { lastDiscoveredAt: input.now },
    });
  }
  return found;
}

async function discoveryHeld(prisma: PrismaClient, projectId: string, now: Date): Promise<boolean> {
  const run = await prisma.lbRun.findFirst({
    where: { projectId, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const newest = await prisma.lbRunStep.findFirst({
    where: { runId: run.id, kind: "discover", error: { not: null } },
    orderBy: { stepIndex: "desc" },
    select: { finishedAt: true },
  });
  if (!newest?.finishedAt) return false;
  return now.getTime() - newest.finishedAt.getTime() < DISCOVER_RETRY_MS;
}

function partialNoticeOf(search: SearchProvider): string | null {
  if (!("partialNotice" in search)) return null;
  const notice = search.partialNotice;
  return typeof notice === "string" && notice.length > 0 ? notice : null;
}

async function recordPartialResults(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  now: Date,
  notice: string,
): Promise<void> {
  const action = `Search used partial results: ${notice}`.slice(0, 90);
  const run = await prisma.lbRun.findFirst({
    where: { projectId: project.id, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run) {
    console.error("linkbuilder.discover", project.id, "partial");
    return;
  }
  const stepIndex = await prisma.lbRunStep.count({ where: { runId: run.id } });
  await prisma.lbRunStep.create({
    data: {
      workspaceId: project.workspaceId,
      runId: run.id,
      stepIndex,
      kind: "discover",
      hostId: null,
      error: null,
      outcome: { lastAction: action },
      startedAt: now,
      finishedAt: now,
    },
  });
  await prisma.lbRun.update({
    where: { id: run.id },
    data: { lastAction: action },
  });
}

async function recordDiscoveryFailure(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  now: Date,
  message: string,
  lastAction: string,
): Promise<void> {
  const error = message.slice(0, 500);
  const action = lastAction.startsWith("Search failed")
    ? `Search failed: ${message}`.slice(0, 90)
    : lastAction;
  const run = await prisma.lbRun.findFirst({
    where: { projectId: project.id, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run) {
    console.error("linkbuilder.discover", project.id, error);
    return;
  }
  const newest = await prisma.lbRunStep.findFirst({
    where: { runId: run.id },
    orderBy: { stepIndex: "desc" },
  });
  if (
    newest?.kind === "discover" &&
    newest.error === error &&
    newest.finishedAt &&
    now.getTime() - newest.finishedAt.getTime() < DISCOVER_RETRY_MS
  ) {
    return;
  }
  const stepIndex = await prisma.lbRunStep.count({ where: { runId: run.id } });
  await prisma.lbRunStep.create({
    data: {
      workspaceId: project.workspaceId,
      runId: run.id,
      stepIndex,
      kind: "discover",
      hostId: null,
      error,
      outcome: { lastAction: action },
      startedAt: now,
      finishedAt: now,
    },
  });
  await prisma.lbRun.update({
    where: { id: run.id },
    data: { lastAction: action },
  });
}

async function fetchProbeText(
  url: string,
  input: { fetchImpl: typeof fetch; allowPrivate: boolean },
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const domain = registrableDomain(parsed.hostname);
  if (!domain) return null;
  if (!input.allowPrivate && isBlockedProbeHost(parsed.hostname)) return null;
  try {
    const response = await input.fetchImpl(url, {
      redirect: "manual",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status >= 300 && response.status < 400) return null;
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function isBlockedProbeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = host.split(".").map((part) => Number(part));
  if (v4.length === 4 && v4.every((part) => part >= 0 && part <= 255)) {
    const [a = 0, b = 0] = v4;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}
