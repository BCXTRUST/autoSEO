import { createHash } from "node:crypto";
import type {
  ArtifactStore,
  CaptchaSolver,
  NotificationProvider,
  RealtimeFanout,
  SearchProvider,
} from "@rakazo/adapter-kit";
import { CaptchaSolverError } from "@rakazo/adapter-kit";
import { type EncryptedSecretStore, STARTER_PLAN } from "@rakazo/adapters";
import {
  type LbHostStatus,
  LbOperatorSettingsSchema,
  LbParkableHostStatusSchema,
  LbPlacementStatusSchema,
  LbQuotasSchema,
  LbScheduleSchema,
  LbWhyNotSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  balanceCheckDue,
  buildWhyNot,
  closingRunStatus,
  countedAfterReverify,
  countedWithinPlan,
  type HostnameResolver,
  isRunTerminal,
  linkBuilderTopic,
  localDateKey,
  operatorHelpFor,
  type PlanCaps,
  pauseDedupeKey,
  recordCountedLive,
  releaseCountedLive,
  scheduleAt,
  shouldWriteWhyNot,
  ticketDue,
  transitionHost,
  transitionPlacement,
  transitionProject,
  transitionRun,
  verifyDeadline,
} from "@rakazo/linkbuilder-core";
import { verifyPlacement } from "@rakazo/linkbuilder-drivers";
import { createAlertSink, deliverDueWebhooks } from "./link-builder-alerts.js";
import { syncCostLedger } from "./link-builder-costs.js";
import { discoverDueProjects } from "./link-builder-discovery.js";
import { renewDueLeases } from "./link-builder-proxy.js";

export interface DueWorkDeps {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  now: Date;
  notifications?: NotificationProvider;
  webhookFetch?: typeof fetch;
  productionWebhooks?: boolean;
  resolveHostname?: HostnameResolver;
  /** Plan ceiling for counted LIVE links. Absent means the starter stub. */
  planCaps?: PlanCaps;
  verifyFetch?: typeof fetch;
  allowPrivateVerify?: boolean;
  artifacts?: ArtifactStore;
  realtime?: RealtimeFanout;
  search?: SearchProvider;
  probeFetch?: typeof fetch;
  allowPrivateProbe?: boolean;
  captcha?: CaptchaSolver;
  resolveCaptcha?: (project: { id: string; workspaceId: string }) => Promise<CaptchaSolver | null>;
  proxies?: Parameters<typeof renewDueLeases>[0]["provider"];
}

export async function runDueWork(deps: DueWorkDeps): Promise<void> {
  const productionWebhooks = deps.productionWebhooks ?? process.env.NODE_ENV === "production";
  const resolveHostname = productionWebhooks ? deps.resolveHostname : undefined;
  const alerts = createAlertSink({
    prisma: deps.prisma,
    secrets: deps.secrets,
    notifications: deps.notifications,
    now: deps.now,
    productionWebhooks,
    resolveHostname,
  });
  await expireTickets(deps);
  await openAndCloseRuns(deps, alerts);
  await verifyDuePlacements(deps, alerts);
  await checkBalances(deps, alerts);
  if (deps.search) {
    await discoverDueProjects({
      prisma: deps.prisma,
      search: deps.search,
      fetchImpl: deps.probeFetch,
      allowPrivate: deps.allowPrivateProbe ?? false,
      now: deps.now,
    }).catch(() => undefined);
  }
  if (deps.proxies) {
    await renewDueLeases({
      prisma: deps.prisma,
      provider: deps.proxies,
      secrets: deps.secrets,
      now: deps.now,
      context: {
        operationId: "lb-proxy-renew",
        traceId: "lb-proxy-renew",
        workspaceId: "renew",
        userId: "renew",
        signal: new AbortController().signal,
      },
    }).catch(() => undefined);
    await pauseDegradedProxies(deps, alerts);
  }
  await announceOpenTickets(deps, alerts);
  await syncCostLedger(deps.prisma);
  await deliverDueWebhooks({
    prisma: deps.prisma,
    secrets: deps.secrets,
    now: deps.now,
    fetchImpl: deps.webhookFetch,
    productionWebhooks,
    resolveHostname,
  });
}

