import type {
  AdapterContext,
  BrowserSession,
  CaptchaSolver,
  SearchProvider,
} from "@rakazo/adapter-kit";
import { CaptchaSolverError } from "@rakazo/adapter-kit";
import {
  type LbLanguage,
  type LbLocale,
  type LbMarket,
  LbMarketPolicySchema,
  LbMarketsSchema,
  LbTopicLaneSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  type DeadHostReprobeStatus,
  discoverHosts,
  discoveryDue,
  forumSearchUrl,
  isExampleRegistrableDomain,
  isFixtureHostDomain,
  isMailSendFailure,
  isNewSignupBannedHost,
  isRestoredSignupHost,
  localDateKey,
  primaryProblemQuery,
  problemInputFromProject,
  queryOmitsShop,
  registrableDomain,
  shopNames,
  topicStatusForPage,
  transitionProject,
  useCaseLanes,
  walkDeadHostSignup,
} from "@rakazo/linkbuilder-core";
import { captchaResponseField, sorryCaptchaFromMarkup } from "@rakazo/linkbuilder-drivers";
import { recordCost } from "./link-builder-costs.js";

/** Hosts that must not be opened for a new signup. */
const DROPPED_FORUM_HOSTS = [
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

const FORUM_LINK_CAP = 30;

export interface DiscoveryBrowserProject {
  id: string;
  workspaceId: string;
  locale: LbLocale;
  timezoneId: string;
  country: LbMarket["country"];
  language: LbLanguage;
}

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
  /** Visible browser. Tests inject this. The runner passes the computer-pane session factory. */
  openBrowser?: (project: DiscoveryBrowserProject) => Promise<BrowserSession>;
  /** Create or resume the team computer before the browser opens. */
  prepareComputer?: (project: { id: string; workspaceId: string }) => Promise<void>;
  /** Destroy the persona desktop when this tick pauses with no new forum. */
  releaseSearchDesktop?: (projectId: string) => Promise<void>;
  resolveCaptcha?: (project: { id: string; workspaceId: string }) => Promise<CaptchaSolver | null>;
}): Promise<number> {
  const projects = await input.prisma.lbProject.findMany({
    where: { status: "active", archivedAt: null },
  });
  let found = 0;
  for (const project of projects) {
    const followWarmup = await confirmedWarmupReady(input.prisma, project.id);
    if (!followWarmup && (await restoredHostWaiting(input.prisma, project))) continue;
    const countHosts = input.prisma.lbHost.count;
    if (!followWarmup && typeof countHosts === "function") {
      const warmingShort = await countHosts({
        where: {
          projectId: project.id,
          status: "warming",
          accounts: { some: { emailVerifiedAt: { not: null }, postCount: { lt: 4 } } },
        },
      });
      if (warmingShort > 0) continue;
    }
    const schedule = project.schedule as { timezone?: string } | null;
    const timeZone = schedule?.timezone || "Europe/Berlin";
    const due = shouldDiscover(project.lastDiscoveredAt, input.now, timeZone);
    if (!due) {
      if (await browserSearchRecent(input.prisma, project.id, input.now)) continue;
      if (!followWarmup && (await storedSearchRows(input.prisma, project.id))) continue;
      if (!followWarmup) {
        const stored = await input.prisma.lbHost.findMany({
          where: { projectId: project.id },
          select: { registrableDomain: true, status: true },
        });
        if (stored.some((host) => hostStartable(host, project.denyHosts))) continue;
      }
    }
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
    const hosts = await input.prisma.lbHost.findMany({
      where: { projectId: project.id },
      select: {
        registrableDomain: true,
        status: true,
        accounts: { select: { id: true } },
      },
    });
    const market = markets.data[0];
    if (!market) {
      await input.prisma.lbProject.update({
        where: { id: project.id },
        data: { lastDiscoveredAt: input.now },
      });
      continue;
    }
    const denyHosts = droppedHosts(project.denyHosts);
    const usedHosts = hosts
      .filter((host) => host.status === "used")
      .map((host) => host.registrableDomain);
    const fetchText = (url: string) =>
      fetchProbeText(url, {
        fetchImpl: input.fetchImpl ?? fetch,
        allowPrivate: input.allowPrivate ?? false,
      });
    const queries = problemQueries(project);
    const browserQuery = queries[0] ?? null;
    const paidQuery = queries.find((query) => query !== browserQuery) ?? null;
    const browser = await searchBrowserFirst({
      input,
      project,
      market,
      browserQuery,
      denyHosts,
      usedHosts,
      lanes: lanes.data,
      fetchText,
    });
    let added = 0;
    if (browser.allowed) {
      added = await persistDiscovered(input.prisma, project, browser.hosts, input.now);
    }
    if (added > 0) {
      found += added;
      await input.prisma.lbProject.update({
        where: { id: project.id },
        data: { lastDiscoveredAt: input.now },
      });
      continue;
    }
    if (!paidQuery) {
      await recordDiscoveryStep(
        input.prisma,
        project,
        input.now,
        "Browser search failed: no second problem query",
        "no second problem query",
      );
      await pauseAfterEmptySearch(input, project);
      continue;
    }
    let paid: Awaited<ReturnType<typeof discoverHosts>> = [];
    try {
      const context = { ...adapter, workspaceId: project.workspaceId };
      let results: Awaited<ReturnType<SearchProvider["search"]>>;
      try {
        results = await input.search.search(
          {
            query: paidQuery,
            country: market.country,
            language: market.language,
            depth: 100,
          },
          context,
        );
      } catch (error) {
        await recordSearchCost(input, project, timeZone, paidQuery);
        throw error;
      }
      await recordSearchCost(input, project, timeZone, paidQuery);
      const notice = partialNoticeOf(input.search);
      if (notice) await recordPartialResults(input.prisma, project, input.now, notice);
      const resultDomains = resultDomainsOf(results.map((result) => result.url));
      const known = new Set(hosts.map((host) => host.registrableDomain.toLowerCase()));
      if (
        resultDomains.length > 0 &&
        resultDomains.every((domain) => known.has(domain.toLowerCase()))
      ) {
        await recordDiscoveryStep(
          input.prisma,
          project,
          input.now,
          `Search rows were already stored: ${resultDomains.length}`,
          null,
        );
        await input.prisma.lbProject.update({
          where: { id: project.id },
          data: { lastDiscoveredAt: input.now },
        });
        continue;
      }
      paid = (
        await probeResultUrls({
          urls: results.map((result) => result.url),
          lanes: lanes.data,
          market,
          denyHosts,
          usedHosts,
          fetchText,
        })
      ).map((host) => gateHostTopic(host, project));
    } catch (error) {
      const message = error instanceof Error ? error.message : "search failed";
      await recordDiscoveryFailure(
        input.prisma,
        project,
        input.now,
        message,
        `Search failed: ${message}`,
      );
      await pauseAfterEmptySearch(input, project);
      continue;
    }
    const paidAdded = await persistDiscovered(input.prisma, project, paid, input.now);
    await input.prisma.lbProject.update({
      where: { id: project.id },
      data: { lastDiscoveredAt: input.now },
    });
    if (paidAdded === 0) {
      await pauseAfterEmptySearch(input, project);
      continue;
    }
    found += paidAdded;
  }
  return found;
}

