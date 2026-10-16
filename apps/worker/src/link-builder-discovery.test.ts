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
        findFirst: async () => steps.at(-1) ?? null,
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
    await discoverDueProjects({
      prisma,
      search,
      now: new Date(now.getTime() + 60_000),
    });

    expect(searches).toBe(1);
    expect(projectUpdates).toBe(0);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("discover");
    expect(steps[0]?.error).toBe("upstream 401");
    expect(steps[0]?.outcome.lastAction?.startsWith("Search failed:")).toBe(true);
    expect(runLastAction?.startsWith("Search failed:")).toBe(true);
  });
});
