import type {
  LbHostPlatform,
  LbHostStatus,
  LbMarket,
  LbParkableHostStatus,
  LbPlacementStatus,
  LbRunStatus,
  LbWhyNot,
} from "@rakazo/contracts";
import { isMailSendFailure } from "./mail-delivery.js";
import { searchedGoogleLine } from "./problem-queries.js";
import { type RunCounters, startRunCounters } from "./run-state.js";
import { initialWorkState, transitionWork } from "./work-stage.js";

/** What the bot is doing when research has no result yet. */
export const RESEARCH_OPENING = "Checking Google for on-topic forums";

/** Lines the old offline script left on the screen. They are not a live log. */
const STALE_RESEARCH_LINES = new Set([
  "researching",
  "researching topics",
  "reading on-topic pages",
  "reading threads",
  "still researching",
]);

/**
 * Kinds an older offline script wrote without a host or a placement.
 * The runner no longer emits them. Verify needs a placed link.
 */
const CUSTOMER_STAGE_KINDS = new Set(["lb_register", "lb_warmup", "lb_place", "lb_verify"]);

/** One search line. Later ticks hold until a real forum or thread exists. */
export const CUSTOMER_RESEARCH_BEATS = 1;

/** Filler the offline log used to rotate. They are not events. */
const CANNED_RESEARCH_LINES = new Set([
  "Checking Google for on-topic forums",
  "Looking for threads",
  "Continuing",
]);

/** Offline customer runs keep researching. They do not invent hosts, accounts, placements, or a verify check. */

export function isCustomerStageKind(kind: string): boolean {
  return CUSTOMER_STAGE_KINDS.has(kind);
}

export type FakeHostKey = "a" | "b" | "c";

export interface FakeScenarioInput {
  seed: string;
  /** Zero-based index of the step to plan. Earlier steps are replayed so transitions stay legal. */
  stepIndex: number;
  /** Research beats already stored. Old fixture steps do not count. */
  researchBeats?: number;
  /** Sentence written on the previous tick. The next tick moves one line ahead. */
  previousAction?: string | null;
  /** Real forum name. A found line is skipped when this is empty or an example host. */
  forumName?: string | null;
  /** Real thread title. A found line is skipped when this is empty or an example host. */
  threadName?: string | null;
  /** Stage changes already stored (`lb_register` and the steps after it). */
  stageBeats?: number;
  /** Counters to keep. Research does not invent registrations or LIVE links. */
  counters?: RunCounters;
  now: Date;
  markets: readonly LbMarket[];
  brandName: string;
  targetUrl: string;
  quotas: { livePerDay: number; liveWeekCap?: number };
  countNofollow: boolean;
  lowBalanceCredits?: number;
  /** Problem query already chosen for this project. The shop name is never a query. */
  searchQuery?: string | null;
}

export interface FakeHostWrite {
  key: FakeHostKey;
  domain: string;
  platform: LbHostPlatform;
  country: string;
  language: string;
  status: LbHostStatus;
  parkedFrom: LbParkableHostStatus | null;
  homepageUrl: string;
}

export interface FakeCaptchaWrite {
  type: "recaptcha_v2";
  door: "page_helper" | "operator";
  outcome: "placed_submitted" | "operator_parked";
  buttonTextObserved: string | null;
  humanCheckboxState: "checked" | "none";
  creditsCharged: number;
  attempt: number;
  helperVersion: string;
}

export interface FakePlacementWrite {
  status: LbPlacementStatus;
  counted: boolean;
  rel: string[];
  threadUrl: string;
  postUrl: string;
  targetUrl: string;
  anchorText: string;
  indexable: boolean;
}

export interface FakeStepPlan {
  done: false;
  stepIndex: number;
  kind: string;
  lastAction: string;
  runStatus: LbRunStatus;
  counters: RunCounters;
  host?: FakeHostWrite;
  captcha?: FakeCaptchaWrite;
  placement?: FakePlacementWrite;
  ticket?: { reason: "captcha_unsolved" };
  accountUsername?: string;
  draftBody?: string;
  whyNot?: LbWhyNot;
  costs: { credits: number; tokens: number; bytes: number; ms: number };
}

export type FakePlan = FakeStepPlan | { done: true } | { hold: true };

export function fakeScriptLength(): number {
  return CUSTOMER_RESEARCH_BEATS;
}

const FIXTURE_HOST_DOMAIN = /^(?:forum|fragen|brett)-[a-z0-9]+\.example$/;

/** Boards the offline runner invents. A customer project does not own these hosts. */
export function isFixtureHostDomain(domain: string): boolean {
  return FIXTURE_HOST_DOMAIN.test(domain.trim().toLowerCase());
}

export function fakeDomains(seed: string): Record<FakeHostKey, string> {
  const tag = hashTag(seed);
  return {
    a: `forum-${tag}.example`,
    b: `fragen-${tag}.example`,
    c: `brett-${tag}.example`,
  };
}

/** A name we can say. Blank text and `*.example` hosts are not results. */
export function researchResultName(name: string | null | undefined): string | null {
  const cleaned = name?.replace(/\s+/g, " ").trim() ?? "";
  if (cleaned.length < 2) return null;
  if (/\.example\b/i.test(cleaned) || FIXTURE_HOST_DOMAIN.test(cleaned)) return null;
  return cleaned;
}

