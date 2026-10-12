import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  closingRunStatus,
  IllegalTransition,
  isLiveMet,
  isRunActive,
  isRunTerminal,
  RUN_STATUSES,
  type RunStatus,
  recordCountedLive,
  recordHostVisited,
  recordRegistration,
  releaseCountedLive,
  startRunCounters,
  TERMINAL_RUN_STATUSES,
  transitionRun,
} from "./index.js";

const LEGAL: Array<[RunStatus, RunStatus]> = [
  ["queued", "running"],
  ["queued", "cancelled"],
  ["running", "paused"],
  ["running", "overtime"],
  ["running", "succeeded"],
  ["running", "partial"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["paused", "running"],
  ["paused", "overtime"],
  ["paused", "partial"],
  ["paused", "failed"],
  ["paused", "cancelled"],
  ["overtime", "paused"],
  ["overtime", "succeeded"],
  ["overtime", "partial"],
  ["overtime", "failed"],
  ["overtime", "cancelled"],
  ["failed", "queued"],
  ["succeeded", "running"],
  ["partial", "running"],
  ["cancelled", "running"],
];

describe("run state machine", () => {
  it("allows exactly the legal table", () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}:${to}`));
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const allowed = legal.has(`${from}:${to}`);
        expect(canTransitionRun(from, to), `${from}->${to}`).toBe(allowed);
        if (allowed) expect(transitionRun(from, to)).toBe(to);
        else expect(() => transitionRun(from, to)).toThrow(IllegalTransition);
      }
    }
  });

  it("classifies active and terminal statuses", () => {
    expect(RUN_STATUSES.filter(isRunActive)).toEqual(["running", "overtime"]);
    expect(RUN_STATUSES.filter(isRunTerminal)).toEqual([...TERMINAL_RUN_STATUSES]);
  });

  it("reopens a closed day when Start is pressed, and retries a failed day through queued", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL_RUN_STATUSES),
        fc.constantFrom(...RUN_STATUSES),
        (from, to) => {
          const start = from !== "failed" && to === "running";
          const retry = from === "failed" && to === "queued";
          expect(canTransitionRun(from, to)).toBe(start || retry);
        },
      ),
    );
  });
});

describe("run counters", () => {
  it("counts registrations, LIVE links and distinct hosts", () => {
    let counters = startRunCounters(2);
    counters = recordRegistration(counters);
    counters = recordHostVisited(counters, { firstVisitToday: true });
    counters = recordHostVisited(counters, { firstVisitToday: false });
    counters = recordCountedLive(counters);
    expect(counters).toEqual({ newToday: 1, liveToday: 1, liveWeek: 3, uniqueHosts: 1 });
    expect(releaseCountedLive(counters, true)).toEqual({
      newToday: 1,
      liveToday: 0,
      liveWeek: 2,
      uniqueHosts: 0,
    });
    expect(
      releaseCountedLive({ newToday: 0, liveToday: 0, liveWeek: 2, uniqueHosts: 1 }, false),
    ).toEqual({ newToday: 0, liveToday: 0, liveWeek: 1, uniqueHosts: 1 });
  });

  it("rejects invalid counter states", () => {
    expect(() => startRunCounters(-1)).toThrow(RangeError);
    expect(() => startRunCounters(1.5)).toThrow(RangeError);
    expect(() =>
      recordCountedLive({ newToday: 0, liveToday: 2, liveWeek: 1, uniqueHosts: 0 }),
    ).toThrow(/liveToday cannot exceed liveWeek/);
    expect(() =>
      recordRegistration({ newToday: -1, liveToday: 0, liveWeek: 0, uniqueHosts: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      recordHostVisited(
        { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: -1 },
        {
          firstVisitToday: false,
        },
      ),
    ).toThrow(RangeError);
  });

  it("meets LIVE by the daily quota or the weekly cap", () => {
    const counters = { newToday: 0, liveToday: 1, liveWeek: 5, uniqueHosts: 1 };
    expect(isLiveMet(counters, { livePerDay: 1 })).toBe(true);
    expect(isLiveMet(counters, { livePerDay: 2 })).toBe(false);
    expect(isLiveMet(counters, { livePerDay: 2, liveWeekCap: 5 })).toBe(true);
    expect(isLiveMet({ ...counters, liveToday: 0 }, { livePerDay: 0 })).toBe(true);
  });

  it("closes a run as succeeded, partial or failed", () => {
    const base = { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: 0 };
    expect(closingRunStatus({ ...base, liveToday: 2, liveWeek: 2 }, { livePerDay: 2 })).toBe(
      "succeeded",
    );
    expect(closingRunStatus({ ...base, liveToday: 1, liveWeek: 1 }, { livePerDay: 2 })).toBe(
      "partial",
    );
    expect(closingRunStatus({ ...base, newToday: 3 }, { livePerDay: 2 })).toBe("partial");
    expect(closingRunStatus(base, { livePerDay: 2 })).toBe("failed");
  });
});
