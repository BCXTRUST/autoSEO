import { lookup } from "node:dns/promises";
import { ORPCError } from "@orpc/server";
import { CaptchaSolverError } from "@rakazo/adapter-kit";
import { CaptellHttpSolver, StaticPlanProvider, stripeCheckoutConfigured } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  EMPTY_COST_SUMMARY,
  LB_DEFAULT_LINK_RATIO,
  LB_DEFAULT_MARKET,
  LB_RESPONSIBILITY_ACK_TEXT_VERSION,
  LbCaptchaDoorSchema,
  LbCaptchaOutcomeSchema,
  LbCaptchaTokenSchema,
  LbCaptchaTypeSchema,
  LbContentSchema,
  LbDisclosureModeSchema,
  LbDraftQualityChecksSchema,
  LbDraftStatusSchema,
  LbHostPlatformSchema,
  type LbHostStatus,
  LbHostStatusSchema,
  LbHrefForNewMembersSchema,
  LbLinkRatioSchema,
  LbLinkSlotSchema,
  LbMarketPolicySchema,
  LbMarketsSchema,
  LbModelLaneSchema,
  LbOperatorSettingsSchema,
  LbOperatorTicketReasonSchema,
  LbOperatorTicketStatusSchema,
  type LbParkableHostStatus,
  LbParkableHostStatusSchema,
  LbPersonaSchema,
  type LbPlacementStatus,
  LbPlacementStatusSchema,
  type LbProjectDetail,
  type LbProjectPatch,
  LbProjectStartableSchema,
  type LbProjectStatus,
  LbProxyLeaseViewSchema,
  LbProxyPolicySchema,
  LbQuotasSchema,
  LbRelDefaultSchema,
  LbResponsibilityAckSchema,
  type LbRunStatus,
  LbRunStatusSchema,
  LbScheduleSchema,
  LbTargetSchema,
  LbThreadStatusSchema,
  LbTopicLaneSchema,
  LbWarmupSchema,
  LbWhyNotSchema,
} from "@rakazo/contracts";
import { LB_DEMO_SLUG, Prisma, type PrismaClient, seedLinkBuilderDemo } from "@rakazo/db";
import {
  applyRunPhrase,
  assertStartWithinPlan,
  brandNameSources,
  resolvePersonaDisplayName,
  buildWhyNot,
  CHECKOUT_NOT_CONNECTED_REASON,
  CREDIT_PACKAGES,
  creditBalanceFromLedger,
  type HostnameResolver,
  isCannedResearchLine,
  isStaleResearchLine,
  isWithinWindow,
  linkBuilderTopic,
  localDateKey,
  operatorHelpFor,
  mayCreateLinkBuilderProject,
  mentionsExampleDomain,
  mentionsFixtureHost,
  PAGE_HELPER_VERSION,
  PlanLimitError,
  projectActivity,
  quoteCreditPurchase,
  type ScheduleState,
  settleCreditPurchase,
  showHostToCustomer,
  stageFromActivity,
  suggestFromPublicPage,
  transitionHost,
  transitionPlacement,
  transitionProject,
  transitionRun,
  validateTargetUrl,
  webhookUrlAllowed,
} from "@rakazo/linkbuilder-core";
import type { RouterDeps } from "./router.js";

const DEFAULT_SCHEDULE = LbScheduleSchema.parse({ timezone: "Europe/Berlin" });

const productionHostnameResolver: HostnameResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address }));
};

/** Drop offline board names, and drop the old captcha handoff line, from a customer-facing event. */
function customerFacingEvent(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/\b(?:forum|fragen|brett)-[a-z0-9]+\.example\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/parked/i.test(cleaned) && /operator/i.test(cleaned)) return null;
  if (/live quota met/i.test(cleaned) || /captcha/i.test(cleaned)) return null;
  if (isCannedResearchLine(cleaned) || isStaleResearchLine(cleaned)) return null;
  return cleaned || null;
}

/** Captell solves captchas. Fixture boards and unsolved-captcha tickets stay off the customer UI. */
function shownToCustomer(
  row: {
    reason?: string;
    domain?: string | null;
    registrableDomain?: string;
    host?: { registrableDomain: string } | null;
  },
  slug?: string | null,
): boolean {
  if (row.reason === "captcha_unsolved") return false;
  const domain = row.registrableDomain ?? row.domain ?? row.host?.registrableDomain ?? "";
  if (!domain) return true;
  return showHostToCustomer(domain, slug);
}

/**
 * Closes tickets a person cannot finish from the UI. A host still parked for one of
 * those tickets is skipped. A view-only desktop is not an action.
 */
