import { LB_DEFAULT_MARKET, type LbRunStatus } from "@rakazo/contracts";
import type { FakeStepPlan } from "@rakazo/linkbuilder-core";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeRunRecord,
  isLinkBuilderFakeEnabled,
  type LinkBuilderFakeStore,
  tickLinkBuilderFake,
} from "./link-builder-fake.js";

const now = new Date("2026-10-05T17:00:00.000Z");

function run(status: LbRunStatus = "running"): FakeRunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    status,
    stepCount: 0,
    researchBeats: 0,
    stageBeats: 0,
    previousAction: null,
    forumName: null,
    threadName: null,
    counters: { newToday: 0, liveToday: 0, liveWeek: 0, uniqueHosts: 0 },
    seed: "project-1",
    brandName: "Nordlicht",
    targetUrl: "https://nordlicht.example/schlaf",
    markets: [{ ...LB_DEFAULT_MARKET }],
    quotas: { livePerDay: 1, liveWeekCap: 5 },
    countNofollow: true,
    lowBalanceCredits: 500,
    searchQuery: null,
  };
}

function memoryStore(initial: FakeRunRecord): LinkBuilderFakeStore & {
  steps: FakeStepPlan[];
  current: FakeRunRecord;
} {
  const current = { ...initial };
  const steps: FakeStepPlan[] = [];
  return {
    steps,
    current,
    async runnable() {
      return current.status === "queued" ||
        current.status === "running" ||
        current.status === "overtime"
        ? [{ ...current }]
        : [];
    },
    async apply(record, step) {
      steps.push(step);
      current.stepCount = record.stepCount + 1;
      current.previousAction = step.lastAction;
      if (step.kind === "research") current.researchBeats += 1;
      if (step.kind.startsWith("lb_")) current.stageBeats += 1;
      current.status = step.runStatus;
      current.counters = step.counters;
    },
    async finishIfOpen(record) {
      current.status = record.status === "queued" ? "cancelled" : "partial";
    },
    async publish() {},
  };
}

describe("link builder fake runner", () => {
  it("is on unless the driver flag says otherwise", () => {
    expect(isLinkBuilderFakeEnabled({})).toBe(true);
    expect(isLinkBuilderFakeEnabled({ LINK_BUILDER_DRIVER: "fake" })).toBe(true);
    expect(isLinkBuilderFakeEnabled({ LINK_BUILDER_DRIVER: "off" })).toBe(false);
    expect(isLinkBuilderFakeEnabled({ LINK_BUILDER_DRIVER: "playwright" })).toBe(false);
  });

  it("holds the canned research loop and records a real forum once", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network");
    });
    const quiet = memoryStore(run("running"));
    quiet.current.previousAction = "Continuing";
    for (let guard = 0; guard < 5; guard += 1) {
      expect(await tickLinkBuilderFake(quiet, now)).toBe(0);
    }
    expect(quiet.steps).toEqual([]);
    const sample = memoryStore(run("running"));
    sample.current.forumName = "gutefrage.net";
    sample.current.threadName = "Vitamin D im Winter?";
    const stepped: number[] = [];
    for (let guard = 0; guard < 5; guard += 1) {
      stepped.push(await tickLinkBuilderFake(sample, now));
    }
    expect(stepped).toEqual([1, 1, 0, 0, 0]);
    expect(sample.steps.map((step) => step.lastAction)).toEqual([
      "Found forum gutefrage.net",
      "Found Vitamin D im Winter?",
    ]);
    expect(sample.steps.every((step) => step.kind === "research")).toBe(true);
    expect(sample.steps.every((step) => step.host === undefined)).toBe(true);
    expect(sample.steps.every((step) => step.placement === undefined)).toBe(true);
    expect(
      sample.steps.every((step) => step.captcha === undefined && step.ticket === undefined),
    ).toBe(true);
    expect(JSON.stringify(sample.steps)).not.toContain(".example");
    expect(JSON.stringify(sample.steps)).not.toMatch(
      /Checking Google for on-topic forums|captcha|solved it|LIVE quota|Parked|Verify/i,
    );
    expect(sample.current.status).toBe("running");
    expect(sample.current.counters).toEqual(run().counters);
    vi.unstubAllGlobals();
  });

  it("records the problem query once and does not register or place a link", async () => {
    const magnesium = memoryStore(run("running"));
    magnesium.current.brandName = "Vitaminexpress";
    magnesium.current.searchQuery = "Magnesium Krämpfe Forum";
    expect(await tickLinkBuilderFake(magnesium, now)).toBe(1);
    expect(await tickLinkBuilderFake(magnesium, now)).toBe(0);
    expect(magnesium.steps.map((step) => step.lastAction)).toEqual([
      "Searched Google.de for Magnesium Krämpfe Forum",
    ]);
    expect(magnesium.steps.every((step) => step.host === undefined)).toBe(true);
    expect(magnesium.steps.every((step) => step.placement === undefined)).toBe(true);
    expect(JSON.stringify(magnesium.steps)).not.toMatch(/vitaminexpress|kaufen|register/i);
    const shop = memoryStore(run("running"));
    shop.current.brandName = "Vitaminexpress";
    shop.current.searchQuery = "Vitaminexpress Magnesium kaufen forum";
    expect(await tickLinkBuilderFake(shop, now)).toBe(0);
    expect(shop.steps).toEqual([]);
  });
});
