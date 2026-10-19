import {
  type AdapterContext,
  type ArtifactStore,
  type BrowserPersona,
  type BrowserSession,
  type BrowserSessionFactory,
  type CaptchaSolver,
  CaptchaSolverError,
  type FormFieldInfo,
  isSecretRegistrationPrompt,
  type MailboxProvider,
  type ProxyEndpoint,
  type ProxyProvider,
  type TextModel,
} from "@rakazo/adapter-kit";
import {
  type EncryptedSecretStore,
  loadSiteLoginForFill,
  mailboxAddressesToRead,
  signupMailboxAddress,
  upsertSiteLogin,
} from "@rakazo/adapters";
import type {
  LbCaptchaDoor,
  LbCaptchaOutcome,
  LbCaptchaType,
  LbContent,
  LbDisclosureMode,
  LbHostPlatform,
  LbHostStatus,
  LbHumanCheckboxState,
  LbLanguage,
  LbLinkRatio,
  LbLinkSlot,
  LbMarket,
  LbOperatorTicketReason,
  LbParkableHostStatus,
  LbPersona,
  LbPlacementStatus,
  LbProxyPolicy,
  LbRunStatus,
  LbSchedule,
  LbTarget,
  LbTopicLane,
  LbWarmup,
} from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import { BrowserEngineUnavailable } from "@rakazo/linkbuilder-browser";
import {
  acceptLanguageFor,
  adminRecheckDue,
  assertSessionCoherence,
  boardTopicQueriesFromProject,
  brandNameSources,
  CoherenceRefused,
  canRegisterHost,
  closingRunStatus,
  countedWithinPlan,
  decideEdgeBlock,
  decideStuckStep,
  extractVerificationLink,
  generateForumPassword,
  generateForumUsername,
  HOST_IDLE_GAP,
  type HostEvent,
  insertReference,
  isExampleRegistrableDomain,
  isFixtureHostDomain,
  isHardEdgeBlock,
  isHostTerminal,
  isMailSendFailure,
  isMissingSandboxWorkspace,
  isNewSignupBannedHost,
  isRestoredSignupHost,
  isSandboxGoneText,
  isWarmupMet,
  localStuckChoice,
  MAIL_SKIP_STATUS,
  marketForHost,
  PAGE_HELPER_EXTENSION_ID,
  PAGE_HELPER_VERSION,
  type PlanCaps,
  pacedDelayMs,
  pageMatchesTopics,
  parseStuckLook,
  proxyStickyKey,
  type RealStepKind,
  type RunCounters,
  recordCountedLive,
  recordHostVisited,
  recordRegistration,
  redactSecrets,
  resolvePersonaDisplayName,
  restoredSignupIndex,
  STUCK_LOOK_SYSTEM,
  type StuckLookAction,
  type StuckRecord,
  sameLocalDay,
  shouldCount,
  shouldSkipDesktopPage,
  skippedHostLine,
  spamRetryDecision,
  statusAfterMissingWorkspace,
  stepCountsTowardPageGiveUp,
  stuckLookPrompt,
  topicTerms,
  transitionHost,
  transitionPlacement,
  transitionProject,
  transitionRun,
  verifyDeadline,
  WORKABLE_HOST_ORDER,
} from "@rakazo/linkbuilder-core";
import {
  acceptCookieWall,
  adminHoldOnVerify,
  type BoardDriver,
  type BoardThread,
  boardDriverFor,
  type CaptchaChallenge,
  clickResendMail,
  enrichCaptchaChallenge,
  formErrorFixable,
  GenericFormDriver,
  instructionClickSelector,
  isLoginPath,
  placeCaptchaToken,
  type RegistrationPage,
  type RegistrationResult,
  runPageHelper,
  solveImageCaptcha,
  splitFormContinues,
  UnmappedFormError,
  usernameTaken,
  verifyPlacement,
} from "@rakazo/linkbuilder-drivers";
import { bumpModelRefusal, composeReply } from "./link-builder-draft.js";
import {
  boardLink,
  chosenLink,
  PAGE_LOOK_MODEL,
  PAGE_LOOK_SYSTEM,
  PAGE_LOOK_WAIT_MS,
  type PageLink,
  pageLookPrompt,
  threadsFromLinks,
  usablePageLinks,
} from "./link-builder-page-move.js";
import { ensureProxyLease } from "./link-builder-proxy.js";

/** Bot id recorded on forum logins the link builder stores; logins are workspace-shared. */
export const LINK_BUILDER_LOGIN_BOT = "link-builder";
/** Image captcha attempts on one form before the host is parked for the operator. */
export const MAX_CAPTCHA_ATTEMPTS = 4;
export type Tx = Prisma.TransactionClient;

export interface RealWorkerServices {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  artifacts: ArtifactStore;
  browsers: BrowserSessionFactory;
  captcha: CaptchaSolver;
  mailbox: MailboxProvider;
  verifyFetch?: typeof fetch;
  allowPrivateVerify: boolean;
  verifyDelayMs: number;
  reverifyAfterMs: number;
  alerts?: import("@rakazo/linkbuilder-core").AlertSink;
  proxies?: ProxyProvider;
  /** When false, a second Chromium edge block marks the host dead instead of launching Camoufox. */
  camoufoxAvailable?: boolean;
  random?: () => number;
  pageHelperButtonSelector: string;
  pageHelperPollMs: number;
  /** Clock for the Page Helper TTL. Production injects `Date.now`. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Recorded harness in tests, OpenRouter when a deployment key is configured. */
  textModel?: TextModel;
  planCaps: PlanCaps;
}

/** Facts about the open persona browser; they live with the worker, never in the database. */
export interface PoolEntry {
  session: BrowserSession;
  marketKey: string;
  hostId: string | null;
  helperConnected: boolean;
  helperVersion: string | null;
  cookieChecked: boolean;
  registerFormReady: boolean;
  captchaAttempts: number;
  /** One correction of a fixable registration error (taken username, banned email, missing password). */
  registrationRetried: boolean;
  /** Spam-protection retries already used on this registration. */
  spamRetries: number;
  /** Split signup steps filled after a submit left the next form open. */
  splitSteps?: number;
  profileSet: boolean;
  engine: "chromium" | "camoufox";
  /** Kept for the open session so a mapped form survives the next step. */
  driver?: BoardDriver;
}

export interface ProjectConfig {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  brandName: string;
  allowedDomains: string[];
  persona: LbPersona;
  markets: LbMarket[];
  quotas: { newPerDay: number; livePerDay: number; liveWeekCap?: number };
  schedule: LbSchedule;
  warmup: LbWarmup;
  targets: LbTarget[];
  facts: string[];
  content: LbContent;
  disclosureMode: LbDisclosureMode;
  linkRatio: LbLinkRatio;
  topicLanes: LbTopicLane[];
  countNofollow: boolean;
  denyHosts: string[];
  preferHosts: string[];
  mailboxId: string | null;
  mailboxAddress: string | null;
  captchaLowBalanceCredits: number;
  operatorTtlHours: number;
  ticketTtlHours: number;
  spamSentences: readonly string[];
  spamMaxRetries: number;
  proxyPolicy: LbProxyPolicy;
}

export type HostRow = Prisma.LbHostGetPayload<object>;
export type AccountRow = Prisma.LbHostAccountGetPayload<object>;
export type PlacementRow = Prisma.LbPlacementGetPayload<object>;

export interface RunRow {
  id: string;
  status: LbRunStatus;
  counters: RunCounters;
}

export interface StepContext {
  services: RealWorkerServices;
  now: Date;
  run: RunRow;
  stepIndex: number;
  project: ProjectConfig;
  host: HostRow | null;
  account: AccountRow | null;
  placement: PlacementRow | null;
  adapter: AdapterContext;
  /** Values redacted from every outcome, error and log line of this step. */
  secrets: string[];
  pool(): PoolEntry | undefined;
  openSession(
    host: HostRow,
    extra?: { proxy?: ProxyEndpoint; acceptLanguage?: string; engine?: "chromium" | "camoufox" },
  ): Promise<PoolEntry>;
  closeSession(): Promise<void>;
  storeArtifact(name: string, mimeType: string, bytes: Uint8Array): Promise<string>;
}

export interface RunPatch {
  status?: LbRunStatus;
  counters?: RunCounters;
  currentHostId?: string | null;
  currentUrl?: string | null;
  finishedAt?: Date;
}

export type StepResult =
  | { kind: "wait"; reason: string }
  | {
      kind: "step";
      lastAction: string;
      hostId: string | null;
      outcome?: Record<string, unknown>;
      artifactIds?: string[];
      credits?: number;
      tokens?: number;
      /** Persisted step kind when it is not the planned handler name. */
      stepKind?: string;
      run?: RunPatch;
      apply?: (tx: Tx) => Promise<void>;
      afterCommit?: () => Promise<void> | void;
    };

export class StaleState extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleState";
  }
}

export class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailure";
  }
}

type StepHandler = (ctx: StepContext) => Promise<StepResult>;

export const REAL_STEP_HANDLERS: Record<RealStepKind, StepHandler> = {
  select_host: selectHost,
  open_session: openSession,
  helper_connected: helperConnected,
  cookie_wall: cookieWall,
  register,
  captcha,
  email_verify: emailVerify,
  admin_check: adminCheck,
  warmup,
  warmup_post: (ctx) => publish(ctx, true),
  post: (ctx) => publish(ctx, false),
  verify,
  close,
};

function requireHost(ctx: StepContext): HostRow {
  if (!ctx.host) throw new StepFailure("No host selected");
  return ctx.host;
}

function requireDriver(host: HostRow, entry?: PoolEntry): BoardDriver {
  if (entry?.driver && entry.hostId === host.id) return entry.driver;
  const driver = boardDriverFor(host.platform as LbHostPlatform);
  if (!driver) throw new StepFailure(`No driver for ${host.platform}`);
  if (entry) entry.driver = driver;
  return driver;
}

/** Project warm-up, at least four link-free posts, and higher when the driver requires it. */
export function postsRequiredBeforeLink(projectMin: number, platform: string): number {
  const floor = boardDriverFor(platform as LbHostPlatform)?.minPostsBeforeLink ?? 0;
  return Math.max(4, projectMin, floor);
}

function requireSession(ctx: StepContext, host: HostRow): PoolEntry {
  const entry = ctx.pool();
  if (!entry || entry.hostId !== host.id) throw new StepFailure("No persona session on this host");
  return entry;
}

function hostStateOf(host: HostRow) {
  return {
    status: host.status as LbHostStatus,
    parkedFrom: (host.parkedFrom as LbParkableHostStatus | null) ?? null,
  };
}

/**
 * One typed host transition, guarded on the status read at the start of the step. A concurrent
 * change makes the guard miss and the whole step roll back.
 */
export async function moveHost(
  tx: Tx,
  host: HostRow,
  event: HostEvent,
  extra: Prisma.LbHostUpdateManyMutationInput = {},
): Promise<void> {
  const next = transitionHost(hostStateOf(host), event);
  const updated = await tx.lbHost.updateMany({
    where: { id: host.id, status: host.status },
    data: { ...extra, status: next.status, parkedFrom: next.parkedFrom },
  });
  if (updated.count !== 1) throw new StaleState(`Host ${host.id} moved during the step`);
}

async function screenshot(ctx: StepContext, entry: PoolEntry, label: string): Promise<string[]> {
  try {
    const bytes = await entry.session.screenshotPng();
    return [await ctx.storeArtifact(`step-${ctx.stepIndex}-${label}.png`, "image/png", bytes)];
  } catch {
    return [];
  }
}

function personaFor(
  ctx: StepContext,
  market: LbMarket,
  host: HostRow,
  extra: { proxy?: ProxyEndpoint; acceptLanguage?: string; engine?: "chromium" | "camoufox" } = {},
): BrowserPersona {
  const locale = host.locale || market.locale;
  const timezoneId = host.timezoneId || market.timezoneId;
  return {
    projectId: ctx.project.id,
    profileKey: ctx.project.id,
    locale,
    timezoneId,
    acceptLanguage: extra.acceptLanguage ?? acceptLanguageFor(locale),
    ...(extra.proxy ? { proxy: extra.proxy } : {}),
    ...(extra.engine ? { engine: extra.engine } : {}),
  };
}

export function marketOf(project: ProjectConfig, host: HostRow): LbMarket {
  const market =
    marketForHost(project.markets, {
      country: host.country,
      language: host.language as LbLanguage,
    }) ?? project.markets[0];
  if (!market) throw new StepFailure("Project has no market");
  return market;
}

export function browserPersona(
  ctx: StepContext,
  host: HostRow,
  extra?: { proxy?: ProxyEndpoint; acceptLanguage?: string; engine?: "chromium" | "camoufox" },
): BrowserPersona {
  return personaFor(ctx, marketOf(ctx.project, host), host, extra);
}

const CAPTCHA_SKIPPED = "Captell could not solve it. Skipping this forum.";

/** Captell owns captchas. A failed solve leaves the forum and does not open a customer ticket. */
function skipUnsolvedCaptcha(host: HostRow, extra: Prisma.LbHostUpdateManyMutationInput = {}) {
  return (tx: Tx) =>
    moveHost(tx, host, "unsupported_captcha", {
      statusReason: "captcha_unsolved",
      ...extra,
    });
}

async function pageGiveUpCount(ctx: StepContext, hostId: string): Promise<number> {
  const steps = await ctx.services.prisma.lbRunStep.findMany({
    where: { hostId },
    select: { outcome: true },
  });
  return steps.filter((step) => stepCountsTowardPageGiveUp(step.outcome)).length;
}

/**
 * The desktop is view-only, so a parked ticket cannot be solved by the user.
 * An unsolvable captcha is skipped immediately. Any other page is skipped after
 * the normal retry budget. The feed line is an ordinary skip.
 */
async function desktopSkipPlan(
  ctx: StepContext,
  host: HostRow,
  reason: LbOperatorTicketReason,
): Promise<{ lastAction: string; apply?: (tx: Tx) => Promise<void> }> {
  const failures = await pageGiveUpCount(ctx, host.id);
  if (
    !shouldSkipDesktopPage({ reason, failures }) ||
    (host.status === "warming" && ctx.account?.emailVerifiedAt)
  ) {
    return { lastAction: "The page did not finish, trying again" };
  }
  return {
    lastAction: skippedHostLine(host.registrableDomain),
    apply: (tx) => giveUpHost(tx, ctx, host, reason),
  };
}

