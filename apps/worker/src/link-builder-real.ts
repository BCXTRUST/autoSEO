import { createHash, randomUUID } from "node:crypto";
import {
  type AdapterContext,
  type AdapterDescriptor,
  type ArtifactStore,
  type BrowserSession,
  type BrowserSessionFactory,
  type CaptchaSolver,
  type CaptchaSolverCapabilities,
  CaptchaSolverError,
  type MailboxProvider,
  type ProxyProvider,
  type RealtimeFanout,
  type SearchProvider,
  type TextModel,
} from "@rakazo/adapter-kit";
import { type EncryptedSecretStore, STARTER_PLAN } from "@rakazo/adapters";
import {
  LB_DEFAULT_SPAM_SENTENCES,
  LbContentSchema,
  LbDisclosureModeSchema,
  type LbHostStatus,
  LbLinkRatioSchema,
  LbMarketsSchema,
  LbOperatorSettingsSchema,
  LbPersonaSchema,
  LbProxyPolicySchema,
  LbQuotasSchema,
  type LbRunStatus,
  LbRunStatusSchema,
  LbScheduleSchema,
  LbSpamRetrySchema,
  LbTargetSchema,
  LbTopicLaneSchema,
  LbWarmupSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  adminRecheckDue,
  type HostnameResolver,
  isHostTerminal,
  isInfrastructureFailure,
  isLiveMet,
  isRunActive,
  isWarmupMet,
  isWithinWindow,
  linkBuilderTopic,
  localDateKey,
  marketKey,
  PAGE_HELPER_BUTTON_SELECTOR,
  type PlanCaps,
  planRealStep,
  type RealPlan,
  redactSecrets,
  transitionRun,
} from "@rakazo/linkbuilder-core";
import { runDueWork } from "./link-builder-operations.js";
import {
  browserPersona,
  isUnique,
  marketOf,
  moveHost,
  type PoolEntry,
  type ProjectConfig,
  pauseForLowBalance,
  postsRequiredBeforeLink,
  REAL_STEP_HANDLERS,
  type RealWorkerServices,
  type RunRow,
  StaleState,
  type StepContext,
  type StepResult,
} from "./link-builder-real-steps.js";

/**
 * M2 browser-driven runner behind `LINK_BUILDER_DRIVER=real`. Each tick takes at most one step
 * per run: one typed transition, persisted as one `LbRunStep` keyed by `runId + stepIndex`, while
 * the run's lease is held under a per-project advisory lock.
 */
export function isLinkBuilderRealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LINK_BUILDER_DRIVER === "real";
}

export interface LinkBuilderRealDeps {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  artifacts: ArtifactStore;
  browsers: BrowserSessionFactory;
  /** Used when `resolveCaptcha` is absent. Tests inject a fake or the emulator. */
  captcha?: CaptchaSolver;
  /**
   * Production loads a per-project solver from the encrypted store.
   * `null` means the project has no Captell token and real mode must refuse it.
   */
  resolveCaptcha?: (
    project: { id: string; workspaceId: string },
    redact: (secret: string) => void,
  ) => Promise<CaptchaSolver | null>;
  mailbox: MailboxProvider;
  realtime?: RealtimeFanout;
  /** Tests point this at the offline fixture; production uses the global fetch. */
  verifyFetch?: typeof fetch;
  /** Only for offline fixtures on loopback. */
  allowPrivateVerify?: boolean;
  now?: () => Date;
  workerId?: string;
  leaseMs?: number;
  verifyDelayMs?: number;
  reverifyAfterMs?: number;
  pageHelperButtonSelector?: string;
  pageHelperPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  textModel?: TextModel;
  search?: SearchProvider;
  proxies?: ProxyProvider;
  notifications?: import("@rakazo/adapter-kit").NotificationProvider;
  webhookFetch?: typeof fetch;
  /** When true, webhook URLs may not target private or loopback addresses. */
  productionWebhooks?: boolean;
  /** Injected DNS lookup for production webhook URLs. Tests pass a fixture. */
  resolveHostname?: HostnameResolver;
  /** Plan ceiling. Absent means the starter stub. */
  planCaps?: PlanCaps;
  /** Passwords the proxy resolver has loaded. Shared with step redaction. */
  revealedSecrets?: string[];
  /** False when the Camoufox executable is not installed. The host then goes dead on a second edge block. */
  camoufoxAvailable?: boolean;
  /** Pause or destroy the persona desktop when a browser step is finished or stuck. */
  releaseDesktop?: (
    projectId: string,
    context: AdapterContext,
    mode: "stop" | "kill",
  ) => Promise<void>;
  probeFetch?: typeof fetch;
  allowPrivateProbe?: boolean;
}

