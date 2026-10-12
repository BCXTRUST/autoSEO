import { describe, expect, it } from "vitest";
import { assertStartWithinPlan, countedWithinPlan, PlanLimitError } from "./plan.js";

const starter = { projects: 3, live_per_day: 10, personas: 3 };

describe("plan limits", () => {
  it("refuses a start that would exceed the project or persona cap", () => {
    expect(() => assertStartWithinPlan({ otherStartedProjects: 0, caps: starter })).not.toThrow();
    expect(() => assertStartWithinPlan({ otherStartedProjects: 2, caps: starter })).not.toThrow();
    expect(() => assertStartWithinPlan({ otherStartedProjects: 3, caps: starter })).toThrow(
      PlanLimitError,
    );
    try {
      assertStartWithinPlan({ otherStartedProjects: 3, caps: starter });
    } catch (error) {
      expect(error).toMatchObject({ cap: "projects" });
    }
    expect(() =>
      assertStartWithinPlan({
        otherStartedProjects: 1,
        caps: { projects: 3, personas: 1 },
      }),
    ).toThrow(/personas/);
  });

  it("refuses a count that would exceed live_per_day", () => {
    expect(
      countedWithinPlan({ wantCounted: true, countedToday: 9, livePerDay: starter.live_per_day }),
    ).toBe(true);
    expect(
      countedWithinPlan({ wantCounted: true, countedToday: 10, livePerDay: starter.live_per_day }),
    ).toBe(false);
    expect(
      countedWithinPlan({ wantCounted: false, countedToday: 0, livePerDay: starter.live_per_day }),
    ).toBe(false);
    expect(countedWithinPlan({ wantCounted: true, countedToday: 0, livePerDay: 0 })).toBe(false);
  });
});
