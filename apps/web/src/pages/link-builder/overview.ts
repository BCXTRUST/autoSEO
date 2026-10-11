import type { LbOperatorTicketView, LbRunStepView, LbWhyNot } from "@rakazo/contracts";
import {
  formatNextRun,
  foundForumLine,
  foundThreadLine,
  isCannedResearchLine,
  isStaleResearchLine,
  isWithinWindow,
  localClock,
  mentionsExampleDomain,
  mentionsFixtureHost,
  parseClockTime,
  RESEARCH_OPENING,
  researchResultName,
  type ScheduleWindow,
  searchedGoogleLine,
  showHostToCustomer,
  stageFromActivity,
  type WorkStage,
} from "@rakazo/linkbuilder-core";

export const OVERVIEW_COUNTS = {
  newToday: "New accounts per day",
  liveToday: "Live links today",
} as const;

export type OverviewIntent = "working" | "paused" | "stopped" | null;

export type OverviewFeedStatus = "working" | "done" | "blocked";

export interface OverviewFeedItem {
  id: string;
  label: string;
  status: OverviewFeedStatus;
  at: string | null;
}

export type OverviewFrame = { kind: "url"; url: string } | { kind: "artifact"; artifactId: string };

const BLOCKED_KINDS = new Set(["coherence_refused", "edge_block"]);

/** Stage kinds the offline runner used to print without a host or a placed link. */
const OFFLINE_STAGE_KINDS = new Set([
  "lb_register",
  "lb_warmup",
  "lb_place",
  "lb_verify",
  "verify",
]);

/** Exact labels from that script. Real work uses longer lines ("Registered", "Account warmed up"). */
const OFFLINE_STAGE_LABEL = /^(register|warmup|place|verify)$/i;

/** A placed link the customer can see. Fixture boards do not count. */
export function overviewHasPlacement(domains: readonly string[], slug?: string | null): boolean {
  return domains.some((domain) => showHostToCustomer(domain, slug));
}

function offlineStage(kind: string, label: string): boolean {
  return OFFLINE_STAGE_KINDS.has(kind) || OFFLINE_STAGE_LABEL.test(label.trim());
}

/** Old offline runs wrote a captcha park and a met quota. Customer projects no longer show that. */
function leftoverHandoff(label: string): boolean {
  return (
    /live quota met/i.test(label) ||
    /captcha/i.test(label) ||
    (/parked/i.test(label) && /operator/i.test(label))
  );
}

/** Start paints a working screen before the server answers. Pause and Stop paint calm. */
export function overviewWorking(input: {
  activity: string | null;
  intent: OverviewIntent;
}): boolean {
  if (input.intent === "working") return true;
  if (input.intent === "paused" || input.intent === "stopped") return false;
  return input.activity === "running" || input.activity === "overtime";
}

export function overviewPill(input: {
  activityLabel: string | null;
  intent: OverviewIntent;
}): string | null {
  if (input.intent === "working") return "running";
  if (input.intent === "paused") return "paused";
  if (input.intent === "stopped") return "stopped";
  if (input.activityLabel && /^needs operator\b/i.test(input.activityLabel)) return null;
  return input.activityLabel;
}

export const HOME_STATUSES = ["Posting", "Waiting", "Needs you", "Paused"] as const;
export type HomeStatus = (typeof HOME_STATUSES)[number];

/** The only status a home screen shows. Not a host board. */
export function homeStatus(input: {
  activity?: string | null;
  activityLabel?: string | null;
  intent?: OverviewIntent;
  needsYou?: boolean;
}): HomeStatus {
  const label = input.activityLabel ?? "";
  if (input.needsYou || input.activity === "needs_operator" || /^needs operator\b/i.test(label)) {
    return "Needs you";
  }
  if (input.intent === "paused" || input.activity === "paused") return "Paused";
  if (input.intent === "working" || input.activity === "running" || input.activity === "overtime") {
    return "Posting";
  }
  return "Waiting";
}

