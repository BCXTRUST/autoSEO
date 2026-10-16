import type { BrowserSession, SearchProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { sampleForumHtml, startRunCounters } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import { discoverDueProjects } from "./link-builder-discovery.js";
import { REAL_STEP_HANDLERS, type StepContext } from "./link-builder-real-steps.js";

function browserWith(links: Array<{ text: string; href: string }>): () => Promise<BrowserSession> {
  return async () =>
    ({
      goto: async () => undefined,
      url: async () => "https://www.google.de/search?q=problem",
      pageText: async () => "Foren",
      listAnchors: async () => links,
      exists: async () => false,
      attribute: async () => null,
      click: async () => undefined,
      close: async () => undefined,
    }) as BrowserSession;
}

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
    const failed = steps.find((step) => step.outcome.lastAction?.startsWith("Search failed:"));
    expect(failed?.kind).toBe("discover");
    expect(failed?.error).toBe("upstream 401");
    expect(runLastAction?.startsWith("Search failed:")).toBe(true);
    expect(steps[0]?.outcome.lastAction?.startsWith("Browser search")).toBe(true);
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
        update: async () => ({}),
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
    expect(searches).toBe(afterPartial + 1);
    expect(hostsCreated).toBeGreaterThan(0);
    const partials = steps.filter((step) =>
      step.outcome.lastAction?.startsWith("Search used partial results:"),
    );
    expect(partials).toHaveLength(1);
    expect(partials[0]?.error).toBeNull();
    expect(partials[0]?.outcome.lastAction?.startsWith("Search used partial results:")).toBe(true);
    expect(partials[0]?.outcome.lastAction).toContain("status ");
    expect(partials).toHaveLength(1);
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
    const failed = steps.find((step) => step.error?.includes("status 20000/40101"));
    expect(failed?.error).toContain("status 20000/40101");
    expect(runLastAction?.startsWith("Search failed:")).toBe(true);
    expect(runLastAction).toContain("status 20000/40101");
    expect(steps.filter((step) => step.error?.includes("40101"))).toHaveLength(1);
  });

  it("does not call DataForSEO when the browser returns an allowed forum", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    let searches = 0;
    let hostsCreated = 0;
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            name: "Nordlicht",
            brandName: "Nordlicht",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: ["medizin-forum.de"],
          },
        ],
        update: async () => ({}),
      },
      lbHost: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async (args: { data: { registrableDomain: string } }) => {
          hostsCreated += 1;
          return { id: "host-allowed", registrableDomain: args.data.registrableDomain };
        },
      },
      lbThreadCandidate: { upsert: async () => ({}) },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
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
        searches += 1;
        return [];
      },
    } satisfies SearchProvider;
    const html = sampleForumHtml({ platform: "phpbb" });
    await discoverDueProjects({
      prisma,
      search,
      now,
      openBrowser: browserWith([
        { text: "Google", href: "https://www.google.de/search?q=magnesium" },
        { text: "Denied", href: "https://medizin-forum.de/viewtopic.php?t=1" },
        { text: "Forum", href: "https://gartentipps.example/viewtopic.php?t=9" },
      ]),
      fetchImpl: async (url) => {
        if (String(url).includes("gartentipps.example")) {
          return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    expect(searches).toBe(0);
    expect(hostsCreated).toBe(1);
    expect(steps[0]?.outcome.lastAction?.startsWith("Searched the browser:")).toBe(true);
    expect(steps.some((step) => step.outcome.lastAction?.includes("vitaminexpress"))).toBe(false);
  });

  it("calls DataForSEO once when the browser returns nothing", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    let searches = 0;
    const queries: string[] = [];
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    let costs = 0;
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            name: "Nordlicht",
            brandName: "Nordlicht",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
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
      lbHost: { findMany: async () => [] },
      lbCostEntry: {
        create: async () => {
          costs += 1;
          return {};
        },
      },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
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
      search: async (request: { query: string }) => {
        searches += 1;
        queries.push(request.query);
        return [];
      },
    } satisfies SearchProvider;
    await discoverDueProjects({
      prisma,
      search,
      now,
      openBrowser: browserWith([]),
    });
    expect(searches).toBe(1);
    expect(costs).toBe(1);
    const browserLine = steps[0]?.outcome.lastAction ?? "";
    expect(browserLine).toMatch(/^Searched the browser: .+ — 0 forums$/);
    const browserQuery = browserLine
      .slice("Searched the browser: ".length)
      .replace(/ — 0 forums$/, "");
    expect(queries[0]).not.toBe(browserQuery);
    expect(
      steps.filter((step) => step.outcome.lastAction?.startsWith("Searched the browser")),
    ).toHaveLength(1);
  });

  it("searches in the browser before a stored forum and does not sign that forum up", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    let searches = 0;
    const order: string[] = [];
    const steps: unknown[] = [];
    const stored = [
      {
        id: "ready-denied",
        registrableDomain: "medizin-forum.de",
        status: "ready",
        statusReason: null,
        accounts: [{ id: "acct-denied" }],
        placements: [],
        platform: "phpbb",
        qualityScore: 9,
        homepageUrl: "https://medizin-forum.de/",
        createdAt: new Date("2026-10-16T08:00:00.000Z"),
      },
      {
        id: "newer",
        registrableDomain: "science-fitness.de",
        status: "qualified",
        statusReason: null,
        accounts: [],
        placements: [],
        platform: "phpbb",
        qualityScore: 8,
        homepageUrl: "https://science-fitness.de/",
        createdAt: new Date("2026-10-16T12:00:00.000Z"),
      },
      {
        id: "oldest",
        registrableDomain: "aquacomputer.de",
        status: "qualified",
        statusReason: null,
        accounts: [],
        placements: [],
        platform: "phpbb",
        qualityScore: 1,
        homepageUrl: "https://aquacomputer.de/",
        createdAt: new Date("2026-10-16T09:00:00.000Z"),
      },
      {
        id: "middle",
        registrableDomain: "edubily.de",
        status: "qualified",
        statusReason: null,
        accounts: [],
        placements: [],
        platform: "phpbb",
        qualityScore: 5,
        homepageUrl: "https://edubily.de/",
        createdAt: new Date("2026-10-16T11:00:00.000Z"),
      },
    ];
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            name: "Nordlicht",
            brandName: "Nordlicht",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: ["frauenselbsthilfe.de"],
          },
        ],
        update: async () => ({}),
      },
      lbHost: { findMany: async () => stored },
      lbCostEntry: { create: async () => ({}) },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
      },
      lbRunStep: {
        findFirst: async () => null,
        findMany: async () => [],
        count: async () => 0,
        create: async (args: { data: unknown }) => {
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
        order.push("dataforseo");
        return [];
      },
    } satisfies SearchProvider;
    await discoverDueProjects({
      prisma,
      search,
      now,
      prepareComputer: async () => {
        order.push("computer");
      },
      openBrowser: async () => {
        order.push("browser");
        return browserWith([])();
      },
    });
    const chosen = await REAL_STEP_HANDLERS.select_host({
      now,
      run: { id: "run-1", counters: startRunCounters() },
      project: {
        id: "p1",
        workspaceId: "w1",
        denyHosts: ["frauenselbsthilfe.de"],
        preferHosts: [],
        quotas: { newPerDay: 2 },
        schedule: { timezone: "Europe/Berlin" },
      },
      host: null,
      pool: () => undefined,
      services: { prisma },
    } as unknown as StepContext);
    expect(order[0]).toBe("computer");
    expect(order[1]).toBe("browser");
    expect(searches).toBe(1);
    expect(order.indexOf("browser")).toBeLessThan(order.indexOf("dataforseo"));
    expect(steps.length).toBeGreaterThan(0);
    expect(chosen).toMatchObject({ kind: "step", hostId: null });
    if (chosen.kind === "step") {
      expect(chosen.lastAction).not.toMatch(/aquacomputer|edubily|science-fitness/);
    }
  });

  it("pauses when the browser search and the one DataForSEO call both fail", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    let searches = 0;
    let browsers = 0;
    let paused = "";
    let released = 0;
    const steps: Array<{ outcome: { lastAction?: string }; error: string | null }> = [];
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            name: "Nordlicht",
            brandName: "Nordlicht",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: ["medizin-forum.de"],
          },
        ],
        update: async () => ({}),
        updateMany: async (args: { data: { status: string } }) => {
          paused = args.data.status;
          return { count: 1 };
        },
      },
      lbHost: { findMany: async () => [] },
      lbCostEntry: { create: async () => ({}) },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
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
        searches += 1;
        throw new Error("status 20000/40501 Invalid Field");
      },
    } satisfies SearchProvider;
    await discoverDueProjects({
      prisma,
      search,
      now,
      prepareComputer: async () => undefined,
      openBrowser: async () => {
        browsers += 1;
        throw new Error("browser down");
      },
      releaseSearchDesktop: async () => {
        released += 1;
      },
    });
    expect(browsers).toBe(1);
    expect(searches).toBe(1);
    expect(paused).toBe("paused");
    expect(released).toBe(1);
    expect(
      steps.some((step) => step.outcome.lastAction?.startsWith("Browser search failed:")),
    ).toBe(true);
    expect(steps.some((step) => step.outcome.lastAction?.startsWith("Search failed:"))).toBe(true);
    expect(steps.some((step) => step.outcome.lastAction?.startsWith("Skipped"))).toBe(false);
  });

  it("searches when nothing is startable even though discovery already ran today", async () => {
    const now = new Date("2026-10-16T17:36:00.000Z");
    let browsers = 0;
    let searches = 0;
    const hosts: Array<{
      registrableDomain: string;
      status: string;
      accounts: Array<{ id: string }>;
    }> = [
      { registrableDomain: "aquacomputer.de", status: "form_not_found", accounts: [] },
      { registrableDomain: "edubily.de", status: "form_not_found", accounts: [] },
      { registrableDomain: "science-fitness.de", status: "form_not_found", accounts: [] },
      { registrableDomain: "medizin-forum.de", status: "qualified", accounts: [] },
      { registrableDomain: "phpbb.de", status: "ready", accounts: [{ id: "acct-phpbb" }] },
      { registrableDomain: "macuser.de", status: "warming", accounts: [] },
      { registrableDomain: "lifters-lounge.com", status: "qualified", accounts: [] },
      { registrableDomain: "frauenselbsthilfe.de", status: "qualified", accounts: [] },
      { registrableDomain: "bulli-forum.com", status: "dead", accounts: [] },
      { registrableDomain: "denied.example", status: "qualified", accounts: [] },
      { registrableDomain: "brett-1ej2xe.example", status: "qualified", accounts: [] },
    ];
    const steps: Array<{
      kind: string;
      finishedAt: Date;
      outcome: { lastAction?: string };
    }> = [];
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            name: "Nordlicht",
            brandName: "Nordlicht",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: now,
            schedule: { timezone: "Europe/Berlin" },
            markets: [
              { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
            ],
            topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
            marketPolicy: "primary_first",
            quotas: { livePerDay: 1 },
            denyHosts: ["denied.example"],
          },
        ],
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      lbHost: { findMany: async () => hosts },
      lbCostEntry: { create: async () => ({}) },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
      },
      lbRunStep: {
        findFirst: async () => null,
        findMany: async () => steps.filter((step) => step.kind === "discover"),
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
        return [];
      },
    } satisfies SearchProvider;
    const open = async () => {
      browsers += 1;
      return browserWith([])();
    };
    await discoverDueProjects({
      prisma,
      search,
      now,
      prepareComputer: async () => undefined,
      openBrowser: open,
    });
    expect(browsers).toBe(1);
    expect(searches).toBe(1);

    steps.length = 0;
    hosts.push({
      registrableDomain: "gartentipps.de",
      status: "qualified",
      accounts: [],
    });
    await discoverDueProjects({
      prisma,
      search,
      now,
      prepareComputer: async () => undefined,
      openBrowser: open,
    });
    expect(browsers).toBe(1);
    expect(searches).toBe(1);

    hosts.pop();
    steps.push({
      kind: "discover",
      finishedAt: new Date(now.getTime() - 60_000),
      outcome: { lastAction: "Searched the browser: Magnesium Schlaf Forum" },
    });
    await discoverDueProjects({
      prisma,
      search,
      now: new Date(now.getTime() + 2_000),
      prepareComputer: async () => undefined,
      openBrowser: open,
    });
    expect(browsers).toBe(1);
    expect(searches).toBe(1);

    steps[0] = {
      kind: "discover",
      finishedAt: new Date(now.getTime() - 16 * 60_000),
      outcome: { lastAction: "Searched the browser: Magnesium Schlaf Forum" },
    };
    await discoverDueProjects({
      prisma,
      search,
      now,
      prepareComputer: async () => undefined,
      openBrowser: open,
    });
    expect(browsers).toBe(2);
    expect(searches).toBe(2);
  });

  it("solves a sorry page from an iframe key and then keeps the forum", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    let hostsCreated = 0;
    let searches = 0;
    let solvedKey = "";
    const html = sampleForumHtml({ platform: "phpbb" });
    const prisma = discoveryPrisma(steps, () => {
      hostsCreated += 1;
    });
    let blocked = true;
    const session = {
      goto: async () => undefined,
      url: async () =>
        blocked ? "https://www.google.com/sorry/index" : "https://www.google.de/search?q=problem",
      pageText: async () => (blocked ? "unusual traffic" : "Foren Ergebnisse captcha tipp"),
      pageHtml: async () =>
        `<script src="https://www.google.com/recaptcha/api2/anchor?k=6LcSorryKey12345678"></script>`,
      listAnchors: async () =>
        blocked
          ? []
          : [
              {
                text: "",
                href: "https://www.google.com/url?q=https://gartentipps.example/viewtopic.php%3Ft%3D9",
              },
            ],
      exists: async (selector: string) => selector.includes("submit"),
      attribute: async () => null,
      click: async () => {
        blocked = false;
      },
      injectToken: async () => undefined,
      close: async () => undefined,
    } as BrowserSession;
    await discoverDueProjects({
      prisma,
      search: countingSearch(() => {
        searches += 1;
      }),
      now,
      openBrowser: async () => session,
      resolveCaptcha: async () => ({
        describe: () => ({
          id: "captell",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: { image: false, token: true, question: false },
        }),
        solve: async (request: { websiteKey: string }) => {
          solvedKey = request.websiteKey;
          return { answer: "token", credits: 1 };
        },
        balance: async () => ({ credits: 1 }),
        answerQuestion: async () => ({ couldNotAnswer: true as const }),
      }),
      fetchImpl: async (url) => {
        if (String(url).includes("gartentipps.example")) {
          return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    expect(solvedKey).toBe("6LcSorryKey12345678");
    expect(hostsCreated).toBe(1);
    expect(searches).toBe(0);
    expect(
      steps.some((step) => step.outcome.lastAction === "Searched the browser: Magnesium Schlaf"),
    ).toBe(false);
    expect(steps[0]?.outcome.lastAction).toMatch(/Searched the browser: .+ — 1 forums$/);
  });

  it("does not treat a results snippet that says captcha as a block", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    let solves = 0;
    const html = sampleForumHtml({ platform: "phpbb" });
    await discoverDueProjects({
      prisma: discoveryPrisma(steps),
      search: countingSearch(() => undefined),
      now,
      resolveCaptcha: async () => {
        solves += 1;
        return null;
      },
      openBrowser: async () =>
        ({
          goto: async () => undefined,
          url: async () => "https://www.google.de/search?q=problem",
          pageText: async () => "Forum thread about a captcha on the board",
          listAnchors: async () => [
            { text: "Forum", href: "https://gartentipps.example/viewtopic.php?t=9" },
          ],
          exists: async () => false,
          close: async () => undefined,
        }) as BrowserSession,
      fetchImpl: async (url) => {
        if (String(url).includes("gartentipps.example")) {
          return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    expect(solves).toBe(0);
    expect(steps.some((step) => step.outcome.lastAction?.includes("captcha"))).toBe(false);
    expect(steps[0]?.outcome.lastAction).toMatch(/— 1 forums$/);
  });

  it("keeps a forum link after twenty Google anchors when the link has no text", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    let created = "";
    const google = Array.from({ length: 20 }, (_, index) => ({
      text: "Google",
      href: `https://www.google.de/search?q=${index}`,
    }));
    const html = `<html><body><a href="/register">Registrieren</a></body></html>`;
    await discoverDueProjects({
      prisma: discoveryPrisma(steps, (domain) => {
        created = domain;
      }),
      search: countingSearch(() => undefined),
      now,
      openBrowser: browserWith([
        ...google,
        { text: "", href: "https://www.google.com/url?q=https://neu.example/forum/thread/1" },
      ]),
      fetchImpl: async (url) => {
        if (String(url).includes("neu.example")) {
          return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
        }
        return new Response("no", { status: 404 });
      },
    });
    expect(created).toBe("neu.example");
    expect(steps[0]?.outcome.lastAction).toMatch(/— 1 forums$/);
  });

  it("records captcha before any DataForSEO call and does not store the query alone", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const steps: Array<{ outcome: { lastAction?: string } }> = [];
    const order: string[] = [];
    await discoverDueProjects({
      prisma: discoveryPrisma(steps),
      search: {
        describe: () => ({
          id: "fake-search",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: { maxDepth: 10, operators: false },
        }),
        search: async () => {
          order.push(steps.map((step) => step.outcome.lastAction).join("|"));
          return [];
        },
      },
      now,
      openBrowser: async () =>
        ({
          goto: async () => undefined,
          url: async () => "https://www.google.com/sorry/index",
          pageText: async () => "ungewöhnlicher datenverkehr",
          pageHtml: async () => "<html></html>",
          listAnchors: async () => [],
          exists: async () => false,
          attribute: async () => null,
          close: async () => undefined,
        }) as BrowserSession,
      resolveCaptcha: async () => null,
    });
    expect(steps[0]?.outcome.lastAction).toBe("Browser search failed: captcha");
    expect(
      steps.some((step) => step.outcome.lastAction === "Searched the browser: Magnesium Schlaf"),
    ).toBe(false);
    expect(order[0]).toContain("captcha");
  });

  it("restores a dead host from a register link and a later form, and leaves denied and down hosts", async () => {
    const now = new Date("2026-10-16T21:00:00.000Z");
    const hosts = [
      hostRow("back", "hardwareluxx.de", "dead"),
      hostRow("shop", "nike.com", "dead"),
      hostRow("denied", "medizin-forum.de", "dead"),
      hostRow("down", "office-fragen.de", "dead"),
      hostRow("fixture", "brett-1ej2xe.example", "dead"),
      hostRow("psychic", "psychic.de", "dead"),
    ];
    const fetched: string[] = [];
    let searches = 0;
    let paused = 0;
    const steps: Array<{ outcome: { lastAction?: string; restored?: unknown } }> = [];
    const pages: Record<string, string> = {
      "https://hardwareluxx.de/": '<a href="/register/">Registrieren</a>',
      "https://hardwareluxx.de/register/":
        '<h1>Forumregeln</h1><a href="/register/form">Weiter</a>',
      "https://hardwareluxx.de/register/form":
        '<form><input type="email" name="email"><input type="password" name="password"></form>',
      "https://nike.com/": "<html><title>Shop</title><p>Shoes</p></html>",
    };
    const prisma = {
      lbProject: {
        findMany: async () => [
          {
            id: "p1",
            workspaceId: "w1",
            status: "active",
            archivedAt: null,
            lastDiscoveredAt: now,
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
        updateMany: async () => {
          paused += 1;
          return { count: 1 };
        },
      },
      lbHost: {
        findMany: async () => hosts,
        updateMany: async (args: {
          where: { id: string; status: string };
          data: { status: string; statusReason: string | null };
        }) => {
          const row = hosts.find((item) => item.id === args.where.id);
          if (row?.status !== "dead" || args.where.status !== "dead") return { count: 0 };
          row.status = args.data.status;
          row.statusReason = args.data.statusReason;
          return { count: 1 };
        },
      },
      lbRun: {
        findFirst: async () => ({
          id: "run-1",
          status: "running",
          projectId: "p1",
          workspaceId: "w1",
        }),
        update: async () => ({}),
      },
      lbRunStep: {
        findMany: async () => steps,
        count: async () => steps.length,
        create: async (args: { data: (typeof steps)[number] }) => {
          steps.push(args.data);
          return args.data;
        },
      },
    } as unknown as PrismaClient;
    await discoverDueProjects({
      prisma,
      search: countingSearch(() => {
        searches += 1;
      }),
      now,
      openBrowser: async () => {
        throw new Error("browser must stay closed during the re-probe");
      },
      fetchImpl: async (url) => {
        const key = String(url);
        fetched.push(key);
        const html = pages[key];
        if (!html) return new Response("down", { status: 503 });
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    expect(hosts.find((row) => row.id === "back")).toMatchObject({
      status: "qualified",
      statusReason: null,
    });
    expect(hosts.find((row) => row.id === "shop")).toMatchObject({
      status: "form_not_found",
      statusReason: "no_signup_form",
    });
    expect(hosts.find((row) => row.id === "denied")?.status).toBe("dead");
    expect(hosts.find((row) => row.id === "down")?.status).toBe("dead");
    expect(hosts.find((row) => row.id === "fixture")?.status).toBe("dead");
    expect(hosts.find((row) => row.id === "psychic")?.status).toBe("dead");
    expect(fetched.some((url) => /medizin-forum|brett-1ej2xe|psychic/.test(url))).toBe(false);
    expect(searches).toBe(0);
    expect(paused).toBe(0);
    expect(steps[0]?.outcome.lastAction).toBe("Re-probed dead hosts: 2 came back");
    expect(steps.some((step) => step.outcome.lastAction?.includes("failed"))).toBe(false);
  });
});

function hostRow(id: string, domain: string, status: string) {
  return {
    id,
    status,
    statusReason: "unknown_platform",
    registrableDomain: domain,
    homepageUrl: `https://${domain}/`,
  };
}

function countingSearch(onSearch: () => void): SearchProvider {
  return {
    describe: () => ({
      id: "fake-search",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { maxDepth: 10, operators: false },
    }),
    search: async () => {
      onSearch();
      return [];
    },
  };
}

function discoveryPrisma(
  steps: Array<{ outcome: { lastAction?: string } }>,
  onCreate?: (domain: string) => void,
): PrismaClient {
  return {
    lbProject: {
      findMany: async () => [
        {
          id: "p1",
          workspaceId: "w1",
          name: "Nordlicht",
          brandName: "Nordlicht",
          status: "active",
          archivedAt: null,
          lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
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
      updateMany: async () => ({ count: 1 }),
    },
    lbHost: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async (args: { data: { registrableDomain: string } }) => {
        onCreate?.(args.data.registrableDomain);
        return { id: "host-new", registrableDomain: args.data.registrableDomain };
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
      update: async () => ({}),
    },
    lbRunStep: {
      findFirst: async () => null,
      findMany: async () => [],
      count: async () => steps.length,
      create: async (args: { data: (typeof steps)[number] }) => {
        steps.push(args.data);
        return args.data;
      },
    },
  } as unknown as PrismaClient;
}