const REPROBE_ACTION = "Re-probed dead hosts:";

/**
 * One pass over stored dead hosts. A register link that reaches a form becomes qualified.
 * A loaded page with no signup path becomes form_not_found. A block, a closed registration,
 * and a fetch failure stay dead. This pass does not search and does not submit an account.
 */
export async function reprobeDeadHosts(
  input: {
    prisma: PrismaClient;
    fetchImpl?: typeof fetch;
    allowPrivate?: boolean;
    now: Date;
  },
  project: { id: string; workspaceId: string; denyHosts?: readonly string[] | null },
): Promise<{ handled: boolean; qualified: number }> {
  const rows = await input.prisma.lbHost.findMany({
    where: { projectId: project.id, status: "dead" },
    select: { id: true, registrableDomain: true, homepageUrl: true, status: true },
  });
  const deny = droppedHosts(project.denyHosts ?? []);
  const eligible = rows.filter(
    (row) =>
      row.status === "dead" &&
      !deadHostLeftAlone(row.registrableDomain, deny) &&
      row.homepageUrl.trim().length > 0,
  );
  if (eligible.length === 0) return { handled: false, qualified: 0 };
  if (await deadReprobeAlreadyRan(input.prisma, project.id)) {
    return { handled: false, qualified: 0 };
  }
  const restored: Array<{ domain: string; status: DeadHostReprobeStatus }> = [];
  let cursor = 0;
  const visit = async (row: (typeof eligible)[number]) => {
    const verdict = await walkDeadHostSignup({
      homepageUrl: row.homepageUrl,
      fetchPage: (url) =>
        fetchSignupPage(url, {
          fetchImpl: input.fetchImpl ?? fetch,
          allowPrivate: input.allowPrivate ?? false,
        }),
    });
    if (verdict === "dead") return;
    await input.prisma.lbHost.updateMany({
      where: { id: row.id, status: "dead" },
      data: {
        status: verdict,
        parkedFrom: null,
        statusReason: verdict === "form_not_found" ? "no_signup_form" : null,
        lastProbeAt: input.now,
      },
    });
    restored.push({ domain: row.registrableDomain, status: verdict });
  };
  const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (cursor < eligible.length) {
      const row = eligible[cursor];
      cursor += 1;
      if (!row) continue;
      await visit(row);
    }
  });
  await Promise.all(workers);
  const qualified = restored.filter((row) => row.status === "qualified").length;
  await recordDeadReprobe(input.prisma, project, input.now, restored);
  return { handled: true, qualified };
}

