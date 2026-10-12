import type { AdapterContext, BrowserSessionFactory } from "@rakazo/adapter-kit";
import {
  FakeBrowserSessionProvider,
  FakeCaptchaSolver,
  type FakePage,
  FakeProxyProvider,
} from "@rakazo/adapter-kit";
import {
  EncryptedSecretStore,
  EndpointTemplateProxyProvider,
  iproyalPreset,
  readLeaseId,
  StaticPlanProvider,
} from "@rakazo/adapters";
import {
  createLbProject,
  grantExplicitProjectAllowance,
  startLbProject,
  updateLbProject,
} from "@rakazo/api/link-builder";
import { type Actor, LbProjectPatchSchema } from "@rakazo/contracts";
import { createPgliteDb, type TestDatabase } from "@rakazo/db/pglite";
import { BrowserEngineUnavailable } from "@rakazo/linkbuilder-browser";
import { canRegisterHost, nextProxyStickyKey } from "@rakazo/linkbuilder-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureProxyLease,
  replaceBlacklistedLease,
  sealProxyUsername,
} from "./link-builder-proxy.js";
import { LinkBuilderRealRunner } from "./link-builder-real.js";

const actor: Actor = {
  userId: "user_identity",
  workspaceId: "org_identity",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const PASSWORD = "s3cret-proxy-password";
const clock = new Date("2026-10-05T12:00:00.000Z");
const adapter: AdapterContext = {
  operationId: "lb-identity",
  traceId: "lb-identity",
  workspaceId: actor.workspaceId,
  userId: actor.userId,
  signal: new AbortController().signal,
};

function browsersFor(text: string): FakeBrowserSessionProvider & BrowserSessionFactory {
  const site: Record<string, FakePage> = {};
  if (text) site["https://board.example/"] = { text, elements: {} };
  const fake = new FakeBrowserSessionProvider(site);
  return Object.assign(fake, { mode: "local" as const });
}

describe("link builder identity", () => {
  let db: TestDatabase;
  const secrets = new EncryptedSecretStore("identity-placeholder-encryption-key");

  beforeAll(async () => {
    db = await createPgliteDb();
    await db.prisma.organization.create({
      data: { id: actor.workspaceId, name: "Identity", slug: "identity", createdAt: new Date() },
    });
    await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
    await grantExplicitProjectAllowance(db.prisma, actor.workspaceId);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function startedProject(name: string) {
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
      }),
    });
    await startLbProject(deps as never, actor, created.id);
    return created;
  }

  function runner(
    browsers: BrowserSessionFactory,
    proxies: FakeProxyProvider | EndpointTemplateProxyProvider,
    extra: { camoufoxAvailable?: boolean } = {},
  ) {
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
      proxies,
      camoufoxAvailable: extra.camoufoxAvailable ?? false,
      now: () => clock,
      workerId: `identity-${Math.random()}`,
    });
  }

  it("leases one exit per country with FakeProxyProvider and never stores the password", async () => {
    const project = await startedProject("Lease");
    await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "board.example",
        homepageUrl: "https://board.example/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status: "qualified",
      },
    });
    const proxies = new FakeProxyProvider(
      [
        {
          id: "exit-de",
          country: "DE",
          server: "proxy.example:8080",
          kind: "static_isp",
          password: { secretId: "sec-pw" },
        },
      ],
      { now: () => clock },
    );
    const browsers = browsersFor("");
    const real = runner(browsers, proxies);
    await real.tick();
    await real.tick();
    const leases = await db.prisma.lbProxyLease.findMany({ where: { projectId: project.id } });
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      country: "DE",
      kind: "static_isp",
      provider: "fake-proxy",
      status: "active",
      endpointSecretId: null,
    });
    expect(JSON.stringify(leases)).not.toContain(PASSWORD);
    expect(JSON.stringify(leases)).not.toContain("sec-pw");
    const persona = browsers.sessions[0]?.persona;
    expect(persona?.locale).toBe("de-DE");
    expect(persona?.timezoneId).toBe("Europe/Berlin");
    expect(persona?.proxy?.password).toEqual({ secretId: "sec-pw" });
    expect(JSON.stringify(persona)).not.toContain(PASSWORD);
    const steps = await db.prisma.lbRunStep.findMany({ where: { hostId: { not: null } } });
    expect(JSON.stringify(steps)).not.toContain(PASSWORD);
    expect(JSON.stringify(steps)).not.toContain("sec-pw");
  });

  it("refuses a session whose locale disagrees with the host country", async () => {
    const project = await startedProject("Coherence");
    const host = await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "mismatch.example",
        homepageUrl: "https://mismatch.example/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "en-US",
        timezoneId: "America/New_York",
        status: "qualified",
      },
    });
    const browsers = browsersFor("");
    const real = runner(
      browsers,
      new FakeProxyProvider([
        {
          id: "exit-coherence",
          country: "DE",
          server: "proxy.example:8080",
          kind: "static_isp",
          password: { secretId: "sec-pw" },
        },
      ]),
    );
    await real.tick();
    await real.tick();
    expect(browsers.sessions).toHaveLength(0);
    const parked = await db.prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
    expect(parked.status).toBe("parked_operator");
    expect(parked.statusReason).toBe("coherence_refused");
    const steps = await db.prisma.lbRunStep.findMany({ where: { hostId: host.id } });
    expect(steps.some((step) => step.kind === "coherence_refused")).toBe(true);
    const projectRow = await db.prisma.lbProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(projectRow.status).toBe("active");
  });

  it("refuses a fifth registration on the same host the same day", async () => {
    const project = await startedProject("Cap");
    const host = await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "cap.example",
        homepageUrl: "https://cap.example/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status: "qualified",
      },
    });
    const run = await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
    await db.prisma.lbRunStep.createMany({
      data: [0, 1, 2, 3].map((stepIndex) => ({
        workspaceId: actor.workspaceId,
        runId: run.id,
        stepIndex,
        kind: "register",
        hostId: host.id,
        outcome: { username: "mira" },
        createdAt: clock,
      })),
    });
    const real = runner(browsersFor(""), new FakeProxyProvider([]));
    await real.tick();
    const steps = await db.prisma.lbRunStep.findMany({
      where: { hostId: host.id },
      orderBy: { stepIndex: "asc" },
    });
    expect(steps.at(-1)?.outcome).toMatchObject({ refused: "registration_cap" });
    const still = await db.prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
    expect(still.status).toBe("qualified");
    expect(await db.prisma.lbHostAccount.count({ where: { hostId: host.id } })).toBe(0);
    expect(
      canRegisterHost({
        priorRegistrationAts: [clock],
        now: new Date("2026-10-06T12:00:00.000Z"),
        timeZone: "UTC",
      }),
    ).toBe(true);
  });

  it("replaces a blacklisted lease with a new session and keeps the account", async () => {
    const project = await startedProject("Blacklist");
    const host = await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "flag.example",
        homepageUrl: "https://flag.example/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status: "qualified",
      },
    });
    await db.prisma.lbHostAccount.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        hostId: host.id,
        username: "mira",
      },
    });
    const provider = new EndpointTemplateProxyProvider(iproyalPreset(), {
      now: () => clock,
      seal: (plaintext, context) =>
        sealProxyUsername({ prisma: db.prisma, secrets }, plaintext, context),
    });
    const deps = {
      prisma: db.prisma,
      provider,
      secrets,
      now: clock,
      context: adapter,
      renewLeadMs: 60_000,
    };
    const first = await ensureProxyLease(deps, {
      projectId: project.id,
      workspaceId: actor.workspaceId,
      country: "DE",
    });
    const replaced = await replaceBlacklistedLease(deps, {
      projectId: project.id,
      workspaceId: actor.workspaceId,
      country: "DE",
    });
    expect(readLeaseId(replaced.id).session).not.toBe(readLeaseId(first.id).session);
    expect(replaced.stickyKey).toBe(nextProxyStickyKey(first.stickyKey));
    const rows = await db.prisma.lbProxyLease.findMany({ where: { projectId: project.id } });
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    const flagged = await db.prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
    expect(flagged.notes).toContain("ip_blacklisted");
    expect(await db.prisma.lbHostAccount.count({ where: { hostId: host.id } })).toBe(1);
  });

  it("marks the host dead when Camoufox is unavailable after two edge blocks", async () => {
    const project = await startedProject("Edge");
    const host = await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "board.example",
        homepageUrl: "https://board.example/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status: "qualified",
      },
    });
    const fake = browsersFor("Just a moment");
    const innerOpen = fake.open.bind(fake);
    const browsers = Object.assign(fake, {
      async open(
        persona: Parameters<FakeBrowserSessionProvider["open"]>[0],
        context: AdapterContext,
      ) {
        if (persona.engine === "camoufox") throw new BrowserEngineUnavailable("camoufox");
        return innerOpen(persona, context);
      },
    });
    const real = runner(
      browsers,
      new FakeProxyProvider([
        {
          id: "exit-edge",
          country: "DE",
          server: "proxy.example:8080",
          kind: "static_isp",
          password: { secretId: "sec-pw" },
        },
      ]),
      { camoufoxAvailable: true },
    );
    await db.prisma.lbProject.update({
      where: { id: project.id },
      data: { proxyPolicy: "none" },
    });
    await real.tick();
    await real.tick();
    let row = await db.prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
    expect(row.status).toBe("qualified");
    const mid = await db.prisma.lbRunStep.findMany({ where: { hostId: host.id } });
    expect(mid.some((step) => step.kind === "edge_block")).toBe(true);
    await real.tick();
    row = await db.prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
    expect(row.status).toBe("dead");
    expect(row.statusReason).toBe("edge_block");
    const steps = await db.prisma.lbRunStep.findMany({ where: { hostId: host.id } });
    expect(steps.some((step) => step.kind === "edge_block")).toBe(true);
  });
});