async function giveUpHost(
  tx: Tx,
  ctx: StepContext,
  host: HostRow,
  reason: LbOperatorTicketReason,
): Promise<void> {
  await tx.lbOperatorTicket.updateMany({
    where: { hostId: host.id, status: "open" },
    data: { status: "skipped", resolvedAt: ctx.now },
  });
  const status = host.status as LbHostStatus;
  if (isHostTerminal(status)) return;
  if (status === "parked_operator") {
    await moveHost(tx, host, "operator_skipped", { statusReason: reason });
    return;
  }
  if (
    reason === "captcha_unsolved" &&
    ["discovered", "probed", "qualified", "registering", "warming", "ready"].includes(status)
  ) {
    await moveHost(tx, host, "unsupported_captcha", { statusReason: reason });
    return;
  }
  await moveHost(tx, host, "failed", { statusReason: reason });
}

function hostOrder(status: string): number {
  return (WORKABLE_HOST_ORDER as readonly string[]).indexOf(status);
}

/** A forum this discovery tick just probed. Older stored rows wait for a later run. */
const JUST_FOUND_MS = 15 * 60 * 1000;

export function hostJustFound(row: { lastProbeAt?: Date | string | null }, now: Date): boolean {
  const raw = row.lastProbeAt;
  const probed =
    raw instanceof Date ? raw.getTime() : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(probed)) return false;
  const age = now.getTime() - probed;
  return age >= -5_000 && age <= JUST_FOUND_MS;
}

const STORED_SIGNUP_DENY = [
  "aquacomputer.de",
  "edubily.de",
  "science-fitness.de",
  "medizin-forum.de",
  "phpbb.de",
  "macuser.de",
  "lifters-lounge.com",
  "frauenselbsthilfe.de",
  "bulli-forum.com",
] as const;

const FORM_MISS_CAP = 3;
const MAIL_WAIT_MS = 3 * 60_000;

/** Stored forums for this signup, in the only order the run may open them. */
const STORED_SIGNUP_ORDER = ["aquacomputer.de", "edubily.de", "science-fitness.de"] as const;