function deadHostLeftAlone(domain: string, denyHosts: readonly string[]): boolean {
  if (isFixtureHostDomain(domain) || isExampleRegistrableDomain(domain)) return true;
  return hostDenied(domain, denyHosts);
}

async function deadReprobeAlreadyRan(prisma: PrismaClient, projectId: string): Promise<boolean> {
  const run = await prisma.lbRun.findFirst({
    where: { projectId, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const steps = await prisma.lbRunStep.findMany({
    where: { runId: run.id, kind: "discover" },
    orderBy: { finishedAt: "desc" },
    take: 20,
    select: { outcome: true },
  });
  return steps.some((step) => stepAction(step.outcome).startsWith(REPROBE_ACTION));
}

async function recordDeadReprobe(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  now: Date,
  restored: readonly { domain: string; status: string }[],
): Promise<void> {
  const action = `${REPROBE_ACTION} ${restored.length} came back`.slice(0, 180);
  const run = await prisma.lbRun.findFirst({
    where: { projectId: project.id, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run) {
    console.error("linkbuilder.discover", project.id, action);
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
      outcome: { lastAction: action, restored },
      startedAt: now,
      finishedAt: now,
    },
  });
  await prisma.lbRun.update({
    where: { id: run.id },
    data: { lastAction: action },
  });
}

async function fetchSignupPage(
  url: string,
  input: { fetchImpl: typeof fetch; allowPrivate: boolean },
): Promise<{ url: string; html: string } | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (!registrableDomain(parsed.hostname)) return null;
    if (!input.allowPrivate && isBlockedProbeHost(parsed.hostname)) return null;
    try {
      const response = await input.fetchImpl(current, {
        redirect: "manual",
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) return null;
      return { url: current, html: await response.text() };
    } catch {
      return null;
    }
  }
  return null;
}

async function pauseAfterEmptySearch(
  input: {
    prisma: PrismaClient;
    releaseSearchDesktop?: (projectId: string) => Promise<void>;
  },
  project: { id: string; workspaceId: string },
): Promise<void> {
  const projects = input.prisma.lbProject as {
    updateMany?: (args: {
      where: { id: string; workspaceId: string; status: string };
      data: { status: string };
    }) => Promise<unknown>;
  };
  if (typeof projects.updateMany === "function") {
    await projects.updateMany({
      where: { id: project.id, workspaceId: project.workspaceId, status: "active" },
      data: { status: transitionProject("active", "paused") },
    });
  }
  await input.releaseSearchDesktop?.(project.id).catch(() => undefined);
}

async function searchBrowserFirst(args: {
  input: {
    prisma: PrismaClient;
    now: Date;
    openBrowser?: (project: DiscoveryBrowserProject) => Promise<BrowserSession>;
    prepareComputer?: (project: { id: string; workspaceId: string }) => Promise<void>;
    resolveCaptcha?: (project: {
      id: string;
      workspaceId: string;
    }) => Promise<CaptchaSolver | null>;
  };
  project: {
    id: string;
    workspaceId: string;
    name?: string | null;
    brandName?: string | null;
    topicLanes?: unknown;
    targets?: unknown;
  };
  market: LbMarket;
  browserQuery: string | null;
  denyHosts: string[];
  usedHosts: string[];
  lanes: Parameters<typeof discoverHosts>[0]["lanes"];
  fetchText: (url: string) => Promise<string | null>;
}): Promise<{ allowed: boolean; hosts: Awaited<ReturnType<typeof discoverHosts>> }> {
  const { input, project, market, browserQuery } = args;
  if (!browserQuery) {
    await recordDiscoveryStep(
      input.prisma,
      project,
      input.now,
      "Browser search failed: no problem query",
      "no problem query",
    );
    return { allowed: false, hosts: [] };
  }
  const searchUrl = forumSearchUrl({
    name: project.name,
    brandName: project.brandName,
    topic: browserQuery,
    keywords: [browserQuery],
  });
  if (new URL(searchUrl).searchParams.get("q") !== browserQuery) {
    await recordDiscoveryStep(
      input.prisma,
      project,
      input.now,
      "Browser search failed: the query was not a problem",
      "query was not a problem",
    );
    return { allowed: false, hosts: [] };
  }
  if (/vitaminexpress/i.test(browserQuery)) {
    await recordDiscoveryStep(
      input.prisma,
      project,
      input.now,
      "Browser search failed: the query named the shop",
      "query named the shop",
    );
    return { allowed: false, hosts: [] };
  }
  if (input.prepareComputer) {
    try {
      await input.prepareComputer({ id: project.id, workspaceId: project.workspaceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "computer failed";
      await recordDiscoveryStep(
        input.prisma,
        project,
        input.now,
        `Browser search failed: ${message}`,
        message,
      );
      return { allowed: false, hosts: [] };
    }
  }
  if (!input.openBrowser) {
    await recordDiscoveryStep(
      input.prisma,
      project,
      input.now,
      "Browser search failed: the browser is not open",
      "browser is not open",
    );
    return { allowed: false, hosts: [] };
  }
  let session: BrowserSession;
  try {
    session = await input.openBrowser({
      id: project.id,
      workspaceId: project.workspaceId,
      locale: market.locale,
      timezoneId: market.timezoneId,
      country: market.country,
      language: market.language,
    });
    await session.goto(searchUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser failed";
    await recordDiscoveryStep(
      input.prisma,
      project,
      input.now,
      `Browser search failed: ${message}`,
      message,
    );
    return { allowed: false, hosts: [] };
  }
  const blocked = await searchPageBlocked(session);
  if (blocked) {
    const solved = await solveSearchCaptcha(input, project, session);
    if (!solved.cleared) return { allowed: false, hosts: [] };
  }
  const urls = await collectForumUrls(session, args.denyHosts);
  const probed = await probeResultUrls({
    urls,
    lanes: args.lanes,
    market,
    denyHosts: args.denyHosts,
    usedHosts: args.usedHosts,
    fetchText: args.fetchText,
  });
  const allowed = probed
    .filter(probedHostKept)
    .map(asStartableHost)
    .map((host) => gateHostTopic(host, project));
  await recordDiscoveryStep(
    input.prisma,
    project,
    input.now,
    `Searched the browser: ${browserQuery} — ${allowed.length} forums`,
    null,
  );
  if (allowed.length === 0) return { allowed: false, hosts: [] };
  return { allowed: true, hosts: allowed };
}

function problemQueries(project: {
  name?: string | null;
  brandName?: string | null;
  topicLanes?: unknown;
  targets?: unknown;
}): string[] {
  const input = problemInputFromProject(project);
  const shops = shopNames(input);
  const queries = useCaseLanes(input).map((lane) => lane.query);
  const primary = primaryProblemQuery(input);
  const ordered = primary ? [primary, ...queries.filter((query) => query !== primary)] : queries;
  return ordered.filter((query) => queryOmitsShop(query, shops) && !/vitaminexpress/i.test(query));
}

function droppedHosts(denyHosts: readonly string[]): string[] {
  return [...new Set([...denyHosts, ...DROPPED_FORUM_HOSTS])];
}

/** Statuses selectHost can open for signup. A missing form and a dead row cannot. */
const STARTABLE_HOST_STATUSES = new Set<string>([
  "ready",
  "warming",
  "pending_email",
  "registering",
  "qualified",
  "pending_admin",
]);

/** True when selectHost would open this host for signup. */
function hostStartable(
  host: { registrableDomain: string; status: string },
  denyHosts: readonly string[],
): boolean {
  if (host.status === "form_not_found" || host.status === "off_topic" || host.status === "dead") {
    return false;
  }
  if (!STARTABLE_HOST_STATUSES.has(host.status)) return false;
  if (
    isFixtureHostDomain(host.registrableDomain) ||
    isExampleRegistrableDomain(host.registrableDomain)
  ) {
    return false;
  }
  return !hostDenied(host.registrableDomain, droppedHosts(denyHosts));
}

function stepAction(outcome: unknown): string {
  if (!outcome || typeof outcome !== "object") return "";
  const action = (outcome as { lastAction?: unknown }).lastAction;
  return typeof action === "string" ? action : "";
}

/** One browser search after this run confirmed a signup and posted on every warming host. */
export function browserSearchFollowsWarmup(input: {
  confirmed: boolean;
  warmingHostIds: readonly string[];
  postedHostIds: readonly string[];
}): boolean {
  if (!input.confirmed || input.warmingHostIds.length === 0) return false;
  const posted = new Set(input.postedHostIds);
  return input.warmingHostIds.every((id) => posted.has(id));
}

async function confirmedWarmupReady(prisma: PrismaClient, projectId: string): Promise<boolean> {
  const run = await prisma.lbRun.findFirst({
    where: { projectId, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const steps = await prisma.lbRunStep.findMany({
    where: { runId: run.id },
    select: { kind: true, hostId: true, error: true, outcome: true },
  });
  const hosts = await prisma.lbHost.findMany({
    where: { projectId, status: "warming" },
    select: { id: true, accounts: { select: { emailVerifiedAt: true } } },
  });
  const postedHostIds = steps
    .filter(
      (step) =>
        step.kind === "warmup_post" &&
        step.error == null &&
        step.hostId != null &&
        stepAction(step.outcome) === "Posted the reply",
    )
    .map((step) => step.hostId as string);
  return browserSearchFollowsWarmup({
    confirmed: steps.some((step) => stepAction(step.outcome) === "Email verified"),
    warmingHostIds: hosts
      .filter((host) => host.accounts.some((account) => account.emailVerifiedAt))
      .map((host) => host.id),
    postedHostIds,
  });
}

/** A restored forum is waiting to sign up. This pass does not search or re-probe. */
async function restoredHostWaiting(
  prisma: PrismaClient,
  project: { id: string; denyHosts?: readonly string[] | null },
): Promise<boolean> {
  const rows = await prisma.lbHost.findMany({
    where: { projectId: project.id, status: "qualified" },
    select: {
      registrableDomain: true,
      status: true,
      accounts: { select: { id: true } },
    },
  });
  const deny = droppedHosts(project.denyHosts ?? []);
  return rows.some(
    (row) =>
      row.status === "qualified" &&
      isRestoredSignupHost(row.registrableDomain) &&
      (row.accounts?.length ?? 0) === 0 &&
      !hostDenied(row.registrableDomain, deny),
  );
}

function resultDomainsOf(urls: readonly string[]): string[] {
  const domains: string[] = [];
  for (const url of urls) {
    try {
      const domain = registrableDomain(url);
      if (domain) domains.push(domain);
    } catch {
      // A result that is not a URL does not count as a stored row.
    }
  }
  return domains;
}

/** The paid search already matched stored hosts, so this run does not buy another one. */
async function storedSearchRows(prisma: PrismaClient, projectId: string): Promise<boolean> {
  const run = await prisma.lbRun.findFirst({
    where: { projectId, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const steps = await prisma.lbRunStep.findMany({
    where: { runId: run.id, kind: "discover" },
    orderBy: { finishedAt: "desc" },
    take: 12,
    select: { outcome: true },
  });
  return steps.some((step) =>
    stepAction(step.outcome).startsWith("Search rows were already stored"),
  );
}

/** A browser search that finished inside the retry window blocks another search. */
async function browserSearchRecent(
  prisma: PrismaClient,
  projectId: string,
  now: Date,
): Promise<boolean> {
  const run = await prisma.lbRun.findFirst({
    where: { projectId, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!run) return false;
  const steps = await prisma.lbRunStep.findMany({
    where: { runId: run.id, kind: "discover" },
    orderBy: { finishedAt: "desc" },
    take: 8,
    select: { finishedAt: true, outcome: true },
  });
  return steps.some((step) => {
    const action = stepAction(step.outcome);
    const searched =
      action.startsWith("Searched the browser") || action.startsWith("Browser search");
    if (!searched || !step.finishedAt) return false;
    return now.getTime() - step.finishedAt.getTime() < DISCOVER_RETRY_MS;
  });
}

function hostDenied(domain: string, denyHosts: readonly string[]): boolean {
  const host = domain.toLowerCase();
  if (isNewSignupBannedHost(host)) return true;
  return denyHosts.some((item) => {
    const needle = item
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    return needle.length > 0 && (host === needle || host.endsWith(`.${needle}`));
  });
}

function isGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    /(^|\.)google\.[a-z.]+$/.test(host) ||
    /(^|\.)gstatic\.com$/.test(host) ||
    /(^|\.)googleusercontent\.com$/.test(host) ||
    /(^|\.)googleapis\.com$/.test(host)
  );
}

function sorryPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path === "/sorry" || path.startsWith("/sorry/");
  } catch {
    return false;
  }
}

async function searchPageBlocked(session: BrowserSession): Promise<boolean> {
  if (sorryPath(await session.url())) return true;
  const text = (await session.pageText()).toLowerCase();
  return text.includes("unusual traffic") || text.includes("ungewöhnlicher datenverkehr");
}

async function solveSearchCaptcha(
  input: {
    prisma: PrismaClient;
    now: Date;
    resolveCaptcha?: (project: {
      id: string;
      workspaceId: string;
    }) => Promise<CaptchaSolver | null>;
  },
  project: { id: string; workspaceId: string },
  session: BrowserSession,
): Promise<{ cleared: boolean }> {
  const websiteURL = await session.url();
  const html = session.pageHtml ? await session.pageHtml().catch(() => "") : "";
  const parsed = sorryCaptchaFromMarkup(html);
  const enterprise = parsed.enterprise;
  const type = enterprise ? "recaptcha_enterprise" : "recaptcha_v2";
  const wireType = "RecaptchaV2";
  const siteKey = parsed.siteKey;
  const detail = {
    websiteURL,
    type: wireType,
    siteKey,
    ...(enterprise ? { isEnterprise: true } : {}),
  };
  const solver = await input.resolveCaptcha?.(project);
  if (!solver || !siteKey) {
    await recordCaptchaAttempt(input.prisma, project, input.now, {
      ...detail,
      code: solver ? "no_site_key" : "missing",
      message: solver ? "no site key" : "solver missing",
    });
    return { cleared: false };
  }
  try {
    const solved = await solver.solve(
      {
        type,
        websiteURL,
        websiteKey: siteKey,
        ...(parsed.dataS ? { enterprisePayload: { s: parsed.dataS } } : {}),
      },
      { ...adapter, workspaceId: project.workspaceId },
    );
    if (session.injectToken) {
      await session.injectToken(captchaResponseField(type), solved.answer);
    }
    for (const selector of [
      "#captcha-form input[type='submit']",
      "input[type='submit']",
      "button[type='submit']",
    ]) {
      if (await session.exists(selector)) {
        await session.click(selector);
        break;
      }
    }
    const cleared = !(await searchPageBlocked(session));
    await recordCaptchaAttempt(input.prisma, project, input.now, { ...detail, solved: true });
    return { cleared };
  } catch (error) {
    const failure = publicSolverFailure(error);
    await recordCaptchaAttempt(input.prisma, project, input.now, { ...detail, ...failure });
    return { cleared: false };
  }
}

function publicSolverFailure(error: unknown): { code: string; message: string } {
  if (error instanceof CaptchaSolverError) {
    return { code: error.code, message: scrubSolverText(error.message || error.code) };
  }
  const message = error instanceof Error ? error.message : "solver failed";
  return { code: "error", message: scrubSolverText(message) };
}

/** Drops a bearer, an API key, and an answer token before a step is stored. */
function scrubSolverText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer")
    .replace(/ct_live_[A-Za-z0-9_-]+/g, "")
    .replace(/CAPTELL_API_KEY/g, "")
    .replace(/"(?:answer|gRecaptchaResponse|token)"\s*:\s*"[^"]*"/gi, "")
    .slice(0, 180);
}

async function recordCaptchaAttempt(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  now: Date,
  detail: {
    websiteURL: string;
    type: string;
    siteKey: string | null;
    isEnterprise?: boolean;
    solved?: boolean;
    code?: string;
    message?: string;
  },
): Promise<void> {
  const summary = detail.solved
    ? `Browser search captcha solved: ${detail.type} ${detail.siteKey ?? ""} ${detail.websiteURL}`
    : `Browser search captcha failed: ${detail.type} ${detail.siteKey ?? ""} ${detail.code ?? ""} ${detail.message ?? ""} ${detail.websiteURL}`;
  await recordDiscoveryStep(prisma, project, now, summary, detail.solved ? null : "captcha", {
    websiteURL: detail.websiteURL,
    type: detail.type,
    siteKey: detail.siteKey,
    ...(detail.isEnterprise ? { isEnterprise: true } : {}),
    ...(detail.solved
      ? { solved: true }
      : { code: detail.code ?? "error", message: scrubSolverText(detail.message ?? "") }),
  });
}

async function collectForumUrls(
  session: BrowserSession,
  denyHosts: readonly string[],
): Promise<string[]> {
  const page = await session.url();
  const anchors = session.listAnchors ? await session.listAnchors("a") : [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const absolute = unwrapHttps(anchor.href, page);
    if (!absolute) continue;
    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      continue;
    }
    if (isGoogleHost(parsed.hostname)) continue;
    const domain = registrableDomain(parsed.hostname);
    if (!domain || hostDenied(domain, denyHosts) || seen.has(domain)) continue;
    seen.add(domain);
    urls.push(absolute);
    if (urls.length >= FORUM_LINK_CAP) break;
  }
  return urls;
}

function probedHostKept(host: Awaited<ReturnType<typeof discoverHosts>>[number]): boolean {
  if (hostDenied(host.registrableDomain, DROPPED_FORUM_HOSTS)) return false;
  if (host.status === "qualified" || host.status === "off_topic") return true;
  if (
    host.reason === "commercial_links_forbidden" ||
    host.reason === "links_forbidden" ||
    host.reason === "unsupported_captcha"
  ) {
    return false;
  }
  return host.facts.platform !== "unknown" || Boolean(host.facts.registerUrl);
}

function asStartableHost<T extends { status: string; reason: string | null }>(host: T): T {
  if (host.status === "qualified" || host.status === "off_topic") return host;
  return { ...host, status: "qualified", reason: null };
}

function gateHostTopic<
  T extends {
    status: string;
    reason: string | null;
    title: string;
    pageText?: string;
    topicTags: string[];
    facts: { rulesExcerpt: string; threads: Array<{ title: string }> };
  },
>(
  host: T,
  project: {
    name?: string | null;
    brandName?: string | null;
    topicLanes?: unknown;
    targets?: unknown;
  },
): T {
  const pageText = [
    host.pageText,
    host.facts.rulesExcerpt,
    ...host.facts.threads.map((thread) => thread.title),
  ]
    .filter(Boolean)
    .join("\n");
  const status = topicStatusForPage(
    host.status,
    { pageText, title: host.title, topicTags: host.topicTags },
    project,
  );
  if (status === host.status) return host;
  return { ...host, status, reason: status === "off_topic" ? "off_topic" : host.reason };
}

function unwrapHttps(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!isGoogleHost(url.hostname)) return url.toString();
  const target = url.searchParams.get("q") || url.searchParams.get("url");
  if (!target) return null;
  try {
    const inner = new URL(target);
    if (inner.protocol !== "https:" || isGoogleHost(inner.hostname)) return null;
    return inner.toString();
  } catch {
    return null;
  }
}

async function probeResultUrls(args: {
  urls: readonly string[];
  lanes: Parameters<typeof discoverHosts>[0]["lanes"];
  market: LbMarket;
  denyHosts: readonly string[];
  usedHosts: readonly string[];
  fetchText: (url: string) => Promise<string | null>;
}): Promise<Awaited<ReturnType<typeof discoverHosts>>> {
  const urls = args.urls.filter((url) => {
    try {
      const domain = registrableDomain(url);
      return (
        Boolean(domain) &&
        !hostDenied(domain!, args.denyHosts) &&
        !isGoogleHost(new URL(url).hostname)
      );
    } catch {
      return false;
    }
  });
  if (urls.length === 0) return [];
  let served = false;
  return discoverHosts({
    lanes: args.lanes,
    markets: [args.market],
    policy: "primary_only",
    supply: {},
    need: 1,
    denyHosts: args.denyHosts,
    usedHosts: args.usedHosts,
    depth: 100,
    search: async () => {
      if (served) return [];
      served = true;
      return urls.map((url) => ({ url, title: "", snippet: "" }));
    },
    fetchText: args.fetchText,
  });
}

async function recordSearchCost(
  input: { prisma: PrismaClient; now: Date },
  project: { id: string; workspaceId: string },
  timeZone: string,
  query: string,
): Promise<void> {
  await recordCost(input.prisma, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    kind: "search_query",
    quantity: 1,
    sourceKey: `search:${project.id}:${localDateKey(input.now, timeZone)}:${query}`,
    occurredAt: input.now,
  }).catch(() => undefined);
}

async function persistDiscovered(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  discovered: Awaited<ReturnType<typeof discoverHosts>>,
  now: Date,
): Promise<number> {
  let found = 0;
  for (const host of discovered) {
    if (hostDenied(host.registrableDomain, DROPPED_FORUM_HOSTS)) continue;
    const existing = await prisma.lbHost.findUnique({
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
      lastProbeAt: now,
      notes: host.facts.rulesExcerpt || null,
    };
    const row = existing
      ? await prisma.lbHost.update({ where: { id: existing.id }, data })
      : await prisma.lbHost.create({
          data: {
            workspaceId: project.workspaceId,
            projectId: project.id,
            registrableDomain: host.registrableDomain,
            ...data,
          },
        });
    found += host.status === "qualified" || host.status === "off_topic" ? 1 : 0;
    for (const thread of host.facts.threads) {
      if (isMailSendFailure(thread.title)) continue;
      await prisma.lbThreadCandidate.upsert({
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
    where: { runId: run.id, kind: "discover" },
    orderBy: { stepIndex: "desc" },
    select: { finishedAt: true, error: true },
  });
  if (!newest?.finishedAt || !newest.error) return false;
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

async function recordDiscoveryStep(
  prisma: PrismaClient,
  project: { id: string; workspaceId: string },
  now: Date,
  lastAction: string,
  error: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  const action = lastAction.slice(0, 180);
  const stored = error?.slice(0, 500) ?? null;
  const run = await prisma.lbRun.findFirst({
    where: { projectId: project.id, status: { in: ["running", "overtime"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!run) {
    console.error("linkbuilder.discover", project.id, action);
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
      error: stored,
      outcome: { lastAction: action, ...detail },
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