/** Closes tickets the user cannot act on. A parked host is skipped. */
async function retireUnusableTickets(deps: DueWorkDeps): Promise<void> {
  const open = await deps.prisma.lbOperatorTicket.findMany({
    where: { status: "open" },
    include: { host: true },
  });
  for (const ticket of open) {
    if (
      operatorHelpFor({
        id: ticket.id,
        status: ticket.status,
        reason: ticket.reason,
        domain: ticket.host.registrableDomain,
        hostStatus: ticket.host.status,
      })
    ) {
      continue;
    }
    await deps.prisma.$transaction(async (tx) => {
      const closed = await tx.lbOperatorTicket.updateMany({
        where: { id: ticket.id, status: "open" },
        data: { status: "skipped", resolvedAt: deps.now },
      });
      if (closed.count !== 1 || ticket.host.status !== "parked_operator") return;
      const parkedFrom = LbParkableHostStatusSchema.safeParse(ticket.host.parkedFrom).data ?? null;
      const next = transitionHost({ status: "parked_operator", parkedFrom }, "operator_skipped");
      await tx.lbHost.updateMany({
        where: { id: ticket.hostId, status: "parked_operator" },
        data: {
          status: next.status,
          parkedFrom: next.parkedFrom,
          statusReason: ticket.reason,
        },
      });
    });
    await publish(deps, ticket.projectId);
  }
}

async function expireTickets(deps: DueWorkDeps): Promise<void> {
  await retireUnusableTickets(deps);
  const open = await deps.prisma.lbOperatorTicket.findMany({
    where: { status: "open" },
    include: { host: true, project: true },
  });
  for (const ticket of open) {
    if (!ticketDue(ticket.expiresAt, deps.now)) continue;
    const settings = LbOperatorSettingsSchema.safeParse(ticket.project.operator);
    const event =
      settings.success && settings.data.onExpire === "requalify"
        ? "park_requalified"
        : "park_expired";
    const parkedFrom = LbParkableHostStatusSchema.safeParse(ticket.host.parkedFrom).data ?? null;
    await deps.prisma.$transaction(async (tx) => {
      const current = await tx.lbOperatorTicket.updateMany({
        where: { id: ticket.id, status: "open" },
        data: { status: "expired", resolvedAt: deps.now },
      });
      if (current.count !== 1 || ticket.host.status !== "parked_operator" || !parkedFrom) return;
      const next = transitionHost({ status: "parked_operator", parkedFrom }, event);
      await tx.lbHost.updateMany({
        where: { id: ticket.hostId, status: "parked_operator" },
        data: { status: next.status, parkedFrom: next.parkedFrom },
      });
    });
    await publish(deps, ticket.projectId);
  }
}