function registrableKey(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function restoredSignupRank(domain: string): number {
  const index = restoredSignupIndex(domain);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function topicEvidence(row: {
  notes?: string | null;
  topicTags?: readonly string[] | null;
}): string {
  return [row.notes ?? "", ...(row.topicTags ?? [])]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

/** Stored page text, title, or tags match a lane. Empty evidence is not a match. */
function topicEvidenceMatches(
  row: { notes?: string | null; topicTags?: readonly string[] | null },
  project: ProjectConfig,
): boolean {
  const evidence = topicEvidence(row);
  if (!evidence.trim() || topicTerms(project).length === 0) return false;
  return pageMatchesTopics(
    { pageText: evidence, title: evidence, topicTags: row.topicTags },
    project,
  );
}

/** Off-topic pages are not eligible. A qualified row with no stored text was already judged. */
function topicAllowsSignup(
  row: { status: string; notes?: string | null; topicTags?: readonly string[] | null },
  project: ProjectConfig,
): boolean {
  if (row.status === "off_topic") return false;
  if (topicTerms(project).length === 0) return true;
  const evidence = topicEvidence(row);
  if (!evidence.trim()) return true;
  return pageMatchesTopics(
    { pageText: evidence, title: evidence, topicTags: row.topicTags },
    project,
  );
}

function storedSignupIndex(domain: string): number {
  const index = (STORED_SIGNUP_ORDER as readonly string[]).indexOf(registrableKey(domain));
  return index === -1 ? STORED_SIGNUP_ORDER.length : index;
}

export function noSignupFormLine(domain: string): string {
  return `No signup form on ${domain.trim()}`;
}

function hostCreatedMs(row: { createdAt?: Date | string | null }): number {
  if (row.createdAt instanceof Date) return row.createdAt.getTime();
  if (typeof row.createdAt === "string") {
    const parsed = Date.parse(row.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.MAX_SAFE_INTEGER;
}

function deniedForStoredSignup(domain: string, deny: ReadonlySet<string>): boolean {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (deny.has(host)) return true;
  const needles = [...deny, ...STORED_SIGNUP_DENY];
  return needles.some((item) => item.length > 0 && (host === item || host.endsWith(`.${item}`)));
}

function unusedQualifiedHost(
  row: { status: string; registrableDomain: string; accounts: readonly unknown[] },
  deny: ReadonlySet<string>,
): boolean {
  return (
    row.status === "qualified" &&
    row.accounts.length === 0 &&
    !deniedForStoredSignup(row.registrableDomain, deny)
  );
}

async function anotherFreshForumRemains(ctx: StepContext, currentDomain: string): Promise<boolean> {
  const current = registrableKey(currentDomain);
  const deny = new Set(ctx.project.denyHosts.map((host) => host.toLowerCase()));
  let rows: Array<{
    status: string;
    registrableDomain: string;
    accounts: readonly unknown[];
    lastProbeAt?: Date | string | null;
  }> = [];
  try {
    rows = await ctx.services.prisma.lbHost.findMany({
      where: { workspaceId: ctx.project.workspaceId, projectId: ctx.project.id },
      include: { accounts: true },
    });
  } catch {
    return false;
  }
  return rows.some((row) => {
    const domain = registrableKey(row.registrableDomain);
    if (domain === current) return false;
    if (row.status !== "qualified" || row.accounts.length > 0) return false;
    if (deniedForStoredSignup(domain, deny)) return false;
    return hostJustFound(row, ctx.now);
  });
}

/** A stored forum still waiting to sign up. An unfinished login row does not skip it. */
function storedSignupTarget(
  row: { status: string; registrableDomain: string },
  deny: ReadonlySet<string>,
): boolean {
  const domain = registrableKey(row.registrableDomain);
  return (
    row.status === "qualified" &&
    (STORED_SIGNUP_ORDER as readonly string[]).includes(domain) &&
    !deniedForStoredSignup(domain, deny)
  );
}

/** A warming host whose latest step was a refused sign-in waits behind the others. */
async function hostsStuckOnLogin(
  ctx: StepContext,
  hostIds: readonly string[],
): Promise<Set<string>> {
  const stuck = new Set<string>();
  if (hostIds.length === 0) return stuck;
  let steps: Array<{
    hostId: string | null;
    kind: string;
    error: string | null;
    outcome: unknown;
  }> = [];
  try {
    steps = await ctx.services.prisma.lbRunStep.findMany({
      where: { runId: ctx.run.id, hostId: { in: [...hostIds] } },
      orderBy: { stepIndex: "desc" },
      take: 24,
      select: { hostId: true, kind: true, error: true, outcome: true },
    });
  } catch {
    return stuck;
  }
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.hostId || seen.has(step.hostId) || step.kind === "page_look") continue;
    seen.add(step.hostId);
    const outcome =
      step.outcome && typeof step.outcome === "object"
        ? (step.outcome as Record<string, unknown>)
        : {};
    const error = step.error ?? "";
    if (outcome.login === false || /angaben sind ungültig|kennwort ist falsch/i.test(error)) {
      stuck.add(step.hostId);
    }
  }
  return stuck;
}

/** Warming hosts that already posted a link-free reply on this run. */
async function hostsPostedThisRun(
  ctx: StepContext,
  hostIds: readonly string[],
): Promise<Set<string>> {
  const posted = new Set<string>();
  if (hostIds.length === 0) return posted;
  try {
    const steps = await ctx.services.prisma.lbRunStep.findMany({
      where: {
        runId: ctx.run.id,
        hostId: { in: [...hostIds] },
        kind: "warmup_post",
        error: null,
      },
      select: { hostId: true, outcome: true },
    });
    for (const step of steps) {
      const outcome =
        step.outcome && typeof step.outcome === "object"
          ? (step.outcome as Record<string, unknown>)
          : {};
      if (outcome.lastAction === "Posted the reply" && step.hostId) posted.add(step.hostId);
    }
  } catch {
    return posted;
  }
  return posted;
}

function hostSortRank(row: {
  status: string;
  statusReason: string | null;
  accounts: ReadonlyArray<{ emailVerifiedAt: Date | null; adminApprovedAt: Date | null }>;
}): number {
  if (row.status === "dead" && isMissingSandboxWorkspace(row.statusReason)) {
    const account = row.accounts[0] ?? null;
    return hostOrder(
      statusAfterMissingWorkspace(
        account
          ? { emailVerifiedAt: account.emailVerifiedAt, adminApprovedAt: account.adminApprovedAt }
          : null,
      ),
    );
  }
  return hostOrder(row.status);
}

async function selectHost(ctx: StepContext): Promise<StepResult> {
  const { prisma } = ctx.services;
  const rows = await prisma.lbHost.findMany({
    where: {
      workspaceId: ctx.project.workspaceId,
      projectId: ctx.project.id,
      OR: [
        { status: { in: [...WORKABLE_HOST_ORDER] } },
        { status: "dead", statusReason: "no_open_thread" },
        { status: "dead", statusReason: { contains: "rakazo-home" } },
        { status: "dead", statusReason: { contains: "sandbox workspace" } },
      ],
    },
    include: { accounts: true, placements: { select: { status: true } } },
  });
  const dueAdmin = await adminHostsDue(ctx, rows);
  const deny = new Set(ctx.project.denyHosts.map((host) => host.toLowerCase()));
  const prefer = new Set(ctx.project.preferHosts.map((host) => host.toLowerCase()));
  const blocked = (row: (typeof rows)[number]) =>
    deniedForStoredSignup(row.registrableDomain, deny) ||
    (isNewSignupBannedHost(row.registrableDomain) && row.accounts.length === 0) ||
    isFixtureHostDomain(row.registrableDomain) ||
    isExampleRegistrableDomain(row.registrableDomain);
  const candidates = rows.filter((row) => {
    if (row.status === "form_not_found" || row.status === "off_topic") return false;
    if (blocked(row) || !boardDriverFor(row.platform as LbHostPlatform)) {
      return false;
    }
    if (row.status === "qualified") {
      const restored = isRestoredSignupHost(row.registrableDomain);
      if (restored && row.accounts.length > 0) return false;
      if (!topicAllowsSignup(row, ctx.project)) return false;
      const matched = topicEvidenceMatches(row, ctx.project);
      if (!restored && !hostJustFound(row, ctx.now) && !matched) return false;
      return ctx.run.counters.newToday < ctx.project.quotas.newPerDay;
    }
    if (row.status === "warming") {
      const account = row.accounts[0];
      if (!account?.emailVerifiedAt) return false;
      const postsShort =
        account.postCount <
        postsRequiredBeforeLink(ctx.project.warmup.minPostsBeforeLink, row.platform);
      return (
        postsShort ||
        isWarmupMet({
          postCount: account.postCount,
          accountCreatedAt: account.createdAt,
          now: ctx.now,
          ...ctx.project.warmup,
        })
      );
    }
    if (row.status === "ready") return !row.placements.some((p) => p.status !== "pending");
    if (row.status === "pending_admin") return dueAdmin.has(row.id);
    if (row.status === "dead") {
      if (row.statusReason === "no_open_thread" && row.accounts.length > 0) return true;
      return isMissingSandboxWorkspace(row.statusReason);
    }
    return true;
  });
  const eligible = [];
  for (const row of candidates) {
    if (row.status === "qualified" && !(await registrationOpen(ctx, row.id))) continue;
    eligible.push(row);
  }
  const loginStuck = await hostsStuckOnLogin(
    ctx,
    eligible.map((row) => row.id),
  );
  const warmingIds = eligible
    .filter((row) => row.status === "warming" && row.accounts[0]?.emailVerifiedAt)
    .map((row) => row.id);
  const postedThisRun = await hostsPostedThisRun(ctx, warmingIds);
  const warmupPosted = warmingIds.length > 0 && warmingIds.every((id) => postedThisRun.has(id));
  eligible.sort((a, b) => {
    const aTarget = storedSignupTarget(a, deny);
    const bTarget = storedSignupTarget(b, deny);
    if (aTarget && bTarget) {
      return storedSignupIndex(a.registrableDomain) - storedSignupIndex(b.registrableDomain);
    }
    if (aTarget !== bTarget) return aTarget ? -1 : 1;
    const aOpen = unusedQualifiedHost(a, deny);
    const bOpen = unusedQualifiedHost(b, deny);
    if (aOpen && bOpen) {
      const restored =
        restoredSignupRank(a.registrableDomain) - restoredSignupRank(b.registrableDomain);
      if (restored !== 0) return restored;
      return hostCreatedMs(a) - hostCreatedMs(b);
    }
    if (ctx.run.counters.newToday === 0 && aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }
    if (aOpen && deniedForStoredSignup(b.registrableDomain, deny)) return -1;
    if (bOpen && deniedForStoredSignup(a.registrableDomain, deny)) return 1;
    if (warmupPosted) {
      const finishSignup = (row: (typeof eligible)[number]) =>
        row.status === "registering" || row.status === "pending_email";
      if (finishSignup(a) !== finishSignup(b)) return finishSignup(a) ? -1 : 1;
    }
    if (loginStuck.has(a.id) !== loginStuck.has(b.id)) return loginStuck.has(a.id) ? 1 : -1;
    const warmingPosts = (row: (typeof eligible)[number]) =>
      row.status === "warming" ? (row.accounts[0]?.postCount ?? 0) : null;
    const aPosts = warmingPosts(a);
    const bPosts = warmingPosts(b);
    if (aPosts !== null && bPosts !== null && aPosts !== bPosts) return aPosts - bPosts;
    return (
      hostSortRank(a) - hostSortRank(b) ||
      Number(prefer.has(b.registrableDomain)) - Number(prefer.has(a.registrableDomain)) ||
      b.qualityScore - a.qualityScore
    );
  });
  const picked = eligible[0];
  if (!picked) {
    const openRows = rows.filter((row) => !blocked(row));
    const capped = openRows.filter((row) => row.status === "qualified");
    for (const host of capped) {
      if (await registrationOpen(ctx, host.id)) continue;
      if (await registrationCapAlreadyTold(ctx, host.id)) {
        return { kind: "wait", reason: "registration_cap" };
      }
      return {
        kind: "step",
        stepKind: "register",
        lastAction: "Registration cap",
        hostId: host.id,
        outcome: { refused: "registration_cap" },
      };
    }
    const denied = rows.filter((row) => blocked(row));
    if (denied.length > 0) {
      const domains = denied.map((row) => row.registrableDomain).sort();
      return {
        kind: "step",
        stepKind: "select_host",
        hostId: null,
        lastAction: `Skipped ${denied.length} denied forums`,
        outcome: { skipped: domains },
      };
    }
    const pending = openRows.filter((row) => row.status === "pending_admin");
    if (pending.length > 0) {
      return {
        kind: "step",
        stepKind: "select_host",
        hostId: null,
        lastAction: "Waiting for a site admin",
        outcome: {
          reason: "admin_approval",
          domains: pending.map((row) => row.registrableDomain).sort(),
        },
      };
    }
    return {
      kind: "step",
      stepKind: "select_host",
      hostId: null,
      lastAction: "No forum left to work on",
      outcome: { reason: "no_workable_host" },
    };
  }
  if (ctx.services.sleep && ctx.host && ctx.host.id !== picked.id) {
    await ctx.services.sleep(pacedDelayMs(HOST_IDLE_GAP, ctx.services.random ?? Math.random));
  }
  const threadRetry = picked.status === "dead" && picked.statusReason === "no_open_thread";
  const workspaceRetry = picked.status === "dead" && isMissingSandboxWorkspace(picked.statusReason);
  const retry = threadRetry || workspaceRetry;
  if (picked.id === ctx.host?.id && !retry) return { kind: "wait", reason: "same_host" };
  const visited = await prisma.lbRunStep.count({ where: { runId: ctx.run.id, hostId: picked.id } });
  const entry = ctx.pool();
  return {
    kind: "step",
    lastAction: threadRetry
      ? `Looking again on ${picked.registrableDomain}`
      : workspaceRetry
        ? `Trying ${picked.registrableDomain} again`
        : `Working on ${picked.registrableDomain}`,
    hostId: picked.id,
    outcome: { hostStatus: picked.status },
    run: {
      currentHostId: picked.id,
      currentUrl: picked.homepageUrl,
      counters: recordHostVisited(ctx.run.counters, { firstVisitToday: visited === 0 }),
    },
    apply: threadRetry
      ? async (tx) => {
          const updated = await tx.lbHost.updateMany({
            where: { id: picked.id, status: "dead", statusReason: "no_open_thread" },
            data: { status: "ready", statusReason: null },
          });
          if (updated.count !== 1) throw new StaleState(`Host ${picked.id} moved during the step`);
        }
      : workspaceRetry
        ? async (tx) => {
            const account = picked.accounts[0] ?? null;
            const updated = await tx.lbHost.updateMany({
              where: { id: picked.id, status: "dead", statusReason: picked.statusReason },
              data: {
                status: statusAfterMissingWorkspace(
                  account
                    ? {
                        emailVerifiedAt: account.emailVerifiedAt,
                        adminApprovedAt: account.adminApprovedAt,
                      }
                    : null,
                ),
                statusReason: null,
              },
            });
            if (updated.count !== 1)
              throw new StaleState(`Host ${picked.id} moved during the step`);
          }
        : undefined,
    afterCommit: () => {
      if (entry && entry.hostId !== picked.id) {
        Object.assign(entry, {
          hostId: null,
          helperConnected: false,
          helperVersion: null,
          cookieChecked: false,
          registerFormReady: false,
          captchaAttempts: 0,
          registrationRetried: false,
          spamRetries: 0,
          profileSet: false,
          driver: undefined,
        });
      }
    },
  };
}

async function adminHostsDue(
  ctx: StepContext,
  rows: readonly { id: string; status: string }[],
): Promise<Set<string>> {
  const pending = rows.filter((row) => row.status === "pending_admin");
  if (pending.length === 0) return new Set();
  const checks = await ctx.services.prisma.lbRunStep.findMany({
    where: { hostId: { in: pending.map((row) => row.id) }, kind: "admin_check" },
    orderBy: { createdAt: "desc" },
    select: { hostId: true, createdAt: true },
  });
  const last = new Map<string, Date>();
  for (const step of checks) {
    if (step.hostId && !last.has(step.hostId)) last.set(step.hostId, step.createdAt);
  }
  return new Set(
    pending
      .filter((row) => adminRecheckDue(last.get(row.id) ?? null, ctx.now))
      .map((row) => row.id),
  );
}

async function registrationCapAlreadyTold(ctx: StepContext, hostId: string): Promise<boolean> {
  const refused = await ctx.services.prisma.lbRunStep.findMany({
    where: { hostId, kind: "register" },
    select: { createdAt: true, outcome: true },
  });
  return refused.some(
    (step) =>
      sameDayRefusal(step.outcome) &&
      canRegisterHost({
        priorRegistrationAts: [step.createdAt],
        now: ctx.now,
        timeZone: ctx.project.schedule.timezone,
      }) === false,
  );
}

function sameDayRefusal(outcome: unknown): boolean {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as { refused?: unknown }).refused === "registration_cap"
  );
}

/** A parked read that never submitted must not spend the host's daily registration. */
export function countsAsRegistration(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return false;
  if (sameDayRefusal(outcome)) return false;
  const record = outcome as { username?: unknown; registration?: unknown };
  if (record.username !== undefined) return true;
  if (Array.isArray(record.registration)) return record.registration.length > 0;
  return typeof record.registration === "string" && record.registration.length > 0;
}

async function registrationOpen(ctx: StepContext, hostId: string): Promise<boolean> {
  const steps = await ctx.services.prisma.lbRunStep.findMany({
    where: { hostId, kind: "register" },
    select: { createdAt: true, outcome: true },
  });
  return canRegisterHost({
    priorRegistrationAts: steps
      .filter((step) => countsAsRegistration(step.outcome))
      .map((step) => step.createdAt),
    now: ctx.now,
    timeZone: ctx.project.schedule.timezone,
  });
}

async function readEdgeBlock(session: BrowserSession): Promise<boolean> {
  const body = await session.pageText().catch(() => "");
  const title = await session.text("title").catch(() => null);
  const meta = (await session.navigationMeta?.()) ?? { status: null, headers: {} };
  return isHardEdgeBlock({ status: meta.status, body, title, headers: meta.headers });
}

function edgeDead(host: HostRow): Extract<StepResult, { kind: "step" }> {
  return {
    kind: "step",
    stepKind: "edge_block",
    lastAction: "Edge block",
    hostId: host.id,
    outcome: { reason: "edge_block" },
    apply: (tx) => moveHost(tx, host, "failed", { statusReason: "edge_block" }),
  };
}

async function openSession(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const market = marketOf(ctx.project, host);
  const locale = host.locale || market.locale;
  const timezoneId = host.timezoneId || market.timezoneId;
  const acceptLanguage = acceptLanguageFor(locale);
  let proxy: ProxyEndpoint | undefined;
  if (ctx.project.proxyPolicy !== "none" && ctx.services.proxies) {
    proxy = await ensureProxyLease(
      {
        prisma: ctx.services.prisma,
        provider: ctx.services.proxies,
        secrets: ctx.services.secrets,
        now: ctx.now,
        context: ctx.adapter,
      },
      {
        projectId: ctx.project.id,
        workspaceId: ctx.project.workspaceId,
        country: host.country,
        stickyKey: proxyStickyKey(ctx.project.id, host.country),
      },
    );
  }
  try {
    assertSessionCoherence(host.country, {
      proxyCountry: proxy?.country ?? host.country,
      locale,
      timezoneId,
      acceptLanguage,
      geolocation: false,
    });
  } catch (error) {
    if (error instanceof CoherenceRefused) {
      return {
        kind: "step",
        stepKind: "coherence_refused",
        lastAction: "Coherence refused",
        hostId: host.id,
        outcome: { reason: "coherence_refused", issues: [...error.issues] },
        apply: (tx) => moveHost(tx, host, "parked", { statusReason: "coherence_refused" }),
      };
    }
    throw error;
  }
  const engine = host.engineHint === "camoufox" ? "camoufox" : "chromium";
  let entry: PoolEntry;
  try {
    entry = await ctx.openSession(host, { proxy, acceptLanguage, engine });
  } catch (error) {
    if (error instanceof BrowserEngineUnavailable) return edgeDead(host);
    throw error;
  }
  await entry.session.goto(host.homepageUrl);
  if (await readEdgeBlock(entry.session)) {
    const prior = await ctx.services.prisma.lbRunStep.count({
      where: { hostId: host.id, kind: "edge_block" },
    });
    const decision = decideEdgeBlock({
      engineHint: host.engineHint,
      priorChromiumBlocks: prior,
      blockedNow: true,
      camoufoxAvailable: ctx.services.camoufoxAvailable ?? false,
    });
    if (decision.action === "record") {
      await ctx.closeSession();
      return {
        kind: "step",
        stepKind: "edge_block",
        lastAction: "Edge block",
        hostId: host.id,
        outcome: { edgeBlock: true, attempt: prior + 1 },
      };
    }
    if (decision.action === "dead") {
      await ctx.closeSession();
      return edgeDead(host);
    }
    if (decision.action === "retry_camoufox") {
      await ctx.closeSession();
      await ctx.services.prisma.lbHost.update({
        where: { id: host.id },
        data: { engineHint: "camoufox" },
      });
      host.engineHint = "camoufox";
      try {
        entry = await ctx.openSession(host, { proxy, acceptLanguage, engine: "camoufox" });
      } catch (error) {
        if (error instanceof BrowserEngineUnavailable) return edgeDead(host);
        throw error;
      }
      await entry.session.goto(host.homepageUrl);
      if (await readEdgeBlock(entry.session)) {
        await ctx.closeSession();
        return edgeDead(host);
      }
    }
  }
  Object.assign(entry, {
    hostId: host.id,
    helperConnected: false,
    helperVersion: null,
    cookieChecked: false,
    registerFormReady: false,
    captchaAttempts: 0,
    registrationRetried: false,
    spamRetries: 0,
    profileSet: false,
    driver: undefined,
  });
  return {
    kind: "step",
    lastAction: `Opened ${host.registrableDomain}`,
    hostId: host.id,
    artifactIds: await screenshot(ctx, entry, "open"),
    outcome: { mode: ctx.services.browsers.mode },
    run: { currentUrl: await entry.session.url() },
  };
}

/**
 * The pinned store build, or any loaded copy of that version. Other Chrome extensions
 * (a desktop image often has one at version 1.0) are not the Page Helper.
 */
export function observedPageHelper(
  loaded: ReadonlyArray<{ id: string; version: string }>,
): { version: string | null; extensionId: string } | null {
  const pinned = loaded.find((item) => item.id === PAGE_HELPER_EXTENSION_ID);
  if (pinned) return { version: pinned.version || null, extensionId: pinned.id };
  const match = loaded.find((item) => item.version === PAGE_HELPER_VERSION);
  if (match) return { version: match.version, extensionId: match.id };
  return null;
}

async function readHelperVersion(session: BrowserSession): Promise<{
  version: string | null;
  extensionId: string | null;
}> {
  const loaded = (await session.extensionVersions?.()) ?? [];
  const helper = observedPageHelper(loaded);
  if (helper) return helper;
  await session.waitFor("html[data-page-helper-version]", { timeoutMs: 5_000 });
  return {
    version: await session.attribute("html", "data-page-helper-version"),
    extensionId: null,
  };
}

/** Missing helper uses Captell's HTTPS door. A loaded helper with the wrong version still parks. */
export function helperConnectionPlan(version: string | null): "api" | "park" | "connected" {
  if (!version) return "api";
  if (version !== PAGE_HELPER_VERSION) return "park";
  return "connected";
}

async function helperConnected(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const entry = requireSession(ctx, host);
  if (entry.engine === "camoufox") {
    // Camoufox is Firefox. The Page Helper is a Chromium extension, so captcha uses the API door.
    entry.helperConnected = true;
    entry.helperVersion = null;
    return {
      kind: "step",
      lastAction: "Camoufox uses the API captcha door",
      hostId: host.id,
      outcome: { engine: "camoufox", door: "https_api" },
    };
  }
  const observed = await readHelperVersion(entry.session).catch(() => ({
    version: null,
    extensionId: null,
  }));
  if (helperConnectionPlan(observed.version) === "api") {
    // No Page Helper is loaded. Captell still solves through the HTTPS door.
    entry.helperConnected = true;
    entry.helperVersion = null;
    return {
      kind: "step",
      lastAction: "Captcha uses the API door",
      hostId: host.id,
      outcome: { helperVersion: "missing", door: "https_api" },
    };
  }
  if (helperConnectionPlan(observed.version) === "park") {
    const seen = observed.version;
    const artifactIds = await screenshot(ctx, entry, "helper");
    entry.registerFormReady = false;
    const plan = await desktopSkipPlan(ctx, host, "unknown_page_state");
    return {
      kind: "step",
      hostId: host.id,
      artifactIds,
      outcome: { helperVersion: seen, expected: PAGE_HELPER_VERSION },
      ...plan,
    };
  }
  entry.helperConnected = true;
  entry.helperVersion = observed.version;
  return {
    kind: "step",
    lastAction: "Page Helper connected",
    hostId: host.id,
    outcome: {
      helperVersion: observed.version,
      extensionId: observed.extensionId,
    },
  };
}

async function cookieWall(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const entry = requireSession(ctx, host);
  const result = await acceptCookieWall(entry.session);
  entry.cookieChecked = true;
  return {
    kind: "step",
    lastAction: result === "accepted" ? "Accepted the cookie notice" : "No cookie notice",
    hostId: host.id,
    outcome: { cookieWall: result },
    artifactIds: result === "accepted" ? await screenshot(ctx, entry, "cookies") : [],
  };
}

interface Credentials {
  username: string;
  password: string;
  email: string;
  accountId: string;
}

/**
 * Reuses the host account's vault login, or generates a username and password in code, stores the
 * password in the encrypted vault at once and creates the account row before anything is typed.
 */
async function ensureCredentials(ctx: StepContext, host: HostRow): Promise<Credentials> {
  const { prisma, secrets } = ctx.services;
  const existing = await prisma.lbHostAccount.findUnique({ where: { hostId: host.id } });
  const priorSignups = await prisma.lbHostAccount.count({ where: { projectId: ctx.project.id } });
  const email = signupMailboxAddress({
    existingAccount: Boolean(existing),
    storedAddress: ctx.project.mailboxAddress,
    seed: ctx.project.id,
    domain: process.env.RESEND_INBOUND_DOMAIN,
    priorSignups,
  });
  if (!email) throw new StepFailure("Project has no mailbox");
  if (existing?.siteLoginId) {
    const password = await loadPassword(ctx, existing.siteLoginId);
    return { username: existing.username, password, email, accountId: existing.id };
  }
  const username = await freshUsername(ctx, host);
  const password = generateForumPassword();
  ctx.secrets.push(password);
  const stored = await upsertSiteLogin(
    { prisma, secrets },
    {
      workspaceId: ctx.project.workspaceId,
      userId: ctx.project.ownerUserId,
      botId: LINK_BUILDER_LOGIN_BOT,
      site: host.homepageUrl,
      username,
      password,
      from: "user",
    },
  );
  if ("error" in stored) throw new StepFailure(stored.error);
  try {
    const account = existing
      ? await prisma.lbHostAccount.update({
          where: { id: existing.id },
          data: { username, siteLoginId: stored.login.id },
        })
      : await prisma.lbHostAccount.create({
          data: {
            workspaceId: ctx.project.workspaceId,
            projectId: ctx.project.id,
            hostId: host.id,
            username,
            siteLoginId: stored.login.id,
          },
        });
    return { username, password, email, accountId: account.id };
  } catch (error) {
    if (!isUnique(error)) throw error;
    return ensureCredentials(ctx, host);
  }
}

/** A generated username with no vault login on this site yet, so no stored password is replaced. */
async function ensurePersonalDisplayName(ctx: StepContext): Promise<string> {
  const language = ctx.project.persona.language ?? ctx.project.markets[0]?.language ?? "de";
  const displayName = resolvePersonaDisplayName({
    displayName: ctx.project.persona.displayName,
    language,
    sources: brandNameSources({
      brandName: ctx.project.brandName,
      projectName: ctx.project.name,
      domains: ctx.project.allowedDomains,
    }),
  });
  if (displayName === ctx.project.persona.displayName) return displayName;
  ctx.project.persona = { ...ctx.project.persona, displayName };
  await ctx.services.prisma.lbProject.update({
    where: { id: ctx.project.id },
    data: { persona: ctx.project.persona as Prisma.InputJsonValue },
  });
  return displayName;
}

async function freshUsername(ctx: StepContext, host: HostRow): Promise<string> {
  const displayName = await ensurePersonalDisplayName(ctx);
  const site = new URL(host.homepageUrl).hostname.replace(/^www\./, "").toLowerCase();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const username = generateForumUsername(displayName);
    const taken = await ctx.services.prisma.siteLogin.count({
      where: {
        workspaceId: ctx.project.workspaceId,
        userId: ctx.project.ownerUserId,
        host: site,
        username,
      },
    });
    if (taken === 0) return username;
  }
  throw new StepFailure("Could not pick a free username");
}

