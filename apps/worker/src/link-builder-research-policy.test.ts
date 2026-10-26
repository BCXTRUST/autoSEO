import type { RealPlan } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import { type LinkBuilderRealDeps, LinkBuilderRealRunner } from "./link-builder-real";
import { marketOf, type ProjectConfig, type StepContext } from "./link-builder-real-steps";

const market = {
  country: "US" as const,
  language: "en" as const,
  locale: "en-US",
  timezoneId: "America/New_York",
};
describe("research before registration", () => {
  it.each([19, 20])("plans safely after %i site reviews", async (count) => {
    const runner = new LinkBuilderRealRunner({
      prisma: { lbHost: { count: async () => count } },
    } as unknown as LinkBuilderRealDeps);
    const ctx = {
      now: new Date("2026-10-26T12:00:00Z"),
      project: {
        id: "project",
        content: { researchBeforeRegistration: true, researchSiteLimit: 20 },
        quotas: { newPerDay: 1, livePerDay: 1 },
        schedule: {
          timezone: "UTC",
          weekdaysOnly: false,
          window: { start: "00:00", end: "23:59" },
          overtimeUntilLiveMet: false,
          hardStopHour: 24,
        },
        warmup: { minPostsBeforeLink: 3, minAccountAgeHours: 24 },
      },
      run: {
        status: "running",
        counters: { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: 0 },
      },
      host: null,
      account: null,
      placement: null,
    } as unknown as StepContext;
    const plan = await (runner as unknown as { plan(ctx: StepContext): Promise<RealPlan> }).plan(
      ctx,
    );
    expect(plan).toEqual(
      count < 20 ? { kind: "wait", reason: "research_batch" } : { kind: "select_host" },
    );
  });
  it("refuses old foreign-language hosts before opening their browser", () => {
    const project = { markets: [market] } as ProjectConfig;
    expect(() =>
      marketOf(project, { country: "DE", language: "de" } as Parameters<typeof marketOf>[1]),
    ).toThrow("Site language is outside the project markets");
    expect(
      marketOf(project, { country: "US", language: "en" } as Parameters<typeof marketOf>[1]),
    ).toEqual(market);
  });
});