async function retireUnusableTickets(prisma: PrismaClient, workspaceId: string): Promise<void> {
  const open = await prisma.lbOperatorTicket.findMany({
    where: { workspaceId, status: "open" },
    include: {
      host: { select: { status: true, parkedFrom: true, registrableDomain: true } },
    },
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
    await prisma.$transaction(async (tx) => {
      const closed = await tx.lbOperatorTicket.updateMany({
        where: { id: ticket.id, status: "open" },
        data: { status: "skipped", resolvedAt: new Date() },
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
  }
}

function helpForTicket(ticket: {
  id: string;
  status: string;
  reason: string;
  host?: { status: string; registrableDomain: string } | null;
}): ReturnType<typeof operatorHelpFor> {
  return operatorHelpFor({
    id: ticket.id,
    status: ticket.status,
    reason: ticket.reason,
    domain: ticket.host?.registrableDomain ?? "",
    hostStatus: ticket.host?.status ?? "",
  });
}

/** Fixture boards are not this customer's links. The Nordlicht demo keeps its own counts. */
function customerCounters(
  slug: string,
  run: { newToday: number; liveToday: number; liveWeek: number } | null,
  hosts: { registrableDomain: string }[],
): { newToday: number; liveToday: number; liveWeek: number } {
  const fixtureOnly =
    slug !== LB_DEMO_SLUG &&
    hosts.length > 0 &&
    hosts.every((host) => !showHostToCustomer(host.registrableDomain, slug));
  if (fixtureOnly || !run) {
    return {
      newToday: fixtureOnly ? 0 : (run?.newToday ?? 0),
      liveToday: fixtureOnly ? 0 : (run?.liveToday ?? 0),
      liveWeek: fixtureOnly ? 0 : (run?.liveWeek ?? 0),
    };
  }
  return { newToday: run.newToday, liveToday: run.liveToday, liveWeek: run.liveWeek };
}

/** Read a public page on one of the project's sites and suggest a keyword and a short rule. */
export async function suggestLbPage(input: {
  url: string;
  allowedDomains: string[];
}): Promise<{ keyword: string; rule: string }> {
  const trimmed = input.url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const checked = validateTargetUrl(withScheme, input.allowedDomains);
  if (!checked.ok) return { keyword: "", rule: "" };
  try {
    return await suggestFromPublicPage(checked.url, { resolve: productionHostnameResolver });
  } catch {
    return { keyword: "", rule: "" };
  }
}

export async function listLbProjects(deps: RouterDeps, actor: Actor) {
  await retireUnusableTickets(deps.prisma, actor.workspaceId);
  const projects = await deps.prisma.lbProject.findMany({
    where: { workspaceId: actor.workspaceId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
  });
  const ids = projects.map((project) => project.id);
  const [runs, tickets, alerts, hostRows] = await Promise.all([
    deps.prisma.lbRun.findMany({
      where: { workspaceId: actor.workspaceId, projectId: { in: ids } },
    }),
    deps.prisma.lbOperatorTicket.findMany({
      where: { workspaceId: actor.workspaceId, projectId: { in: ids }, status: "open" },
      select: {
        id: true,
        projectId: true,
        status: true,
        reason: true,
        host: { select: { status: true, registrableDomain: true } },
      },
    }),
    deps.prisma.lbAlert.findMany({
      where: { workspaceId: actor.workspaceId, projectId: { in: ids } },
      orderBy: { createdAt: "desc" },
    }),
    deps.prisma.lbHost.findMany({
      where: { workspaceId: actor.workspaceId, projectId: { in: ids } },
      select: { projectId: true, registrableDomain: true },
    }),
  ]);
  const now = new Date();
  return projects.map((project) => {
    const schedule = readSchedule(project.schedule);
    const today = localDateKey(now, schedule.timezone);
    const projectRuns = runs.filter((run) => run.projectId === project.id);
    const todayRun = projectRuns.find((run) => run.date === today) ?? null;
    const latest = [...projectRuns].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
    const quotas = readQuotas(project.quotas);
    const help =
      tickets
        .filter((ticket) => ticket.projectId === project.id && shownToCustomer(ticket, project.slug))
        .map((ticket) => helpForTicket(ticket))
        .find((item) => item !== null) ?? null;
    const runStatus = todayRun ? readRunStatus(todayRun.status) : null;
    const activity = projectActivity({
      projectStatus: readProjectStatus(project.status),
      runStatus,
      openTickets: 0,
      schedule: scheduleState(
        schedule,
        now,
        (todayRun?.liveToday ?? 0) >= (quotas?.livePerDay ?? 0),
      ),
    });
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      status: readProjectStatus(project.status),
      brandName: project.brandName,
      activity: activity.activity,
      activityLabel: activity.label,
      ...customerCounters(
        project.slug,
        todayRun,
        hostRows.filter((host) => host.projectId === project.id),
      ),
      newPerDay: quotas?.newPerDay ?? 0,
      livePerDay: quotas?.livePerDay ?? 0,
      liveWeekCap: quotas?.liveWeekCap ?? null,
      runStatus,
      lastEvent: customerFacingEvent(
        newerEvent(
          todayRun?.lastAction ?? latest?.lastAction ?? null,
          todayRun?.updatedAt ?? latest?.updatedAt ?? null,
          alerts.find((alert) => alert.projectId === project.id) ?? null,
        ),
      ),
      operatorQueue: 0,
      operatorHelp: help,
    };
  });
}

export async function getLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  return toDetail(await requireProject(deps.prisma, actor, projectId));
}

export async function createLbProject(
  deps: RouterDeps,
  actor: Actor,
  input: {
    name: string;
    slug?: string;
    brandName: string;
    allowedDomains: string[];
    markets?: LbProjectDetail["markets"];
  },
) {
  await assertMayCreateProject(deps.prisma, actor.workspaceId);
  const markets = input.markets ?? [{ ...LB_DEFAULT_MARKET }];
  const schedule = LbScheduleSchema.parse({ timezone: markets[0]?.timezoneId ?? "Europe/Berlin" });
  const base = slugifyProjectName(input.slug ?? input.name);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 60);
    try {
      const row = await deps.prisma.lbProject.create({
        data: {
          workspaceId: actor.workspaceId,
          createdByUserId: actor.userId,
          name: input.name,
          slug,
          brandName: input.brandName,
          allowedDomains: input.allowedDomains,
          markets: json(markets),
          schedule: json(schedule),
        },
      });
      return toDetail(row);
    } catch (error) {
      if (!isUnique(error)) throw error;
    }
  }
  throw new ORPCError("CONFLICT", { message: "Choose a different name" });
}

export async function updateLbProject(
  deps: RouterDeps,
  actor: Actor,
  input: LbProjectPatch & { projectId: string },
) {
  const row = await requireProject(deps.prisma, actor, input.projectId);
  const data: Prisma.LbProjectUpdateInput = {};
  if (input.instruction) {
    const quotas = readQuotas(row.quotas);
    const schedule = readSchedule(row.schedule);
    if (!quotas) throw new ORPCError("BAD_REQUEST", { message: "Project has no quotas" });
    const today = localDateKey(new Date(), schedule.timezone);
    const run = await deps.prisma.lbRun.findFirst({
      where: { projectId: row.id, workspaceId: actor.workspaceId, date: today },
    });
    const applied = applyRunPhrase({
      phrase: input.instruction,
      quotas,
      schedule,
      newToday: run?.newToday ?? 0,
      liveToday: run?.liveToday ?? 0,
    });
    if (!applied) throw new ORPCError("BAD_REQUEST", { message: "Unknown instruction" });
    data.quotas = json(applied.quotas);
    data.schedule = json(applied.schedule);
    if (applied.resume) {
      const current = readProjectStatus(row.status);
      if (current === "paused" || current === "stopped" || current === "draft") {
        data.status = transitionOrBad(current === "draft" ? "draft" : current, "active");
      }
    }
    const updated = await deps.prisma.lbProject.update({ where: { id: row.id }, data });
    if (applied.resume) {
      await ensureRunningToday(deps.prisma, actor.workspaceId, row.id, applied.schedule);
      await deps.prisma.lbRun.updateMany({
        where: { projectId: row.id, workspaceId: actor.workspaceId, date: today },
        data: { lastAction: applied.summary },
      });
    }
    await publish(deps, row.id);
    return toDetail(updated);
  }
  if (input.name !== undefined) data.name = input.name;
  if (input.slug !== undefined) data.slug = input.slug;
  if (input.brandName !== undefined) data.brandName = input.brandName;
  if (input.allowedDomains !== undefined) data.allowedDomains = input.allowedDomains;
  if (input.persona !== undefined) {
    data.persona = json(
      personaWithPersonalName(input.persona, {
        brandName: input.brandName ?? row.brandName,
        name: input.name ?? row.name,
        slug: input.slug ?? row.slug,
        allowedDomains: input.allowedDomains ?? row.allowedDomains,
        markets: input.markets ?? row.markets,
      }),
    );
  }
  if (input.captchaLowBalanceCredits !== undefined) {
    data.captchaLowBalanceCredits = input.captchaLowBalanceCredits;
  }
  if (input.quotas !== undefined) data.quotas = json(input.quotas);
  if (input.schedule !== undefined) data.schedule = json(input.schedule);
  if (input.topicLanes !== undefined) data.topicLanes = json(input.topicLanes);
  if (input.markets !== undefined) data.markets = json(input.markets);
  if (input.marketPolicy !== undefined) data.marketPolicy = input.marketPolicy;
  if (input.disclosureMode !== undefined) data.disclosureMode = input.disclosureMode;
  if (input.linkRatio !== undefined) data.linkRatio = json(input.linkRatio);
  if (input.proxyPolicy !== undefined) data.proxyPolicy = input.proxyPolicy;
  if (input.countNofollow !== undefined) data.countNofollow = input.countNofollow;
  if (input.targets !== undefined) data.targets = json(input.targets);
  if (input.facts !== undefined) data.facts = input.facts;
  if (input.denyHosts !== undefined) data.denyHosts = input.denyHosts;
  if (input.preferHosts !== undefined) data.preferHosts = input.preferHosts;
  if (input.warmup !== undefined) data.warmup = json(input.warmup);
  if (input.spamRetry !== undefined) data.spamRetry = json(input.spamRetry);
  if (input.content !== undefined) data.content = json(input.content);
  if (input.operator !== undefined) data.operator = json(input.operator);
  if (input.provisionMailbox && !row.mailboxId) {
    const inbox = await provisionProjectInbox(deps, actor, row.id);
    data.mailboxId = inbox.inboxId;
    data.mailboxAddress = inbox.address;
  }
  if (input.webhookUrl !== undefined) {
    if (!input.webhookUrl) {
      data.webhookUrl = null;
    } else {
      const production = process.env.NODE_ENV === "production";
      const allowed = await webhookUrlAllowed(input.webhookUrl, {
        production,
        resolve: production ? productionHostnameResolver : undefined,
      });
      if (!allowed.ok)
        throw new ORPCError("BAD_REQUEST", { message: "Webhook URL is not allowed" });
      data.webhookUrl = allowed.url.toString();
    }
  }
  if (input.webhookSecret) {
    const secretValue = input.webhookSecret.startsWith("whsec_")
      ? input.webhookSecret
      : `whsec_${input.webhookSecret}`;
    data.webhookSecret = {
      connect: { id: await storeWebhookSecret(deps, actor, secretValue) },
    };
  }
  if (input.captchaToken) {
    data.captchaSecret = {
      connect: { id: await storeCaptchaToken(deps, actor, input.captchaToken) },
    };
  }
  try {
    const updated = await deps.prisma.lbProject.update({
      where: { id: row.id },
      data,
    });
    if (updated.workspaceId !== actor.workspaceId) throw new ORPCError("NOT_FOUND");
    return toDetail(updated);
  } catch (error) {
    if (isUnique(error)) throw new ORPCError("CONFLICT", { message: "That address is taken" });
    throw error;
  }
}

export async function archiveLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  const row = await requireProject(deps.prisma, actor, projectId);
  const status = transitionOrBad(readProjectStatus(row.status), "archived");
  await deps.prisma.lbProject.update({
    where: { id: row.id },
    data: { status, archivedAt: new Date() },
  });
  return { ok: true as const };
}

export async function startLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  const row = await requireProject(deps.prisma, actor, projectId);
  const parsed = LbProjectStartableSchema.safeParse(configFrom(row));
  if (!parsed.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: parsed.error.issues[0]?.message ?? "Project is incomplete",
    });
  }
  const current = readProjectStatus(row.status);
  const others = await deps.prisma.lbProject.count({
    where: {
      workspaceId: actor.workspaceId,
      archivedAt: null,
      status: { in: ["active", "paused", "stopped"] },
      id: { not: row.id },
    },
  });
  const plan = await (deps.plan ?? new StaticPlanProvider()).current(actor.workspaceId, {
    operationId: "lb-plan",
    traceId: "lb-plan",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  try {
    assertStartWithinPlan({ otherStartedProjects: others, caps: plan.caps });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      throw new ORPCError("FORBIDDEN", { message: error.message });
    }
    throw error;
  }
  const status = current === "active" ? current : transitionOrBad(current, "active");
  const ack = LbResponsibilityAckSchema.parse({
    acceptedAt: new Date().toISOString(),
    acceptedByUserId: actor.userId,
    textVersion: LB_RESPONSIBILITY_ACK_TEXT_VERSION,
  });
  const persona = readPersona(row.persona);
  const personal = persona
    ? personaWithPersonalName(persona, {
        brandName: row.brandName,
        name: row.name,
        slug: row.slug,
        allowedDomains: row.allowedDomains,
        markets: row.markets,
      })
    : null;
  await deps.prisma.lbProject.update({
    where: { id: row.id },
    data: {
      status,
      responsibilityAck: json(ack),
      ...(personal && personal.displayName !== persona?.displayName
        ? { persona: json(personal) }
        : {}),
    },
  });
  await ensureRunningToday(deps.prisma, actor.workspaceId, row.id, parsed.data.schedule);
  await publish(deps, row.id);
  return getLbProject(deps, actor, row.id);
}

