import type { SearchProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { discoverDueProjects } from "./link-builder-discovery.js";

describe("discoverDueProjects", () => {
  it("records one failed search and does not search again within 15 minutes", async () => {
    const lastDiscoveredAt = new Date("2026-10-15T09:10:11.995Z");
    const now = new Date("2026-10-16T10:00:00.000Z");
    let projectUpdates = 0;
    let searches = 0;
    const steps: Array<{
      kind: string;
      error: string | null;
      finishedAt: Date;
      outcome: { lastAction?: string };
    }> = [];
    let runLastAction: string | null = null;
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt,
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [
              { id: "lane", tag: "Einschlafprobleme", description: "nicht einschlafen" },
            ],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: [],
          },
        ],
        update: async () => {
          projectUpdates += 1;
          return {};
        },
      },
      lbHost: { findMany: async () => [] },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async (args: { data: { lastAction: string } }) => {
          runLastAction = args.data.lastAction;
          return {};
        },
      },
      lbRunStep: {
        findFirst: async (args?: { where?: { kind?: string; error?: { not: null } } }) => {
          const kind = args?.where?.kind;
          const requireError = Boolean(args?.where?.error);
          for (let index = steps.length - 1; index >= 0; index -= 1) {
            const step = steps[index];
            if (!step) continue;
            if (kind && step.kind !== kind) continue;
            if (requireError && !step.error) continue;
            return step;
          }
          return null;
        },
        count: async () => steps.length,
        create: async (args: { data: (typeof steps)[number] }) => {
          steps.push(args.data);
          return args.data;
        },
      },
    } as unknown as PrismaClient;
    const search = {
      describe: () => ({
        id: "fake-search",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { maxDepth: 10, operators: false },
      }),
      search: async () => {
        searches += 1;
        throw new Error("upstream 401");
      },
    } satisfies SearchProvider;

    await discoverDueProjects({ prisma, search, now });
    steps.push({
      kind: "select_host",
      error: null,
      finishedAt: new Date(now.getTime() + 1_000),
      outcome: { lastAction: "Skipped 8 denied forums" },
    });
    await discoverDueProjects({
      prisma,
      search,
      now: new Date(now.getTime() + 60_000),
    });

    expect(searches).toBe(1);
    expect(projectUpdates).toBe(0);
    expect(steps.filter((step) => step.kind === "discover")).toHaveLength(1);
    expect(steps[0]?.kind).toBe("discover");
    expect(steps[0]?.error).toBe("upstream 401");
    expect(steps[0]?.outcome.lastAction?.startsWith("Search failed:")).toBe(true);
    expect(runLastAction?.startsWith("Search failed:")).toBe(true);
  });

  it("records partial results once and still searches on the next pass", async () => {
    const lastDiscoveredAt = new Date("2026-10-15T09:10:11.995Z");
    const now = new Date("2026-10-16T10:00:00.000Z");
    let searches = 0;
    let hostsCreated = 0;
    const steps: Array<{
      kind: string;
      error: string | null;
      finishedAt: Date;
      outcome: { lastAction?: string };
    }> = [];
    let runLastAction: string | null = null;
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt,
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: [],
          },
        ],
        update: async () => ({}),
      },
      lbHost: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => {
          hostsCreated += 1;
          return { id: "host-1" };
        },
      },
      lbThreadCandidate: { upsert: async () => ({}) },
      lbCostEntry: { create: async () => ({}) },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async (args: { data: { lastAction: string } }) => {
          runLastAction = args.data.lastAction;
          return {};
        },
      },
      lbRunStep: {
        findFirst: async (args?: { where?: { kind?: string; error?: { not: null } } }) => {
          const kind = args?.where?.kind;
          const requireError = Boolean(args?.where?.error);
          for (let index = steps.length - 1; index >= 0; index -= 1) {
            const step = steps[index];
            if (!step) continue;
            if (kind && step.kind !== kind) continue;
            if (requireError && !step.error) continue;
            return step;
          }
          return null;
        },
        count: async () => steps.length,
        create: async (args: { data: (typeof steps)[number] }) => {
          steps.push(args.data);
          return args.data;
        },
      },
    } as unknown as PrismaClient;
    const search = {
      partialNotice: null as string | null,
      describe: () => ({
        id: "fake-search",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { maxDepth: 10, operators: false },
      }),
      search: async () => {
        searches += 1;
        search.partialNotice = "status 20000/40106 Task completed with partial results.";
        return [
          {
            url: "https://gartentipps.example/viewtopic.php?t=1",
            title: "Garten",
            snippet: "",
            domain: "gartentipps.example",
          },
        ];
      },
    } satisfies SearchProvider & { partialNotice: string | null };

    await discoverDueProjects({
      prisma,
      search,
      now,
      fetchImpl: async () => new Response("no", { status: 404 }),
    });
    const afterPartial = searches;
    const full = {
      partialNotice: null as string | null,
      describe: search.describe,
      search: async () => {
        searches += 1;
        full.partialNotice = null;
        return [
          {
            url: "https://gartentipps.example/viewtopic.php?t=2",
            title: "Garten",
            snippet: "",
            domain: "gartentipps.example",
          },
        ];
      },
    } satisfies SearchProvider & { partialNotice: string | null };
    await discoverDueProjects({
      prisma,
      search: full,
      now: new Date(now.getTime() + 60_000),
      fetchImpl: async () => new Response("no", { status: 404 }),
    });

    expect(afterPartial).toBe(1);
    expect(searches).toBeGreaterThan(afterPartial + 1);
    expect(hostsCreated).toBeGreaterThan(0);
    const partials = steps.filter((step) => step.kind === "discover");
    expect(partials).toHaveLength(1);
    expect(partials[0]?.error).toBeNull();
    expect(partials[0]?.outcome.lastAction?.startsWith("Search used partial results:")).toBe(true);
    expect(partials[0]?.outcome.lastAction).toContain("status ");
    expect(runLastAction?.startsWith("Search used partial results:")).toBe(true);
    expect(runLastAction).toContain("status ");
  });

  it("records a provider status when search throws", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const steps: Array<{
      kind: string;
      error: string | null;
      outcome: { lastAction?: string };
    }> = [];
    let runLastAction: string | null = null;
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: [],
          },
        ],
        update: async () => ({}),
      },
      lbHost: { findMany: async () => [] },
      lbRun: {
        findFirst: async () => ({ id: "run-1", status: "running", projectId: "p1" }),
        update: async (args: { data: { lastAction: string } }) => {
          runLastAction = args.data.lastAction;
          return {};
        },
      },
      lbRunStep: {
        findFirst: async () => null,
        count: async () => steps.length,
        create: async (args: { data: (typeof steps)[number] }) => {
          steps.push(args.data);
          return args.data;
        },
      },
    } as unknown as PrismaClient;
    const search = {
      describe: () => ({
        id: "fake-search",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { maxDepth: 10, operators: false },
      }),
      search: async () => {
        throw new Error("status 20000/40101 Internal SE Server Error.");
      },
    } satisfies SearchProvider;
    await discoverDueProjects({ prisma, search, now });
    expect(steps[0]?.error).toContain("status 20000/40101");
    expect(runLastAction?.startsWith("Search failed:")).toBe(true);
    expect(runLastAction).toContain("status 20000/40101");
  });
});
