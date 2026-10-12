import { type LbRunStatus, LbRunStatusSchema } from "@rakazo/contracts";
import { assertCount, IllegalTransition } from "./errors.js";

export type RunStatus = LbRunStatus;

export const RUN_STATUSES = LbRunStatusSchema.options;
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

const ALLOWED: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["paused", "overtime", "succeeded", "partial", "failed", "cancelled"],
  paused: ["running", "overtime", "partial", "failed", "cancelled"],
  overtime: ["paused", "succeeded", "partial", "failed", "cancelled"],
  // Start reopens a closed day so the bot can begin at research again.
  succeeded: ["running"],
  partial: ["running"],
  // A failed day may be retried before the window closes; the (projectId, date) key stays.
  failed: ["queued"],
  cancelled: ["running"],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransitionRun(from, to)) throw new IllegalTransition("run", from, to);
  return to;
}

/** Working states in which the worker may take the next step. */
export function isRunActive(status: RunStatus): boolean {
  return status === "running" || status === "overtime";
}

export function isRunTerminal(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export interface RunCounters {
  newToday: number;
  liveToday: number;
  liveWeek: number;
  uniqueHosts: number;
}

export interface RunQuotaTargets {
  livePerDay: number;
  liveWeekCap?: number;
}

function checked(counters: RunCounters): RunCounters {
  assertCount("newToday", counters.newToday);
  assertCount("liveToday", counters.liveToday);
  assertCount("liveWeek", counters.liveWeek);
  assertCount("uniqueHosts", counters.uniqueHosts);
  if (counters.liveToday > counters.liveWeek) {
    throw new RangeError("liveToday cannot exceed liveWeek");
  }
  return counters;
}

/** Counters for a new day; `liveWeekSoFar` carries this week's earlier LIVE links. */
export function startRunCounters(liveWeekSoFar = 0): RunCounters {
  return checked({ newToday: 0, liveToday: 0, liveWeek: liveWeekSoFar, uniqueHosts: 0 });
}

export function recordRegistration(counters: RunCounters): RunCounters {
  return checked({ ...checked(counters), newToday: counters.newToday + 1 });
}

export function recordCountedLive(counters: RunCounters): RunCounters {
  checked(counters);
  return checked({
    ...counters,
    liveToday: counters.liveToday + 1,
    liveWeek: counters.liveWeek + 1,
  });
}

/**
 * A counted link left the inventory. `countedToday` also drops today's LIVE ring.
 * `liveWeek` never falls below `liveToday`.
 */
export function releaseCountedLive(counters: RunCounters, countedToday: boolean): RunCounters {
  checked(counters);
  const liveToday = countedToday ? Math.max(0, counters.liveToday - 1) : counters.liveToday;
  const liveWeek = Math.max(liveToday, counters.liveWeek - 1);
  const uniqueHosts = countedToday ? Math.max(0, counters.uniqueHosts - 1) : counters.uniqueHosts;
  return checked({ ...counters, liveToday, liveWeek, uniqueHosts });
}

/** Counts each host worked on today once. */
export function recordHostVisited(
  counters: RunCounters,
  visit: { firstVisitToday: boolean },
): RunCounters {
  checked(counters);
  if (!visit.firstVisitToday) return counters;
  return checked({ ...counters, uniqueHosts: counters.uniqueHosts + 1 });
}

export function isLiveMet(counters: RunCounters, quotas: RunQuotaTargets): boolean {
  if (counters.liveToday >= quotas.livePerDay) return true;
  return quotas.liveWeekCap !== undefined && counters.liveWeek >= quotas.liveWeekCap;
}

/** Terminal status for a run whose window has closed. */
export function closingRunStatus(
  counters: RunCounters,
  quotas: RunQuotaTargets,
): Extract<RunStatus, "succeeded" | "partial" | "failed"> {
  checked(counters);
  if (isLiveMet(counters, quotas)) return "succeeded";
  if (counters.liveToday > 0 || counters.newToday > 0) return "partial";
  return "failed";
}