async function loadPassword(ctx: StepContext, siteLoginId: string): Promise<string> {
  const loaded = await loadSiteLoginForFill(
    { prisma: ctx.services.prisma, secrets: ctx.services.secrets },
    {
      workspaceId: ctx.project.workspaceId,
      userId: ctx.project.ownerUserId,
      botId: LINK_BUILDER_LOGIN_BOT,
      loginId: siteLoginId,
    },
  );
  if ("error" in loaded) throw new StepFailure("Vault login is missing");
  ctx.secrets.push(loaded.password);
  return loaded.password;
}

/** Result of a registration submit, mapped to exactly one host transition. */
async function registrationOutcome(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  result: RegistrationResult,
  artifactIds: string[],
): Promise<Extract<StepResult, { kind: "step" }>> {
  const base = { kind: "step" as const, hostId: host.id, artifactIds };
  const settled = () => {
    entry.registerFormReady = false;
    entry.captchaAttempts = 0;
  };
  switch (result.kind) {
    case "pending_email":
      return {
        ...base,
        lastAction: "Registered, waiting for the verification mail",
        outcome: { registration: result.kind },
        apply: (tx) => moveHost(tx, host, "email_pending"),
        afterCommit: settled,
      };
    case "pending_admin":
      return {
        ...base,
        lastAction: "Registered, waiting for the board admin",
        outcome: { registration: result.kind },
        apply: (tx) => moveHost(tx, host, "admin_pending"),
        afterCommit: settled,
      };
    case "active":
      return {
        ...base,
        lastAction: "Registered",
        outcome: { registration: result.kind },
        apply: (tx) => moveHost(tx, host, "account_active"),
        afterCommit: settled,
      };
    case "form_error":
      return {
        ...base,
        lastAction: "The board refused the registration",
        outcome: { registration: result.kind, messages: redactAll(ctx, result.messages) },
        apply: (tx) =>
          moveHost(tx, host, "failed", {
            statusReason: redactAll(ctx, result.messages).join(" ").slice(0, 500),
          }),
        afterCommit: settled,
      };
    case "unknown": {
      const plan = await desktopSkipPlan(ctx, host, "unknown_page_state");
      return {
        ...base,
        ...plan,
        outcome: { registration: result.kind, messages: redactAll(ctx, result.messages) },
        afterCommit: settled,
      };
    }
    case "captcha_rejected":
      throw new StepFailure("captcha_rejected is handled by the captcha step");
  }
}

/**
 * Stock drivers are the prior. An unknown host, or a stock driver that never reaches a
 * registration form, uses the generic form driver instead of parking.
 */
export function selectsGenericRegistrationJourney(
  platform: string,
  stockPage?: RegistrationPage | null,
): boolean {
  if (platform === "unknown") return true;
  return stockPage === "unknown" || stockPage === "unmapped";
}

function warmupReplyWithoutLink(language: string): string {
  return language.split("-")[0] === "de"
    ? "Danke für den Hinweis, das hatte ich ähnlich erlebt."
    : "Thanks for laying that out. I had a similar experience.";
}

/** Link-free warmup. Brand relevance is for the later live post, not this one. */
export function warmupReplyChoice(language: string): {
  body: string;
  linkSlot: "none";
  targetUrl: null;
  anchorText: null;
} {
  return {
    body: warmupReplyWithoutLink(language),
    linkSlot: "none",
    targetUrl: null,
    anchorText: null,
  };
}

async function missedFormsThisRun(ctx: StepContext): Promise<number> {
  try {
    const steps = await ctx.services.prisma.lbRunStep.findMany({
      where: { runId: ctx.run.id },
      select: { outcome: true },
    });
    return steps.filter((step) => stepActionText(step.outcome).startsWith("No signup form")).length;
  } catch {
    return 0;
  }
}

function stepActionText(outcome: unknown): string {
  if (!outcome || typeof outcome !== "object") return "";
  const action = (outcome as { lastAction?: unknown }).lastAction;
  return typeof action === "string" ? action : "";
}

/** The open page has no signup path. The host stays retryable; this run does not pick it again. */
async function noSignupForm(
  ctx: StepContext,
  host: HostRow,
  artifactIds: string[],
): Promise<Extract<StepResult, { kind: "step" }>> {
  const misses = await missedFormsThisRun(ctx);
  const another =
    misses + 1 < FORM_MISS_CAP && (await anotherFreshForumRemains(ctx, host.registrableDomain));
  return {
    kind: "step",
    lastAction: noSignupFormLine(host.registrableDomain),
    hostId: host.id,
    artifactIds,
    outcome: {
      reason: "no_signup_form",
      domain: host.registrableDomain,
      releaseDesktop: !another,
    },
    apply: async (tx) => {
      const updated = await tx.lbHost.updateMany({
        where: { id: host.id, status: host.status },
        data: { status: "form_not_found", parkedFrom: null, statusReason: "no_signup_form" },
      });
      if (updated.count !== 1) throw new StaleState(`Host ${host.id} moved during the step`);
      if (another) return;
      await tx.lbProject.updateMany({
        where: { id: ctx.project.id, workspaceId: ctx.project.workspaceId, status: "active" },
        data: { status: transitionProject("active", "paused") },
      });
    },
  };
}

async function register(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  if (host.status === "qualified" && !(await registrationOpen(ctx, host.id))) {
    if (await registrationCapAlreadyTold(ctx, host.id)) {
      return { kind: "wait", reason: "registration_cap" };
    }
    return {
      kind: "step",
      stepKind: "register",
      lastAction: "Registration cap",
      hostId: host.id,
      outcome: { refused: "registration_cap" },
    };
  }
  const entry = requireSession(ctx, host);
  const genericHost = selectsGenericRegistrationJourney(host.platform);
  let driver: BoardDriver = genericHost ? new GenericFormDriver() : requireDriver(host, entry);
  if (genericHost) entry.driver = driver;
  if (host.status === "registering") {
    // A resumed step: the operator may already have submitted, so read the page and never submit.
    const current = await driver.readRegistrationResult(entry.session);
    if (current.kind !== "form_error" && current.kind !== "unknown") {
      if (current.kind === "captcha_rejected") entry.registerFormReady = false;
      else {
        const artifactIds = await screenshot(ctx, entry, "resumed");
        const result = await registrationOutcome(ctx, host, entry, current, artifactIds);
        return { ...result, outcome: { ...result.outcome, resumed: true } };
      }
    }
  }
  let page: Awaited<ReturnType<BoardDriver["openRegistration"]>> = "unknown";
  if (!genericHost) {
    try {
      page = await driver.openRegistration(entry.session, host.homepageUrl);
    } catch (error) {
      if (!(error instanceof UnmappedFormError)) throw error;
      page = "unmapped";
    }
  }
  if (page !== "form" && page !== "closed") {
    const generic = new GenericFormDriver();
    entry.driver = generic;
    driver = generic;
    page = await generic.openRegistration(entry.session, host.homepageUrl);
  }
  if (page !== "form") {
    const artifactIds = await screenshot(ctx, entry, "register");
    if (page === "closed") {
      return {
        kind: "step",
        lastAction: "Registration is closed",
        hostId: host.id,
        artifactIds,
        apply: (tx) => moveHost(tx, host, "failed", { statusReason: "registration_closed" }),
      };
    }
    return noSignupForm(ctx, host, artifactIds);
  }
  const credentials = await ensureCredentials(ctx, host);
  await driver.fillRegistration(entry.session, credentials);
  entry.registerFormReady = true;
  entry.captchaAttempts = 0;
  const artifactIds = await screenshot(ctx, entry, "register");
  const starting = host.status === "qualified";
  return {
    kind: "step",
    lastAction: "Filled the registration form",
    hostId: host.id,
    artifactIds,
    outcome: { username: credentials.username },
    run: starting ? { counters: recordRegistration(ctx.run.counters) } : undefined,
    apply: starting
      ? (tx) =>
          moveHost(tx, host, "registration_started", {
            registerUrl: driver.registerUrl(host.homepageUrl),
          })
      : undefined,
  };
}

interface CaptchaRecord {
  type: LbCaptchaType;
  door: LbCaptchaDoor;
  outcome: LbCaptchaOutcome;
  credits: number;
  balanceAfter?: number;
  taskId?: string | null;
  buttonTextObserved?: string | null;
  humanCheckboxState?: LbHumanCheckboxState;
  imageGridOpen?: boolean;
  siteKeyFound?: boolean;
  helperVersion?: string | null;
}

/** Pauses the project once and writes a single credits alert. A second caller finds it already paused. */
export async function pauseForLowBalance(
  ctx: StepContext,
  balance: number,
  record: Pick<CaptchaRecord, "type" | "door"> = { type: "unsupported", door: "https_api" },
): Promise<boolean> {
  if (process.env.CAPTELL_API_KEY?.trim()) return false;
  const paused = await ctx.services.prisma.$transaction(async (tx) => {
    const updated = await tx.lbProject.updateMany({
      where: { id: ctx.project.id, workspaceId: ctx.project.workspaceId, status: "active" },
      data: { status: transitionProject("active", "paused") },
    });
    if (updated.count !== 1) return false;
    await tx.lbCaptchaEvent.create({
      data: {
        workspaceId: ctx.project.workspaceId,
        projectId: ctx.project.id,
        runId: ctx.run.id,
        type: record.type,
        door: record.door,
        outcome: "credits",
        attempt: 1,
        creditsCharged: 0,
        balanceAfter: balance,
        createdAt: ctx.now,
      },
    });
    await tx.lbRun.update({
      where: { id: ctx.run.id },
      data: { lastAction: "Paused, Captell balance is low" },
    });
    return true;
  });
  return paused;
}

function captchaEvent(ctx: StepContext, host: HostRow, attempt: number, record: CaptchaRecord) {
  return (tx: Tx) =>
    tx.lbCaptchaEvent.create({
      data: {
        workspaceId: ctx.project.workspaceId,
        projectId: ctx.project.id,
        hostId: host.id,
        runId: ctx.run.id,
        type: record.type,
        door: record.door,
        outcome: record.outcome,
        buttonTextObserved: record.buttonTextObserved ?? null,
        humanCheckboxState: record.humanCheckboxState ?? null,
        imageGridOpen: record.imageGridOpen ?? false,
        siteKeyFound: record.siteKeyFound ?? false,
        attempt,
        creditsCharged: record.credits,
        balanceAfter: record.balanceAfter ?? null,
        taskId: record.taskId ?? null,
        helperVersion: record.helperVersion ?? null,
      },
    });
}

function withEvent(
  result: Extract<StepResult, { kind: "step" }>,
  event: (tx: Tx) => Promise<unknown>,
  credits: number,
): StepResult {
  const apply = result.apply;
  return {
    ...result,
    credits: (result.credits ?? 0) + credits,
    apply: async (tx) => {
      await event(tx);
      await apply?.(tx);
    },
  };
}

function widgetRecord(
  challenge: Extract<CaptchaChallenge, { kind: "widget" }>,
  door: LbCaptchaDoor,
  extra: Partial<CaptchaRecord>,
): CaptchaRecord {
  return {
    type: challenge.type,
    door,
    outcome: extra.outcome ?? "placed_submitted",
    credits: extra.credits ?? 0,
    balanceAfter: extra.balanceAfter,
    taskId: extra.taskId,
    buttonTextObserved: extra.buttonTextObserved,
    humanCheckboxState: extra.humanCheckboxState,
    imageGridOpen: extra.imageGridOpen ?? false,
    siteKeyFound: challenge.siteKey !== null,
    helperVersion: extra.helperVersion,
  };
}

async function captcha(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const entry = requireSession(ctx, host);
  const driver = requireDriver(host, entry);
  const challenge = await enrichCaptchaChallenge(
    entry.session,
    await driver.detectCaptcha(entry.session),
    ctx.services.pageHelperButtonSelector,
  );
  const attempt = entry.captchaAttempts + 1;
  try {
    if (challenge.kind === "image")
      return await imageCaptcha(ctx, host, entry, driver, challenge, attempt);
    if (challenge.kind === "question") {
      return await questionCaptcha(ctx, host, entry, driver, challenge, attempt);
    }
    if (challenge.kind === "widget")
      return await widgetCaptcha(ctx, host, entry, driver, challenge, attempt);
    return finishRegistration(
      ctx,
      host,
      entry,
      driver,
      attempt,
      null,
      await driver.submitRegistration(entry.session),
    );
  } catch (error) {
    if (error instanceof CaptchaSolverError) return solverFailure(ctx, host, entry, attempt, error);
    throw error;
  }
}

