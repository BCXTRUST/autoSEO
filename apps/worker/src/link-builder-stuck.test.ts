import { describe, expect, it } from "vitest";
import {
  REAL_STEP_HANDLERS,
  recoverStuckStep,
  type StepContext,
} from "./link-builder-real-steps.js";

function ctx(input: {
  steps: Array<{ outcome: unknown; error: string | null; createdAt: Date }>;
  status?: string;
  computers?: Array<{ state: string; providerRef: string | null; updatedAt: Date }>;
}): StepContext {
  return {
    now: new Date("2026-10-15T12:00:00Z"),
    run: { id: "run-1" },
    project: { id: "project-1", workspaceId: "ws-1" },
    host: null,
    pool: () => undefined,
    services: {
      prisma: {
        lbRunStep: { findMany: async () => input.steps },
        lbProject: { findUnique: async () => ({ status: input.status ?? "active" }) },
        computer: { findMany: async () => input.computers ?? [] },
      },
    },
  } as unknown as StepContext;
}

describe("recoverStuckStep", () => {
  it("leaves a moving step alone", async () => {
    const result = await recoverStuckStep(
      ctx({
        steps: [
          {
            outcome: { lastAction: "Filled the registration form" },
            error: null,
            createdAt: new Date("2026-10-15T11:00:00Z"),
          },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it("waits when the sandbox is gone and has not been replaced", async () => {
    const result = await recoverStuckStep(
      ctx({
        steps: [
          {
            outcome: { lastAction: "Step failed, retrying" },
            error: "SandboxNotFoundError",
            createdAt: new Date("2026-10-15T11:00:00Z"),
          },
        ],
      }),
    );
    expect(result).toEqual({ kind: "wait", reason: "sandbox_gone" });
  });

  it("continues after the viewer stores a new sandbox", async () => {
    const result = await recoverStuckStep(
      ctx({
        steps: [
          {
            outcome: { lastAction: "Step failed, retrying" },
            error: "SandboxNotFoundError",
            createdAt: new Date("2026-10-15T11:00:00Z"),
          },
        ],
        computers: [
          {
            state: "running",
            providerRef: "sb-new",
            updatedAt: new Date("2026-10-15T11:05:00Z"),
          },
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it("looks once, and pauses when that look still cannot see a page", async () => {
    const looked = await recoverStuckStep(
      ctx({
        steps: [
          {
            outcome: { lastAction: "The page did not finish, trying again" },
            error: null,
            createdAt: new Date("2026-10-15T11:00:00Z"),
          },
        ],
      }),
    );
    expect(looked?.kind).toBe("step");
    if (looked?.kind !== "step") return;
    expect(looked.outcome).toMatchObject({ pauseSandbox: true, looked: true });
    expect(looked.lastAction).toBe("Paused, the browser step is stuck");

    const again = await recoverStuckStep(
      ctx({
        status: "paused",
        steps: [
          {
            outcome: { lastAction: "Step failed, retrying", looked: false },
            error: null,
            createdAt: new Date("2026-10-15T11:02:00Z"),
          },
          {
            outcome: { lastAction: "Looking at the page to find the form", looked: true },
            error: null,
            createdAt: new Date("2026-10-15T11:01:00Z"),
          },
        ],
      }),
    );
    expect(again).toEqual({ kind: "wait", reason: "already_paused" });
  });

  it("does not open a thread while the host is registering", async () => {
    const gotos: string[] = [];
    const thread = "https://forum.nordlicht.test/thread-1";
    const session = {
      url: async () => "https://forum.nordlicht.test/register",
      formFields: async () => [],
      listAnchors: async () => [
        { text: "Vitamin question", href: thread },
        { text: "Registrieren", href: "https://forum.nordlicht.test/register" },
      ],
      goto: async (url: string) => {
        gotos.push(url);
      },
      holdForm: async () => undefined,
      releaseForm: async () => undefined,
      exists: async () => false,
    };
    const looked = await recoverStuckStep({
      ...ctx({
        steps: [
          {
            outcome: { lastAction: "The page did not finish, trying again" },
            error: null,
            createdAt: new Date("2026-10-15T11:00:00Z"),
            kind: "register",
          },
        ],
      }),
      host: {
        id: "host-1",
        status: "registering",
        registrableDomain: "forum.nordlicht.test",
        homepageUrl: "https://forum.nordlicht.test/",
      },
      pool: () => ({ session }),
      services: {
        prisma: {
          lbRunStep: {
            findMany: async () => [
              {
                outcome: { lastAction: "The page did not finish, trying again" },
                error: null,
                createdAt: new Date("2026-10-15T11:00:00Z"),
                kind: "register",
              },
            ],
          },
          lbProject: { findUnique: async () => ({ status: "active" }) },
          computer: { findMany: async () => [] },
        },
        textModel: {
          complete: async () => ({ ok: true, value: { action: "other_thread", index: 0 } }),
        },
      },
    } as unknown as StepContext);
    expect(looked?.kind).toBe("step");
    if (looked?.kind !== "step") return;
    expect(looked.outcome).toMatchObject({ looked: true, choice: "find_form" });
    expect(gotos.some((url) => url.includes("thread"))).toBe(false);
  });

  it("does not start a signup on a banned host with no account", async () => {
    const result = await REAL_STEP_HANDLERS.select_host({
      now: new Date("2026-10-15T12:00:00Z"),
      run: { id: "run-1", counters: { newToday: 0 } },
      project: {
        id: "project-1",
        workspaceId: "ws-1",
        denyHosts: [],
        preferHosts: [],
        quotas: { newPerDay: 2 },
        schedule: { timezone: "Europe/Berlin" },
      },
      host: null,
      pool: () => undefined,
      services: {
        prisma: {
          lbHost: {
            findMany: async () => [
              {
                id: "banned",
                registrableDomain: "frauenselbsthilfe.de",
                status: "qualified",
                accounts: [],
                placements: [],
                platform: "phpbb",
                qualityScore: 1,
                homepageUrl: "https://frauenselbsthilfe.de/",
                statusReason: null,
              },
            ],
          },
          lbRunStep: { findMany: async () => [], count: async () => 0 },
        },
      },
    } as unknown as StepContext);
    expect(result).toEqual({
      kind: "step",
      stepKind: "select_host",
      hostId: null,
      lastAction: "Skipped 1 denied forums",
      outcome: { skipped: ["frauenselbsthilfe.de"] },
    });
  });
});
