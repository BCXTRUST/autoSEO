import { describe, expect, it } from "vitest";
import { applyRunPhrase } from "./run-phrase.js";
import { formatNextRun, isWithinWindow } from "./schedule.js";

const quotas = { newPerDay: 2, livePerDay: 1, liveWeekCap: 5, maxLivePerHost: 1 as const };
const schedule = {
  timezone: "Europe/Berlin",
  weekdaysOnly: true,
  window: { start: "09:00", end: "22:00" },
  overtimeUntilLiveMet: false,
  hardStopHour: 24,
};

describe("run phrases", () => {
  it("continues now, adds today's registrations, and sets the weekly limit", () => {
    const now = new Date("2026-10-10T11:00:00.000Z");
    const continued = applyRunPhrase({
      phrase: "continue",
      quotas,
      schedule,
      newToday: 2,
      liveToday: 0,
      now,
    });
    expect(continued?.resume).toBe(true);
    expect(continued?.summary).toBe("Running now");
    expect(isWithinWindow(now, continued!.schedule, { liveMet: false }).active).toBe(true);

    const more = applyRunPhrase({
      phrase: "do 3 more registrations today",
      quotas,
      schedule,
      newToday: 2,
      liveToday: 0,
      now,
    });
    expect(more?.quotas.newPerDay).toBe(5);
    expect(more?.resume).toBe(true);
    expect(more?.summary).toBe("Registrations today 5");

    const week = applyRunPhrase({
      phrase: "increase the weekly limit to 10",
      quotas,
      schedule,
      newToday: 2,
      liveToday: 0,
      now,
    });
    expect(week?.quotas.liveWeekCap).toBe(10);
    expect(week?.summary).toBe("Weekly limit 10");
    expect(week?.resume).toBe(false);

    const posts = applyRunPhrase({
      phrase: "do 2 more posts today",
      quotas,
      schedule,
      newToday: 0,
      liveToday: 1,
      now,
    });
    expect(posts?.quotas.livePerDay).toBe(3);
    expect(posts?.summary).toBe("Posts today 3");
  });

  it("names the next window in the project timezone", () => {
    const saturday = new Date("2026-10-10T11:00:00.000Z");
    expect(formatNextRun(saturday, schedule)).toBe("Mon 09:00 Europe/Berlin");
  });
});