async function imageCaptcha(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  driver: BoardDriver,
  challenge: Extract<CaptchaChallenge, { kind: "image" }>,
  attempt: number,
): Promise<StepResult> {
  const solution = await solveImageCaptcha(
    entry.session,
    challenge,
    ctx.services.captcha,
    ctx.adapter,
  );
  if (!solution.ok) {
    const artifactIds = await screenshot(ctx, entry, "captcha");
    entry.registerFormReady = false;
    return withEvent(
      {
        kind: "step",
        lastAction: CAPTCHA_SKIPPED,
        hostId: host.id,
        artifactIds,
        outcome: { captcha: solution.reason },
        apply: skipUnsolvedCaptcha(host),
      },
      captchaEvent(ctx, host, attempt, {
        type: "image_letters",
        door: "https_api",
        outcome: "unsupported",
        credits: 0,
      }),
      0,
    );
  }
  return finishRegistration(
    ctx,
    host,
    entry,
    driver,
    attempt,
    {
      type: "image_letters",
      door: "https_api",
      outcome: "placed_submitted",
      credits: solution.credits,
      balanceAfter: solution.balance,
      taskId: solution.taskId,
    },
    await driver.submitRegistration(entry.session),
  );
}

async function questionCaptcha(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  driver: BoardDriver,
  challenge: Extract<CaptchaChallenge, { kind: "question" }>,
  attempt: number,
): Promise<StepResult> {
  const question = challenge.question.trim();
  const prompt = question || (await entry.session.pageText()).trim().slice(0, 400);
  const skipQuestion = async (): Promise<StepResult> => {
    const artifactIds = await screenshot(ctx, entry, "captcha");
    entry.registerFormReady = false;
    return withEvent(
      {
        kind: "step",
        lastAction: CAPTCHA_SKIPPED,
        hostId: host.id,
        artifactIds,
        outcome: { captcha: "question_unanswered" },
        apply: skipUnsolvedCaptcha(host),
      },
      captchaEvent(ctx, host, attempt, {
        type: "knowledge_question",
        door: "https_api",
        outcome: "unsupported",
        credits: 0,
      }),
      0,
    );
  };
  if (!prompt || isSecretRegistrationPrompt(prompt) || isLoginPath(await entry.session.url())) {
    return skipQuestion();
  }
  const answer = await ctx.services.captcha.answerQuestion(
    question ? { question } : { pageText: prompt },
    ctx.adapter,
  );
  if ("couldNotAnswer" in answer) {
    return skipQuestion();
  }
  if ("instruction" in answer) {
    const selector = instructionClickSelector(answer.instruction);
    if (!selector) return skipQuestion();
    await entry.session.click(selector);
    if (isLoginPath(await entry.session.url())) {
      return skipQuestion();
    }
    return finishRegistration(
      ctx,
      host,
      entry,
      driver,
      attempt,
      {
        type: "knowledge_question",
        door: "https_api",
        outcome: "placed_submitted",
        credits: 0,
      },
      await driver.readRegistrationResult(entry.session, { waitMs: 15_000 }),
    );
  }
  await entry.session.fill(challenge.answerSelector, answer.answer);
  return finishRegistration(
    ctx,
    host,
    entry,
    driver,
    attempt,
    {
      type: "knowledge_question",
      door: "https_api",
      outcome: "placed_submitted",
      credits: 0,
    },
    await driver.submitRegistration(entry.session),
  );
}

async function widgetCaptcha(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  driver: BoardDriver,
  challenge: Extract<CaptchaChallenge, { kind: "widget" }>,
  attempt: number,
): Promise<StepResult> {
  const helperReady = await entry.session.waitFor(ctx.services.pageHelperButtonSelector, {
    timeoutMs: 2_000,
  });
  if (!helperReady) return widgetViaApi(ctx, host, entry, driver, challenge, attempt);
  const run = await runPageHelper(entry.session, {
    buttonSelector: ctx.services.pageHelperButtonSelector,
    submitSelector: driver.registerSubmitSelector,
    pageMessages: (session) => driver.pageMessages(session),
    sleep: ctx.services.sleep,
    now: ctx.services.nowMs ?? Date.now,
    pollMs: ctx.services.pageHelperPollMs,
  });
  const record = widgetRecord(challenge, "page_helper", {
    outcome: run.decision.outcome ?? "placed_submitted",
    buttonTextObserved: run.buttonText,
    humanCheckboxState: run.humanCheckbox,
    imageGridOpen: run.imageGridOpen,
    helperVersion: entry.helperVersion ?? PAGE_HELPER_VERSION,
  });
  if (run.decision.action === "pause_project") {
    const paused = await pauseForLowBalance(ctx, 0, { type: challenge.type, door: "page_helper" });
    if (paused) {
      return {
        kind: "step",
        lastAction: "Paused, Captell balance is low",
        hostId: host.id,
        outcome: { helper: run.decision.action },
      };
    }
  }
  if (run.decision.action !== "submit") {
    const artifactIds = await screenshot(ctx, entry, "captcha");
    entry.registerFormReady = false;
    const event = run.decision.hostEvent;
    const skipping = !event || event === "parked";
    const apply =
      skipping || !event
        ? skipUnsolvedCaptcha(host, { captchaType: challenge.type })
        : (tx: Tx) => moveHost(tx, host, event, { captchaType: challenge.type });
    return withEvent(
      {
        kind: "step",
        hostId: host.id,
        artifactIds,
        outcome: { helper: run.decision.action, reason: run.decision.reason ?? null },
        lastAction: skipping ? CAPTCHA_SKIPPED : "Captcha not supported",
        apply,
      },
      captchaEvent(ctx, host, attempt, skipping ? { ...record, outcome: "unsupported" } : record),
      0,
    );
  }
  return finishRegistration(
    ctx,
    host,
    entry,
    driver,
    attempt,
    record,
    await driver.readRegistrationResult(entry.session, { waitMs: 15_000 }),
  );
}

async function widgetViaApi(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  driver: BoardDriver,
  challenge: Extract<CaptchaChallenge, { kind: "widget" }>,
  attempt: number,
): Promise<StepResult> {
  if (!challenge.siteKey) {
    return finishRegistration(
      ctx,
      host,
      entry,
      driver,
      attempt,
      null,
      await driver.submitRegistration(entry.session),
    );
  }
  const solved = await ctx.services.captcha.solve(
    { type: challenge.type, websiteURL: await entry.session.url(), websiteKey: challenge.siteKey },
    ctx.adapter,
  );
  await placeCaptchaToken(entry.session, challenge.type, solved.answer);
  return finishRegistration(
    ctx,
    host,
    entry,
    driver,
    attempt,
    widgetRecord(challenge, "https_api", {
      outcome: "placed_submitted",
      credits: solved.credits,
      balanceAfter: solved.balance,
      taskId: solved.taskId,
    }),
    await driver.submitRegistration(entry.session),
  );
}

async function solverFailure(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  attempt: number,
  error: CaptchaSolverError,
): Promise<StepResult> {
  const artifactIds = await screenshot(ctx, entry, "captcha");
  if (error.code === "credits") {
    const paused = await pauseForLowBalance(ctx, 0);
    if (paused) {
      return {
        kind: "step",
        lastAction: "Paused, Captell balance is low",
        hostId: host.id,
        artifactIds,
        outcome: { captcha: "credits" },
      };
    }
  }
  const outcome: LbCaptchaOutcome =
    error.code === "sandbox"
      ? "sandbox"
      : error.code === "missing_site_key"
        ? "missing_site_key"
        : error.code === "unsupported"
          ? "unsupported"
          : error.code === "no_token"
            ? "no_token"
            : "unsupported";
  entry.registerFormReady = false;
  const stop = error.code === "missing_site_key" || error.code === "unsupported";
  return withEvent(
    {
      kind: "step",
      lastAction: stop ? "Captcha not supported" : CAPTCHA_SKIPPED,
      hostId: host.id,
      artifactIds,
      outcome: { captcha: error.code },
      apply: stop ? (tx) => moveHost(tx, host, "unsupported_captcha") : skipUnsolvedCaptcha(host),
    },
    captchaEvent(ctx, host, attempt, {
      type: "unsupported",
      door: "https_api",
      outcome,
      credits: 0,
    }),
    0,
  );
}

async function finishRegistration(
  ctx: StepContext,
  host: HostRow,
  entry: PoolEntry,
  driver: BoardDriver,
  attempt: number,
  record: CaptchaRecord | null,
  result: RegistrationResult,
): Promise<StepResult> {
  const artifactIds = await screenshot(ctx, entry, "submitted");
  const event = record ? captchaEvent(ctx, host, attempt, record) : async () => undefined;
  const credits = record?.credits ?? 0;
  if (result.kind === "captcha_rejected") {
    entry.captchaAttempts = attempt;
    // The board re-renders the form; refill it so a retry or the operator only has the captcha left.
    const credentials = await ensureCredentials(ctx, host);
    await driver.fillRegistration(entry.session, credentials);
    if (attempt < MAX_CAPTCHA_ATTEMPTS) {
      return withEvent(
        {
          kind: "step",
          lastAction: "Captcha rejected, trying again",
          hostId: host.id,
          artifactIds,
          outcome: { registration: result.kind, attempt },
        },
        event,
        credits,
      );
    }
    const parkedShot = await screenshot(ctx, entry, "parked");
    entry.registerFormReady = false;
    entry.captchaAttempts = 0;
    return withEvent(
      {
        kind: "step",
        lastAction: CAPTCHA_SKIPPED,
        hostId: host.id,
        artifactIds: [...artifactIds, ...parkedShot],
        outcome: { registration: result.kind, attempt },
        apply: skipUnsolvedCaptcha(host),
      },
      event,
      credits,
    );
  }
  const spam = spamRetryDecision({
    messages: result.kind === "form_error" || result.kind === "unknown" ? result.messages : [],
    sentences: ctx.project.spamSentences,
    retriesUsed: entry.spamRetries,
    maxRetries: ctx.project.spamMaxRetries,
  });
  if (spam === "retry") {
    entry.spamRetries += 1;
    entry.registerFormReady = false;
    entry.captchaAttempts = 0;
    const credentials = await ensureCredentials(ctx, host);
    await driver.fillRegistration(entry.session, credentials);
    return withEvent(
      {
        kind: "step",
        lastAction: "Spam filter, trying once more",
        hostId: host.id,
        artifactIds,
        outcome: { registration: "spam_retry" },
      },
      event,
      credits,
    );
  }
  if (spam === "block") {
    entry.registerFormReady = false;
    return withEvent(
      {
        kind: "step",
        lastAction: "Board blocked this account as spam",
        hostId: host.id,
        artifactIds,
        outcome: { registration: "spam_blocked" },
        apply: (tx) => moveHost(tx, host, "spam_blocked"),
        afterCommit: () => {
          entry.captchaAttempts = 0;
        },
      },
      event,
      credits,
    );
  }
  if (splitFormContinues(result)) {
    const used = entry.splitSteps ?? 0;
    if (used < 3) {
      entry.splitSteps = used + 1;
      const credentials = await ensureCredentials(ctx, host);
      await driver.fillRegistration(entry.session, credentials);
      entry.registerFormReady = true;
      entry.captchaAttempts = 0;
      return withEvent(
        {
          kind: "step",
          lastAction: "Filled the next registration step",
          hostId: host.id,
          artifactIds,
          outcome: { registration: "next_step" },
        },
        event,
        credits,
      );
    }
  }
  if (
    result.kind === "form_error" &&
    formErrorFixable(result.messages) &&
    !entry.registrationRetried
  ) {
    entry.registrationRetried = true;
    entry.registerFormReady = false;
    entry.captchaAttempts = 0;
    if (usernameTaken(result.messages)) await rotateUsername(ctx, host);
    return withEvent(
      {
        kind: "step",
        lastAction: "Correcting the registration form",
        hostId: host.id,
        artifactIds,
        outcome: {
          registration: "form_error",
          retry: true,
          messages: redactAll(ctx, result.messages),
        },
      },
      event,
      credits,
    );
  }
  return withEvent(
    await registrationOutcome(ctx, host, entry, result, artifactIds),
    event,
    credits,
  );
}

async function unmappedForm(
  ctx: StepContext,
  host: HostRow,
): Promise<Extract<StepResult, { kind: "step" }>> {
  const plan = await desktopSkipPlan(ctx, host, "unmapped_form");
  return {
    kind: "step",
    hostId: host.id,
    outcome: { reason: "unmapped_form" },
    ...plan,
  };
}

async function rotateUsername(ctx: StepContext, host: HostRow): Promise<void> {
  const { prisma, secrets } = ctx.services;
  const account = await prisma.lbHostAccount.findUnique({ where: { hostId: host.id } });
  if (!account?.siteLoginId) return;
  const password = await loadPassword(ctx, account.siteLoginId);
  const username = await freshUsername(ctx, host);
  const stored = await upsertSiteLogin(
    { prisma, secrets },
    {
      workspaceId: ctx.project.workspaceId,
      userId: ctx.project.ownerUserId,
      botId: LINK_BUILDER_LOGIN_BOT,
      site: host.homepageUrl,
      username,
      password,
      from: "bot",
    },
  );
  if ("error" in stored) return;
  await prisma.lbHostAccount.update({
    where: { id: account.id },
    data: { username, siteLoginId: stored.login.id },
  });
}

async function adminCheck(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const entry = requireSession(ctx, host);
  const driver = requireDriver(host, entry);
  const activation = await driver.activationResult(entry.session);
  const site = host.registrableDomain;
  if (activation === "active") {
    return {
      kind: "step",
      lastAction: `Site admin approved the registration at ${site}`,
      hostId: host.id,
      outcome: { activation, waiting: "registration" },
      apply: (tx) => moveHost(tx, host, "account_active"),
    };
  }
  return {
    kind: "step",
    lastAction: `Checked ${site}. Still waiting for the site admin to approve the registration`,
    hostId: host.id,
    outcome: { activation, waiting: "registration" },
  };
}

