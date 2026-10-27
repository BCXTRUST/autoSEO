import type { SearchProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { sampleForumHtml } from "@rakazo/linkbuilder-core";
import { expect, it } from "vitest";
import { discoverDueProjects } from "./link-builder-discovery.js";

it("replaces four rejected candidates from saved results until five qualify, beyond old review/search caps", async () => {
  const oldMode = process.env.LINK_BUILDER_BROWSER_SEARCH;
  process.env.LINK_BUILDER_BROWSER_SEARCH = "off";
  const now = new Date("2026-10-27T12:00:00Z");
  const project = {
    id: "project",
    workspaceId: "workspace",
    name: "Signal",
    brandName: "Signal",
    status: "active",
    archivedAt: null,
    lastDiscoveredAt: null,
    schedule: { timezone: "UTC" },
    markets: [{ country: "US", language: "en", locale: "en-US", timezoneId: "America/New_York" }],
    topicLanes: [
      { id: "meditation", tag: "Meditation", description: "Relaxation", exampleQuestions: [] },
    ],
    targets: [],
    denyHosts: [],
    marketPolicy: "primary_first",
    quotas: { livePerDay: 5 },
    content: { researchTargetCount: 5, researchSiteLimit: 20, researchBeforeRegistration: true },
  };
  type Host = { id: string; registrableDomain: string; status: string; lastProbeAt: Date };
  const hosts: Host[] = Array.from({ length: 20 }, (_, i) => ({
    id: `old-${i}`,
    registrableDomain: `old-${i}.test`,
    status: "off_topic",
    lastProbeAt: now,
  }));
  const steps: { outcome: Record<string, unknown>; error: string | null; finishedAt: Date }[] = [];
  let searches = 0;
  let paused = false;
  const prisma = {
    lbProject: {
      findMany: async () => [project],
      update: async () => project,
      updateMany: async () => {
        paused = true;
        return { count: 1 };
      },
    },
    lbHost: {
      findMany: async () => hosts.map((host) => ({ ...host, accounts: [] })),
      count: async (args: { where: { status?: string | { in: string[] } } }) => {
        const status = args.where.status;
        if (status === "warming") return 0;
        return typeof status === "object"
          ? hosts.filter((host) => status.in.includes(host.status)).length
          : hosts.length;
      },
      findUnique: async (args: {
        where: { workspaceId_projectId_registrableDomain: { registrableDomain: string } };
      }) =>
        hosts.find(
          (host) =>
            host.registrableDomain ===
            args.where.workspaceId_projectId_registrableDomain.registrableDomain,
        ) ?? null,
      create: async (args: { data: Omit<Host, "id"> }) => {
        const host = { id: `new-${hosts.length}`, ...args.data };
        hosts.push(host);
        return host;
      },
    },
    lbThreadCandidate: { upsert: async () => ({}) },
    lbRun: { findFirst: async () => ({ id: "run", status: "running" }), update: async () => ({}) },
    lbRunStep: {
      findMany: async () => [],
      count: async () => steps.length,
      findFirst: async (args: { where?: { outcome?: unknown } }) =>
        args.where?.outcome
          ? ([...steps].reverse().find((step) => step.outcome.researchQueue === true) ?? null)
          : (steps.at(-1) ?? null),
      create: async (args: { data: (typeof steps)[number] }) => {
        steps.push(args.data);
        return args.data;
      },
    },
    lbCostEntry: { count: async () => 41, create: async () => ({}) },
  } as unknown as PrismaClient;
  const search = {
    search: async () => {
      searches += 1;
      return Array.from({ length: 9 }, (_, i) => ({
        url: `https://candidate-${i}.test/viewtopic.php?t=1`,
        title: "Meditation",
        snippet: "",
      }));
    },
  } as unknown as SearchProvider;
  const fetchImpl = async (value: string | URL | Request) => {
    const url = new URL(String(value));
    const candidate = Number(/candidate-(\d+)/.exec(url.hostname)?.[1]);
    const html =
      candidate < 4
        ? '<html lang="en"><body>Business directory, no discussion board</body></html>'
        : sampleForumHtml({
            platform: "phpbb",
            threadTitle: "Meditation practice questions?",
          }).replace("<html>", '<html lang="en">');
    return new Response(html, { status: 200 });
  };
  try {
    const run = () =>
      discoverDueProjects({
        prisma,
        search,
        now,
        fetchImpl: fetchImpl as typeof fetch,
        allowPrivate: true,
      });
    await run();
    expect(hosts.filter((host) => host.status === "qualified")).toHaveLength(1);
    expect(hosts).toHaveLength(25);
    const paidSearches = searches;
    expect(paidSearches).toBeGreaterThan(0);
    await run();
    expect(hosts.filter((host) => host.status === "qualified")).toHaveLength(5);
    expect(hosts).toHaveLength(29);
    expect(searches).toBe(paidSearches);
    await run();
    expect(hosts).toHaveLength(29);
    expect(searches).toBe(paidSearches);
    expect(paused).toBe(false);
  } finally {
    if (oldMode === undefined) delete process.env.LINK_BUILDER_BROWSER_SEARCH;
    else process.env.LINK_BUILDER_BROWSER_SEARCH = oldMode;
  }
});
