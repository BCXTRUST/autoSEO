import type { AdapterContext, BrowserSessionFactory, ProxyEndpoint } from "@rakazo/adapter-kit";
import { FakeBrowserSessionProvider, FakeCaptchaSolver } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, FakeSandboxProvider, StaticPlanProvider } from "@rakazo/adapters";
import {
  createLbProject,
  grantExplicitProjectAllowance,
  startLbProject,
  updateLbProject,
} from "@rakazo/api/link-builder";
import { type Actor, LbProjectPatchSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createPgliteDb, type TestDatabase } from "@rakazo/db/pglite";
import { LocalBrowserRefused } from "@rakazo/linkbuilder-browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLinkBuilderFakeEnabled } from "./link-builder-fake.js";
import { isLinkBuilderRealEnabled, LinkBuilderRealRunner } from "./link-builder-real.js";
import {
  countsAsRegistration,
  helperConnectionPlan,
  observedPageHelper,
  selectsGenericRegistrationJourney,
  templateReply,
  warmupReplyChoice,
} from "./link-builder-real-steps.js";
import {
  browserFactoryFromEnv,
  proxyResolverFor,
  resolvePersonaComputer,
} from "./link-builder-real-wiring.js";

const prisma = {} as PrismaClient;
const sandbox = new FakeSandboxProvider();

