import type { RealtimeFanout } from "@rakazo/adapter-kit";
import {
  LbMarketsSchema,
  LbQuotasSchema,
  type LbRunStatus,
  LbRunStatusSchema,
  LbTargetSchema,
} from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import {
  type FakeStepPlan,
  isCustomerStageKind,
  isExampleRegistrableDomain,
  isFixtureHostDomain,
  linkBuilderTopic,
  planFakeStep,
  primaryProblemQueryFromProject,
  type RunCounters,
  researchResultName,
  transitionRun,
} from "@rakazo/linkbuilder-core";

/**
 * M1 fake runner. `LINK_BUILDER_DRIVER=fake` (the default) advances active runs
 * one deterministic step at a time. `off` or any other value leaves runs untouched
 * so a later driver can take the same rows. It never opens a network connection.
 */
export function isLinkBuilderFakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LINK_BUILDER_DRIVER ?? "fake") === "fake";
}

export interface FakeRunRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  status: LbRunStatus;
  stepCount: number;
  researchBeats: number;
  stageBeats: number;
  previousAction: string | null;
  forumName: string | null;
  threadName: string | null;
  counters: RunCounters;
  seed: string;
  brandName: string;
  targetUrl: string;
  markets: ReturnType<typeof LbMarketsSchema.parse>;
  quotas: { livePerDay: number; liveWeekCap?: number };
  countNofollow: boolean;
  lowBalanceCredits: number;
  searchQuery: string | null;
}

export interface LinkBuilderFakeStore {
  runnable(now: Date): Promise<FakeRunRecord[]>;
  apply(run: FakeRunRecord, step: FakeStepPlan): Promise<void>;
  finishIfOpen(run: FakeRunRecord): Promise<void>;
  publish(projectId: string, cursor: string): Promise<void>;
}

export async function tickLinkBuilderFake(store: LinkBuilderFakeStore, now: Date): Promise<number> {
  const runs = await store.runnable(now);
  let stepped = 0;
  for (const run of runs) {
    try {
      const plan = planFakeStep({
        seed: run.seed,
        stepIndex: run.stepCount,
        researchBeats: run.researchBeats,
        stageBeats: run.stageBeats,
        previousAction: run.previousAction,
        forumName: run.forumName,
        threadName: run.threadName,
        counters: run.counters,
        now,
        markets: run.markets,
        brandName: run.brandName,
        targetUrl: run.targetUrl,
        searchQuery: run.searchQuery,
        quotas: run.quotas,
        countNofollow: run.countNofollow,
        lowBalanceCredits: run.lowBalanceCredits,
      });
      if ("hold" in plan) continue;
      if (!("kind" in plan)) {
        await store.finishIfOpen(run);
        continue;
      }
      if (
        plan.host &&
        (isFixtureHostDomain(plan.host.domain) || isExampleRegistrableDomain(plan.host.domain))
      ) {
        continue;
      }
      const runStatus =
        plan.runStatus === run.status ? run.status : transitionRun(run.status, plan.runStatus);
      await store.apply(run, { ...plan, runStatus });
      await store.publish(run.projectId, `${run.id}:${plan.stepIndex}`);
      stepped += 1;
    } catch (error) {
      console.error(
        "linkbuilder.fake",
        run.projectId,
        error instanceof Error ? error.message : "step failed",
      );
    }
  }
  return stepped;
}