/** One line for a home card. Posting includes today's counted links. */
export function homeLine(input: {
  status: HomeStatus;
  liveToday: number;
  livePerDay: number;
}): string {
  if (input.status === "Posting") {
    return `Posting ${input.liveToday} of ${input.livePerDay} links today`;
  }
  return input.status;
}

const PERSON_REASONS = new Set(["missing_password"]);

/** Open ticket a person can finish. Captcha and unknown pages stay off this screen. */
export function personTicket<T extends { status: string; reason: string }>(
  tickets: readonly T[],
): T | null {
  return (
    tickets.find((ticket) => ticket.status === "open" && PERSON_REASONS.has(ticket.reason)) ?? null
  );
}

/** What is stuck, and the one next step. */
export function stuckHelp(ticket: { domain: string; reason: string }): {
  stuck: string;
  next: string;
} {
  const site = ticket.domain.trim() || "this site";
  switch (ticket.reason) {
    case "captcha_unsolved":
      return { stuck: `Stuck on a captcha at ${site}.`, next: "Solve the captcha, then continue." };
    case "two_factor":
      return { stuck: `Stuck on a login code at ${site}.`, next: "Enter the code, then continue." };
    case "missing_password":
      return {
        stuck: `Stuck. ${site} needs a password.`,
        next: "Add the password, then continue.",
      };
    case "admin_approval":
      return {
        stuck: `Waiting for the site admin to approve the registration at ${site}.`,
        next: "We check again later. You do not need to approve it.",
      };
    case "unknown_page_state":
      return {
        stuck: `Stuck on a page we do not recognize at ${site}.`,
        next: "Finish the page, then continue.",
      };
    case "unmapped_form":
      return {
        stuck: `Stuck on a form we do not know at ${site}.`,
        next: "Fill the form, then continue.",
      };
    default:
      return { stuck: `Stuck at ${site}.`, next: "Finish the page, then continue." };
  }
}

/** Skips and holds that are part of a healthy run. Not failures. */
export function statusNotes(whyNot: LbWhyNot | null | undefined): string[] {
  if (!whyNot) return [];
  const lines: string[] = [];
  if (whyNot.unsupportedCaptcha > 0) {
    lines.push(
      whyNot.unsupportedCaptcha === 1
        ? "Skipped 1 site. Captcha cannot be solved."
        : `Skipped ${whyNot.unsupportedCaptcha} sites. Captcha cannot be solved.`,
    );
  }
  if (whyNot.pendingEmail > 0) {
    lines.push(
      whyNot.pendingEmail === 1
        ? "1 account waiting for email."
        : `${whyNot.pendingEmail} accounts waiting for email.`,
    );
  }
  if (whyNot.pendingAdmin > 0) {
    lines.push(
      whyNot.pendingAdmin === 1
        ? "1 registration waiting for the site admin. We check again later."
        : `${whyNot.pendingAdmin} registrations waiting for the site admin. We check again later.`,
    );
  }
  return lines;
}

const REGISTERED_HOST = new Set(["pending_email", "pending_admin", "warming", "ready", "used"]);
const SKIPPED_HOST = new Set(["unsupported_captcha", "denied", "spam_blocked"]);

export interface DoneCounts {
  registered: number;
  posted: number;
  skipped: number;
}

/** What already happened, as three counts. Fixture boards stay out. */
export function doneCounts(
  hosts: readonly { registrableDomain: string; status: string }[],
  placements: readonly { domain: string; status: string }[],
  slug?: string | null,
): DoneCounts {
  const visibleHosts = hosts.filter((host) => showHostToCustomer(host.registrableDomain, slug));
  const visiblePosts = placements.filter(
    (row) => showHostToCustomer(row.domain, slug) && row.status !== "dead",
  );
  return {
    registered: visibleHosts.filter((host) => REGISTERED_HOST.has(host.status)).length,
    posted: visiblePosts.length,
    skipped: visibleHosts.filter((host) => SKIPPED_HOST.has(host.status)).length,
  };
}

export interface WaitLine {
  id: string;
  text: string;
}