export async function pauseLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  const row = await requireProject(deps.prisma, actor, projectId);
  const status = transitionOrBad(readProjectStatus(row.status), "paused");
  await deps.prisma.lbProject.update({ where: { id: row.id }, data: { status } });
  await setOpenRun(deps.prisma, actor.workspaceId, row.id, "paused");
  await publish(deps, row.id);
  return getLbProject(deps, actor, row.id);
}

export async function stopLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  const row = await requireProject(deps.prisma, actor, projectId);
  const status = transitionOrBad(readProjectStatus(row.status), "stopped");
  await deps.prisma.lbProject.update({ where: { id: row.id }, data: { status } });
  await setOpenRun(deps.prisma, actor.workspaceId, row.id, "cancelled");
  await publish(deps, row.id);
  return getLbProject(deps, actor, row.id);
}

export async function statusLbProject(deps: RouterDeps, actor: Actor, projectId: string) {
  const row = await requireProject(deps.prisma, actor, projectId);
  await retireUnusableTickets(deps.prisma, actor.workspaceId);
  const schedule = readSchedule(row.schedule);
  const quotas = readQuotas(row.quotas);
  const now = new Date();
  const today = localDateKey(now, schedule.timezone);
  const [runs, openTicketRows, hosts, latestAlert, costs] = await Promise.all([
    deps.prisma.lbRun.findMany({ where: { workspaceId: actor.workspaceId, projectId: row.id } }),
    deps.prisma.lbOperatorTicket.findMany({
      where: { workspaceId: actor.workspaceId, projectId: row.id, status: "open" },
      select: {
        id: true,
        status: true,
        reason: true,
        host: { select: { status: true, registrableDomain: true } },
      },
    }),
    deps.prisma.lbHost.findMany({
      where: { workspaceId: actor.workspaceId, projectId: row.id },
      select: { status: true, registrableDomain: true },
    }),
    deps.prisma.lbAlert.findFirst({
      where: { workspaceId: actor.workspaceId, projectId: row.id },
      orderBy: { createdAt: "desc" },
    }),
    costWindow(deps.prisma, actor.workspaceId, row.id, schedule.timezone),
  ]);
  const help =
    openTicketRows
      .filter((ticket) => shownToCustomer(ticket, row.slug))
      .map((ticket) => helpForTicket(ticket))
      .find((item) => item !== null) ?? null;
  const todayRun = runs.find((run) => run.date === today) ?? null;
  const runStatus = todayRun ? readRunStatus(todayRun.status) : null;
  const faced = customerCounters(row.slug, todayRun, hosts);
  const runView = todayRun
    ? {
        ...runCounters(todayRun),
        newToday: faced.newToday,
        liveToday: faced.liveToday,
        liveWeek: faced.liveWeek,
        uniqueHosts: faced.liveToday === 0 && faced.newToday === 0 ? 0 : todayRun.uniqueHosts,
      }
    : null;
  const credits = await readCreditBalance(deps.prisma, actor.workspaceId);
  const liveMet = faced.liveToday >= (quotas?.livePerDay ?? 0) && (quotas?.livePerDay ?? 0) > 0;
  const scheduleView = scheduleState(schedule, now, liveMet);
  const activity = projectActivity({
    projectStatus: readProjectStatus(row.status),
    runStatus,
    openTickets: 0,
    schedule: scheduleView,
  });
  const storedWhy = todayRun ? LbWhyNotSchema.safeParse(todayRun.whyNot) : null;
  const visibleParked = hosts.filter(
    (host) => host.status === "parked_operator" && shownToCustomer(host, row.slug),
  ).length;
  const whyNotBase =
    storedWhy?.success === true
      ? storedWhy.data
      : liveMet
        ? null
        : buildWhyNot({
            hostCounts: countHosts(hosts.filter((host) => shownToCustomer(host, row.slug))),
            modelErrors: 0,
            modelRefusals: 0,
            captchaBalance: null,
            lowBalanceCredits: row.captchaLowBalanceCredits,
            proxy: "ok",
          });
  const whyNot = whyNotBase
    ? { ...whyNotBase, parked: Math.min(whyNotBase.parked, visibleParked) }
    : null;
  return {
    projectId: row.id,
    projectStatus: readProjectStatus(row.status),
    activity: activity.activity,
    activityLabel: activity.label,
    run: runView,
    stage: stageFromActivity({
      runStatus,
      lastAction: todayRun?.lastAction ?? null,
    }),
    credits: { balance: credits, payment: "stub" as const },
    whyNot,
    operatorQueue: 0,
    operatorHelp: help,
    scheduleActive: scheduleView.active,
    scheduleReason: scheduleView.reason,
    newPerDay: quotas?.newPerDay ?? 0,
    livePerDay: quotas?.livePerDay ?? 0,
    liveWeekCap: quotas?.liveWeekCap ?? null,
    lastEvent: customerFacingEvent(
      newerEvent(todayRun?.lastAction ?? null, todayRun?.updatedAt ?? null, latestAlert),
    ),
    costs,
  };
}