const CAPTELL_SECRET_MISSING = "Real mode needs a Captell token for this project";

const unconfiguredCaptcha: CaptchaSolver = {
  describe(): AdapterDescriptor<CaptchaSolverCapabilities> {
    return {
      id: "unconfigured-captcha",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { supports: [] },
    };
  },
  balance() {
    return Promise.reject(new CaptchaSolverError("error", "Captcha solver is not configured"));
  },
  solve() {
    return Promise.reject(new CaptchaSolverError("error", "Captcha solver is not configured"));
  },
  answerQuestion() {
    return Promise.reject(new CaptchaSolverError("error", "Captcha solver is not configured"));
  },
};

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_VERIFY_DELAY_MS = 60_000;
const DEFAULT_REVERIFY_MS = 24 * 3_600_000;
const MAX_CONSECUTIVE_ERRORS = 4;

export type TickOutcome = "stepped" | "waited" | "skipped" | "failed";

export class LinkBuilderRealRunner {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly services: RealWorkerServices;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly revealed: string[];

  constructor(private readonly deps: LinkBuilderRealDeps) {
    this.workerId = deps.workerId ?? `lb-real-${randomUUID()}`;
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = deps.now ?? (() => new Date());
    this.revealed = deps.revealedSecrets ?? [];
    this.services = {
      prisma: deps.prisma,
      secrets: deps.secrets,
      artifacts: deps.artifacts,
      browsers: deps.browsers,
      captcha: deps.captcha ?? unconfiguredCaptcha,
      mailbox: deps.mailbox,
      verifyFetch: deps.verifyFetch,
      allowPrivateVerify: deps.allowPrivateVerify ?? false,
      verifyDelayMs: deps.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS,
      reverifyAfterMs: deps.reverifyAfterMs ?? DEFAULT_REVERIFY_MS,
      proxies: deps.proxies,
      camoufoxAvailable: deps.camoufoxAvailable ?? false,
      pageHelperButtonSelector: deps.pageHelperButtonSelector ?? PAGE_HELPER_BUTTON_SELECTOR,
      pageHelperPollMs: deps.pageHelperPollMs ?? 250,
      nowMs: () => (deps.now ? deps.now().getTime() : Date.now()),
      sleep: deps.sleep,
      textModel: deps.textModel,
      planCaps: deps.planCaps ?? STARTER_PLAN.caps,
    };
  }

  /** The open persona browser of a project, for tests and operator tooling. */
  sessionFor(projectId: string): BrowserSession | null {
    return this.pool.get(projectId)?.session ?? null;
  }

  async tick(): Promise<number> {
    const now = this.now();
    await runDueWork({
      prisma: this.deps.prisma,
      secrets: this.deps.secrets,
      now,
      notifications: this.deps.notifications,
      webhookFetch: this.deps.webhookFetch,
      productionWebhooks: this.deps.productionWebhooks,
      resolveHostname: this.deps.resolveHostname,
      verifyFetch: this.deps.verifyFetch,
      allowPrivateVerify: this.deps.allowPrivateVerify,
      artifacts: this.deps.artifacts,
      realtime: this.deps.realtime,
      search: this.deps.search,
      probeFetch: this.deps.probeFetch,
      allowPrivateProbe: this.deps.allowPrivateProbe,
      captcha: this.deps.captcha,
      resolveCaptcha: this.deps.resolveCaptcha
        ? async (project) => this.deps.resolveCaptcha!(project, () => undefined)
        : undefined,
      proxies: this.deps.proxies,
    }).catch((error: unknown) => {
      console.error(
        "linkbuilder.schedule",
        error instanceof Error ? error.message : "schedule failed",
      );
    });
    const runs = await this.deps.prisma.lbRun.findMany({
      where: { status: { in: ["running", "overtime"] }, project: { status: "active" } },
      select: { id: true, date: true, project: { select: { schedule: true } } },
      orderBy: { createdAt: "asc" },
    });
    let stepped = 0;
    for (const run of runs) {
      const schedule = LbScheduleSchema.safeParse(run.project.schedule);
      const today = schedule.success ? localDateKey(now, schedule.data.timezone) : run.date;
      if (run.date !== today) continue;
      try {
        if ((await this.step(run.id)) === "stepped") stepped += 1;
      } catch (error) {
        console.error(
          "linkbuilder.real",
          run.id,
          error instanceof Error ? error.message : "step failed",
        );
      }
    }
    return stepped;
  }