/** One line per site that is actually waiting. Names the site and what the admin must do. */
export function waitLines(input: {
  hosts: readonly { id: string; registrableDomain: string; status: string }[];
  steps: readonly { id: string; lastAction: string | null }[];
  slug?: string | null;
}): WaitLine[] {
  const lines: WaitLine[] = [];
  const seen = new Set<string>();
  const push = (id: string, text: string) => {
    if (seen.has(text)) return;
    seen.add(text);
    lines.push({ id, text });
  };
  for (const host of input.hosts) {
    if (!showHostToCustomer(host.registrableDomain, input.slug)) continue;
    if (host.status === "pending_admin") {
      push(
        `admin:${host.id}`,
        `${host.registrableDomain} — waiting for the site admin to approve the registration. We check again later.`,
      );
    }
    if (host.status === "pending_email") {
      push(
        `email:${host.id}`,
        `${host.registrableDomain} — waiting for the confirmation email. We check again later.`,
      );
    }
  }
  for (const step of [...input.steps].reverse()) {
    const label = step.lastAction?.trim() ?? "";
    if (!/^Waiting for the site admin to approve the post at /i.test(label)) continue;
    push(`post:${step.id}`, label);
  }
  return lines;
}

/** Counts for the top of the dashboard. Host rows win; the status totals fill a gap. */
export function dashboardSummary(input: {
  hosts: readonly { id: string; registrableDomain: string; status: string }[];
  placements: readonly { domain: string; status: string }[];
  steps: readonly { id: string; lastAction: string | null }[];
  slug?: string | null;
  whyNot?: LbWhyNot | null;
}): { done: DoneCounts; notes: WaitLine[] } {
  const counted = doneCounts(input.hosts, input.placements, input.slug);
  const why = input.whyNot;
  const done: DoneCounts = {
    registered: Math.max(counted.registered, (why?.pendingEmail ?? 0) + (why?.pendingAdmin ?? 0)),
    posted: counted.posted,
    skipped: Math.max(
      counted.skipped,
      (why?.unsupportedCaptcha ?? 0) + (why?.parked ?? 0) + (why?.spamBlocked ?? 0),
    ),
  };
  const named = waitLines(input);
  const notes =
    named.length > 0
      ? named.slice(0, 3)
      : statusNotes(why)
          .slice(0, 3)
          .map((text, index) => ({ id: `note:${index}`, text }));
  return { done, notes };
}

/** The screen chip stays a short action. A wait or a paragraph stays off the picture. */
export function cornerLabel(action: string, fallback: string): string {
  const text = action.trim();
  if (!text || text.length > 72) return fallback;
  if (/waiting for|skipped \d/i.test(text)) return fallback;
  return text;
}

/** The check list stays short. Post text and essays stay on Details. */
export function showOnDashboard(label: string): boolean {
  const text = label.trim();
  if (!text || text.length > 90 || text.includes("\n")) return false;
  const sentences = text.split(/[.!?]/).filter((part) => part.trim().length > 0);
  return !(sentences.length > 1 && text.length > 60);
}

function skippedSites(count: number, why: string): string {
  const sites = count === 1 ? "1 site" : `${count} sites`;
  return `Skipped ${sites}. ${why}`;
}

/** Non-zero blockers only. Warm-up, skips, and mail holds stay off this list. */
export function whyNotFeedLines(whyNot: LbWhyNot | null | undefined): string[] {
  if (!whyNot) return [];
  const lines: string[] = [];
  if (whyNot.parked > 0) lines.push(skippedSites(whyNot.parked, "Needs a person."));
  if (whyNot.spamBlocked > 0) lines.push(skippedSites(whyNot.spamBlocked, "Marked as spam."));
  if (whyNot.modelErrors > 0) lines.push(skippedSites(whyNot.modelErrors, "The writer failed."));
  if (whyNot.modelRefusals > 0)
    lines.push(skippedSites(whyNot.modelRefusals, "The writer refused."));
  if (whyNot.proxy === "degraded") lines.push("The connection is weak.");
  if (whyNot.reasons.includes("captcha_balance_low")) lines.push("Captcha credits are low.");
  if (whyNot.reasons.includes("week_cap_reached")) lines.push("Live links this week are full.");
  if (whyNot.reasons.includes("new_quota_reached")) lines.push("Today's links are full.");
  return lines;
}