async function openAndCloseRuns(
  deps: DueWorkDeps,
  alerts: ReturnType<typeof createAlertSink>,
): Promise<void> {
  const projects = await deps.prisma.lbProject.findMany({
    where: { status: "active", archivedAt: null },
  });
  for (const project of projects) {
    const schedule = LbScheduleSchema.safeParse(project.schedule);
    const quotas = LbQuotasSchema.safeParse(project.quotas);
    if (!schedule.success || !quotas.success) continue;
    const today = localDateKey(deps.now, schedule.data.timezone);
    const run = await deps.prisma.lbRun.findFirst({
      where: { projectId: project.id, date: today },
    });
    const liveMet = (run?.liveToday ?? 0) >= quotas.data.livePerDay;
    const state = scheduleAt(deps.now, schedule.data, liveMet);
    if (state.active && !run) {
      const liveWeek = await weekLiveBefore(deps.prisma, project.id, today);
      await deps.prisma.lbRun.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          date: today,
          status: state.mode === "overtime" ? "overtime" : "running",
          liveWeek,
          startedAt: deps.now,
          lastAction: state.mode === "overtime" ? "Overtime" : "Started",
        },
      });
      await publish(deps, project.id);
    } else if (run && state.mode === "overtime" && run.status === "running") {
      await deps.prisma.lbRun.update({
        where: { id: run.id },
        data: { status: transitionRun("running", "overtime"), lastAction: "Overtime" },
      });
      await publish(deps, project.id);
    }
    const current = await deps.prisma.lbRun.findFirst({
      where: { projectId: project.id, date: today },
    });
    if (!current || !shouldWriteWhyNot(state.reason, false)) continue;
    const runStatus = readRunStatus(current.status);
    if (current.whyNot && isRunTerminal(runStatus)) continue;
    const previous = LbWhyNotSchema.safeParse(current.whyNot);
    const whyNot = await whyNotFor(deps, project, {
      modelErrors: previous.success ? previous.data.modelErrors : 0,
      modelRefusals: previous.success ? previous.data.modelRefusals : 0,
    });
    if (runStatus !== "running" && runStatus !== "overtime") {
      await deps.prisma.lbRun.update({ where: { id: current.id }, data: { whyNot } });
      await alerts.emit({
        kind: "run.finished",
        workspaceId: project.workspaceId,
        projectId: project.id,
        dedupeKey: `run.finished:${current.id}`,
        message: "Run finished",
        payload: { runId: current.id, status: runStatus },
      });
      continue;
    }
    const closing = closingRunStatus(
      {
        newToday: current.newToday,
        liveToday: current.liveToday,
        liveWeek: current.liveWeek,
        uniqueHosts: current.uniqueHosts,
      },
      quotas.data,
    );
    transitionRun(runStatus, closing);
    await deps.prisma.lbRun.update({
      where: { id: current.id },
      data: {
        whyNot,
        status: closing,
        finishedAt: deps.now,
        leaseExpiresAt: null,
        lastAction: closing === "succeeded" ? "Daily goal met" : "Day closed",
      },
    });
    await alerts.emit({
      kind: "run.finished",
      workspaceId: project.workspaceId,
      projectId: project.id,
      dedupeKey: `run.finished:${current.id}`,
      message: closing === "succeeded" ? "Run finished" : "Run finished below quota",
      payload: { runId: current.id, status: closing },
    });
    await publish(deps, project.id);
  }
}