  /** Takes the next step of one run; never throws for a step failure. */
  async step(runId: string): Promise<TickOutcome> {
    const now = this.now();
    const fence = await this.claim(runId, now);
    if (fence === null) return "skipped";
    const ctx = await this.load(runId, now);
    if (!ctx) return "skipped";
    const gate = await this.prepareCaptcha(ctx);
    if (gate === "paused") return "waited";
    if (gate === "missing") {
      const prior = await this.deps.prisma.lbRunStep.findFirst({
        where: { runId, error: CAPTELL_SECRET_MISSING },
        select: { id: true },
      });
      if (prior) return "waited";
      await this.commit(
        ctx,
        fence,
        "captell_secret",
        {
          kind: "step",
          lastAction: "Captell token is not configured",
          hostId: ctx.host?.id ?? null,
          outcome: { reason: "captell_secret_missing" },
        },
        CAPTELL_SECRET_MISSING,
        new Date(),
      );
      return "failed";
    }
    const plan = await this.plan(ctx);
    if (plan.kind === "done" || plan.kind === "wait") {
      await this.dropDesktop(ctx, plan.kind, "", false);
      return "waited";
    }
    const startedAt = new Date();
    let result: StepResult;
    let error: string | null = null;
    try {
      result = await Promise.race([
        REAL_STEP_HANDLERS[plan.kind](ctx),
        new Promise<StepResult>((_, reject) => {
          setTimeout(() => reject(new Error("Browser action timed out")), 3 * 60_000);
        }),
      ]);
    } catch (caught) {
      error = redactSecrets(caught instanceof Error ? caught.message : "Step failed", ctx.secrets);
      result = await this.failure(ctx, error);
    }
    if (result.kind === "wait") return "waited";
    const committed = await this.commit(ctx, fence, plan.kind, result, error, startedAt);
    if (!committed) return "skipped";
    await result.afterCommit?.();
    await this.dropDesktop(
      ctx,
      plan.kind,
      result.kind === "step" ? result.lastAction : "",
      error !== null && /timed out|timeout|not running anymore/i.test(error),
    );
    await this.deps.realtime
      ?.publish(
        linkBuilderTopic(ctx.project.id),
        JSON.stringify({ cursor: `${runId}:${ctx.stepIndex}` }),
      )
      .catch(() => undefined);
    return error ? "failed" : "stepped";
  }