export function foundForumLine(name: string | null | undefined): string | null {
  const forum = researchResultName(name);
  return forum ? `Found forum ${forum}` : null;
}

export function foundThreadLine(name: string | null | undefined): string | null {
  const thread = researchResultName(name);
  if (!thread || isMailSendFailure(thread)) return null;
  return `Found ${thread}`;
}

export function isStaleResearchLine(label: string): boolean {
  return STALE_RESEARCH_LINES.has(label.trim().toLowerCase());
}

/** Rotating filler. A found line is not one of these. */
export function isCannedResearchLine(label: string): boolean {
  return CANNED_RESEARCH_LINES.has(label.trim());
}

/** Real finds only. The canned opening, looking, and continuing lines are not events. */
export function researchLogLines(found?: {
  forumName?: string | null;
  threadName?: string | null;
}): string[] {
  const lines: string[] = [];
  const forumLine = foundForumLine(found?.forumName);
  if (forumLine) lines.push(forumLine);
  const threadLine = foundThreadLine(found?.threadName);
  if (threadLine) lines.push(threadLine);
  return lines;
}

/**
 * The next line worth storing. A found forum or thread is said once.
 * The canned opening, looking, and continuing lines are never replayed.
 */
export function nextRealResearchEvent(
  previous: string | null | undefined,
  found?: { forumName?: string | null; threadName?: string | null },
): string | null {
  const forum = foundForumLine(found?.forumName);
  const thread = foundThreadLine(found?.threadName);
  const sequence = [forum, thread].filter((line): line is string => Boolean(line));
  if (sequence.length === 0) return null;
  const said = previous?.trim() ?? "";
  const index = sequence.indexOf(said);
  if (index >= 0) return sequence[index + 1] ?? null;
  if (!said || isCannedResearchLine(said) || isStaleResearchLine(said)) return sequence[0] ?? null;
  if (/^searched google\.de for /i.test(said) || /^opened google search$/i.test(said)) {
    return sequence[0] ?? null;
  }
  return null;
}

/** @deprecated The live runner no longer cycles these lines. */
export function nextResearchLine(
  previous: string | null | undefined,
  found?: { forumName?: string | null; threadName?: string | null },
): string {
  return nextRealResearchEvent(previous, found) ?? RESEARCH_OPENING;
}

/** A search line we can store. A shop name or a buy query is not one. */
export function problemSearchAction(
  query: string | null | undefined,
  brandName?: string | null,
): string | null {
  const cleaned = query?.replace(/\s+/g, " ").trim() ?? "";
  if (cleaned.length < 3) return null;
  if (/\bkaufen\b|vitaminexpress|vitamin express/i.test(cleaned)) return null;
  const shop = brandName?.trim().toLowerCase() ?? "";
  if (shop.length > 2 && cleaned.toLowerCase().includes(shop)) return null;
  return searchedGoogleLine(cleaned);
}

/** Plans the next real event. Holds when nothing new has happened. No host is invented. */
export function planFakeStep(input: FakeScenarioInput): FakePlan {
  if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) {
    throw new RangeError("stepIndex must be a non-negative integer");
  }
  const beat = input.researchBeats ?? input.stepIndex;
  const stageBeat = input.stageBeats ?? 0;
  if (!Number.isInteger(beat) || beat < 0) {
    throw new RangeError("researchBeats must be a non-negative integer");
  }
  if (!Number.isInteger(stageBeat) || stageBeat < 0) {
    throw new RangeError("stageBeats must be a non-negative integer");
  }
  const counters = input.counters ?? startRunCounters(0);
  transitionWork(initialWorkState(), "research");
  const searchLine = problemSearchAction(input.searchQuery, input.brandName);
  const said = input.previousAction?.trim() ?? "";
  if (searchLine && said !== searchLine && !said.startsWith("Found ")) {
    return {
      done: false,
      stepIndex: input.stepIndex,
      kind: "research",
      lastAction: searchLine,
      runStatus: "running",
      counters,
      costs: { credits: 0, tokens: 0, bytes: 0, ms: 400 },
    };
  }
  const lastAction = nextRealResearchEvent(input.previousAction, {
    forumName: input.forumName,
    threadName: input.threadName,
  });
  if (!lastAction) return { hold: true };
  return {
    done: false,
    stepIndex: input.stepIndex,
    kind: "research",
    lastAction,
    runStatus: "running",
    counters,
    costs: { credits: 0, tokens: 0, bytes: 0, ms: 400 },
  };
}

/** Replays until the log holds. A project with no find stores the search line once. */
export function replayFakeScript(input: Omit<FakeScenarioInput, "stepIndex">): FakeStepPlan[] {
  const steps: FakeStepPlan[] = [];
  let researchBeats = 0;
  let previousAction: string | null = input.previousAction ?? null;
  for (let index = 0; index < 8; index += 1) {
    const plan = planFakeStep({
      ...input,
      stepIndex: index,
      researchBeats,
      stageBeats: 0,
      previousAction,
    });
    if (!("kind" in plan)) break;
    steps.push(plan);
    previousAction = plan.lastAction;
    researchBeats += 1;
  }
  return steps;
}

function hashTag(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}