export async function summarizeLbCosts(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; range: "day" | "week" },
) {
  const row = await requireProject(deps.prisma, actor, input.projectId);
  const schedule = readSchedule(row.schedule);
  const today = localDateKey(new Date(), schedule.timezone);
  const from = input.range === "week" ? weekStart(today) : today;
  return sumCosts(deps.prisma, actor.workspaceId, row.id, schedule.timezone, from, today);
}

export async function seedLbDemo(deps: RouterDeps, actor: Actor) {
  await assertMayCreateProject(deps.prisma, actor.workspaceId);
  const seeded = await seedLinkBuilderDemo(deps.prisma, {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
  });
  return getLbProject(deps, actor, seeded.projectId);
}

export async function listLbHosts(deps: RouterDeps, actor: Actor, projectId: string) {
  const project = await requireProject(deps.prisma, actor, projectId);
  const hosts = await deps.prisma.lbHost.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    orderBy: { registrableDomain: "asc" },
  });
  return hosts
    .filter((host) => shownToCustomer(host, project.slug))
    .map((host) => ({
      id: host.id,
      registrableDomain: host.registrableDomain,
      homepageUrl: host.homepageUrl,
      platform: LbHostPlatformSchema.parse(host.platform),
      country: host.country,
      language: host.language,
      locale: host.locale,
      timezoneId: host.timezoneId,
      status: LbHostStatusSchema.parse(host.status),
      parkedFrom: host.parkedFrom ? LbParkableHostStatusSchema.parse(host.parkedFrom) : null,
      qualityScore: host.qualityScore,
      topicTags: host.topicTags,
      captchaType: host.captchaType ? LbCaptchaTypeSchema.parse(host.captchaType) : null,
      hrefForNewMembers: LbHrefForNewMembersSchema.parse(host.hrefForNewMembers),
      relDefault: LbRelDefaultSchema.parse(host.relDefault),
      signatureLinks: host.signatureLinks,
      minPostsForLinks: host.minPostsForLinks,
      registerUrl: host.registerUrl,
      statusReason: host.statusReason,
    }));
}