async function verifyDuePlacements(
  deps: DueWorkDeps,
  alerts: ReturnType<typeof createAlertSink>,
): Promise<void> {
  const due = await deps.prisma.lbPlacement.findMany({
    where: {
      status: { not: "dead" },
      nextVerifyAt: { lte: deps.now },
      project: { status: { in: ["active", "paused"] }, archivedAt: null },
    },
    include: { project: true, host: true },
  });
  for (const placement of due) {
    if (!placement.nextVerifyAt || placement.nextVerifyAt > deps.now) continue;
    // The first check of a host the runner is still driving stays on the verify step.
    if (
      placement.status === "pending" &&
      placement.verifyCount === 0 &&
      ["qualified", "registering", "pending_email", "warming", "ready"].includes(
        placement.host.status,
      )
    ) {
      continue;
    }
    let checked: Awaited<ReturnType<typeof verifyPlacement>>;
    try {
      checked = await verifyPlacement({
        postUrl: placement.postUrl,
        targetUrl: placement.targetUrl,
        fetchImpl: deps.verifyFetch,
        allowPrivateNetwork: deps.allowPrivateVerify ?? false,
      });
    } catch {
      continue;
    }
    const schedule = LbScheduleSchema.safeParse(placement.project.schedule);
    const timezone = schedule.success ? schedule.data.timezone : "UTC";
    const current = LbPlacementStatusSchema.parse(placement.status);
    const status = transitionPlacement(current, checked.outcome.status);
    const others = await deps.prisma.lbPlacement.count({
      where: { hostId: placement.hostId, counted: true, id: { not: placement.id } },
    });
    let counted = countedAfterReverify({
      wasCounted: placement.counted,
      status,
      countNofollow: placement.project.countNofollow,
      anotherCountedOnHost: others > 0,
    });
    if (!placement.counted && counted) {
      const date = localDateKey(placement.createdAt, timezone);
      const day = await deps.prisma.lbRun.findFirst({
        where: { projectId: placement.projectId, date },
        select: { liveToday: true },
      });
      counted = countedWithinPlan({
        wantCounted: true,
        countedToday: day?.liveToday ?? 0,
        livePerDay: (deps.planCaps ?? STARTER_PLAN.caps).live_per_day,
      });
    }
    const snapshotArtifactId = await storeSnapshot(deps, placement, checked.html);
    const completed = placement.verifyCount + 1;
    await deps.prisma.$transaction(async (tx) => {
      await tx.lbPlacement.update({
        where: { id: placement.id },
        data: {
          status,
          rel: checked.outcome.rel,
          indexable: checked.outcome.indexable,
          verifiedAt: deps.now,
          verifyMethod: "logged_out_fetch",
          snapshotArtifactId,
          counted,
          verifyCount: completed,
          nextVerifyAt: status === "dead" ? null : verifyDeadline(placement.createdAt, completed),
        },
      });
      const countedOn = placement.createdAt;
      if (placement.counted && !counted) {
        await shiftCounted(tx, placement.projectId, timezone, countedOn, -1);
      } else if (!placement.counted && counted) {
        await shiftCounted(tx, placement.projectId, timezone, countedOn, 1);
      }
      if (counted && placement.host.status === "ready") {
        const next = transitionHost(placement.host.status as LbHostStatus, "link_counted");
        await tx.lbHost.updateMany({
          where: { id: placement.hostId, status: "ready" },
          data: { status: next.status, parkedFrom: null },
        });
      }
    });
    if (counted && (status === "live" || status === "nofollow_live")) {
      await alerts.emit({
        kind: "placement.live",
        workspaceId: placement.workspaceId,
        projectId: placement.projectId,
        dedupeKey: `placement.live:${placement.id}`,
        message: "Placement is LIVE",
        payload: { placementId: placement.id, status },
      });
    }
    await publish(deps, placement.projectId);
  }
}

async function checkBalances(
  deps: DueWorkDeps,
  alerts: ReturnType<typeof createAlertSink>,
): Promise<void> {
  if (process.env.CAPTELL_API_KEY?.trim()) return;
  const projects = await deps.prisma.lbProject.findMany({
    where: { status: "active", archivedAt: null },
  });
  for (const project of projects) {
    const schedule = LbScheduleSchema.safeParse(project.schedule);
    const quotas = LbQuotasSchema.safeParse(project.quotas);
    if (!schedule.success || !quotas.success) continue;
    const today = localDateKey(deps.now, schedule.data.timezone);
    const run = await deps.prisma.lbRun.findFirst({
      where: { projectId: project.id, date: today },
    });
    const liveMet = (run?.liveToday ?? 0) >= quotas.data.livePerDay;
    const state = scheduleAt(deps.now, schedule.data, liveMet);
    if (!balanceCheckDue({ scheduleActive: state.active, checkedThisTick: false })) continue;
    const solver =
      (await deps.resolveCaptcha?.({ id: project.id, workspaceId: project.workspaceId })) ??
      deps.captcha ??
      null;
    if (!solver) continue;
    let credits: number;
    try {
      credits = (
        await solver.balance({
          operationId: `lb-balance:${project.id}`,
          traceId: `lb-balance:${project.id}`,
          workspaceId: project.workspaceId,
          userId: project.createdByUserId,
          signal: new AbortController().signal,
        })
      ).credits;
    } catch (error) {
      if (!(error instanceof CaptchaSolverError) || error.code !== "credits") continue;
      credits = 0;
    }
    await deps.prisma.lbProject.update({
      where: { id: project.id },
      data: { lastCaptchaBalance: credits },
    });
    if (credits >= project.captchaLowBalanceCredits) continue;
    const paused = await deps.prisma.$transaction(async (tx) => {
      const updated = await tx.lbProject.updateMany({
        where: { id: project.id, status: "active" },
        data: { status: transitionProject("active", "paused"), lastCaptchaBalance: credits },
      });
      if (updated.count !== 1) return false;
      await tx.lbCaptchaEvent.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          runId: run?.id,
          type: "unsupported",
          door: "https_api",
          outcome: "credits",
          attempt: 1,
          creditsCharged: 0,
          balanceAfter: credits,
          createdAt: deps.now,
        },
      });
      if (run) {
        await tx.lbRun.update({
          where: { id: run.id },
          data: { lastAction: "Paused, Captell balance is low" },
        });
      }
      return true;
    });
    if (!paused) continue;
    await alerts.emit({
      kind: "project.paused",
      workspaceId: project.workspaceId,
      projectId: project.id,
      dedupeKey: pauseDedupeKey("balance"),
      message: "Paused, Captell balance is low",
      payload: { reason: "balance", balance: credits },
    });
    await publish(deps, project.id);
  }
}