export function overviewFeed(input: {
  steps: LbRunStepView[];
  lastEvent: string | null;
  working: boolean;
  blockers: string[];
  /** Expected holds: a skip, mail, or an admin review. */
  notes?: string[];
  /** Customer projects drop leftover `*.example` lines. The Nordlicht demo keeps its own. */
  hideExampleCopy?: boolean;
  /** Verify runs only after a link is placed. Without one, those lines stay off the feed. */
  hasPlacement?: boolean;
  /** Real forum. A found line is omitted when this is blank or an example host. */
  forumName?: string | null;
  /** Real thread title. A found line is omitted when this is blank or an example host. */
  threadName?: string | null;
  /** Recorded search queries. Zero means a Google line has not happened. */
  searches?: number;
  /** Problem query that was actually opened. Omitted when no search was counted. */
  searchQuery?: string | null;
}): OverviewFeedItem[] {
  const hasPlacement = input.hasPlacement === true;
  let keptOpening = false;
  const steps = [...input.steps]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .filter((step) => {
      const label = step.lastAction?.trim() || step.kind;
      if (isStaleResearchLine(label)) return false;
      if (isCannedResearchLine(label)) return false;
      if (input.searches === 0 && claimsGoogleSearch(label)) return false;
      if (input.searchQuery && /^opened google search$/i.test(label)) return false;
      if (label === RESEARCH_OPENING) {
        if (keptOpening) return false;
        keptOpening = true;
      }
      if (!visibleFoundLine(label, input.forumName, input.threadName)) return false;
      if (!hasPlacement && offlineStage(step.kind, label)) return false;
      if (mentionsFixtureHost(label)) return false;
      if (input.hideExampleCopy && (mentionsExampleDomain(label) || leftoverHandoff(label))) {
        return false;
      }
      return true;
    });
  const items: OverviewFeedItem[] = [];
  for (const step of steps) {
    const label = step.lastAction?.trim() || step.kind;
    const at = step.createdAt;
    const previous = items.at(-1);
    const duplicate =
      previous !== undefined && previous.label === label && sameMoment(previous.at, at);
    if (duplicate) continue;
    items.push({
      id: step.id,
      label,
      status: step.error || BLOCKED_KINDS.has(step.kind) ? "blocked" : "done",
      at,
    });
  }
  const seen = new Set(items.map((item) => item.label));
  const event = input.lastEvent?.trim() ?? "";
  const researchAlready = items.some((item) => /research/i.test(item.label));
  const hiddenEvent =
    isStaleResearchLine(event) ||
    isCannedResearchLine(event) ||
    (input.searches === 0 && claimsGoogleSearch(event)) ||
    Boolean(input.searchQuery && /^opened google search$/i.test(event)) ||
    !visibleFoundLine(event, input.forumName, input.threadName) ||
    mentionsFixtureHost(event) ||
    (!hasPlacement && offlineStage("", event)) ||
    (event.toLowerCase() === "researching" && researchAlready) ||
    (input.hideExampleCopy && (mentionsExampleDomain(event) || leftoverHandoff(event)));
  if (event && !seen.has(event) && !hiddenEvent) {
    items.push({ id: `event:${event}`, label: event, status: "done", at: null });
  }
  placeFoundLines(items, input.forumName, input.threadName);
  const query = input.searchQuery?.trim() ?? "";
  if ((input.searches ?? 0) > 0 && query) {
    const line = searchedGoogleLine(query);
    if (!items.some((item) => item.label === line)) {
      items.unshift({ id: `search:${query}`, label: line, status: "done", at: null });
    }
  }
  if (input.working) {
    let open = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item || item.status === "blocked" || item.id.startsWith("found:")) continue;
      open = index;
      break;
    }
    if (open < 0) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]?.status !== "blocked") {
          open = index;
          break;
        }
      }
    }
    const current = open >= 0 ? items[open] : undefined;
    if (current) {
      current.status = "working";
      if (open < items.length - 1) {
        items.splice(open, 1);
        items.push(current);
      }
    }
  }
  for (const line of input.blockers) {
    items.push({ id: `blocker:${line}`, label: line, status: "blocked", at: null });
  }
  for (const line of input.notes ?? []) {
    items.push({ id: `note:${line}`, label: line, status: "done", at: null });
  }
  return items;
}