  async close(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((entry) => entry.session.close().catch(() => undefined)));
  }

  private async claim(runId: string, now: Date): Promise<number | null> {
    return this.deps.prisma.$transaction(async (tx) => {
      const run = await tx.lbRun.findUnique({
        where: { id: runId },
        select: {
          projectId: true,
          status: true,
          leaseOwner: true,
          leaseFence: true,
          leaseExpiresAt: true,
        },
      });
      if (!run) return null;
      const status = LbRunStatusSchema.safeParse(run.status);
      if (!status.success || !isRunActive(status.data)) return null;
      const lockKey = `lb-project:${run.projectId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`;
      const busy = await tx.lbRun.count({
        where: {
          projectId: run.projectId,
          leaseOwner: { not: this.workerId },
          leaseExpiresAt: { gt: now },
        },
      });
      if (busy > 0) return null;
      const held =
        run.leaseOwner === this.workerId && (run.leaseExpiresAt?.getTime() ?? 0) > now.getTime();
      const fence = held ? run.leaseFence : run.leaseFence + 1;
      await tx.lbRun.update({
        where: { id: runId },
        data: {
          leaseOwner: this.workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        },
      });
      return fence;
    });
  }

  private async load(runId: string, now: Date): Promise<StepContext | null> {
    const { prisma } = this.deps;
    const run = await prisma.lbRun.findUnique({
      where: { id: runId },
      include: { project: true, _count: { select: { steps: true } } },
    });
    if (!run) return null;
    const status = LbRunStatusSchema.safeParse(run.status);
    const project = projectConfig(run.project);
    if (!status.success || !project) return null;
    const host = run.currentHostId
      ? await prisma.lbHost.findUnique({ where: { id: run.currentHostId } })
      : null;
    const account = host
      ? await prisma.lbHostAccount.findUnique({ where: { hostId: host.id } })
      : null;
    const placement = host
      ? await prisma.lbPlacement.findFirst({
          where: { hostId: host.id, projectId: project.id },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const runRow: RunRow = {
      id: run.id,
      status: status.data,
      counters: {
        newToday: run.newToday,
        liveToday: run.liveToday,
        liveWeek: run.liveWeek,
        uniqueHosts: run.uniqueHosts,
      },
    };
    const adapter: AdapterContext = {
      operationId: `lb-run:${run.id}:${run._count.steps}`,
      traceId: `lb-run:${run.id}`,
      workspaceId: project.workspaceId,
      userId: project.ownerUserId,
      signal: new AbortController().signal,
    };
    const ctx: StepContext = {
      services: this.services,
      now,
      run: runRow,
      stepIndex: run._count.steps,
      project,
      host,
      account,
      placement,
      adapter,
      secrets: this.revealed,
      pool: () => this.pool.get(project.id),
      openSession: (target, extra) => this.openSession(ctx, target, extra),
      closeSession: () => this.closeSession(project.id),
      storeArtifact: (name, mimeType, bytes) => this.storeArtifact(ctx, name, mimeType, bytes),
    };
    return ctx;
  }

  /**
   * Binds the project's solver and refuses to open the browser when the balance is low
   * or the Captell token is missing. Returns `paused` or `missing` when the step must stop.
   */
  private async prepareCaptcha(ctx: StepContext): Promise<"ok" | "paused" | "missing"> {
    if (this.deps.resolveCaptcha) {
      const solver = await this.deps.resolveCaptcha(ctx.project, (secret) => {
        ctx.secrets.push(secret);
      });
      if (!solver) return "missing";
      ctx.services = { ...ctx.services, captcha: solver };
    }
    if (process.env.CAPTELL_API_KEY?.trim()) return "ok";
    let credits: number;
    try {
      credits = (await ctx.services.captcha.balance(ctx.adapter)).credits;
    } catch (error) {
      if (error instanceof CaptchaSolverError && error.code === "credits") {
        await pauseForLowBalance(ctx, 0);
        return "paused";
      }
      if (error instanceof CaptchaSolverError && error.code === "sandbox") {
        await this.pauseForSandbox(ctx);
        return "paused";
      }
      throw error;
    }
    if (credits < ctx.project.captchaLowBalanceCredits) {
      await pauseForLowBalance(ctx, credits);
      return "paused";
    }
    return "ok";
  }

  private async pauseForSandbox(ctx: StepContext): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const updated = await tx.lbProject.updateMany({
        where: { id: ctx.project.id, workspaceId: ctx.project.workspaceId, status: "active" },
        data: { status: "paused" },
      });
      if (updated.count !== 1) return;
      await tx.lbCaptchaEvent.create({
        data: {
          workspaceId: ctx.project.workspaceId,
          projectId: ctx.project.id,
          runId: ctx.run.id,
          type: "unsupported",
          door: "https_api",
          outcome: "sandbox",
          attempt: 1,
          creditsCharged: 0,
          createdAt: ctx.now,
        },
      });
      await tx.lbRun.update({
        where: { id: ctx.run.id },
        data: { lastAction: "Paused, Captell returned a sandbox balance" },
      });
    });
  }

  private async plan(ctx: StepContext): Promise<RealPlan> {
    const quotas = ctx.project.quotas;
    const liveMet = isLiveMet(ctx.run.counters, quotas);
    const schedule = isWithinWindow(ctx.now, ctx.project.schedule, { liveMet });
    if (!schedule.active && !liveMet) return { kind: "close" };
    const entry = this.pool.get(ctx.project.id);
    const host = ctx.host;
    return planRealStep({
      runStatus: ctx.run.status,
      liveMet,
      host: host
        ? {
            id: host.id,
            status: host.status as never,
            parkedFrom: (host.parkedFrom as never) ?? null,
          }
        : null,
      session: {
        hostId: entry?.hostId ?? null,
        helperConnected: entry?.helperConnected ?? false,
        cookieChecked: entry?.cookieChecked ?? false,
        registerFormReady: entry?.registerFormReady ?? false,
      },
      warmupMet: ctx.account
        ? isWarmupMet({
            postCount: ctx.account.postCount,
            accountCreatedAt: ctx.account.createdAt,
            now: ctx.now,
            minAccountAgeHours: ctx.project.warmup.minAccountAgeHours,
            minPostsBeforeLink: postsRequiredBeforeLink(
              ctx.project.warmup.minPostsBeforeLink,
              ctx.host?.platform ?? "",
            ),
          })
        : false,
      warmupPostsShort: ctx.account
        ? ctx.account.postCount <
          postsRequiredBeforeLink(ctx.project.warmup.minPostsBeforeLink, ctx.host?.platform ?? "")
        : false,
      minPostsBeforeLink: postsRequiredBeforeLink(
        ctx.project.warmup.minPostsBeforeLink,
        ctx.host?.platform ?? "",
      ),
      warmupPosts: ctx.account?.postCount ?? 0,
      placement: ctx.placement
        ? { status: ctx.placement.status as never, counted: ctx.placement.counted }
        : null,
      adminCheckDue:
        host?.status === "pending_admin" ? await this.adminCheckDue(ctx, host.id) : false,
    });
  }

  private async adminCheckDue(ctx: StepContext, hostId: string): Promise<boolean> {
    const last = await this.deps.prisma.lbRunStep.findFirst({
      where: { hostId, kind: "admin_check" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return adminRecheckDue(last?.createdAt ?? null, ctx.now);
  }

  /**
   * A failed step drops the persona session so the next tick re-reads the page from scratch.
   * After repeated failures on one host the host is given up.
   */
  private async failure(ctx: StepContext, message: string): Promise<StepResult> {
    await this.closeSession(ctx.project.id);
    const host = ctx.host;
    const recent = await this.deps.prisma.lbRunStep.findMany({
      where: { runId: ctx.run.id },
      orderBy: { stepIndex: "desc" },
      take: MAX_CONSECUTIVE_ERRORS - 1,
      select: { error: true, hostId: true },
    });
    const postFailures = host
      ? await this.deps.prisma.lbRunStep.count({
          where: {
            hostId: host.id,
            kind: { in: ["warmup_post", "post"] },
            error: { not: null },
          },
        })
      : 0;
    const repeated =
      recent.length === MAX_CONSECUTIVE_ERRORS - 1 &&
      recent.every((step) => step.error && step.hostId === host?.id);
    const infra = isInfrastructureFailure(message);
    const giveUp =
      host !== null &&
      !infra &&
      !isHostTerminal(host.status as LbHostStatus) &&
      (repeated || postFailures + 1 >= MAX_CONSECUTIVE_ERRORS);
    return {
      kind: "step",
      lastAction: giveUp ? "Skipped this site" : "Step failed, retrying",
      hostId: host?.id ?? null,
      outcome: { error: message },
      apply: giveUp
        ? (tx) => moveHost(tx, host, "failed", { statusReason: message.slice(0, 500) })
        : undefined,
    };
  }

  private async commit(
    ctx: StepContext,
    fence: number,
    kind: string,
    result: Extract<StepResult, { kind: "step" }>,
    error: string | null,
    startedAt: Date,
  ): Promise<boolean> {
    const patch = result.run ?? {};
    const counters = patch.counters;
    const status = this.nextRunStatus(ctx, patch.status);
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        const fenced = await tx.lbRun.updateMany({
          where: { id: ctx.run.id, leaseOwner: this.workerId, leaseFence: fence },
          data: {
            lastAction: result.lastAction,
            lastError: error,
            ...(status !== ctx.run.status ? { status } : {}),
            ...(counters ?? {}),
            ...(patch.currentHostId !== undefined ? { currentHostId: patch.currentHostId } : {}),
            ...(patch.currentUrl !== undefined ? { currentUrl: patch.currentUrl } : {}),
            ...(patch.finishedAt ? { finishedAt: patch.finishedAt, leaseExpiresAt: null } : {}),
          },
        });
        if (fenced.count !== 1) throw new StaleState("Run lease was lost");
        await result.apply?.(tx);
        await tx.lbRunStep.create({
          data: {
            workspaceId: ctx.project.workspaceId,
            runId: ctx.run.id,
            stepIndex: ctx.stepIndex,
            kind: result.stepKind ?? kind,
            hostId: result.hostId,
            input: json({ hostStatus: ctx.host?.status ?? null }),
            outcome: json({
              lastAction: result.lastAction,
              ...redactOutcome(result.outcome ?? {}, ctx.secrets),
            }),
            error,
            artifactIds: result.artifactIds ?? [],
            costs: json({
              credits: result.credits ?? 0,
              tokens: result.tokens ?? 0,
              bytes: 0,
              ms: Date.now() - startedAt.getTime(),
            }),
            startedAt,
            finishedAt: new Date(),
          },
        });
      });
      return true;
    } catch (caught) {
      if (caught instanceof StaleState || isUnique(caught)) return false;
      throw caught;
    }
  }

  private nextRunStatus(ctx: StepContext, requested: LbRunStatus | undefined): LbRunStatus {
    if (requested) return requested;
    const liveMet = isLiveMet(ctx.run.counters, ctx.project.quotas);
    const schedule = isWithinWindow(ctx.now, ctx.project.schedule, { liveMet });
    if (schedule.mode === "overtime" && ctx.run.status === "running") {
      return transitionRun(ctx.run.status, "overtime");
    }
    return ctx.run.status;
  }

  private async openSession(
    ctx: StepContext,
    host: { id: string } & Parameters<typeof marketOf>[1],
    extra?: Parameters<typeof browserPersona>[2],
  ) {
    const key = marketKey(marketOf(ctx.project, host));
    const existing = this.pool.get(ctx.project.id);
    const engine = extra?.engine ?? "chromium";
    if (existing && existing.marketKey === key && existing.engine === engine) return existing;
    if (existing) await this.closeSession(ctx.project.id);
    const session = await this.deps.browsers.open(browserPersona(ctx, host, extra), ctx.adapter);
    const entry: PoolEntry = {
      session,
      marketKey: key,
      hostId: null,
      helperConnected: false,
      helperVersion: null,
      cookieChecked: false,
      registerFormReady: false,
      captchaAttempts: 0,
      registrationRetried: false,
      spamRetries: 0,
      profileSet: false,
      engine,
    };
    this.pool.set(ctx.project.id, entry);
    return entry;
  }

  private async dropDesktop(
    ctx: StepContext,
    planKind: string,
    lastAction: string,
    stuck: boolean,
  ): Promise<void> {
    if (!this.deps.releaseDesktop) return;
    const idle =
      stuck ||
      planKind === "wait" ||
      planKind === "done" ||
      planKind === "close" ||
      planKind === "select_host" ||
      /skipp|gave up|captcha not supported|waiting for the (verification|site admin|confirmation email)/i.test(
        lastAction,
      );
    if (!idle) return;
    await this.deps.prisma.lbRun
      .updateMany({
        where: { id: ctx.run.id, leaseOwner: this.workerId },
        data: { leaseExpiresAt: new Date(0) },
      })
      .catch(() => undefined);
    await this.closeSession(ctx.project.id);
    await this.deps
      .releaseDesktop(ctx.project.id, ctx.adapter, stuck ? "kill" : "stop")
      .catch(() => undefined);
  }

  private async closeSession(projectId: string): Promise<void> {
    const entry = this.pool.get(projectId);
    this.pool.delete(projectId);
    await entry?.session.close().catch(() => undefined);
  }

  private async storeArtifact(
    ctx: StepContext,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const stored = await this.deps.artifacts.put({ name, mimeType, bytes }, ctx.adapter);
    const row = await this.deps.prisma.artifact
      .create({
        data: {
          workspaceId: ctx.project.workspaceId,
          userId: ctx.project.ownerUserId,
          runId: null,
          name,
          mimeType,
          size: bytes.byteLength,
          hash: createHash("sha256").update(bytes).digest("hex"),
          storageKey: stored.id,
        },
        select: { id: true },
      })
      .catch(async (error: unknown) => {
        await this.deps.artifacts.remove(stored.id, ctx.adapter).catch(() => undefined);
        throw error;
      });
    return row.id;
  }
}