async function pauseDegradedProxies(
  deps: DueWorkDeps,
  alerts: ReturnType<typeof createAlertSink>,
): Promise<void> {
  const stale = await deps.prisma.lbProxyLease.findMany({
    where: { status: "active", renewsAt: { lt: deps.now } },
    select: { projectId: true, workspaceId: true },
  });
  const seen = new Set<string>();
  for (const lease of stale) {
    if (seen.has(lease.projectId)) continue;
    seen.add(lease.projectId);
    const project = await deps.prisma.lbProject.findUnique({ where: { id: lease.projectId } });
    if (project?.status !== "active") continue;
    const paused = await deps.prisma.lbProject.updateMany({
      where: { id: project.id, status: "active" },
      data: { status: "paused" },
    });
    if (paused.count !== 1) continue;
    await alerts.emit({
      kind: "project.paused",
      workspaceId: project.workspaceId,
      projectId: project.id,
      dedupeKey: pauseDedupeKey("proxy"),
      message: "Paused, proxy is degraded",
      payload: { reason: "proxy" },
    });
  }
  const unhealthy = await deps.prisma.lbProject.findMany({
    where: {
      status: "active",
      archivedAt: null,
      OR: [{ mailboxId: null }, { mailboxAddress: null }],
    },
  });
  for (const project of unhealthy) {
    const paused = await deps.prisma.lbProject.updateMany({
      where: { id: project.id, status: "active" },
      data: { status: "paused" },
    });
    if (paused.count !== 1) continue;
    await alerts.emit({
      kind: "project.paused",
      workspaceId: project.workspaceId,
      projectId: project.id,
      dedupeKey: pauseDedupeKey("mailbox"),
      message: "Paused, mailbox is unhealthy",
      payload: { reason: "mailbox" },
    });
  }
}

async function announceOpenTickets(
  deps: DueWorkDeps,
  alerts: ReturnType<typeof createAlertSink>,
): Promise<void> {
  const tickets = await deps.prisma.lbOperatorTicket.findMany({
    where: { status: "open" },
    include: { host: { select: { registrableDomain: true, status: true } } },
  });
  for (const ticket of tickets) {
    const help = operatorHelpFor({
      id: ticket.id,
      status: ticket.status,
      reason: ticket.reason,
      domain: ticket.host.registrableDomain,
      hostStatus: ticket.host.status,
    });
    if (!help) continue;
    await alerts.emit({
      kind: "captcha.needs_operator",
      workspaceId: ticket.workspaceId,
      projectId: ticket.projectId,
      dedupeKey: `captcha.needs_operator:${ticket.id}`,
      message: help.label,
      payload: { ticketId: ticket.id, hostId: ticket.hostId },
    });
  }
}