async function emailVerify(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const entry = requireSession(ctx, host);
  const driver = requireDriver(host, entry);
  const { mailbox } = ctx.services;
  if (!ctx.project.mailboxId || !mailbox.listMessages) {
    return {
      kind: "step",
      hostId: host.id,
      lastAction: MAIL_SKIP_STATUS,
      apply: (tx) => moveHost(tx, host, "failed", { statusReason: "mail_send_failed" }),
    };
  }
  const account = ctx.account;
  if (!account) throw new StepFailure("Host has no account");
  const since = { since: new Date(account.createdAt.getTime() - 5 * 60_000) };
  const priorSignups = await ctx.services.prisma.lbHostAccount.count({
    where: { projectId: ctx.project.id },
  });
  const inboxIds = mailboxAddressesToRead({
    seed: ctx.project.id,
    domain: process.env.RESEND_INBOUND_DOMAIN,
    priorSignups,
    storedIds: [ctx.project.mailboxId, ctx.project.mailboxAddress],
  });
  const readInbox = async () => {
    const mails = [];
    for (const inboxId of inboxIds) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const batch = await mailbox.listMessages?.(inboxId, since, ctx.adapter);
          if (batch) mails.push(...batch);
          break;
        } catch {
          if (attempt === 1) break;
        }
      }
    }
    return mails;
  };
  const linkFrom = (mails: Awaited<ReturnType<typeof readInbox>>) => {
    let found: string | null = null;
    for (const mail of [...(mails ?? [])].reverse()) {
      found = extractVerificationLink(mail, host.homepageUrl);
      if (found) break;
    }
    return found;
  };
  let link = linkFrom(await readInbox());
  if (!link && ctx.services.sleep) {
    await ctx.services.sleep(1_000);
    link = linkFrom(await readInbox());
  }
  if (!link) {
    const resent = await clickResendMail(entry.session);
    if (resent) await new Promise((resolve) => setTimeout(resolve, 1500));
    link = linkFrom(await readInbox());
  }
  if (!link) {
    const waited = ctx.now.getTime() - account.createdAt.getTime();
    if (waited >= MAIL_WAIT_MS) {
      const domain = (process.env.RESEND_INBOUND_DOMAIN ?? "")
        .trim()
        .toLowerCase()
        .replace(/^@/, "");
      return {
        kind: "step",
        hostId: host.id,
        lastAction: domain ? `No confirmation mail on ${domain}` : "No confirmation mail",
        outcome: { mail: "not_in_inbox", paused: true },
        run: { status: transitionRun(ctx.run.status, "paused") },
        apply: async (tx) => {
          await tx.lbProject.updateMany({
            where: { id: ctx.project.id, workspaceId: ctx.project.workspaceId, status: "active" },
            data: { status: transitionProject("active", "paused") },
          });
        },
      };
    }
    return {
      kind: "step",
      hostId: host.id,
      lastAction: "Confirmation not in inbox",
      outcome: { mail: "not_in_inbox" },
    };
  }
  await entry.session.releaseForm?.();
  await entry.session.goto(link);
  const activation = await driver.activationResult(entry.session);
  const artifactIds = await screenshot(ctx, entry, "activated");
  const verifiedAt = ctx.now;
  if (activation === "unknown") {
    const plan = await desktopSkipPlan(ctx, host, "unknown_page_state");
    return {
      kind: "step",
      hostId: host.id,
      artifactIds,
      outcome: { activation },
      ...plan,
    };
  }
  const verified = activation === "active";
  return {
    kind: "step",
    lastAction: verified ? "Email verified" : "Email verified, waiting for the admin",
    hostId: host.id,
    artifactIds,
    outcome: { activation },
    apply: async (tx) => {
      await tx.lbHostAccount.update({
        where: { id: account.id },
        data: { emailVerifiedAt: verifiedAt },
      });
      await moveHost(tx, host, verified ? "account_active" : "admin_pending");
    },
  };
}

async function warmup(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  return {
    kind: "step",
    lastAction: "Account warmed up",
    hostId: host.id,
    outcome: { postCount: ctx.account?.postCount ?? 0 },
    apply: (tx) => moveHost(tx, host, "warmup_completed"),
  };
}

const REPLY_TEMPLATES: Record<string, (brand: string) => string> = {
  de: (brand) =>
    `Wir standen letztes Jahr vor derselben Frage. Eine gemeinsame Online-Liste, die alle im Vorstand bearbeiten können, hat uns viel Hin und Her erspart. Bei ${brand} ist das ganz gut beschrieben: [REF]`,
  en: (brand) =>
    `We had the same question last season. A shared online list that everyone on the committee can edit saved us a lot of back and forth. ${brand} describes the setup quite well: [REF]`,
};

/** M2 draft: a fixed template per language. The model-written draft arrives with the drafter lane. */
export function templateReply(input: {
  brandName: string;
  language: string;
  targetUrl: string;
  register: LbPersona["register"];
  format: BoardDriver["bodyFormat"];
}): string {
  const primary = input.language.split("-")[0] ?? "en";
  const template = REPLY_TEMPLATES[primary] ?? REPLY_TEMPLATES.en!;
  return insertReference(template(input.brandName), {
    targetUrl: input.targetUrl,
    anchorText: input.brandName,
    slot: "inline",
    format: input.format,
    language: input.language as LbLanguage,
    register: input.register,
  });
}

async function threadsForReply(
  driver: BoardDriver,
  session: Parameters<BoardDriver["listThreads"]>[0],
  homepageUrl: string,
  project: ProjectConfig,
  skip: Set<string>,
): Promise<{
  threads: Awaited<ReturnType<BoardDriver["listThreads"]>>;
  searched: boolean;
}> {
  if (driver.searchThreads) {
    for (const query of boardTopicQueriesFromProject(project)) {
      let found: Awaited<ReturnType<BoardDriver["listThreads"]>> = [];
      try {
        found = await driver.searchThreads(session, homepageUrl, query);
      } catch (error) {
        if (error instanceof UnmappedFormError) throw error;
        found = [];
      }
      const fresh = found.filter(
        (thread) => !skip.has(thread.url) && !isMailSendFailure(thread.title),
      );
      if (fresh.length > 0) return { threads: fresh, searched: true };
    }
  }
  const listed = (await driver.listThreads(session, homepageUrl)).filter(
    (thread) => !skip.has(thread.url) && !isMailSendFailure(thread.title),
  );
  return { threads: listed, searched: false };
}

const PAGE_ANCHOR_SELECTORS = [
  "a[href*='thread-']",
  "a[href*='thread']",
  "a[href*='viewtopic']",
  "a[href*='showthread']",
  "a[href*='forum-']",
  "a[href*='board']",
  "a[href*='viewforum']",
  "a[href*='forum']",
  "a",
];
const FIRST_ANCHOR_SELECTORS = ["a[href*='thread-']", "a[href*='forum-']", "a[href*='viewtopic']"];

async function noteAction(ctx: StepContext, lastAction: string): Promise<void> {
  await ctx.services.prisma.lbRun
    .updateMany({ where: { id: ctx.run.id }, data: { lastAction } })
    .catch(() => undefined);
}

async function collectPageAnchors(
  session: BrowserSession,
): Promise<Array<{ text: string; href: string }>> {
  const found: Array<{ text: string; href: string }> = [];
  if (session.listAnchors) {
    for (const selector of PAGE_ANCHOR_SELECTORS) {
      try {
        found.push(...(await session.listAnchors(selector)));
      } catch {
        // The open runner may not know this read yet.
      }
    }
  }
  if (
    !found.some((link) => /thread-\d+|forum-\d+|viewtopic|viewforum|showthread/i.test(link.href))
  ) {
    if (session.clickables) {
      try {
        for (const control of await session.clickables()) {
          if (control.href) found.push({ text: control.text, href: control.href });
        }
      } catch {
        // An older runner may not list clickable links.
      }
    }
    const one = await firstAnchor(session);
    if (one) found.push(one);
  }
  return found;
}

async function firstAnchor(
  session: BrowserSession,
): Promise<{ text: string; href: string } | null> {
  for (const selector of FIRST_ANCHOR_SELECTORS) {
    try {
      if (!(await session.exists(selector))) continue;
      const href = await session.attribute(selector, "href");
      if (!href) continue;
      return { text: (await session.text(selector)) ?? "", href };
    } catch {
      // Keep looking with the next selector.
    }
  }
  return null;
}

function topicWords(project: ProjectConfig): string[] {
  const raw = [
    project.name,
    project.brandName,
    ...project.topicLanes.flatMap((lane) => [lane.tag, lane.description, ...lane.exampleQuestions]),
  ].join(" ");
  return [
    ...new Set(
      raw
        .toLowerCase()
        .split(/[^a-z0-9äöüß]+/)
        .filter((word) => word.length > 3),
    ),
  ];
}

async function askPageMove(ctx: StepContext, links: PageLink[]): Promise<PageLink | null> {
  const model = ctx.services.textModel;
  if (!model || links.length === 0) return null;
  const request = {
    lane: "classify" as const,
    modelId: PAGE_LOOK_MODEL,
    system: PAGE_LOOK_SYSTEM,
    user: pageLookPrompt(links),
    maxTokens: 180,
    schema: {
      safeParse(value: unknown) {
        if (!value || typeof value !== "object") return { success: false as const };
        const row = value as { action?: unknown; index?: unknown };
        const action = row.action === "open" || row.action === "skip" ? row.action : null;
        if (!action) return { success: false as const };
        const index =
          typeof row.index === "number" && Number.isInteger(row.index) ? row.index : undefined;
        return { success: true as const, data: { action, index } };
      },
    },
  };
  try {
    const result = await Promise.race([
      model.complete(request as never, ctx.adapter),
      new Promise<{ ok: false }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), PAGE_LOOK_WAIT_MS);
      }),
    ]);
    if (!result.ok || !("value" in result) || !result.value) return null;
    const value = result.value as { action?: string; index?: number };
    return chosenLink(links, value.action ?? "", value.index);
  } catch {
    return null;
  }
}

async function recoverOpenThreads(
  ctx: StepContext,
  entry: PoolEntry,
  driver: BoardDriver,
  host: HostRow,
  skip: Set<string>,
): Promise<BoardThread[]> {
  await noteAction(ctx, `Looking for a thread on ${host.registrableDomain}`);
  const pageUrl = await entry.session.url().catch(() => host.homepageUrl);
  const links = usablePageLinks(
    await collectPageAnchors(entry.session),
    pageUrl,
    host.registrableDomain,
  );
  const direct = threadsFromLinks(links).filter((thread) => !skip.has(thread.url));
  if (direct.length > 0) return direct;
  const picked = boardLink(links, topicWords(ctx.project)) ?? (await askPageMove(ctx, links));
  if (!picked) return [];
  await noteAction(ctx, `Reading a board on ${host.registrableDomain}`);
  try {
    await entry.session.goto(picked.url);
  } catch {
    return [];
  }
  const nextUrl = await entry.session.url().catch(() => picked.url);
  const nextLinks = usablePageLinks(
    await collectPageAnchors(entry.session),
    nextUrl,
    host.registrableDomain,
  );
  const fromLinks = threadsFromLinks(nextLinks).filter((thread) => !skip.has(thread.url));
  if (fromLinks.length > 0) return fromLinks;
  try {
    const listed = await driver.listThreads(entry.session, host.homepageUrl);
    return listed.filter((thread) => !skip.has(thread.url));
  } catch (error) {
    if (error instanceof UnmappedFormError) throw error;
    return [];
  }
}

