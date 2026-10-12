import type { BrowserSessionFactory } from "@rakazo/adapter-kit";
import {
  CaptellEmulator,
  captellCues,
  EncryptedSecretStore,
  LocalArtifactStore,
} from "@rakazo/adapters";
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
import { captchaSolverForProject } from "./link-builder-real-wiring.js";

const actor: Actor = {
  userId: "user_balance",
  workspaceId: "org_balance",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

const browsers = {
  mode: "local",
  describe: () => ({
    id: "unused",
    contractVersion: "1",
    adapterVersion: "0",
    capabilities: { extensions: false, persistentProfile: false, liveScreen: false },
  }),
  open: () => Promise.reject(new Error("balance check opened a browser")),
} as BrowserSessionFactory;

describe("Captell balance pause", () => {
  let db: TestDatabase;
  const secrets = new EncryptedSecretStore("balance-placeholder-encryption-key");
  const clock = new Date("2026-10-05T12:00:00.000Z");

  beforeAll(async () => {
    db = await createPgliteDb();
    await db.prisma.organization.create({
      data: { id: actor.workspaceId, name: "Balance", slug: "balance", createdAt: new Date() },
    });
    await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
    await grantExplicitProjectAllowance(db.prisma, actor.workspaceId);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("pauses once when the balance is below the threshold, on the injected clock", async () => {
    const emulator = new CaptellEmulator([captellCues.balance(12)]);
    const deps = {
      prisma: db.prisma,
      secrets,
      artifacts: new LocalArtifactStore("/tmp/rakazo-lb-balance"),
    };
    const created = await createLbProject(deps as never, actor, {
      name: "Low balance",
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
    });
    await updateLbProject(deps as never, actor, {
      projectId: created.id,
      ...LbProjectPatchSchema.parse({
        persona: { displayName: "Mira Sol", register: "du" },
        quotas: { newPerDay: 1, livePerDay: 1 },
        schedule: {
          timezone: "UTC",
          weekdaysOnly: false,
          window: { start: "00:00", end: "23:59" },
        },
        topicLanes: [{ id: "lane", tag: "sleep", description: "Rest" }],
        targets: [{ url: "https://nordlicht.example/guide", priority: 50 }],
        captchaToken: "ct_live_placeholder",
        captchaLowBalanceCredits: 500,
        provisionMailbox: true,
      }),
    });
    await startLbProject(deps as never, actor, created.id);
    const runner = new LinkBuilderRealRunner({
      prisma: db.prisma,
      secrets,
      artifacts: deps.artifacts,
      browsers,
      resolveCaptcha: (project, redact) =>
        captchaSolverForProject({
          prisma: db.prisma,
          secrets,
          projectId: project.id,
          workspaceId: project.workspaceId,
          redact,
          fetch: emulator.fetch,
        }),
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
      workerId: "balance-worker",
    });
    await runner.tick();
    const project = await db.prisma.lbProject.findUniqueOrThrow({ where: { id: created.id } });
    expect(project.status).toBe("paused");
    const events = await db.prisma.lbCaptchaEvent.findMany({ where: { projectId: created.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "credits",
      door: "https_api",
      balanceAfter: 12,
      creditsCharged: 0,
      createdAt: clock,
    });
    expect(JSON.stringify(events[0])).not.toContain("ct_live_placeholder");
    expect(emulator.requests).toHaveLength(1);
    expect(emulator.requests[0]?.authorization).toBe("Bearer ct_live_placeholder");

    clock.setUTCDate(clock.getUTCDate() + 1);
    await runner.tick();
    expect(await db.prisma.lbCaptchaEvent.count({ where: { projectId: created.id } })).toBe(1);
    expect(emulator.requests).toHaveLength(1);
    await runner.close();
  });

  it("refuses real mode once when the Captell secret is gone", async () => {
    const deps = {
      prisma: db.prisma,
      secrets,
      artifacts: new LocalArtifactStore("/tmp/rakazo-lb-balance"),
    };
    const created = await createLbProject(deps as never, actor, {
      name: "Missing token",
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
    });
    await updateLbProject(deps as never, actor, {
      projectId: created.id,
      ...LbProjectPatchSchema.parse({
        persona: { displayName: "Noa Feld", register: "du" },
        quotas: { newPerDay: 1, livePerDay: 1 },
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
    await db.prisma.lbProject.update({
      where: { id: created.id },
      data: { captchaSecretId: null },
    });
    const runner = new LinkBuilderRealRunner({
      prisma: db.prisma,
      secrets,
      artifacts: deps.artifacts,
      browsers,
      resolveCaptcha: (project, redact) =>
        captchaSolverForProject({
          prisma: db.prisma,
          secrets,
          projectId: project.id,
          workspaceId: project.workspaceId,
          redact,
          fetch: new CaptellEmulator().fetch,
        }),
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
      workerId: "missing-worker",
    });
    expect(
      await runner.step(
        (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: created.id } })).id,
      ),
    ).toBe("failed");
    expect(
      await runner.step(
        (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId: created.id } })).id,
      ),
    ).toBe("waited");
    const steps = await db.prisma.lbRunStep.findMany({ where: { run: { projectId: created.id } } });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.error).toBe("Real mode needs a Captell token for this project");
    expect(JSON.stringify(steps[0])).not.toContain("ct_live_placeholder");
    await runner.close();
  });
});