async function whyNotFor(
  deps: DueWorkDeps,
  project: {
    id: string;
    captchaLowBalanceCredits: number;
    lastCaptchaBalance: number | null;
  },
  preserved: { modelErrors: number; modelRefusals: number },
) {
  const hosts = await deps.prisma.lbHost.findMany({
    where: { projectId: project.id },
    select: { status: true },
  });
  const hostCounts: Partial<Record<LbHostStatus, number>> = {};
  for (const host of hosts) {
    const status = host.status as LbHostStatus;
    hostCounts[status] = (hostCounts[status] ?? 0) + 1;
  }
  const stale = await deps.prisma.lbProxyLease.count({
    where: { projectId: project.id, status: "active", renewsAt: { lt: deps.now } },
  });
  return LbWhyNotSchema.parse(
    buildWhyNot({
      hostCounts,
      modelErrors: preserved.modelErrors,
      modelRefusals: preserved.modelRefusals,
      captchaBalance: project.lastCaptchaBalance,
      lowBalanceCredits: project.captchaLowBalanceCredits,
      proxy: stale > 0 ? "degraded" : "ok",
    }),
  );
}

async function shiftCounted(
  tx: Prisma.TransactionClient,
  projectId: string,
  timeZone: string,
  countedOn: Date,
  delta: 1 | -1,
): Promise<void> {
  const date = localDateKey(countedOn, timeZone);
  const week = weekStart(date);
  const runs = await tx.lbRun.findMany({ where: { projectId } });
  for (const run of runs) {
    if (weekStart(run.date) !== week) continue;
    const counters = {
      newToday: run.newToday,
      liveToday: run.liveToday,
      liveWeek: run.liveWeek,
      uniqueHosts: run.uniqueHosts,
    };
    const next =
      delta === 1
        ? run.date === date
          ? recordCountedLive(counters)
          : counters
        : releaseCountedLive(counters, run.date === date);
    if (
      next.liveToday === counters.liveToday &&
      next.liveWeek === counters.liveWeek &&
      next.uniqueHosts === counters.uniqueHosts
    ) {
      continue;
    }
    await tx.lbRun.update({
      where: { id: run.id },
      data: {
        liveToday: next.liveToday,
        liveWeek: next.liveWeek,
        uniqueHosts: next.uniqueHosts,
      },
    });
  }
}

async function weekLiveBefore(
  prisma: PrismaClient,
  projectId: string,
  date: string,
): Promise<number> {
  const runs = await prisma.lbRun.findMany({
    where: { projectId },
    select: { date: true, liveToday: true },
  });
  const week = weekStart(date);
  return runs
    .filter((run) => run.date !== date && weekStart(run.date) === week)
    .reduce((sum, run) => sum + run.liveToday, 0);
}

function weekStart(dateKey: string): string {
  const [year = 0, month = 1, day = 1] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

function readRunStatus(status: string) {
  const parsed = [
    "queued",
    "running",
    "paused",
    "overtime",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
  ];
  if (!parsed.includes(status)) return "failed" as const;
  return status as
    | "queued"
    | "running"
    | "paused"
    | "overtime"
    | "succeeded"
    | "partial"
    | "failed"
    | "cancelled";
}

async function storeSnapshot(
  deps: DueWorkDeps,
  placement: { id: string; workspaceId: string; project: { createdByUserId: string } },
  html: string,
): Promise<string | null> {
  if (!deps.artifacts) return null;
  const bytes = new TextEncoder().encode(html);
  try {
    const stored = await deps.artifacts.put(
      { name: `verify-${placement.id}.html`, mimeType: "text/html", bytes },
      {
        operationId: `lb-verify:${placement.id}`,
        traceId: `lb-verify:${placement.id}`,
        workspaceId: placement.workspaceId,
        userId: placement.project.createdByUserId,
        signal: new AbortController().signal,
      },
    );
    const row = await deps.prisma.artifact.create({
      data: {
        workspaceId: placement.workspaceId,
        userId: placement.project.createdByUserId,
        name: `verify-${placement.id}.html`,
        mimeType: "text/html",
        size: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
        storageKey: stored.id,
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null;
  }
}

async function publish(deps: DueWorkDeps, projectId: string): Promise<void> {
  await deps.realtime
    ?.publish(linkBuilderTopic(projectId), JSON.stringify({ cursor: deps.now.toISOString() }))
    .catch(() => undefined);
}