export async function listLbPlacements(deps: RouterDeps, actor: Actor, projectId: string) {
  const project = await requireProject(deps.prisma, actor, projectId);
  const rows = await deps.prisma.lbPlacement.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    include: { host: { select: { registrableDomain: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.filter((row) => shownToCustomer(row, project.slug)).map((row) => placementView(row));
}

export async function verifyLbPlacement(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; placementId: string },
) {
  await requireProject(deps.prisma, actor, input.projectId);
  const row = await deps.prisma.lbPlacement.findFirst({
    where: { id: input.placementId, workspaceId: actor.workspaceId, projectId: input.projectId },
    include: { host: { select: { registrableDomain: true } } },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  const status = transitionPlacement(
    row.status as LbPlacementStatus,
    row.status as LbPlacementStatus,
  );
  const updated = await deps.prisma.lbPlacement.update({
    where: { id: row.id },
    data: { status, verifiedAt: new Date(), verifyMethod: row.verifyMethod ?? "logged_out_fetch" },
    include: { host: { select: { registrableDomain: true } } },
  });
  return placementView(updated);
}

/** Active leases for the Settings tab. Credentials, gateway hosts and secret ids are omitted. */
export async function listLbProxyLeases(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const rows = await deps.prisma.lbProxyLease.findMany({
    where: { workspaceId: actor.workspaceId, projectId, status: "active" },
    orderBy: { country: "asc" },
    select: {
      id: true,
      country: true,
      kind: true,
      provider: true,
      renewsAt: true,
      status: true,
    },
  });
  return rows.map((row) =>
    LbProxyLeaseViewSchema.parse({
      id: row.id,
      country: row.country,
      kind: row.kind,
      providerId: row.provider,
      expiresAt: row.renewsAt?.toISOString() ?? null,
      status: row.status,
    }),
  );
}

export async function listLbRuns(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const runs = await deps.prisma.lbRun.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    orderBy: { date: "desc" },
  });
  return runs.map((run) => ({
    ...runCounters(run),
    whyNot: LbWhyNotSchema.safeParse(run.whyNot).data ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
}

export async function listLbRunSteps(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; runId: string },
) {
  const project = await requireProject(deps.prisma, actor, input.projectId);
  const run = await deps.prisma.lbRun.findFirst({
    where: { id: input.runId, workspaceId: actor.workspaceId, projectId: input.projectId },
    select: { id: true },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const steps = await deps.prisma.lbRunStep.findMany({
    where: { workspaceId: actor.workspaceId, runId: run.id },
    orderBy: { stepIndex: "asc" },
  });
  return steps.flatMap((step) => {
    const lastAction = outcomeAction(step.outcome);
    if (!customerStepVisible(project.slug, lastAction)) return [];
    return [
      {
        id: step.id,
        stepIndex: step.stepIndex,
        kind: step.kind,
        hostId: step.hostId,
        lastAction,
        error: step.error,
        costs: {
          credits: numberField(step.costs, "credits"),
          tokens: numberField(step.costs, "tokens"),
          bytes: numberField(step.costs, "bytes"),
          ms: numberField(step.costs, "ms"),
        },
        artifactIds: step.artifactIds,
        createdAt: step.createdAt.toISOString(),
      },
    ];
  });
}

/** Reads a step screenshot or verification snapshot that belongs to this project. */
export async function getLbArtifact(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; artifactId: string },
) {
  await requireProject(deps.prisma, actor, input.projectId);
  const [step, placement] = await Promise.all([
    deps.prisma.lbRunStep.findFirst({
      where: {
        workspaceId: actor.workspaceId,
        run: { projectId: input.projectId },
        artifactIds: { has: input.artifactId },
      },
      select: { id: true },
    }),
    deps.prisma.lbPlacement.findFirst({
      where: {
        workspaceId: actor.workspaceId,
        projectId: input.projectId,
        snapshotArtifactId: input.artifactId,
      },
      select: { id: true },
    }),
  ]);
  if (!step && !placement) throw new ORPCError("NOT_FOUND");
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.artifactId, workspaceId: actor.workspaceId },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  const bytes = await deps.artifacts.get(row.storageKey, {
    operationId: `lb-artifact:${row.id}`,
    traceId: `lb-artifact:${row.id}`,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

export async function listLbThreads(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const rows = await deps.prisma.lbThreadCandidate.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    include: { host: { select: { registrableDomain: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return rows
    .filter((row) => shownToCustomer(row))
    .map((row) => ({
      id: row.id,
      hostId: row.hostId,
      domain: row.host.registrableDomain,
      url: row.url,
      title: row.title,
      excerpt: row.excerpt,
      status: LbThreadStatusSchema.parse(row.status),
      relevance: row.relevance,
      openQuestion: row.openQuestion,
      laneId: row.laneId,
      rejectReason: row.rejectReason,
    }));
}

export async function listLbDrafts(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const rows = await deps.prisma.lbDraft.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((row) => draftView(row));
}

function draftView(row: {
  id: string;
  threadCandidateId: string;
  body: string;
  status: string;
  linkSlot: string;
  modelLane: string;
  modelId: string;
  targetUrl: string | null;
  anchorText: string | null;
  confidence: number | null;
  qualityChecks: unknown;
}) {
  const quality = LbDraftQualityChecksSchema.safeParse(row.qualityChecks);
  return {
    id: row.id,
    threadCandidateId: row.threadCandidateId,
    body: row.body,
    status: LbDraftStatusSchema.parse(row.status),
    linkSlot: LbLinkSlotSchema.parse(row.linkSlot),
    modelLane: LbModelLaneSchema.parse(row.modelLane),
    modelId: row.modelId,
    targetUrl: row.targetUrl,
    anchorText: row.anchorText,
    confidence: row.confidence,
    qualityChecks: quality.success
      ? quality.data
      : {
          factsOnly: true,
          noBannedClaims: true,
          registerMatches: true,
          lengthOk: true,
          singleLink: true,
          notTestimonial: true,
          issues: [],
        },
  };
}

export async function decideLbDraft(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; draftId: string },
  status: "approved" | "discarded",
) {
  const project = await requireProject(deps.prisma, actor, input.projectId);
  if (project.disclosureMode !== "drafts_only" && status === "approved") {
    throw new ORPCError("BAD_REQUEST", { message: "Draft approval is for drafts only mode" });
  }
  const row = await deps.prisma.lbDraft.findFirst({
    where: { id: input.draftId, workspaceId: actor.workspaceId, projectId: input.projectId },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  if (row.status !== "drafted")
    throw new ORPCError("BAD_REQUEST", { message: "Draft is not open" });
  const updated = await deps.prisma.lbDraft.update({
    where: { id: row.id },
    data: { status },
  });
  await publish(deps, input.projectId);
  return draftView(updated);
}

export async function listLbCaptchaEvents(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const rows = await deps.prisma.lbCaptchaEvent.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    include: { host: { select: { registrableDomain: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows
    .filter((row) => shownToCustomer(row))
    .map((row) => ({
      id: row.id,
      hostId: row.hostId,
      domain: row.host?.registrableDomain ?? null,
      type: LbCaptchaTypeSchema.parse(row.type),
      door: LbCaptchaDoorSchema.parse(row.door),
      outcome: LbCaptchaOutcomeSchema.parse(row.outcome),
      buttonTextObserved: row.buttonTextObserved,
      attempt: row.attempt,
      creditsCharged: row.creditsCharged,
      taskId: row.taskId,
      createdAt: row.createdAt.toISOString(),
    }));
}

export async function listLbTickets(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; status?: string },
) {
  await requireProject(deps.prisma, actor, input.projectId);
  if (!input.status || input.status === "open") {
    await retireUnusableTickets(deps.prisma, actor.workspaceId);
  }
  const rows = await deps.prisma.lbOperatorTicket.findMany({
    where: {
      workspaceId: actor.workspaceId,
      projectId: input.projectId,
      ...(input.status ? { status: input.status } : {}),
    },
    include: { host: { select: { registrableDomain: true } } },
    orderBy: { createdAt: "desc" },
  });
  const visible = rows.filter((row) => shownToCustomer(row));
  const screenshots = await ticketScreenshots(deps.prisma, actor.workspaceId, visible);
  return visible.map((row) => ticketView(row, screenshots.get(row.id) ?? null));
}

/** The last PNG a run stored for the ticket's host up to the moment the ticket was opened. */
async function ticketScreenshots(
  prisma: PrismaClient,
  workspaceId: string,
  tickets: Array<{ id: string; runId: string | null; hostId: string; createdAt: Date }>,
): Promise<Map<string, string>> {
  const runIds = [...new Set(tickets.flatMap((ticket) => (ticket.runId ? [ticket.runId] : [])))];
  const result = new Map<string, string>();
  if (runIds.length === 0) return result;
  const steps = await prisma.lbRunStep.findMany({
    where: { workspaceId, runId: { in: runIds }, NOT: { artifactIds: { isEmpty: true } } },
    select: { runId: true, hostId: true, artifactIds: true, createdAt: true, stepIndex: true },
    orderBy: { stepIndex: "desc" },
  });
  const pngs = new Set(
    (
      await prisma.artifact.findMany({
        where: {
          workspaceId,
          id: { in: steps.flatMap((step) => step.artifactIds) },
          mimeType: "image/png",
        },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  for (const ticket of tickets) {
    const step = steps.find(
      (candidate) =>
        candidate.runId === ticket.runId &&
        candidate.hostId === ticket.hostId &&
        candidate.createdAt.getTime() <= ticket.createdAt.getTime() + 60_000 &&
        candidate.artifactIds.some((id) => pngs.has(id)),
    );
    const id = step?.artifactIds.filter((artifactId) => pngs.has(artifactId)).at(-1);
    if (id) result.set(ticket.id, id);
  }
  return result;
}

export async function continueLbTicket(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; ticketId: string; note?: string },
) {
  return settleTicket(deps, actor, input, "resolved");
}

export async function skipLbTicket(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; ticketId: string; note?: string },
) {
  return settleTicket(deps, actor, input, "skipped");
}

export async function checkLbCaptchaBalance(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId?: string; token?: string },
) {
  let token = input.token;
  if (input.projectId) {
    const project = await requireProject(deps.prisma, actor, input.projectId);
    if (project.captchaSecretId) {
      const secret = await deps.prisma.secret.findFirst({
        where: { id: project.captchaSecretId, workspaceId: actor.workspaceId },
        select: { ciphertext: true },
      });
      if (!secret) throw new ORPCError("NOT_FOUND");
      try {
        token = deps.secrets.load(secret.ciphertext);
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "Captell token is unreadable" });
      }
    }
  }
  const parsed = LbCaptchaTokenSchema.safeParse(token);
  if (!parsed.success) throw new ORPCError("BAD_REQUEST", { message: "Expected a ct_live_ token" });
  const solver = new CaptellHttpSolver({
    fetch: deps.captellFetch,
    token: async () => parsed.data,
  });
  try {
    const balance = await solver.balance({
      operationId: "lb-captcha-balance",
      traceId: "lb-captcha-balance",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    });
    return { credits: balance.credits, helperVersion: PAGE_HELPER_VERSION };
  } catch (error) {
    if (error instanceof CaptchaSolverError && error.code === "sandbox") {
      throw new ORPCError("BAD_REQUEST", { message: "Captell returned a sandbox balance" });
    }
    throw new ORPCError("BAD_REQUEST", { message: "Captell balance check failed" });
  }
}

export async function* followLbProject(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; cursor: string },
  signal?: AbortSignal,
) {
  await requireProject(deps.prisma, actor, input.projectId);
  let cursor = input.cursor;
  const latch = new Latch();
  const unsubscribe = deps.realtime
    ? await deps.realtime
        .subscribe(linkBuilderTopic(input.projectId), () => latch.notify())
        .catch(() => async () => {})
    : async () => {};
  try {
    while (!signal?.aborted) {
      const next = await projectCursor(deps.prisma, actor.workspaceId, input.projectId);
      if (next !== cursor) {
        cursor = next;
        yield { projectId: input.projectId, cursor: next };
      }
      await latch.wait(1_500, signal);
    }
  } finally {
    await unsubscribe();
  }
}

async function settleTicket(
  deps: RouterDeps,
  actor: Actor,
  input: { projectId: string; ticketId: string; note?: string },
  nextStatus: "resolved" | "skipped",
) {
  await requireProject(deps.prisma, actor, input.projectId);
  const ticket = await deps.prisma.lbOperatorTicket.findFirst({
    where: {
      id: input.ticketId,
      workspaceId: actor.workspaceId,
      projectId: input.projectId,
      status: "open",
    },
    include: { host: true },
  });
  if (!ticket) throw new ORPCError("NOT_FOUND");
  const parkedFrom = LbParkableHostStatusSchema.safeParse(ticket.host.parkedFrom).data ?? null;
  const hostState = { status: ticket.host.status as LbHostStatus, parkedFrom };
  let hostNext: { status: LbHostStatus; parkedFrom: LbParkableHostStatus | null };
  try {
    hostNext =
      nextStatus === "resolved"
        ? transitionHost(hostState, "resumed")
        : transitionHost(hostState, "operator_skipped");
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Host cannot move",
    });
  }
  const updated = await deps.prisma.$transaction(async (tx) => {
    await tx.lbHost.update({
      where: { id: ticket.hostId },
      data: { status: hostNext.status, parkedFrom: hostNext.parkedFrom },
    });
    return tx.lbOperatorTicket.update({
      where: { id: ticket.id },
      data: {
        status: nextStatus,
        note: input.note ?? ticket.note,
        resolvedByUserId: actor.userId,
        resolvedAt: new Date(),
      },
      include: { host: { select: { registrableDomain: true } } },
    });
  });
  await publish(deps, input.projectId);
  const screenshots = await ticketScreenshots(deps.prisma, actor.workspaceId, [updated]);
  return ticketView(updated, screenshots.get(updated.id) ?? null);
}

async function ensureRunningToday(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  schedule: { timezone: string },
) {
  const date = localDateKey(new Date(), schedule.timezone);
  const existing = await prisma.lbRun.findFirst({ where: { projectId, date, workspaceId } });
  if (!existing) {
    const liveWeek = await weekLiveBefore(prisma, workspaceId, projectId, date);
    await prisma.lbRun.create({
      data: {
        workspaceId,
        projectId,
        date,
        status: "running",
        liveWeek,
        startedAt: new Date(),
        lastAction: null,
      },
    });
    return;
  }
  const status = readRunStatus(existing.status);
  const next = resumeRunStatus(status);
  const keptAction =
    existing.lastAction &&
    !isCannedResearchLine(existing.lastAction) &&
    !isStaleResearchLine(existing.lastAction)
      ? existing.lastAction
      : null;
  await prisma.lbRun.update({
    where: { id: existing.id },
    data: {
      status: next ?? status,
      startedAt: existing.startedAt ?? new Date(),
      lastAction: keptAction,
      currentHostId: null,
      currentUrl: null,
      finishedAt: null,
    },
  });
}

function customerStepVisible(slug: string, lastAction: string | null): boolean {
  if (!lastAction) return true;
  if (isCannedResearchLine(lastAction) || isStaleResearchLine(lastAction)) return false;
  if (mentionsFixtureHost(lastAction)) return false;
  if (slug !== LB_DEMO_SLUG && mentionsExampleDomain(lastAction)) return false;
  if (slug !== LB_DEMO_SLUG && /live quota met|captcha/i.test(lastAction)) return false;
  if (slug !== LB_DEMO_SLUG && /parked/i.test(lastAction) && /operator/i.test(lastAction))
    return false;
  return true;
}

async function readCreditBalance(prisma: PrismaClient, workspaceId: string): Promise<number> {
  const [steps, purchases] = await Promise.all([
    prisma.lbRunStep.findMany({
      where: { workspaceId },
      select: { costs: true },
    }),
    listCreditPurchases(prisma, workspaceId),
  ]);
  let spent = 0;
  for (const step of steps) spent += numberField(step.costs, "credits");
  return creditBalanceFromLedger(spent, purchases);
}

async function listCreditPurchases(prisma: PrismaClient, workspaceId: string) {
  return prisma.lbCreditPurchase.findMany({
    where: { workspaceId },
    select: { billing: true, chargeId: true, credits: true },
  });
}

async function assertMayCreateProject(prisma: PrismaClient, workspaceId: string) {
  const purchases = await listCreditPurchases(prisma, workspaceId);
  if (!mayCreateLinkBuilderProject(purchases)) {
    throw new ORPCError("FORBIDDEN", { message: "Buy a credit package first." });
  }
}

/**
 * Writes an explicit dev/test allowance. It does not record a charge and adds no credits.
 * Production routes never call this.
 */
export async function grantExplicitProjectAllowance(prisma: PrismaClient, workspaceId: string) {
  await prisma.lbCreditPurchase.create({
    data: {
      workspaceId,
      packageId: "allowance",
      credits: 0,
      priceCents: 0,
      currency: "eur",
      billing: "allowance",
    },
  });
}

export async function offerLbBilling(deps: RouterDeps, actor: Actor) {
  const purchases = await listCreditPurchases(deps.prisma, actor.workspaceId);
  const balance = await readCreditBalance(deps.prisma, actor.workspaceId);
  const checkoutConnected = stripeCheckoutConfigured();
  return {
    packages: CREDIT_PACKAGES.map((pack) => ({ ...pack })),
    entitled: mayCreateLinkBuilderProject(purchases),
    checkoutConnected,
    balance,
    reason: checkoutConnected ? "" : CHECKOUT_NOT_CONNECTED_REASON,
  };
}

/**
 * Quotes a package. A card is charged only when billing is live and a charge id already exists.
 * This route has no charge id, so it does not write a purchase or change the balance.
 */
export async function checkoutLbPackage(deps: RouterDeps, actor: Actor, packageId: string) {
  const billing = stripeCheckoutConfigured() ? "live" : "stub";
  const purchases = await listCreditPurchases(deps.prisma, actor.workspaceId);
  const balance = await readCreditBalance(deps.prisma, actor.workspaceId);
  const quote = quoteCreditPurchase({ billing, chargeId: null, packageId, balance });
  return {
    charged: quote.charged,
    entitled: quote.charged || mayCreateLinkBuilderProject(purchases),
    balance: quote.balance,
    reason: quote.reason,
    checkoutUrl: null,
  };
}

/** Buying credits never charges a card while billing is a stub, and never invents a payment. */
export async function buyLbCredits(deps: RouterDeps, actor: Actor, projectId: string) {
  await requireProject(deps.prisma, actor, projectId);
  const billing = (deps.plan ?? new StaticPlanProvider()).describe().capabilities.billing;
  const balance = await readCreditBalance(deps.prisma, actor.workspaceId);
  return settleCreditPurchase({ billing, balance, chargeId: null, amount: 0 });
}

function resumeRunStatus(current: LbRunStatus): LbRunStatus | null {
  if (current === "running" || current === "overtime") return null;
  if (current === "failed") return transitionRun(transitionRun(current, "queued"), "running");
  return transitionRun(current, "running");
}

async function setOpenRun(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  to: "paused" | "cancelled",
) {
  const runs = await prisma.lbRun.findMany({
    where: { workspaceId, projectId, status: { in: ["queued", "running", "overtime", "paused"] } },
  });
  for (const run of runs) {
    const status = readRunStatus(run.status);
    if (status === to) continue;
    if (to === "paused" && status !== "running" && status !== "overtime") continue;
    const next = transitionRun(status, to);
    await prisma.lbRun.update({ where: { id: run.id }, data: { status: next } });
  }
}

async function weekLiveBefore(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  date: string,
): Promise<number> {
  const runs = await prisma.lbRun.findMany({
    where: { workspaceId, projectId },
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

function newerEvent(
  action: string | null,
  actionAt: Date | null,
  alert: { message: string; createdAt: Date } | null,
): string | null {
  if (!alert) return action;
  if (!action || !actionAt || alert.createdAt.getTime() >= actionAt.getTime()) return alert.message;
  return action;
}

async function costWindow(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  timeZone: string,
) {
  const today = localDateKey(new Date(), timeZone);
  const [day, week] = await Promise.all([
    sumCosts(prisma, workspaceId, projectId, timeZone, today, today),
    sumCosts(prisma, workspaceId, projectId, timeZone, weekStart(today), today),
  ]);
  return { day, week };
}

async function sumCosts(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  timeZone: string,
  from: string,
  to: string,
) {
  const entries = await prisma.lbCostEntry.findMany({
    where: { workspaceId, projectId },
    select: { kind: true, quantity: true, occurredAt: true },
  });
  const totals = { ...EMPTY_COST_SUMMARY };
  for (const entry of entries) {
    let date = "";
    try {
      date = localDateKey(entry.occurredAt, timeZone);
    } catch {
      continue;
    }
    if (date < from || date > to) continue;
    if (entry.kind === "captell_credits") totals.captellCredits += entry.quantity;
    if (entry.kind === "model_tokens") totals.modelTokens += entry.quantity;
    if (entry.kind === "search_query") totals.searchQueries += entry.quantity;
    if (entry.kind === "proxy_lease_day") totals.proxyLeaseDays += entry.quantity;
  }
  return totals;
}

async function provisionProjectInbox(deps: RouterDeps, actor: Actor, projectId: string) {
  if (deps.mailbox) {
    return deps.mailbox.ensureInbox(projectId, {
      operationId: "lb-mailbox",
      traceId: "lb-mailbox",
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    });
  }
  const local = `lb-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 48);
  return { inboxId: `${local}@inbox.example`, address: `${local}@inbox.example` };
}

async function storeWebhookSecret(deps: RouterDeps, actor: Actor, secret: string): Promise<string> {
  const stored = await deps.secrets.put(secret, {
    operationId: "lb-webhook",
    traceId: "lb-webhook",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const row = await deps.prisma.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      kind: "lb_webhook",
      ciphertext: stored.ciphertext,
    },
    select: { id: true },
  });
  return row.id;
}

async function storeCaptchaToken(deps: RouterDeps, actor: Actor, token: string): Promise<string> {
  const stored = await deps.secrets.put(token, {
    operationId: "lb-captcha",
    traceId: "lb-captcha",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const secret = await deps.prisma.secret.create({
    data: {
      id: stored.id,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      kind: "lb_captcha",
      ciphertext: stored.ciphertext,
    },
    select: { id: true },
  });
  return secret.id;
}

async function requireProject(prisma: PrismaClient, actor: Actor, projectId: string) {
  const row = await prisma.lbProject.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId, archivedAt: null },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

async function projectCursor(prisma: PrismaClient, workspaceId: string, projectId: string) {
  const [step, ticket, placement, alert] = await Promise.all([
    prisma.lbRunStep.findFirst({
      where: { workspaceId, run: { projectId, workspaceId } },
      orderBy: [{ createdAt: "desc" }, { stepIndex: "desc" }],
      select: { runId: true, stepIndex: true },
    }),
    prisma.lbOperatorTicket.findFirst({
      where: { workspaceId, projectId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true, updatedAt: true },
    }),
    prisma.lbPlacement.findFirst({
      where: { workspaceId, projectId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true, updatedAt: true },
    }),
    prisma.lbAlert.findFirst({
      where: { workspaceId, projectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    }),
  ]);
  return [
    `${step?.runId ?? ""}:${step?.stepIndex ?? -1}`,
    `${ticket?.id ?? ""}:${ticket?.status ?? ""}:${ticket?.updatedAt.toISOString() ?? ""}`,
    `${placement?.id ?? ""}:${placement?.status ?? ""}:${placement?.updatedAt.toISOString() ?? ""}`,
    `${alert?.id ?? ""}:${alert?.createdAt.toISOString() ?? ""}`,
  ].join("|");
}

async function publish(deps: RouterDeps, projectId: string) {
  await deps.realtime
    ?.publish(linkBuilderTopic(projectId), JSON.stringify({ cursor: new Date().toISOString() }))
    .catch(() => undefined);
}

function configFrom(row: {
  name: string;
  slug: string;
  brandName: string;
  allowedDomains: string[];
  persona: unknown;
  mailboxId: string | null;
  captchaSecretId: string | null;
  captchaLowBalanceCredits: number;
  quotas: unknown;
  schedule: unknown;
  topicLanes: unknown;
  markets: unknown;
  marketPolicy: string;
  disclosureMode: string;
  linkRatio: unknown;
  proxyPolicy: string;
  countNofollow: boolean;
  targets: unknown;
  facts: string[];
  denyHosts: string[];
  preferHosts: string[];
  warmup: unknown;
  spamRetry: unknown;
  content: unknown;
  operator: unknown;
}) {
  return {
    name: row.name,
    slug: row.slug,
    brandName: row.brandName,
    allowedDomains: row.allowedDomains,
    persona: row.persona ?? undefined,
    mailboxId: row.mailboxId ?? undefined,
    captchaSecretId: row.captchaSecretId ?? undefined,
    captchaLowBalanceCredits: row.captchaLowBalanceCredits,
    quotas: row.quotas ?? undefined,
    schedule: row.schedule,
    topicLanes: row.topicLanes,
    markets: row.markets,
    marketPolicy: row.marketPolicy,
    disclosureMode: row.disclosureMode,
    linkRatio: row.linkRatio,
    proxyPolicy: row.proxyPolicy,
    countNofollow: row.countNofollow,
    targets: row.targets,
    facts: row.facts,
    denyHosts: row.denyHosts,
    preferHosts: row.preferHosts,
    warmup: row.warmup,
    spamRetry: row.spamRetry,
    content: row.content,
    operator: row.operator,
  };
}

type ProjectRow = Awaited<ReturnType<PrismaClient["lbProject"]["findFirstOrThrow"]>>;

function toDetail(row: ProjectRow): LbProjectDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: readProjectStatus(row.status),
    brandName: row.brandName,
    allowedDomains: row.allowedDomains,
    persona: readPersona(row.persona),
    mailboxId: row.mailboxId,
    mailboxAddress: row.mailboxAddress,
    captchaConfigured: Boolean(row.captchaSecretId),
    captchaLowBalanceCredits: row.captchaLowBalanceCredits,
    quotas: readQuotas(row.quotas),
    schedule: readSchedule(row.schedule),
    topicLanes: LbTopicLaneSchema.array().safeParse(row.topicLanes).data ?? [],
    markets: LbMarketsSchema.safeParse(row.markets).data ?? [{ ...LB_DEFAULT_MARKET }],
    marketPolicy: LbMarketPolicySchema.safeParse(row.marketPolicy).data ?? "primary_first",
    disclosureMode:
      LbDisclosureModeSchema.safeParse(row.disclosureMode).data ?? "undisclosed_persona",
    responsibilityAck: LbResponsibilityAckSchema.safeParse(row.responsibilityAck).data ?? null,
    linkRatio: LbLinkRatioSchema.safeParse(row.linkRatio).data ?? { ...LB_DEFAULT_LINK_RATIO },
    proxyPolicy: LbProxyPolicySchema.safeParse(row.proxyPolicy).data ?? "static_isp_per_persona",
    countNofollow: row.countNofollow,
    targets: LbTargetSchema.array().safeParse(row.targets).data ?? [],
    facts: row.facts,
    denyHosts: row.denyHosts,
    preferHosts: row.preferHosts,
    warmup: LbWarmupSchema.safeParse(row.warmup).data ?? LbWarmupSchema.parse({}),
    content: LbContentSchema.safeParse(row.content).data ?? LbContentSchema.parse({}),
    operator:
      LbOperatorSettingsSchema.safeParse(row.operator).data ?? LbOperatorSettingsSchema.parse({}),
    webhookUrl: row.webhookUrl ?? null,
    webhookConfigured: Boolean(row.webhookSecretId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function placementView(row: {
  id: string;
  hostId: string;
  threadUrl: string;
  postUrl: string;
  targetUrl: string;
  anchorText: string;
  rel: string[];
  status: string;
  counted: boolean;
  verifiedAt: Date | null;
  snapshotArtifactId: string | null;
  host: { registrableDomain: string };
}) {
  return {
    id: row.id,
    hostId: row.hostId,
    domain: row.host.registrableDomain,
    threadUrl: row.threadUrl,
    postUrl: row.postUrl,
    targetUrl: row.targetUrl,
    anchorText: row.anchorText,
    rel: row.rel,
    status: LbPlacementStatusSchema.parse(row.status),
    counted: row.counted,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    snapshotArtifactId: row.snapshotArtifactId,
  };
}

function ticketView(
  row: {
    id: string;
    projectId: string;
    hostId: string;
    runId: string | null;
    reason: string;
    screenUrl: string | null;
    note: string | null;
    status: string;
    expiresAt: Date | null;
    createdAt: Date;
    host: { registrableDomain: string };
  },
  screenshotArtifactId: string | null,
) {
  return {
    id: row.id,
    projectId: row.projectId,
    hostId: row.hostId,
    domain: row.host.registrableDomain,
    runId: row.runId,
    reason: LbOperatorTicketReasonSchema.parse(row.reason),
    screenUrl: row.screenUrl,
    screenshotArtifactId,
    note: row.note,
    status: LbOperatorTicketStatusSchema.parse(row.status),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function runCounters(run: {
  id: string;
  date: string;
  status: string;
  newToday: number;
  liveToday: number;
  liveWeek: number;
  uniqueHosts: number;
  lastAction: string | null;
  lastError: string | null;
  currentUrl?: string | null;
}) {
  return {
    id: run.id,
    date: run.date,
    status: readRunStatus(run.status),
    newToday: run.newToday,
    liveToday: run.liveToday,
    liveWeek: run.liveWeek,
    uniqueHosts: run.uniqueHosts,
    lastAction: run.lastAction,
    lastError: run.lastError,
    currentUrl: run.currentUrl ?? null,
  };
}

function countHosts(hosts: Array<{ status: string }>): Partial<Record<LbHostStatus, number>> {
  const counts: Partial<Record<LbHostStatus, number>> = {};
  for (const host of hosts) {
    const status = host.status as LbHostStatus;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function readProjectStatus(status: string): LbProjectStatus {
  if (
    status === "draft" ||
    status === "active" ||
    status === "paused" ||
    status === "stopped" ||
    status === "archived"
  ) {
    return status;
  }
  return "draft";
}

function readRunStatus(status: string): LbRunStatus {
  const parsed = LbRunStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : "queued";
}

function readSchedule(value: unknown) {
  return LbScheduleSchema.safeParse(value).data ?? DEFAULT_SCHEDULE;
}

function readQuotas(value: unknown) {
  return LbQuotasSchema.safeParse(value).data ?? null;
}

function readPersona(value: unknown) {
  return LbPersonaSchema.safeParse(value).data ?? null;
}

function personaWithPersonalName(
  persona: NonNullable<ReturnType<typeof readPersona>>,
  row: {
    brandName: string;
    name: string;
    slug: string;
    allowedDomains: string[];
    markets: unknown;
  },
) {
  const markets = LbMarketsSchema.safeParse(row.markets);
  const language = persona.language ?? markets.data?.[0]?.language ?? "de";
  return {
    ...persona,
    displayName: resolvePersonaDisplayName({
      displayName: persona.displayName,
      language,
      sources: brandNameSources({
        brandName: row.brandName,
        projectName: row.name,
        slug: row.slug,
        domains: row.allowedDomains,
      }),
    }),
  };
}

function scheduleState(
  schedule: ReturnType<typeof readSchedule>,
  now: Date,
  liveMet: boolean,
): ScheduleState {
  return isWithinWindow(now, schedule, { liveMet });
}

function outcomeAction(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || !("lastAction" in outcome)) return null;
  const value = (outcome as { lastAction?: unknown }).lastAction;
  return typeof value === "string" ? value : null;
}

function numberField(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || !(key in value)) return 0;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function transitionOrBad(from: LbProjectStatus, to: LbProjectStatus): LbProjectStatus {
  try {
    return transitionProject(from, to);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "That change is not available",
    });
  }
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

class Latch {
  generation = 0;
  private wake: (() => void) | undefined;

  notify(): void {
    this.generation += 1;
    this.wake?.();
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const expected = this.generation;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      this.wake = () => {
        if (this.generation !== expected) finish();
      };
    });
  }
}