export function startLinkBuilderFakeRunner(deps: {
  prisma: PrismaClient;
  realtime?: RealtimeFanout;
  now?: () => Date;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
}): { stop: () => void } {
  if (!isLinkBuilderFakeEnabled(deps.env)) return { stop() {} };
  const store = createPrismaFakeStore(deps.prisma, deps.realtime);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const interval = deps.intervalMs ?? 1_500;
  const loop = () => {
    if (stopped) return;
    void tickLinkBuilderFake(store, (deps.now ?? (() => new Date()))())
      .catch((error: unknown) => {
        console.error("linkbuilder.fake", error instanceof Error ? error.message : "tick failed");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, interval);
      });
  };
  loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function createPrismaFakeStore(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
): LinkBuilderFakeStore {
  return {
    async runnable() {
      const runs = await prisma.lbRun.findMany({
        where: { status: { in: ["queued", "running", "overtime"] }, project: { status: "active" } },
        include: {
          project: {
            include: {
              hosts: {
                select: { registrableDomain: true },
                orderBy: { createdAt: "desc" },
                take: 8,
              },
              threadCandidates: {
                select: {
                  title: true,
                  host: { select: { registrableDomain: true } },
                },
                orderBy: { createdAt: "desc" },
                take: 8,
              },
            },
          },
          _count: { select: { steps: true } },
          steps: { select: { kind: true, stepIndex: true, outcome: true } },
        },
      });
      const records: FakeRunRecord[] = [];
      for (const run of runs) {
        const mapped = mapRun(run);
        if (mapped) records.push(mapped);
      }
      return records;
    },
    async apply(run, step) {
      try {
        await prisma.$transaction(async (tx) => {
          const host = step.host ? await upsertHost(tx, run, step) : null;
          if (step.accountUsername && host)
            await ensureAccount(tx, run, host.id, step.accountUsername);
          if (step.kind === "post" && step.placement && host) {
            await ensurePost(tx, run, host.id, step);
          }
          if (step.kind === "verify" && step.placement && host) {
            await tx.lbPlacement.updateMany({
              where: { workspaceId: run.workspaceId, projectId: run.projectId, hostId: host.id },
              data: {
                status: step.placement.status,
                counted: step.placement.counted,
                rel: step.placement.rel,
                indexable: step.placement.indexable,
                verifiedAt: new Date(),
                verifyMethod: "logged_out_fetch",
              },
            });
          }
          if (step.captcha && host) {
            await tx.lbCaptchaEvent.create({
              data: {
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                hostId: host.id,
                runId: run.id,
                type: step.captcha.type,
                door: step.captcha.door,
                outcome: step.captcha.outcome,
                buttonTextObserved: step.captcha.buttonTextObserved,
                humanCheckboxState: step.captcha.humanCheckboxState,
                attempt: step.captcha.attempt,
                creditsCharged: step.captcha.creditsCharged,
                helperVersion: step.captcha.helperVersion,
              },
            });
          }
          if (step.ticket && host) {
            await tx.lbOperatorTicket.create({
              data: {
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                hostId: host.id,
                runId: run.id,
                reason: step.ticket.reason,
                status: "open",
              },
            });
          }
          await tx.lbRun.update({
            where: { id: run.id },
            data: {
              status: step.runStatus,
              newToday: step.counters.newToday,
              liveToday: step.counters.liveToday,
              liveWeek: step.counters.liveWeek,
              uniqueHosts: step.counters.uniqueHosts,
              lastAction: step.lastAction,
              currentHostId: host?.id,
              currentUrl: step.placement?.postUrl ?? step.host?.homepageUrl,
              whyNot: step.whyNot ? json(step.whyNot) : undefined,
              finishedAt: step.kind === "close" ? new Date() : undefined,
            },
          });
          await tx.lbRunStep.create({
            data: {
              workspaceId: run.workspaceId,
              runId: run.id,
              stepIndex: step.stepIndex,
              kind: step.kind,
              hostId: host?.id,
              outcome: json({ lastAction: step.lastAction }),
              costs: json(step.costs),
            },
          });
        });
      } catch (error) {
        if (!isUnique(error)) throw error;
      }
    },
    async finishIfOpen(run) {
      if (run.status === "succeeded" || run.status === "partial" || run.status === "failed") return;
      const status =
        run.status === "queued"
          ? transitionRun(run.status, "cancelled")
          : transitionRun(run.status, "partial");
      await prisma.lbRun.update({
        where: { id: run.id },
        data: { status, finishedAt: new Date(), lastAction: "Day closed" },
      });
    },
    async publish(projectId, cursor) {
      await realtime
        ?.publish(linkBuilderTopic(projectId), JSON.stringify({ cursor }))
        .catch(() => undefined);
    },
  };
}

function mapRun(run: {
  id: string;
  projectId: string;
  workspaceId: string;
  status: string;
  _count: { steps: number };
  steps: { kind: string; stepIndex: number; outcome: unknown }[];
  newToday: number;
  liveToday: number;
  liveWeek: number;
  uniqueHosts: number;
  project: {
    id: string;
    name: string;
    brandName: string;
    allowedDomains: string[];
    markets: unknown;
    quotas: unknown;
    topicLanes: unknown;
    targets: unknown;
    countNofollow: boolean;
    captchaLowBalanceCredits: number;
    hosts?: { registrableDomain: string }[];
    threadCandidates?: { title: string; host?: { registrableDomain: string } | null }[];
  };
}): FakeRunRecord | null {
  const status = LbRunStatusSchema.safeParse(run.status);
  const markets = LbMarketsSchema.safeParse(run.project.markets);
  const quotas = LbQuotasSchema.safeParse(run.project.quotas);
  const targets = zTargets(run.project.targets);
  const domain = run.project.allowedDomains[0];
  if (!status.success || !markets.success || !quotas.success || !domain) return null;
  return {
    id: run.id,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    status: status.data,
    stepCount: run._count.steps,
    researchBeats: run.steps.filter((step) => step.kind === "research").length,
    stageBeats: run.steps.filter((step) => isCustomerStageKind(step.kind)).length,
    previousAction: latestAction(run.steps),
    forumName: firstRealName((run.project.hosts ?? []).map((host) => host.registrableDomain)),
    threadName: firstRealName(
      (run.project.threadCandidates ?? [])
        .filter((thread) => researchResultName(thread.host?.registrableDomain ?? "") !== null)
        .map((thread) => thread.title),
    ),
    counters: {
      newToday: run.newToday,
      liveToday: run.liveToday,
      liveWeek: run.liveWeek,
      uniqueHosts: run.uniqueHosts,
    },
    seed: run.project.id,
    brandName: run.project.brandName,
    targetUrl: targets[0]?.url ?? `https://${domain}/`,
    searchQuery: primaryProblemQueryFromProject({
      name: run.project.name,
      brandName: run.project.brandName,
      topicLanes: run.project.topicLanes,
      targets: run.project.targets,
    }),
    markets: markets.data,
    quotas: { livePerDay: quotas.data.livePerDay, liveWeekCap: quotas.data.liveWeekCap },
    countNofollow: run.project.countNofollow,
    lowBalanceCredits: run.project.captchaLowBalanceCredits,
  };
}