function formatSpan(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 1) return "under a minute";
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * How long the open window still runs, and a pace guess from recent steps.
 * Steps closer than 15s or farther than 45m are pauses, not a pace.
 */
export function overviewPace(input: {
  now: Date;
  schedule?: ScheduleWindow | null;
  steps: readonly { createdAt: string }[];
  liveToday: number;
  livePerDay: number;
  newToday: number;
  newPerDay: number;
}): string[] {
  const lines: string[] = [];
  let windowLeft: number | null = null;
  if (input.schedule?.window) {
    const liveMet = input.livePerDay > 0 && input.liveToday >= input.livePerDay;
    const state = isWithinWindow(input.now, input.schedule, { liveMet });
    if (!state.active) {
      lines.push(`Next run ${formatNextRun(input.now, input.schedule)}`);
    } else {
      const clock = localClock(input.now, input.schedule.timezone);
      const end =
        state.mode === "overtime"
          ? input.schedule.hardStopHour * 60
          : parseClockTime(input.schedule.window.end);
      windowLeft = Math.max(0, end - clock.minutes);
      lines.push(`${formatSpan(windowLeft)} left today`);
    }
  }
  if (input.schedule?.window && windowLeft === null) return lines;
  const liveLeft = Math.max(0, input.livePerDay - input.liveToday);
  const newLeft = Math.max(0, input.newPerDay - input.newToday);
  const times = input.steps
    .map((step) => Date.parse(step.createdAt))
    .filter((at) => Number.isFinite(at))
    .sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap >= 15_000 && gap <= 45 * 60_000) gaps.push(gap);
  }
  const recent = gaps.slice(-8);
  const units = liveLeft > 0 ? liveLeft : newLeft;
  const noun =
    liveLeft > 0 ? (units === 1 ? "link" : "links") : units === 1 ? "account" : "accounts";
  if (units > 0 && recent.length >= 2) {
    const sorted = [...recent].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;
    const minutes = Math.max(1, Math.round((median * units) / 60_000));
    if (windowLeft !== null && minutes > windowLeft) {
      lines.push(`${units} ${noun} still open`);
    } else {
      lines.push(`About ${formatSpan(minutes)} for ${units} ${noun}`);
    }
  } else if (units > 0) {
    lines.push(`${units} ${noun} left today`);
  }
  return lines;
}

/** Site and page open on the team computer: consent, registration, or reply. */
export function livePageLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.pathname.includes("/novnc/")) return null;
  const host = parsed.hostname.replace(/^www\./, "");
  if (!host) return null;
  const path =
    `${decodeURIComponent(parsed.pathname)} ${decodeURIComponent(parsed.search)}`.toLowerCase();
  const kind = pageKind(path);
  return kind ? `Opening ${host} ${kind}` : `Opening ${host}`;
}

function pageKind(path: string): "consent" | "registration" | "reply" | null {
  if (/consent|cookie|datenschutz/.test(path)) return "consent";
  if (/regist|sign-?up|signup/.test(path)) return "registration";
  if (/reply|antwort|comment|thread|\/post(?:\/|$)|\/forum(?:\/|$)/.test(path)) return "reply";
  return null;
}

export function overviewAction(
  items: OverviewFeedItem[],
  working: boolean,
  liveUrl?: string | null,
): string {
  const live = livePageLabel(liveUrl);
  if (live) return live;
  if (working) {
    const current = [...items].reverse().find((item) => item.status === "working");
    return current?.label || "Working";
  }
  const last = [...items].reverse().find((item) => item.status !== "blocked");
  return last?.label ?? "";
}

/** A sentence that says Google was searched. Hidden while the search count is still zero. */
function claimsGoogleSearch(label: string): boolean {
  return /google/i.test(label) && /(check|search|opened|opening)/i.test(label);
}

