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
  it.each([
    { count: 19, target: undefined, eligible: 0, wait: true },
    { count: 20, target: undefined, eligible: 0, wait: false },
    { count: 5, target: 5, eligible: 1, wait: true },
    { count: 8, target: 5, eligible: 5, wait: false },
    { count: 20, target: 5, eligible: 2, wait: true },
    { count: 100, target: 5, eligible: 4, wait: true },
  ])(
    "plans safely for $count reviews and $eligible eligible sites",
    async ({ count, target, eligible, wait }) => {
      const runner = new LinkBuilderRealRunner({
        prisma: {
          lbHost: {
            count: async (args: { where: { status?: unknown } }) =>
              args.where.status ? eligible : count,
          },
        },
      } as unknown as LinkBuilderRealDeps);
      const ctx = {
        now: new Date("2026-10-26T12:00:00Z"),
        project: {
          id: "project",
          content: {
            researchBeforeRegistration: true,
            researchSiteLimit: 20,
            researchTargetCount: target,
          },
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
        wait ? { kind: "wait", reason: "research_batch" } : { kind: "select_host" },
      );
    },
  );
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