async function publish(ctx: StepContext, warmup: boolean): Promise<StepResult> {
  const host = requireHost(ctx);
  if (
    host.status === "pending_email" ||
    host.status === "registering" ||
    host.status === "qualified"
  ) {
    return {
      kind: "step",
      hostId: host.id,
      lastAction: "Waiting for the confirmation",
      outcome: { refused: "pending_email" },
    };
  }
  const account = ctx.account;
  if (!account) throw new StepFailure("Host has no account");
  const timeZone = ctx.project.schedule?.timezone || "Europe/Berlin";
  const postedToday = account.lastPostAt
    ? sameLocalDay(account.lastPostAt, ctx.now, timeZone)
    : false;
  if (!warmup && (sameLocalDay(account.createdAt, ctx.now, timeZone) || postedToday)) {
    return {
      kind: "step",
      hostId: host.id,
      lastAction: "Link waits for a later day",
      outcome: { refused: "link_day" },
    };
  }
  const entry = requireSession(ctx, host);
  const driver = requireDriver(host, entry);
  const { prisma } = ctx.services;
  if (!account.siteLoginId) {
    const plan = await desktopSkipPlan(ctx, host, "missing_password");
    return {
      kind: "step",
      hostId: host.id,
      ...plan,
    };
  }
  const password = await loadPassword(ctx, account.siteLoginId);
  let loggedIn = false;
  try {
    loggedIn = await driver.login(entry.session, host.homepageUrl, {
      username: account.username,
      password,
    });
  } catch (error) {
    if (error instanceof UnmappedFormError) return unmappedForm(ctx, host);
    throw error;
  }
  if (!loggedIn) {
    const plan = await desktopSkipPlan(ctx, host, "unknown_page_state");
    return {
      kind: "step",
      hostId: host.id,
      artifactIds: await screenshot(ctx, entry, "login"),
      outcome: { login: false },
      ...plan,
    };
  }
  if (!entry.profileSet) {
    const pastWarmup = isWarmupMet({
      postCount: account.postCount,
      accountCreatedAt: account.createdAt,
      now: ctx.now,
      minPostsBeforeLink: postsRequiredBeforeLink(
        ctx.project.warmup.minPostsBeforeLink,
        host.platform,
      ),
      minAccountAgeHours: ctx.project.warmup.minAccountAgeHours,
    });
    const target = ctx.project.targets[0]?.url ?? null;
    const includeSignature = host.signatureLinks && pastWarmup && target !== null;
    try {
      await driver.setProfile(entry.session, host.homepageUrl, {
        bio: ctx.project.persona.bio.trim() || ctx.project.persona.displayName,
        signature: includeSignature ? target : null,
        includeSignature,
      });
    } catch (error) {
      if (error instanceof UnmappedFormError) return unmappedForm(ctx, host);
      throw error;
    }
    entry.profileSet = true;
  }
  const known = await prisma.lbThreadCandidate.findMany({
    where: { hostId: host.id, status: { in: ["posted", "rejected"] } },
    select: { url: true },
  });
  const skip = new Set(known.map((thread) => thread.url));
  const found = await threadsForReply(driver, entry.session, host.homepageUrl, ctx.project, skip);
  let threads = found.threads;
  if (threads.length === 0) {
    threads = await recoverOpenThreads(ctx, entry, driver, host, skip);
  }
  if (threads.length === 0) {
    return {
      kind: "step",
      lastAction: "No thread here, moving on",
      hostId: host.id,
      outcome: { rejected: [] },
      apply: (tx) => moveHost(tx, host, "failed", { statusReason: "no_thread_after_look" }),
    };
  }
  const selectionBudget = found.searched ? 4 : 1;
  const model = ctx.services.textModel;
  let chosen: {
    thread: (typeof threads)[number];
    body: string;
    linkSlot: LbLinkSlot;
    targetUrl: string | null;
    anchorText: string | null;
    modelLane: string;
    modelId: string;
    confidence: number | null;
    qualityChecks: Prisma.InputJsonValue;
    tokens: number;
    relevance: number;
    openQuestion: boolean;
    queueOnly: boolean;
    refusal: boolean;
  } | null = null;
  let rule = driver.probeLinkRule("");
  const rejections: Array<{ url: string; title: string; reason: string; relevance: number }> = [];
  let drafted = 0;
  for (const thread of threads) {
    const approved = warmup
      ? null
      : await prisma.lbDraft.findFirst({
          where: {
            projectId: ctx.project.id,
            status: "approved",
            threadCandidate: { hostId: host.id, url: thread.url },
          },
        });
    let opened = false;
    let discussion = "";
    try {
      await entry.session.goto(thread.url);
      const firstPost = await entry.session.text("div.postbody div.content").catch(() => null);
      discussion = firstPost || (await entry.session.pageText().catch(() => ""));
      opened = await driver.openReply(entry.session, thread);
    } catch (error) {
      if (error instanceof UnmappedFormError) return unmappedForm(ctx, host);
      rejections.push({
        url: thread.url,
        title: thread.title,
        reason: "replies_closed",
        relevance: 0,
      });
      continue;
    }
    if (!opened && (await entry.session.exists("form#login").catch(() => false))) {
      try {
        const again = await driver.login(entry.session, host.homepageUrl, {
          username: account.username,
          password,
        });
        if (again) opened = await driver.openReply(entry.session, thread);
      } catch (error) {
        if (error instanceof UnmappedFormError) return unmappedForm(ctx, host);
      }
    }
    if (!opened) {
      rejections.push({
        url: thread.url,
        title: thread.title,
        reason: "replies_closed",
        relevance: 0,
      });
      continue;
    }
    if (warmup) {
      const reply = warmupReplyChoice(host.language || marketOf(ctx.project, host).language);
      chosen = {
        thread,
        body: reply.body,
        linkSlot: reply.linkSlot,
        targetUrl: reply.targetUrl,
        anchorText: reply.anchorText,
        modelLane: "draft",
        modelId: "warmup-fixed",
        confidence: null,
        qualityChecks: {},
        tokens: 0,
        relevance: 0,
        openQuestion: true,
        queueOnly: false,
        refusal: false,
      };
      break;
    }
    if (!model) throw new StepFailure("Draft model is not configured");
    const editorText = await entry.session.pageText().catch(() => "");
    const pageText = [discussion, editorText].filter(Boolean).join("\n");
    rule = driver.probePageLinkRule
      ? await driver.probePageLinkRule(entry.session)
      : driver.probeLinkRule(pageText);
    if (approved) {
      chosen = {
        thread,
        body: approved.body,
        linkSlot: approved.linkSlot as LbLinkSlot,
        targetUrl: approved.targetUrl,
        anchorText: approved.anchorText,
        modelLane: approved.modelLane,
        modelId: approved.modelId,
        confidence: approved.confidence,
        qualityChecks: approved.qualityChecks as Prisma.InputJsonValue,
        tokens: 0,
        relevance: 1,
        openQuestion: true,
        queueOnly: false,
        refusal: false,
      };
      break;
    }
    const composed = await composeReply({
      model,
      adapter: ctx.adapter,
      project: ctx.project,
      thread: {
        title: thread.title,
        excerpt: (discussion || pageText).replace(/\s+/g, " ").trim().slice(0, 700),
        pageText,
        lastActivityAt: thread.lastActivityAt ?? null,
        citeSource: !warmup,
        signatureLinks: host.signatureLinks,
        allowEmoji: driver.allowEmoji === true,
        bodyFormat: driver.bodyFormat,
        hostCountry: host.country,
        hostLanguage: host.language,
        postsOnHost: account.postCount,
        linkPostsOnHost: account.linkPostCount,
        now: ctx.now,
      },
    });
    const relevance = composed.draft.relevance?.relevance ?? 0;
    const openQuestion = composed.draft.relevance?.openQuestion ?? false;
    if (composed.draft.action === "refused") {
      rejections.push({
        url: thread.url,
        title: thread.title,
        reason: "model_refusal",
        relevance,
      });
      chosen = {
        thread,
        body: composed.draft.body,
        linkSlot: "none",
        targetUrl: null,
        anchorText: null,
        modelLane: composed.draft.modelLane,
        modelId: composed.draft.modelId,
        confidence: composed.draft.confidence,
        qualityChecks: composed.draft.qualityChecks as unknown as Prisma.InputJsonValue,
        tokens: composed.draft.tokens,
        relevance,
        openQuestion,
        queueOnly: false,
        refusal: true,
      };
      break;
    }
    drafted += 1;
    if (!composed.selection.selected) {
      rejections.push({
        url: thread.url,
        title: thread.title,
        reason: composed.selection.rejectReason ?? "rejected",
        relevance,
      });
      if (drafted >= selectionBudget) break;
      continue;
    }
    const queueOnly =
      composed.draft.action === "queue" ||
      (composed.draft.action === "post" && ctx.project.disclosureMode === "drafts_only");
    if (composed.draft.action === "discard") {
      rejections.push({ url: thread.url, title: thread.title, reason: "discarded", relevance });
      chosen = {
        thread,
        body: composed.draft.body,
        linkSlot: composed.draft.linkSlot,
        targetUrl: composed.draft.targetUrl,
        anchorText: composed.draft.anchorText,
        modelLane: composed.draft.modelLane,
        modelId: composed.draft.modelId,
        confidence: composed.draft.confidence,
        qualityChecks: composed.draft.qualityChecks as unknown as Prisma.InputJsonValue,
        tokens: composed.draft.tokens,
        relevance,
        openQuestion,
        queueOnly: false,
        refusal: false,
      };
      chosen = { ...chosen, queueOnly: false };
      // Keep the discarded draft and stop. A later thread can be tried next tick.
      break;
    }
    chosen = {
      thread,
      body: composed.draft.body,
      linkSlot: warmup ? "none" : composed.draft.linkSlot,
      targetUrl: warmup ? null : composed.draft.targetUrl,
      anchorText: warmup ? null : composed.draft.anchorText,
      modelLane: composed.draft.modelLane,
      modelId: composed.draft.modelId,
      confidence: composed.draft.confidence,
      qualityChecks: composed.draft.qualityChecks as unknown as Prisma.InputJsonValue,
      tokens: composed.draft.tokens,
      relevance,
      openQuestion,
      queueOnly,
      refusal: false,
    };
    break;
  }
  const upsertRejected = async (tx: Tx) => {
    for (const rejection of rejections) {
      if (chosen && rejection.url === chosen.thread.url && !chosen.refusal) continue;
      if (isMailSendFailure(rejection.title)) continue;
      await tx.lbThreadCandidate.upsert({
        where: { hostId_url: { hostId: host.id, url: rejection.url } },
        create: {
          workspaceId: ctx.project.workspaceId,
          projectId: ctx.project.id,
          hostId: host.id,
          url: rejection.url,
          title: rejection.title,
          relevance: rejection.relevance,
          openQuestion: false,
          status: "rejected",
          rejectReason: rejection.reason,
        },
        update: {
          status: "rejected",
          rejectReason: rejection.reason,
          relevance: rejection.relevance,
        },
      });
    }
  };
  if (!chosen) {
    return {
      kind: "step",
      lastAction: threads.length === 0 ? "No thread here, moving on" : "No thread passed selection",
      hostId: host.id,
      outcome: { rejected: rejections.map((rejection) => rejection.reason) },
      apply: async (tx) => {
        await upsertRejected(tx);
        if (threads.length === 0)
          await moveHost(tx, host, "failed", { statusReason: "no_thread_after_look" });
      },
    };
  }
  const thread = chosen.thread;
  const body = chosen.body;
  const base = {
    workspaceId: ctx.project.workspaceId,
    projectId: ctx.project.id,
    hostId: host.id,
    url: thread.url,
  };
  const upsertThread = (tx: Tx, status: string, rejectReason?: string) =>
    tx.lbThreadCandidate.upsert({
      where: { hostId_url: { hostId: host.id, url: thread.url } },
      create: {
        ...base,
        title: thread.title,
        replyCount: thread.replyCount ?? 0,
        openQuestion: chosen.openQuestion,
        relevance: chosen.relevance,
        laneId: ctx.project.topicLanes[0]?.id,
        status,
        rejectReason,
      },
      update: {
        status,
        rejectReason,
        relevance: chosen.relevance,
        openQuestion: chosen.openQuestion,
      },
    });
  if (chosen.refusal) {
    return {
      kind: "step",
      lastAction: "Model refused the draft",
      hostId: host.id,
      outcome: { thread: thread.url, modelRefusal: true, modelId: chosen.modelId },
      tokens: chosen.tokens,
      apply: async (tx) => {
        const run = await tx.lbRun.findUnique({
          where: { id: ctx.run.id },
          select: { whyNot: true },
        });
        await tx.lbRun.update({
          where: { id: ctx.run.id },
          data: { whyNot: bumpModelRefusal(run?.whyNot) },
        });
        await upsertRejected(tx);
      },
    };
  }
  const discarded = rejections.some(
    (rejection) => rejection.url === thread.url && rejection.reason === "discarded",
  );
  if (discarded) {
    return {
      kind: "step",
      lastAction: "Draft discarded",
      hostId: host.id,
      outcome: { thread: thread.url, issues: chosen.qualityChecks },
      apply: async (tx) => {
        const candidate = await upsertThread(tx, "rejected", "discarded");
        await tx.lbDraft.create({
          data: {
            workspaceId: ctx.project.workspaceId,
            projectId: ctx.project.id,
            threadCandidateId: candidate.id,
            modelLane: chosen.modelLane,
            modelId: chosen.modelId,
            body: chosen.body,
            linkSlot: chosen.linkSlot,
            targetUrl: chosen.targetUrl,
            anchorText: chosen.anchorText,
            confidence: chosen.confidence,
            status: "discarded",
            qualityChecks: chosen.qualityChecks,
          },
        });
      },
    };
  }
  if (chosen.queueOnly) {
    return {
      kind: "step",
      lastAction: "Draft waiting for approval",
      hostId: host.id,
      outcome: { thread: thread.url, modelId: chosen.modelId },
      tokens: chosen.tokens,
      apply: async (tx) => {
        const candidate = await upsertThread(tx, "candidate");
        await tx.lbDraft.create({
          data: {
            workspaceId: ctx.project.workspaceId,
            projectId: ctx.project.id,
            threadCandidateId: candidate.id,
            modelLane: chosen.modelLane,
            modelId: chosen.modelId,
            body: chosen.body,
            linkSlot: chosen.linkSlot,
            targetUrl: chosen.targetUrl,
            anchorText: chosen.anchorText,
            confidence: chosen.confidence,
            status: "drafted",
            qualityChecks: chosen.qualityChecks,
          },
        });
      },
    };
  }
  await driver.fillReply(entry.session, body);
  const challenge = await driver.detectCaptcha(entry.session);
  if (challenge.kind === "widget") {
    const solved = await ctx.services.captcha.solve(
      {
        type: challenge.type,
        websiteURL: await entry.session.url(),
        websiteKey: challenge.siteKey,
      },
      ctx.adapter,
    );
    await placeCaptchaToken(entry.session, challenge.type, solved.answer);
  }
  const reply = await driver.submitReply(entry.session);
  const artifactIds = await screenshot(ctx, entry, reply.kind === "posted" ? "posted" : "reply");
  const ruleData = {
    hrefForNewMembers: rule.hrefForNewMembers,
    minPostsForLinks: rule.minPosts,
    ...(rule.relDefault !== "unknown" ? { relDefault: rule.relDefault } : {}),
  };
  if (reply.kind === "rejected") {
    return {
      kind: "step",
      lastAction: "The board rejected the reply",
      hostId: host.id,
      artifactIds,
      outcome: { thread: thread.url, messages: redactAll(ctx, reply.messages) },
      apply: async (tx) => {
        await tx.lbHost.update({ where: { id: host.id }, data: ruleData });
        await upsertThread(tx, "rejected", redactAll(ctx, reply.messages).join(" ").slice(0, 300));
      },
    };
  }
  if (reply.kind === "unknown") {
    const plan = await desktopSkipPlan(ctx, host, "unknown_page_state");
    return {
      kind: "step",
      hostId: host.id,
      artifactIds,
      outcome: { thread: thread.url, messages: redactAll(ctx, reply.messages) },
      ...plan,
    };
  }
  const postedAt = ctx.now;
  await entry.session.goto(reply.permalink);
  const threadShot = await screenshot(ctx, entry, "thread");
  return {
    kind: "step",
    lastAction: "Posted the reply",
    hostId: host.id,
    artifactIds: [...artifactIds, ...threadShot],
    outcome: { thread: thread.url, permalink: reply.permalink },
    run: { currentUrl: reply.permalink },
    apply: async (tx) => {
      await tx.lbHost.update({ where: { id: host.id }, data: ruleData });
      const candidate = await upsertThread(tx, "posted");
      const linked = chosen.linkSlot !== "none" && chosen.targetUrl && chosen.anchorText;
      const draft = await tx.lbDraft.create({
        data: {
          workspaceId: ctx.project.workspaceId,
          projectId: ctx.project.id,
          threadCandidateId: candidate.id,
          modelLane: chosen.modelLane,
          modelId: chosen.modelId,
          body,
          linkSlot: chosen.linkSlot,
          targetUrl: chosen.targetUrl,
          anchorText: chosen.anchorText,
          confidence: chosen.confidence,
          status: "posted",
          qualityChecks: chosen.qualityChecks,
        },
      });
      if (linked && chosen.targetUrl && chosen.anchorText) {
        await tx.lbPlacement.create({
          data: {
            workspaceId: ctx.project.workspaceId,
            projectId: ctx.project.id,
            hostId: host.id,
            hostAccountId: account.id,
            draftId: draft.id,
            threadUrl: thread.url,
            postUrl: reply.permalink,
            targetUrl: chosen.targetUrl,
            anchorText: chosen.anchorText,
            status: "pending",
            counted: false,
            nextVerifyAt: new Date(postedAt.getTime() + ctx.services.verifyDelayMs),
            verifyCount: 0,
          },
        });
      }
      await tx.lbHostAccount.update({
        where: { id: account.id },
        data: {
          postCount: { increment: 1 },
          ...(linked ? { linkPostCount: { increment: 1 } } : {}),
          firstPostAt: account.firstPostAt ?? postedAt,
          lastPostAt: postedAt,
        },
      });
    },
  };
}