/** A stored "Found …" line stays only when that forum or thread is on the project. */
function visibleFoundLine(
  label: string,
  forumName: string | null | undefined,
  threadName: string | null | undefined,
): boolean {
  if (!label.startsWith("Found ")) return true;
  if (label.startsWith("Found forum ")) {
    return researchResultName(label.slice("Found forum ".length)) === researchResultName(forumName);
  }
  return researchResultName(label.slice("Found ".length)) === researchResultName(threadName);
}

function researchRank(label: string): number | null {
  if (label === RESEARCH_OPENING) return 0;
  if (label.startsWith("Found forum ")) return 1;
  if (label === "Looking for threads" || label.startsWith("Looking for threads on ")) return 2;
  if (label.startsWith("Found ")) return 3;
  if (label === "Continuing") return 4;
  return null;
}

/** Puts a real find in script order. Example hosts never become a line. */
function placeFoundLines(
  items: OverviewFeedItem[],
  forumName: string | null | undefined,
  threadName: string | null | undefined,
) {
  const forum = researchResultName(forumName);
  if (forum) {
    for (const item of items) {
      if (item.label === "Looking for threads") item.label = `Looking for threads on ${forum}`;
    }
  }
  insertRanked(items, foundForumLine(forum));
  insertRanked(items, foundThreadLine(threadName));
}

function insertRanked(items: OverviewFeedItem[], line: string | null) {
  if (!line || items.some((item) => item.label === line)) return;
  const rank = researchRank(line);
  if (rank === null) return;
  let index = items.length;
  for (let cursor = 0; cursor < items.length; cursor += 1) {
    const existing = researchRank(items[cursor]?.label ?? "");
    if (existing !== null && existing > rank) {
      index = cursor;
      break;
    }
  }
  items.splice(index, 0, { id: `found:${line}`, label: line, status: "done", at: null });
}

/** A stuck repeat in the same minute is one moment. A new sentence still lands. */
function sameMoment(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const a = new Date(left);
  const b = new Date(right);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

function liveScreen(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/novnc/") || url.startsWith("https://")) return url;
  return null;
}

/**
 * Stage shown on the rail. Verify is only current when a placement exists to check.
 * Offline register, warmup, and place labels are the same: they are not work.
 */
export function overviewStage(input: {
  runStatus: string | null;
  lastAction: string | null;
  stepKinds?: readonly string[];
  hasPlacement: boolean;
}): WorkStage {
  const kinds = (input.stepKinds ?? []).filter(
    (kind) => input.hasPlacement || !OFFLINE_STAGE_KINDS.has(kind),
  );
  const action = input.lastAction?.trim() ?? "";
  const lastAction =
    !input.hasPlacement && OFFLINE_STAGE_LABEL.test(action) ? null : input.lastAction;
  const stage = stageFromActivity({
    runStatus: input.runStatus,
    lastAction,
    stepKinds: kinds,
  });
  if (!input.hasPlacement && stage === "verify") return "research";
  return stage;
}

/** Prefer an open ticket screen, then the team computer stream, then the newest screenshot. */
export function overviewFrame(input: {
  steps: LbRunStepView[];
  tickets: LbOperatorTicketView[];
  /** Live team-computer stream (`/novnc/` or `https://`). */
  screenUrl?: string | null;
}): OverviewFrame | null {
  const open = input.tickets.find(
    (ticket) => ticket.status === "open" && liveScreen(ticket.screenUrl),
  );
  const screen = open ? liveScreen(open.screenUrl) : null;
  if (screen) return { kind: "url", url: screen };
  const computer = liveScreen(input.screenUrl);
  if (computer) return { kind: "url", url: computer };
  const steps = [...input.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const artifactId = steps[index]?.artifactIds[0];
    if (artifactId) return { kind: "artifact", artifactId };
  }
  const shot = [...input.tickets].reverse().find((ticket) => ticket.screenshotArtifactId);
  if (shot?.screenshotArtifactId)
    return { kind: "artifact", artifactId: shot.screenshotArtifactId };
  return null;
}