function latestAction(steps: { stepIndex: number; outcome: unknown }[]): string | null {
  let latest: { stepIndex: number; outcome: unknown } | undefined;
  for (const step of steps) {
    if (!latest || step.stepIndex >= latest.stepIndex) latest = step;
  }
  if (!latest?.outcome || typeof latest.outcome !== "object") return null;
  const value = (latest.outcome as { lastAction?: unknown }).lastAction;
  return typeof value === "string" ? value : null;
}

function firstRealName(names: readonly string[]): string | null {
  for (const name of names) {
    const real = researchResultName(name);
    if (real) return real;
  }
  return null;
}

function zTargets(value: unknown): Array<{ url: string }> {
  const parsed = LbTargetSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

type Tx = Prisma.TransactionClient;

async function upsertHost(tx: Tx, run: FakeRunRecord, step: FakeStepPlan) {
  const host = step.host;
  if (!host) return null;
  if (isFixtureHostDomain(host.domain) || isExampleRegistrableDomain(host.domain)) return null;
  const existing = await tx.lbHost.findFirst({
    where: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      registrableDomain: host.domain,
    },
    select: { id: true },
  });
  const data = {
    homepageUrl: host.homepageUrl,
    platform: host.platform,
    language: host.language,
    country: host.country,
    status: host.status,
    parkedFrom: host.parkedFrom,
    notes: `fake-key:${host.key}`,
    qualityScore: host.key === "a" ? 0.8 : host.key === "b" ? 0.66 : 0.52,
    relDefault: "ugc",
    hrefForNewMembers: "yes",
  };
  if (existing) {
    return tx.lbHost.update({ where: { id: existing.id }, data, select: { id: true } });
  }
  return tx.lbHost.create({
    data: {
      ...data,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      registrableDomain: host.domain,
    },
    select: { id: true },
  });
}

async function ensureAccount(tx: Tx, run: FakeRunRecord, hostId: string, username: string) {
  const existing = await tx.lbHostAccount.findFirst({ where: { hostId }, select: { id: true } });
  if (existing) return existing;
  return tx.lbHostAccount.create({
    data: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      hostId,
      username,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
}

async function ensurePost(tx: Tx, run: FakeRunRecord, hostId: string, step: FakeStepPlan) {
  const placement = step.placement;
  if (!placement) return;
  const existing = await tx.lbPlacement.findFirst({
    where: { workspaceId: run.workspaceId, hostId },
    select: { id: true },
  });
  if (existing) return;
  const account = await ensureAccount(tx, run, hostId, step.accountUsername ?? "member");
  const thread = await tx.lbThreadCandidate.create({
    data: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      hostId,
      url: placement.threadUrl,
      title: placement.anchorText,
      excerpt: "",
      relevance: 0.8,
      openQuestion: true,
      status: "posted",
    },
    select: { id: true },
  });
  const draft = await tx.lbDraft.create({
    data: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadCandidateId: thread.id,
      modelLane: "draft",
      modelId: "fake-draft",
      body: step.draftBody ?? placement.anchorText,
      linkSlot: "inline",
      targetUrl: placement.targetUrl,
      anchorText: placement.anchorText,
      status: "posted",
      qualityChecks: json({
        factsOnly: true,
        noBannedClaims: true,
        registerMatches: true,
        lengthOk: true,
        singleLink: true,
        notTestimonial: true,
        issues: [],
      }),
    },
    select: { id: true },
  });
  await tx.lbPlacement.create({
    data: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      hostId,
      hostAccountId: account.id,
      draftId: draft.id,
      threadUrl: placement.threadUrl,
      postUrl: placement.postUrl,
      targetUrl: placement.targetUrl,
      anchorText: placement.anchorText,
      rel: placement.rel,
      indexable: placement.indexable,
      status: "pending",
      counted: false,
    },
  });
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
