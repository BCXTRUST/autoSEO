import type { AdapterContext, BrowserSessionFactory, ProcessEvent } from "@rakazo/adapter-kit";
import {
  FakeBrowserSessionProvider,
  FakeCaptchaSolver,
  FakeProxyProvider,
} from "@rakazo/adapter-kit";
import { EncryptedSecretStore, StaticPlanProvider } from "@rakazo/adapters";
import {
  createLbProject,
  grantExplicitProjectAllowance,
  startLbProject,
  updateLbProject,
} from "@rakazo/api/link-builder";
import { type Actor, LbProjectPatchSchema } from "@rakazo/contracts";
import { createPgliteDb, type TestDatabase } from "@rakazo/db/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkBuilderRealRunner } from "./link-builder-real.js";

const actor: Actor = {
  userId: "user_seen",
  workspaceId: "org_seen",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const clock = new Date("2026-10-15T12:00:00.000Z");

function browsers(): FakeBrowserSessionProvider & BrowserSessionFactory {
  const fake = new FakeBrowserSessionProvider({
    "https://forum.nordlicht.test/": { text: "Welcome", elements: {} },
  });
  return Object.assign(fake, { mode: "local" as const });
}

describe("browser window heartbeat", () => {
  let db: TestDatabase;
  const secrets = new EncryptedSecretStore("browser-seen-placeholder-encryption-key");

  beforeAll(async () => {
    db = await createPgliteDb();
    await db.prisma.organization.create({
      data: { id: actor.workspaceId, name: "Seen", slug: "seen", createdAt: new Date() },
    });
    await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
    await grantExplicitProjectAllowance(db.prisma, actor.workspaceId);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("sets browserSeenAt after open_session and clears it on close", async () => {
    const deps = {
      prisma: db.prisma,
      secrets,
      plan: new StaticPlanProvider({
        name: "starter",
        caps: { projects: 8, live_per_day: 10, personas: 8 },
      }),
    };
    const project = await createLbProject(deps as never, actor, {
      name: "Seen",
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
    });
    await updateLbProject(deps as never, actor, {
      projectId: project.id,
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
    await startLbProject(deps as never, actor, project.id);
    await db.prisma.lbHost.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId: project.id,
        registrableDomain: "forum.nordlicht.test",
        homepageUrl: "https://forum.nordlicht.test/",
        platform: "phpbb",
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        status: "qualified",
      },
    });
    const computer = await db.prisma.computer.create({
      data: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        scope: "team",
        scopeKey: `team:${project.id}`,
        homeKey: `home-${project.id}`,
        kind: "e2b",
        state: "running",
        providerRef: "box-seen",
      },
    });
    const commands: string[] = [];
    const sandbox = {
      async *execute(
        _ref: unknown,
        request: { argv: string[] },
        _context: AdapterContext,
      ): AsyncIterable<ProcessEvent> {
        commands.push(request.argv.join(" "));
        yield { type: "stdout", data: "browser\n" };
        yield { type: "exit", code: 0 };
      },
      keepAlive: async () => {
        commands.push("keepAlive");
      },
    };
    const runner = new LinkBuilderRealRunner({
      prisma: db.prisma,
      secrets,
      artifacts: { put: async () => ({ id: "art" }), remove: async () => undefined } as never,
      browsers: browsers(),
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
      proxies: new FakeProxyProvider(
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
      ),
      sandbox: sandbox as never,
      now: () => clock,
      workerId: "seen-worker",
    });
    const run = await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await runner.step(run.id);
      const opened = await db.prisma.lbRunStep.findFirst({
        where: { runId: run.id, kind: "open_session" },
      });
      if (opened) break;
    }
    const seen = await db.prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    expect(seen.browserSeenAt?.toISOString()).toBe(clock.toISOString());
    expect(commands.some((command) => command.includes("chromium Chromium"))).toBe(true);
    expect(commands).toContain("keepAlive");
    await (runner as unknown as { closeSession(projectId: string): Promise<void> }).closeSession(
      project.id,
    );
    const cleared = await db.prisma.computer.findUniqueOrThrow({ where: { id: computer.id } });
    expect(cleared.browserSeenAt).toBeNull();
  });
});