async function verify(ctx: StepContext): Promise<StepResult> {
  const host = requireHost(ctx);
  const placement = ctx.placement;
  if (placement?.status !== "pending") throw new StepFailure("Nothing to verify");
  if (placement.nextVerifyAt && placement.nextVerifyAt > ctx.now) {
    return { kind: "wait", reason: "verify_delay" };
  }
  // A plain logged-out fetch from the worker, never the persona browser or its exit IP.
  const checked = await verifyPlacement({
    postUrl: placement.postUrl,
    targetUrl: placement.targetUrl,
    fetchImpl: ctx.services.verifyFetch,
    allowPrivateNetwork: ctx.services.allowPrivateVerify,
  });
  const hold = checked.outcome.status === "dead" ? adminHoldOnVerify(checked.html) : null;
  if (hold) {
    const site = host.registrableDomain;
    return {
      kind: "step",
      lastAction:
        hold === "post"
          ? `Waiting for the site admin to approve the post at ${site}`
          : `Waiting for the site admin to approve the registration at ${site}`,
      hostId: host.id,
      outcome: { waiting: hold, httpStatus: checked.httpStatus },
      apply: async (tx) => {
        await tx.lbPlacement.update({
          where: { id: placement.id },
          data: {
            nextVerifyAt: new Date(ctx.now.getTime() + ctx.services.verifyDelayMs),
            verifyCount: placement.verifyCount + 1,
          },
        });
      },
    };
  }
  const snapshotId = await ctx.storeArtifact(
    `verify-${placement.id}.html`,
    "text/html",
    new TextEncoder().encode(checked.html),
  );
  const status: LbPlacementStatus = transitionPlacement(
    placement.status as LbPlacementStatus,
    checked.outcome.status,
  );
  // The partial unique index still rejects a second counted link if another step races this one.
  const wantCounted =
    shouldCount(checked.outcome, ctx.project.countNofollow) &&
    (await ctx.services.prisma.lbPlacement.count({ where: { hostId: host.id, counted: true } })) ===
      0;
  const counted = countedWithinPlan({
    wantCounted,
    countedToday: ctx.run.counters.liveToday,
    livePerDay: ctx.services.planCaps.live_per_day,
  });
  return {
    kind: "step",
    lastAction:
      status === "live"
        ? "Link is LIVE"
        : status === "nofollow_live"
          ? "Link is LIVE (nofollow)"
          : status === "removed"
            ? "Link was removed"
            : "Post is gone",
    hostId: host.id,
    artifactIds: [snapshotId],
    outcome: {
      status,
      rel: checked.outcome.rel,
      indexable: checked.outcome.indexable,
      httpStatus: checked.httpStatus,
    },
    run: counted ? { counters: recordCountedLive(ctx.run.counters) } : undefined,
    apply: async (tx) => {
      await tx.lbPlacement.update({
        where: { id: placement.id },
        data: {
          status,
          rel: checked.outcome.rel,
          indexable: checked.outcome.indexable,
          verifiedAt: ctx.now,
          verifyMethod: "logged_out_fetch",
          snapshotArtifactId: snapshotId,
          nextVerifyAt: verifyDeadline(placement.createdAt, placement.verifyCount + 1),
          verifyCount: placement.verifyCount + 1,
          counted,
        },
      });
      if (counted) await moveHost(tx, host, "link_counted");
    },
  };
}

async function close(ctx: StepContext): Promise<StepResult> {
  const status = closingRunStatus(ctx.run.counters, ctx.project.quotas);
  return {
    kind: "step",
    lastAction: status === "succeeded" ? "Daily goal met" : "Day closed",
    hostId: ctx.host?.id ?? null,
    outcome: { status },
    run: { status: transitionRun(ctx.run.status, status), finishedAt: ctx.now },
    afterCommit: () => ctx.closeSession(),
  };
}

const PAUSED_STUCK = "Paused, the browser step is stuck";

/**
 * A step that did not move looks at the page once and takes a different action.
 * The same click is not repeated. A dead sandbox is left for the viewer.
 * After that look, a still-stuck step pauses the project.
 */
export async function recoverStuckStep(ctx: StepContext): Promise<StepResult | null> {
  let rows: Array<{ outcome: unknown; error: string | null; createdAt: Date; kind?: string }> = [];
  try {
    rows = await ctx.services.prisma.lbRunStep.findMany({
      where: { runId: ctx.run.id },
      orderBy: { stepIndex: "desc" },
      take: 4,
      select: { outcome: true, error: true, createdAt: true, kind: true },
    });
  } catch {
    return null;
  }
  const decision = decideStuckStep(rows.map(stuckRecordFromStep));
  if (decision === "continue") return null;
  if (decision === "yield") {
    const yieldTo = await sandboxYield(ctx, rows[0]?.createdAt ?? ctx.now);
    if (yieldTo === "wait") return { kind: "wait", reason: "sandbox_gone" };
    return null;
  }
  const latestKind = rows[0]?.kind ?? "";
  if (
    (decision === "look" || decision === "pause") &&
    latestKind === "register" &&
    !signupFormWasOpen(ctx, rows) &&
    ctx.host
  ) {
    return noSignupForm(ctx, ctx.host, []);
  }
  if (decision === "pause" && !ctx.host) {
    const project = await ctx.services.prisma.lbProject.findUnique({
      where: { id: ctx.project.id },
      select: { status: true },
    });
    if (project?.status === "active") return null;
  }
  if (decision === "pause" && ctx.host?.status === "warming" && ctx.account?.emailVerifiedAt) {
    return null;
  }
  if (decision === "pause") return pauseStuckProject(ctx);
  return lookAtStuckPage(ctx, latestKind);
}

function signupFormWasOpen(ctx: StepContext, rows: Array<{ outcome: unknown }>): boolean {
  if (ctx.pool()?.registerFormReady) return true;
  const status = ctx.host?.status;
  if (status === "registering" || status === "pending_email" || status === "pending_admin") {
    return true;
  }
  return rows.some((row) => {
    const outcome =
      row.outcome && typeof row.outcome === "object"
        ? (row.outcome as Record<string, unknown>)
        : {};
    const action = typeof outcome.lastAction === "string" ? outcome.lastAction : "";
    return (
      action === "Filled the registration form" || action.startsWith("Filled the next registration")
    );
  });
}

function stuckRecordFromStep(step: { outcome: unknown; error: string | null }): StuckRecord {
  const outcome =
    step.outcome && typeof step.outcome === "object"
      ? (step.outcome as Record<string, unknown>)
      : {};
  const action = typeof outcome.lastAction === "string" ? outcome.lastAction : "";
  const detail = typeof outcome.error === "string" ? outcome.error : "";
  const error = [step.error, detail].filter(Boolean).join(" ") || null;
  return { action, error, looked: outcome.looked === true };
}

/** A stopped sandbox is opened again. A sandbox that is still running waits for the viewer. */
async function sandboxYield(ctx: StepContext, failedAt: Date): Promise<"go" | "wait"> {
  try {
    const computers = await ctx.services.prisma.computer.findMany({
      where: { workspaceId: ctx.project.workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 4,
      select: { state: true, providerRef: true, updatedAt: true },
    });
    const running = computers.filter(
      (computer) => computer.state === "running" && Boolean(computer.providerRef),
    );
    if (running.length === 0) return "go";
    if (running.some((computer) => computer.updatedAt.getTime() > failedAt.getTime())) return "go";
    return "wait";
  } catch {
    return "go";
  }
}

async function pauseStuckProject(ctx: StepContext): Promise<StepResult> {
  const project = await ctx.services.prisma.lbProject.findUnique({
    where: { id: ctx.project.id },
    select: { status: true },
  });
  if (project?.status !== "active") return { kind: "wait", reason: "already_paused" };
  return {
    kind: "step",
    lastAction: PAUSED_STUCK,
    hostId: ctx.host?.id ?? null,
    stepKind: "page_look",
    outcome: { pauseSandbox: true, looked: true },
    apply: async (tx) => {
      await tx.lbProject.updateMany({
        where: { id: ctx.project.id, workspaceId: ctx.project.workspaceId, status: "active" },
        data: { status: transitionProject("active", "paused") },
      });
    },
  };
}

const REGISTER_LOOK_KINDS = new Set(["register", "captcha", "finish_registration"]);

function stayOnRegistration(ctx: StepContext, stepKind: string): boolean {
  if (ctx.host?.status === "registering") return true;
  return REGISTER_LOOK_KINDS.has(stepKind);
}

async function lookAtStuckPage(ctx: StepContext, stepKind = ""): Promise<StepResult> {
  try {
    const entry = await sessionForLook(ctx);
    if (!entry) return pauseStuckProject(ctx);
    const pageUrl = await entry.session.url().catch(() => ctx.host?.homepageUrl ?? "");
    const fields = entry.session.formFields
      ? await entry.session.formFields("form").catch(() => [])
      : [];
    const domain = ctx.host?.registrableDomain || hostnameOf(pageUrl);
    const links = (
      domain ? usablePageLinks(await collectPageAnchors(entry.session), pageUrl, domain) : []
    ).filter((link) => !bannedPage(link.url));
    const labels = emptyFieldLabels(fields);
    const stay = stayOnRegistration(ctx, stepKind);
    const asked =
      (await askStuckLook(
        ctx,
        pageUrl,
        labels,
        links.map((link) => link.text),
        stay,
      )) ?? localStuckChoice({ emptyFillable: labels.length, threadCount: links.length });
    const choice =
      stay && asked.action === "other_thread" ? { action: "find_form" as const } : asked;
    if (choice.action === "fill_fields") {
      await entry.session.holdForm?.();
      if (ctx.host) await fillEmptyAccountFields(ctx, entry.session, fields);
      return looked(ctx, pageUrl, "Looking at the page to fill the form", choice.action);
    }
    if (choice.action === "other_thread") {
      const next = links[choice.index];
      if (next && next.url !== pageUrl) {
        await entry.session.releaseForm?.();
        await entry.session.goto(next.url);
      }
      return looked(ctx, pageUrl, "Looking at the page to open another thread", choice.action);
    }
    const visible = fields.filter((field) => !field.hidden);
    if (visible.length === 0) {
      const registerUrl = registrationLink(await collectPageAnchors(entry.session), pageUrl);
      if (registerUrl && registerUrl !== pageUrl) await entry.session.goto(registerUrl);
    }
    await entry.session.holdForm?.();
    return looked(ctx, pageUrl, "Looking at the page to find the form", "find_form");
  } catch (error) {
    if (sandboxGoneError(error)) {
      return {
        kind: "step",
        lastAction: "Sandbox not found",
        hostId: ctx.host?.id ?? null,
        stepKind: "page_look",
        outcome: { sandboxGone: true, looked: false },
      };
    }
    return pauseStuckProject(ctx);
  }
}

async function sessionForLook(ctx: StepContext): Promise<PoolEntry | null> {
  const open = ctx.pool();
  if (open) return open;
  if (!ctx.host) return null;
  return ctx.openSession(ctx.host);
}

function looked(
  ctx: StepContext,
  url: string,
  lastAction: string,
  choice: StuckLookAction["action"],
): StepResult {
  return {
    kind: "step",
    lastAction,
    hostId: ctx.host?.id ?? null,
    stepKind: "page_look",
    outcome: { looked: true, choice, url },
  };
}

async function askStuckLook(
  ctx: StepContext,
  url: string,
  fields: readonly string[],
  links: readonly string[],
  stayOnForm = false,
): Promise<StuckLookAction | null> {
  const model = ctx.services.textModel;
  if (!model) return null;
  const linkCount = stayOnForm ? 0 : links.length;
  const request = {
    lane: "classify" as const,
    modelId: PAGE_LOOK_MODEL,
    system: STUCK_LOOK_SYSTEM,
    user: stuckLookPrompt({ url, fields, links, allowOtherThread: !stayOnForm }),
    maxTokens: 120,
    schema: {
      safeParse(value: unknown) {
        const parsed = parseStuckLook(value, linkCount);
        if (!parsed) return { success: false as const };
        return { success: true as const, data: parsed };
      },
    },
  };
  try {
    const result = await Promise.race([
      model.complete(request as never, ctx.adapter),
      new Promise<{ ok: false }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), PAGE_LOOK_WAIT_MS);
      }),
    ]);
    if (!result.ok || !("value" in result) || !result.value) return null;
    return parseStuckLook(result.value, linkCount);
  } catch {
    return null;
  }
}

async function fillEmptyAccountFields(
  ctx: StepContext,
  session: BrowserSession,
  fields: readonly FormFieldInfo[],
): Promise<void> {
  const host = ctx.host;
  if (!host) return;
  const empty = fields.filter(isEmptyFillable);
  if (empty.length === 0) return;
  const credentials = await ensureCredentials(ctx, host);
  for (const field of empty) {
    const value = valueForField(field, credentials);
    if (!value) continue;
    await session.fill(field.selector, value.text, { secret: value.secret });
  }
}

function isEmptyFillable(field: FormFieldInfo): boolean {
  if (field.hidden) return false;
  const type = (field.type ?? "").toLowerCase();
  if (["hidden", "submit", "button", "checkbox", "radio", "file", "image"].includes(type)) {
    return false;
  }
  if (field.tag === "button") return false;
  if ((field.value ?? "").trim()) return false;
  return field.tag === "input" || field.tag === "textarea";
}

function valueForField(
  field: FormFieldInfo,
  credentials: { username: string; password: string; email: string },
): { text: string; secret: boolean } | null {
  const blob = [
    field.type,
    field.name,
    field.id,
    field.autocomplete,
    field.label,
    field.placeholder,
  ]
    .filter((part) => part)
    .join(" ")
    .toLowerCase();
  if (/password|passwort|passwd/.test(blob)) return { text: credentials.password, secret: true };
  if (field.type === "email" || /e-?mail/.test(blob))
    return { text: credentials.email, secret: false };
  if (/user|nick|benutzer|username/.test(blob))
    return { text: credentials.username, secret: false };
  return null;
}

function emptyFieldLabels(fields: readonly FormFieldInfo[]): string[] {
  return fields
    .filter(isEmptyFillable)
    .map((field) => field.label || field.name || field.autocomplete || field.type || "field")
    .slice(0, 12);
}

function registrationLink(
  anchors: readonly { text: string; href: string }[],
  pageUrl: string,
): string | null {
  for (const item of anchors) {
    const blob = `${item.text} ${item.href}`.toLowerCase();
    if (!/registrier|sign[\s-]*up|create account|konto erstellen|register/.test(blob)) continue;
    const absolute = absoluteHttpUrl(item.href, pageUrl);
    if (!absolute || bannedPage(absolute)) continue;
    return absolute;
  }
  return null;
}

function absoluteHttpUrl(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(href, pageUrl || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function bannedPage(value: string): boolean {
  return isNewSignupBannedHost(hostnameOf(value));
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function sandboxGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return isSandboxGoneText(String(error));
  return isSandboxGoneText(`${error.name} ${error.message}`);
}

export function redactAll(ctx: StepContext, values: readonly string[]): string[] {
  return values.map((value) => redactText(ctx, value));
}

export function redactText(ctx: StepContext, value: string): string {
  return redactSecrets(value, ctx.secrets);
}

export function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