describe("link builder real driver wiring", () => {
  it("writes a link-free warmup reply without a relevance score", () => {
    const reply = warmupReplyChoice("de");
    expect(reply.linkSlot).toBe("none");
    expect(reply.targetUrl).toBeNull();
    expect(reply.anchorText).toBeNull();
    expect(reply.body).not.toMatch(/https?:\/\//);
    expect(reply.body.length).toBeGreaterThan(10);
    expect(warmupReplyChoice("en").body).not.toBe(reply.body);
  });

  it("uses the Captell API door when the Page Helper is missing", () => {
    expect(helperConnectionPlan(null)).toBe("api");
    expect(helperConnectionPlan("")).toBe("api");
    expect(helperConnectionPlan("2026.10.4.16")).toBe("connected");
    expect(helperConnectionPlan("1999.1.1")).toBe("park");
  });

  it("ignores desktop extensions that are not the Page Helper", () => {
    const unrelated = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", version: "1.0" };
    expect(observedPageHelper([unrelated])).toBeNull();
    expect(
      observedPageHelper([
        unrelated,
        { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", version: "2026.10.4.16" },
      ]),
    ).toEqual({
      version: "2026.10.4.16",
      extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(
      observedPageHelper([{ id: "kaddlbmbmgfolcpajhnfpcbekblekifn", version: "1999.1.1" }]),
    ).toEqual({
      version: "1999.1.1",
      extensionId: "kaddlbmbmgfolcpajhnfpcbekblekifn",
    });
  });

  it("runs only behind LINK_BUILDER_DRIVER=real and leaves the fake runner off", () => {
    expect(isLinkBuilderRealEnabled({})).toBe(false);
    expect(isLinkBuilderRealEnabled({ LINK_BUILDER_DRIVER: "real" })).toBe(true);
    expect(isLinkBuilderFakeEnabled({ LINK_BUILDER_DRIVER: "real" })).toBe(false);
  });

  it("uses the sandbox browser unless the local browser is opted in", () => {
    const factory = browserFactoryFromEnv({ env: {}, dataDir: "/tmp/data", sandbox, prisma });
    expect(factory.mode).toBe("sandbox");
    const local = browserFactoryFromEnv({
      env: { LINK_BUILDER_BROWSER: "local" },
      dataDir: "/tmp/data",
      sandbox,
      prisma,
    });
    expect(local.mode).toBe("local");
  });

  it("refuses the local browser in production without the allow flag", () => {
    const build = (env: NodeJS.ProcessEnv) =>
      browserFactoryFromEnv({ env, dataDir: "/tmp/data", sandbox, prisma });
    expect(() => build({ LINK_BUILDER_BROWSER: "local", NODE_ENV: "production" })).toThrow(
      LocalBrowserRefused,
    );
    expect(
      build({
        LINK_BUILDER_BROWSER: "local",
        NODE_ENV: "production",
        LINK_BUILDER_ALLOW_LOCAL_BROWSER: "true",
      }).mode,
    ).toBe("local");
  });

  it("builds a Kernel factory only when the secret ref is set", () => {
    expect(() =>
      browserFactoryFromEnv({
        env: { LINK_BUILDER_BROWSER: "kernel" },
        dataDir: "/tmp/data",
        sandbox,
        prisma,
      }),
    ).toThrow(/LINK_BUILDER_KERNEL_SECRET_ID/);
    const kernel = browserFactoryFromEnv({
      env: { LINK_BUILDER_BROWSER: "kernel", LINK_BUILDER_KERNEL_SECRET_ID: "secret-kernel" },
      dataDir: "/tmp/data",
      sandbox,
      prisma,
      secrets: { load: () => "", redact: () => undefined } as never,
    });
    expect(kernel.mode).toBe("kernel");
    expect(kernel.describe().id).toBe("kernel-browser");
    const unused = browserFactoryFromEnv({
      env: { LINK_BUILDER_KERNEL_SECRET_ID: "secret-kernel" },
      dataDir: "/tmp/data",
      sandbox,
      prisma,
      secrets: { load: () => "", redact: () => undefined } as never,
    });
    expect(unused.mode).toBe("sandbox");
  });

  it("wakes a suspended computer before the persona browser opens", async () => {
    const provisioned: Array<{ providerRef?: string; providerKind?: string }> = [];
    const updates: Array<{ state?: string; providerRef?: string }> = [];
    const prisma = {
      lbProject: { findUnique: async () => ({ workspaceId: "ws" }) },
      computer: {
        findMany: async () => [
          {
            id: "comp-1",
            scope: "dedicated",
            state: "suspended",
            providerRef: "sb-old",
            kind: "e2b",
            homeKey: "home-1",
          },
        ],
        update: async ({ data }: { data: { state?: string; providerRef?: string } }) => {
          updates.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: async (request: { providerRef?: string; providerKind?: string }) => {
        provisioned.push(request);
        return {
          id: "sb-old",
          botId: "home-1",
          kind: "e2b" as const,
          providerRef: "sb-old",
          fresh: false,
        };
      },
    } as unknown as FakeSandboxProvider;
    const context = {
      operationId: "op",
      traceId: "tr",
      workspaceId: "ws",
      userId: "user",
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    const ref = await resolvePersonaComputer({
      prisma,
      sandbox,
      projectId: "project-1",
      context,
      dataDir: "/tmp/data",
    });
    expect(provisioned).toEqual([
      {
        botId: "home-1",
        homePath: "/tmp/data/computer-home/home-1",
        providerRef: "sb-old",
        providerKind: "e2b",
      },
    ]);
    expect(ref.providerRef).toBe("sb-old");
    expect(updates).toEqual([{ state: "running", providerRef: "sb-old", kind: "e2b" }]);
  });
});

describe("proxy resolver", () => {
  it("records each revealed proxy secret once", async () => {
    const revealed: string[] = [];
    const prisma = {
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => ({ ciphertext: where.id }),
      },
    } as unknown as PrismaClient;
    const resolve = proxyResolverFor({
      prisma,
      secrets: {
        load: (ciphertext: string) => (ciphertext === "user" ? "persona-user" : "persona-secret"),
      } as never,
      revealed,
    });
    const endpoint = {
      id: "lease-1",
      country: "DE",
      stickyKey: "persona:DE",
      server: "proxy.example:8080",
      protocol: "http",
      username: { secretId: "user" },
      password: { secretId: "pass" },
      kind: "static_isp",
    } as ProxyEndpoint;
    const context = {
      operationId: "op",
      traceId: "tr",
      workspaceId: "ws",
      userId: "user",
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    await resolve(endpoint, context);
    await resolve(endpoint, context);
    expect(revealed).toEqual(["persona-secret", "persona-user:persona-secret@proxy.example:8080"]);
  });
});

describe("generic registration journey", () => {
  it("selects the generic journey for an unknown platform", () => {
    expect(selectsGenericRegistrationJourney("unknown")).toBe(true);
    expect(selectsGenericRegistrationJourney("unknown", "form")).toBe(true);
  });

  it("keeps a stock driver that already found the form", () => {
    expect(selectsGenericRegistrationJourney("phpbb", "form")).toBe(false);
    expect(selectsGenericRegistrationJourney("xenforo", "closed")).toBe(false);
    expect(selectsGenericRegistrationJourney("phpbb", "unknown")).toBe(true);
    expect(selectsGenericRegistrationJourney("xenforo", "unmapped")).toBe(true);
  });
});

describe("registration budget", () => {
  it("does not spend a host's daily registration on a read that never submitted", () => {
    expect(countsAsRegistration({ registration: [], result: "parked", reason: "unmapped" })).toBe(
      false,
    );
    expect(countsAsRegistration({ registration: ["pending_email"] })).toBe(true);
    expect(countsAsRegistration({ registration: "form_error" })).toBe(true);
    expect(countsAsRegistration({ username: "sophie_braun95" })).toBe(true);
    expect(countsAsRegistration({ refused: "registration_cap" })).toBe(false);
  });
});

describe("template reply", () => {
  it("inserts exactly one link in the board's markup", () => {
    const body = templateReply({
      brandName: "Vereinsplaner",
      language: "de",
      targetUrl: "https://vereinsplaner.example/mitglieder",
      register: "du",
      format: "bbcode",
    });
    expect(body).toContain("[url=https://vereinsplaner.example/mitglieder]Vereinsplaner[/url]");
    expect(body.match(/\[url=/g)).toHaveLength(1);
    expect(body).not.toContain("[REF]");
  });

  it("falls back to English for languages without a template", () => {
    const body = templateReply({
      brandName: "Planner",
      language: "fr",
      targetUrl: "https://planner.example/",
      register: "du",
      format: "markdown",
    });
    expect(body).toContain("[Planner](https://planner.example/)");
  });
});

describe("recorded host skips", () => {
  let db: TestDatabase;
  const clock = new Date("2026-10-16T12:00:00.000Z");
  const actor: Actor = {
    userId: "user_skip",
    workspaceId: "org_skip",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const secrets = new EncryptedSecretStore("skip-placeholder-encryption-key");

  beforeAll(async () => {
    db = await createPgliteDb();
    await db.prisma.organization.create({
      data: { id: actor.workspaceId, name: "Skip", slug: "skip", createdAt: new Date() },
    });
    await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
    await grantExplicitProjectAllowance(db.prisma, actor.workspaceId);
  });

  afterAll(async () => {
    await db?.close();
  });

  function runner(browsers: BrowserSessionFactory) {
    return new LinkBuilderRealRunner({
      prisma: db.prisma,
      secrets,
      artifacts: { put: async () => ({ id: "art" }), remove: async () => undefined } as never,
      browsers,
      captcha: new FakeCaptchaSolver({ balance: 5_000 }),
      mailbox: {
        describe: () => ({
          id: "unused",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: { inbound: "webhook" },
        }),
        ensureInbox: async () => ({ inboxId: "mbx", address: "a@inbox.example" }),
      },
      now: () => clock,
      workerId: `skip-${Math.random()}`,
    });
  }

  async function startedProject(name: string, denyHosts: string[]) {
    const deps = {
      prisma: db.prisma,
      secrets,
      plan: new StaticPlanProvider({
        name: "starter",
        caps: { projects: 8, live_per_day: 10, personas: 8 },
      }),
    };
    const created = await createLbProject(deps as never, actor, {
      name,
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
    });
    await updateLbProject(deps as never, actor, {
      projectId: created.id,
      ...LbProjectPatchSchema.parse({
        persona: { displayName: "Mira Sol", register: "du" },
        quotas: { newPerDay: 2, livePerDay: 1 },
        schedule: {
          timezone: "UTC",
          weekdaysOnly: false,
          window: { start: "00:00", end: "23:59" },
        },
        topicLanes: [{ id: "lane", tag: "sleep", description: "Rest" }],
        targets: [{ url: "https://nordlicht.example/guide", priority: 50 }],
        captchaToken: "ct_live_placeholder",
        provisionMailbox: true,
        denyHosts,
      }),
    });
    await startLbProject(deps as never, actor, created.id);
    return created;
  }

  async function host(projectId: string, domain: string, status: "pending_admin" | "ready") {
    return db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        registrableDomain: domain,
        homepageUrl: `https://${domain}/`,
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status,
      },
    });
  }

  function skipSteps(projectId: string) {
    return db.prisma.lbRunStep.findMany({
      where: { run: { projectId } },
      orderBy: { stepIndex: "asc" },
    });
  }

  it("records one skip for denied forums and does not open a browser", async () => {
    const project = await startedProject("Denied", ["macuser.de", "medizin-forum.de"]);
    await host(project.id, "macuser.de", "pending_admin");
    await host(project.id, "medizin-forum.de", "ready");
    const browsers = new FakeBrowserSessionProvider({});
    const real = runner(Object.assign(browsers, { mode: "local" as const }));
    await real.tick();
    await real.tick();
    const steps = await skipSteps(project.id);
    const skips = steps.filter((step) => step.kind === "select_host" && step.hostId === null);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.outcome).toMatchObject({
      lastAction: "Skipped 2 denied forums",
      skipped: ["macuser.de", "medizin-forum.de"],
    });
    const run = await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
    expect(run.lastAction).toBe("Skipped 2 denied forums");
    expect(browsers.sessions).toHaveLength(0);
    await db.prisma.lbProject.update({ where: { id: project.id }, data: { status: "paused" } });
    await db.prisma.lbRun.updateMany({
      where: { projectId: project.id },
      data: { status: "paused" },
    });
  });

  it("records one admin wait for an allowed pending forum", async () => {
    const project = await startedProject("Admin", []);
    const pending = await host(project.id, "gartentipps.de", "pending_admin");
    const run = await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
    await db.prisma.lbRunStep.create({
      data: {
        workspaceId: actor.workspaceId,
        runId: run.id,
        stepIndex: 0,
        kind: "admin_check",
        hostId: pending.id,
        createdAt: new Date(clock.getTime() - 60 * 60 * 1000),
        finishedAt: new Date(clock.getTime() - 60 * 60 * 1000),
      },
    });
    const browsers = new FakeBrowserSessionProvider({});
    const real = runner(Object.assign(browsers, { mode: "local" as const }));
    await real.tick();
    await real.tick();
    const steps = await skipSteps(project.id);
    const waits = steps.filter((step) => {
      const outcome = step.outcome as { lastAction?: string };
      return outcome.lastAction === "Waiting for a site admin";
    });
    expect(waits).toHaveLength(1);
    expect(waits[0]?.outcome).toMatchObject({
      reason: "admin_approval",
      domains: ["gartentipps.de"],
    });
    const updated = await db.prisma.lbRun.findFirstOrThrow({ where: { id: run.id } });
    expect(updated.lastAction).toBe("Waiting for a site admin");
    expect(browsers.sessions).toHaveLength(0);
  });
});
