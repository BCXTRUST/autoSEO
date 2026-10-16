import { describe, expect, it } from "vitest";
import { hostState } from "./host-state.js";
import { isWarmupMet, planRealStep, type RealPlanInput } from "./real-pipeline.js";

const noSession = {
  hostId: null,
  helperConnected: false,
  cookieChecked: false,
  registerFormReady: false,
};
const onHost = {
  hostId: "h1",
  helperConnected: true,
  cookieChecked: false,
  registerFormReady: false,
};

function input(overrides: Partial<RealPlanInput>): RealPlanInput {
  return {
    runStatus: "running",
    liveMet: false,
    host: { id: "h1", ...hostState("qualified") },
    session: noSession,
    warmupMet: true,
    placement: null,
    ...overrides,
  };
}

describe("planRealStep", () => {
  it("stops on terminal runs and waits on paused runs", () => {
    expect(planRealStep(input({ runStatus: "succeeded" }))).toEqual({ kind: "done" });
    expect(planRealStep(input({ runStatus: "failed" }))).toEqual({ kind: "done" });
    expect(planRealStep(input({ runStatus: "paused" }))).toEqual({
      kind: "wait",
      reason: "paused",
    });
  });

  it("closes once the daily goal is met", () => {
    expect(planRealStep(input({ liveMet: true }))).toEqual({ kind: "close" });
  });

  it("selects a host when none is workable", () => {
    expect(planRealStep(input({ host: null }))).toEqual({ kind: "select_host" });
    for (const status of ["used", "dead", "discovered", "pending_admin"] as const) {
      expect(planRealStep(input({ host: { id: "h1", ...hostState(status) } }))).toEqual({
        kind: "select_host",
      });
    }
    expect(
      planRealStep(input({ host: { id: "h1", ...hostState("parked_operator", "registering") } })),
    ).toEqual({ kind: "select_host" });
  });

  it("rechecks a site-admin hold only when that check is due", () => {
    const host = { id: "h1", ...hostState("pending_admin") };
    expect(planRealStep(input({ host }))).toEqual({ kind: "select_host" });
    expect(planRealStep(input({ host, adminCheckDue: true }))).toEqual({ kind: "open_session" });
    expect(
      planRealStep(
        input({
          host,
          adminCheckDue: true,
          session: { ...onHost, helperConnected: false },
        }),
      ),
    ).toEqual({ kind: "helper_connected" });
    expect(
      planRealStep(
        input({ host, adminCheckDue: true, session: { ...onHost, helperConnected: true } }),
      ),
    ).toEqual({ kind: "admin_check" });
  });

  it("opens a session before any browser step on a new host", () => {
    expect(planRealStep(input({}))).toEqual({ kind: "open_session" });
    expect(
      planRealStep(
        input({
          session: {
            hostId: "other",
            helperConnected: true,
            cookieChecked: true,
            registerFormReady: true,
          },
        }),
      ),
    ).toEqual({ kind: "open_session" });
  });

  it("checks the Page Helper before the first browser action on a host", () => {
    expect(planRealStep(input({ session: { ...onHost, helperConnected: false } }))).toEqual({
      kind: "helper_connected",
    });
  });

  it("walks the registration funnel in order", () => {
    expect(planRealStep(input({ session: onHost }))).toEqual({ kind: "cookie_wall" });
    expect(planRealStep(input({ session: { ...onHost, cookieChecked: true } }))).toEqual({
      kind: "register",
    });
    const registering = { id: "h1", ...hostState("registering") };
    expect(planRealStep(input({ host: registering, session: onHost }))).toEqual({
      kind: "register",
    });
    expect(
      planRealStep(input({ host: registering, session: { ...onHost, registerFormReady: true } })),
    ).toEqual({ kind: "captcha" });
    expect(
      planRealStep(input({ host: { id: "h1", ...hostState("pending_email") }, session: onHost })),
    ).toEqual({
      kind: "email_verify",
    });
  });

  it("registers a chosen host instead of parking it on research", () => {
    expect(
      planRealStep(
        input({
          researchComplete: true,
          session: { ...onHost, cookieChecked: true },
        }),
      ),
    ).toEqual({ kind: "register" });
  });

  it("does not plan a post after email verification pauses the run", () => {
    const warming = { id: "h1", ...hostState("warming") };
    const plan = planRealStep(
      input({
        runStatus: "paused",
        host: warming,
        session: { ...onHost, cookieChecked: true },
        warmupMet: false,
        warmupPostsShort: true,
        minPostsBeforeLink: 0,
        warmupPosts: 0,
      }),
    );
    expect(plan.kind).not.toBe("post");
    expect(plan.kind).not.toBe("warmup_post");
    expect(plan).toEqual({ kind: "wait", reason: "paused" });
  });

  it("refuses to register before research and to link before warmup", () => {
    expect(planRealStep(input({ researchComplete: false, session: onHost }))).toEqual({
      kind: "wait",
      reason: "research",
    });
    const ready = { id: "h1", ...hostState("ready") };
    expect(
      planRealStep(
        input({
          host: ready,
          session: onHost,
          minPostsBeforeLink: 3,
          warmupPosts: 0,
        }),
      ),
    ).toEqual({ kind: "warmup_post" });
  });

  it("warms up, posts and verifies", () => {
    const warming = { id: "h1", ...hostState("warming") };
    expect(planRealStep(input({ host: warming, warmupMet: true }))).toEqual({ kind: "warmup" });
    expect(planRealStep(input({ host: warming, warmupMet: false }))).toEqual({
      kind: "select_host",
    });
    expect(
      planRealStep(
        input({ host: warming, warmupMet: false, warmupPostsShort: true, session: onHost }),
      ),
    ).toEqual({ kind: "warmup_post" });
    const ready = { id: "h1", ...hostState("ready") };
    expect(planRealStep(input({ host: ready }))).toEqual({ kind: "open_session" });
    expect(planRealStep(input({ host: ready, session: onHost }))).toEqual({ kind: "post" });
    expect(
      planRealStep(input({ host: ready, placement: { status: "pending", counted: false } })),
    ).toEqual({ kind: "verify" });
    expect(
      planRealStep(input({ host: ready, placement: { status: "removed", counted: false } })),
    ).toEqual({ kind: "select_host" });
  });
});

describe("isWarmupMet", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  it("needs both the post count and the account age", () => {
    const base = { now, minPostsBeforeLink: 2, minAccountAgeHours: 24 };
    const old = new Date("2026-10-03T12:00:00Z");
    expect(isWarmupMet({ ...base, postCount: 2, accountCreatedAt: old })).toBe(true);
    expect(isWarmupMet({ ...base, postCount: 1, accountCreatedAt: old })).toBe(false);
    expect(isWarmupMet({ ...base, postCount: 5, accountCreatedAt: now })).toBe(false);
    expect(
      isWarmupMet({
        now,
        minPostsBeforeLink: 0,
        minAccountAgeHours: 0,
        postCount: 0,
        accountCreatedAt: now,
      }),
    ).toBe(true);
  });
});