export function startLinkBuilderRealRunner(
  deps: LinkBuilderRealDeps & { intervalMs?: number; env?: NodeJS.ProcessEnv },
): { runner: LinkBuilderRealRunner | null; stop: () => Promise<void> } {
  if (!isLinkBuilderRealEnabled(deps.env)) return { runner: null, stop: async () => {} };
  const runner = new LinkBuilderRealRunner(deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const interval = deps.intervalMs ?? 2_000;
  const loop = () => {
    if (stopped) return;
    void runner
      .tick()
      .catch((error: unknown) => {
        console.error("linkbuilder.real", error instanceof Error ? error.message : "tick failed");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, interval);
      });
  };
  loop();
  return {
    runner,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await runner.close();
    },
  };
}

function projectConfig(row: {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  status: string;
  name: string;
  brandName: string;
  allowedDomains: string[];
  persona: unknown;
  markets: unknown;
  quotas: unknown;
  schedule: unknown;
  warmup: unknown;
  targets: unknown;
  countNofollow: boolean;
  denyHosts: string[];
  preferHosts: string[];
  mailboxId: string | null;
  mailboxAddress: string | null;
  captchaLowBalanceCredits: number;
  operator: unknown;
  spamRetry: unknown;
  facts: string[];
  content: unknown;
  disclosureMode: string;
  linkRatio: unknown;
  topicLanes: unknown;
  proxyPolicy: string;
}): ProjectConfig | null {
  if (row.status !== "active") return null;
  const persona = LbPersonaSchema.safeParse(row.persona);
  const markets = LbMarketsSchema.safeParse(row.markets);
  const quotas = LbQuotasSchema.safeParse(row.quotas);
  const schedule = LbScheduleSchema.safeParse(row.schedule);
  const warmup = LbWarmupSchema.safeParse(row.warmup);
  const targets = LbTargetSchema.array().safeParse(row.targets);
  const operator = LbOperatorSettingsSchema.safeParse(row.operator);
  const spam = LbSpamRetrySchema.safeParse(row.spamRetry);
  if (!persona.success || !markets.success || !quotas.success || !schedule.success) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.createdByUserId,
    name: row.name,
    brandName: row.brandName,
    allowedDomains: row.allowedDomains,
    persona: persona.data,
    markets: markets.data,
    quotas: quotas.data,
    schedule: schedule.data,
    warmup: warmup.success ? warmup.data : LbWarmupSchema.parse({}),
    targets: targets.success ? targets.data : [],
    facts: row.facts,
    content: LbContentSchema.safeParse(row.content).data ?? LbContentSchema.parse({}),
    disclosureMode:
      LbDisclosureModeSchema.safeParse(row.disclosureMode).data ?? "undisclosed_persona",
    linkRatio: LbLinkRatioSchema.safeParse(row.linkRatio).data ?? { links: 1, posts: 3 },
    topicLanes: LbTopicLaneSchema.array().safeParse(row.topicLanes).data ?? [],
    countNofollow: row.countNofollow,
    denyHosts: row.denyHosts,
    preferHosts: row.preferHosts,
    mailboxId: row.mailboxId,
    mailboxAddress: row.mailboxAddress,
    captchaLowBalanceCredits: row.captchaLowBalanceCredits,
    operatorTtlHours: operator.success ? operator.data.parkedHostTtlHours : 48,
    ticketTtlHours: operator.success ? operator.data.ticketTtlHours : 24,
    spamSentences: spam.success ? spam.data.sentences : [...LB_DEFAULT_SPAM_SENTENCES],
    spamMaxRetries: spam.success ? spam.data.maxRetries : 1,
    proxyPolicy: LbProxyPolicySchema.safeParse(row.proxyPolicy).data ?? "static_isp_per_persona",
  };
}

function redactOutcome(
  outcome: Record<string, unknown>,
  secrets: string[],
): Record<string, unknown> {
  return JSON.parse(redactSecrets(JSON.stringify(outcome), secrets)) as Record<string, unknown>;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
