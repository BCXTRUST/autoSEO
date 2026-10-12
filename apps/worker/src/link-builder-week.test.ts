import { mkdir, writeFile } from "node:fs/promises";
import type { CaptchaSolver } from "@rakazo/adapter-kit";
import { FakeProxyProvider } from "@rakazo/adapter-kit";
import { EncryptedSecretStore } from "@rakazo/adapters";
import {
  createLbProject,
  grantExplicitProjectAllowance,
  startLbProject,
  summarizeLbCosts,
  updateLbProject,
} from "@rakazo/api/link-builder";
import { type Actor, LbProjectPatchSchema } from "@rakazo/contracts";
import { createPgliteDb, type TestDatabase } from "@rakazo/db/pglite";
import { verifyWebhookSignature } from "@rakazo/linkbuilder-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkBuilderRealRunner } from "./link-builder-real.js";

const actor: Actor = {
  userId: "user_week",
  workspaceId: "org_week",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

const ANCHOR = new Date("2026-10-05T07:00:00.000Z");
const TARGET = "https://nordlicht.example/guide";
const SECRET = "whsec_week_test_secret_value";

describe("link builder week", () => {
  let db: TestDatabase;
  const secrets = new EncryptedSecretStore("week-placeholder-encryption-key");
  let clock = new Date(ANCHOR);
  let credits = 5_000;
  let projectId = "";
  const deliveries: Array<{ body: string; signature: string; status: number }> = [];
  let pauseFailures = 0;

  const captcha = {
    describe: () => ({
      id: "week-captcha",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { supports: [] },
    }),
    balance: async () => ({ credits }),
    solve: async () => {
      throw new Error("unused");
    },
    answerQuestion: async () => ({ couldNotAnswer: true as const }),
  } as CaptchaSolver;

  const proxies = new FakeProxyProvider(
    [
      {
        id: "de-1",
        country: "DE",
        server: "proxy.example:8080",
        kind: "static_isp",
        password: { secretId: "sec-pw" },
      },
    ],
    { now: () => clock },
  );

  beforeAll(async () => {
    db = await createPgliteDb();
    await db.prisma.organization.create({
      data: { id: actor.workspaceId, name: "Week", slug: "week", createdAt: new Date() },
    });
    await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
    await grantExplicitProjectAllowance(db.prisma, actor.workspaceId);
    const deps = { prisma: db.prisma, secrets };
    const created = await createLbProject(deps as never, actor, {
      name: "Nordlicht",
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
      markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
    });
    projectId = created.id;
    await updateLbProject(deps as never, actor, {
      projectId,
      ...LbProjectPatchSchema.parse({
        persona: { displayName: "Mira Woche", register: "du" },
        quotas: { newPerDay: 1, livePerDay: 2 },
        schedule: {
          timezone: "Europe/Berlin",
          weekdaysOnly: true,
          window: { start: "09:00", end: "17:00" },
          overtimeUntilLiveMet: true,
          hardStopHour: 20,
        },
        topicLanes: [{ id: "lane", tag: "sleep", description: "Rest" }],
        targets: [{ url: TARGET, priority: 50 }],
        captchaToken: "ct_live_placeholder",
        captchaLowBalanceCredits: 500,
        provisionMailbox: true,
        operator: {
          parkedHostTtlHours: 48,
          ticketTtlHours: 24,
          onExpire: "skip",
          channels: ["push"],
        },
        webhookUrl: "https://hooks.example/link-builder",
        webhookSecret: SECRET,
      }),
    });
    await startLbProject(deps as never, actor, projectId);
    await db.prisma.lbRun.deleteMany({ where: { projectId } });
    const endpoint = await proxies.lease(
      { country: "DE", stickyKey: "week-persona", kinds: ["static_isp", "residential"] },
      {
        operationId: "lease",
        traceId: "lease",
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      },
    );
    await db.prisma.lbProxyLease.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        provider: "fake",
        providerLeaseId: endpoint.id,
        country: "DE",
        stickyKey: "week-persona",
        kind: "static_isp",
        status: "active",
        leasedAt: ANCHOR,
        renewsAt: new Date(ANCHOR.getTime() + 5 * 60_000),
      },
    });
    const parked = await host("parked.example", "parked_operator", "qualified");
    await db.prisma.lbOperatorTicket.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        hostId: parked,
        reason: "captcha_unsolved",
        status: "open",
        expiresAt: new Date("2026-10-06T08:00:00.000Z"),
        createdAt: new Date("2026-10-05T08:00:00.000Z"),
      },
    });
    await placement("alpha.example", "http://127.0.0.1/viewtopic.php?p=1#p1");
    await placement("beta.example", "http://127.0.0.1/viewtopic.php?p=2#p2");
    await db.prisma.lbCaptchaEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        type: "recaptcha_v2",
        door: "https_api",
        outcome: "placed_submitted",
        creditsCharged: 12,
        createdAt: ANCHOR,
      },
    });
    const run = await db.prisma.lbRun.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        date: "2026-10-04",
        status: "succeeded",
        startedAt: ANCHOR,
      },
    });
    await db.prisma.lbRunStep.create({
      data: {
        workspaceId: actor.workspaceId,
        runId: run.id,
        stepIndex: 0,
        kind: "post",
        outcome: { modelLane: "draft" },
        costs: { credits: 0, tokens: 40, bytes: 0, ms: 1 },
        createdAt: ANCHOR,
      },
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  function runner() {
    return new LinkBuilderRealRunner({
      prisma: db.prisma,
      secrets,
      artifacts: {
        put: async () => ({ id: "art", hash: "h" }),
        remove: async () => undefined,
      } as never,
      browsers: {
        mode: "local",
        open: async () => {
          throw new Error("no browser");
        },
      } as never,
      captcha,
      mailbox: {
        describe: () => ({
          id: "week-mail",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: { inbound: "webhook" },
        }),
        ensureInbox: async () => ({ inboxId: "mbx", address: "week@inbox.example" }),
      },
      proxies,
      search: {
        describe: () => ({
          id: "week-search",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: { maxDepth: 10, operators: true },
        }),
        search: async () => [],
      },
      verifyFetch: async (input) => {
        const url = String(input);
        const removed = clock.getTime() >= ANCHOR.getTime() + 3 * 86_400_000;
        const dead = clock.getTime() >= ANCHOR.getTime() + 7 * 86_400_000;
        if (url.includes("p=2") && dead) {
          return new Response("The topic you selected does not exist.", { status: 404 });
        }
        const link = url.includes("p=1") && removed ? "" : `<a href="${TARGET}">guide</a>`;
        const id = url.includes("p=2") ? "p2" : "p1";
        return new Response(`<html><body><div id="${id}">${link}</div></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      allowPrivateVerify: true,
      webhookFetch: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        const headers = new Headers(init?.headers);
        const body = String(init?.body ?? "");
        const pause = body.includes('"kind":"project.paused"');
        const fail = pause && pauseFailures < 2;
        if (pause) pauseFailures += 1;
        const status = fail ? 500 : 200;
        deliveries.push({
          body,
          signature: headers.get("X-autoSEO-Signature") ?? "",
          status,
        });
        return new Response(fail ? "no" : "ok", { status });
      },
      productionWebhooks: true,
      resolveHostname: async () => [{ address: "203.0.113.10" }],
      now: () => clock,
      workerId: "week-worker",
    });
  }

  async function at(iso: string) {
    clock = new Date(iso);
    await runner().tick();
  }

  async function snapshot(label: string) {
    const runs = await db.prisma.lbRun.findMany({
      where: { projectId, date: { not: "2026-10-04" } },
      orderBy: { date: "asc" },
    });
    const placements = await db.prisma.lbPlacement.findMany({
      where: { projectId },
      include: { host: true },
      orderBy: { postUrl: "asc" },
    });
    const line = [
      label,
      ...runs.map(
        (run) =>
          `${run.date} ${run.status} live ${run.liveToday}/${run.liveWeek}${run.whyNot ? " why" : ""}`,
      ),
      placements
        .map((row) => `${row.host.registrableDomain} ${row.status}${row.counted ? " counted" : ""}`)
        .join(", "),
    ].join(" | ");
    return line;
  }

  async function host(domain: string, status: string, parkedFrom: string | null) {
    const row = await db.prisma.lbHost.create({
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
        parkedFrom,
      },
    });
    return row.id;
  }

  async function placement(domain: string, postUrl: string) {
    const hostId = await host(domain, "used", null);
    const account = await db.prisma.lbHostAccount.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        hostId,
        username: domain.split(".")[0] ?? "member",
      },
    });
    await db.prisma.lbPlacement.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        hostId,
        hostAccountId: account.id,
        threadUrl: postUrl,
        postUrl,
        targetUrl: TARGET,
        anchorText: "guide",
        status: "pending",
        counted: false,
        verifyCount: 0,
        nextVerifyAt: new Date(ANCHOR.getTime() + 2 * 60_000),
        createdAt: ANCHOR,
      },
    });
  }

  it("simulates a week of LIVE, removal, death, overtime, expiry and one pause", async () => {
    const log: string[] = [];
    const note = async (label: string) => {
      const line = await snapshot(label);
      log.push(line);
    };

    await at("2026-10-05T06:00:00.000Z");
    expect(await db.prisma.lbRun.count({ where: { projectId, date: "2026-10-05" } })).toBe(0);

    await at("2026-10-05T07:02:00.000Z");
    const monday = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-05" },
    });
    expect(monday.liveToday).toBe(2);
    expect(monday.liveWeek).toBe(2);
    expect(["running", "succeeded"]).toContain(monday.status);
    const live = await db.prisma.lbPlacement.findMany({ where: { projectId, status: "live" } });
    expect(live).toHaveLength(2);
    expect(live.every((row) => row.counted)).toBe(true);
    await note("Mon 09:02 live");

    await at("2026-10-05T15:30:00.000Z");
    const mondayClosed = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-05" },
    });
    expect(mondayClosed.status).toBe("succeeded");
    expect(mondayClosed.whyNot).toMatchObject({
      supply: { qualified: 0, ready: 0 },
      parked: 0,
      spamBlocked: 0,
      proxy: "ok",
      captchaBalance: 5000,
    });
    await note("Mon 17:30 closed");

    await at("2026-10-06T07:00:00.000Z");
    const still = await db.prisma.lbPlacement.findMany({ where: { projectId, counted: true } });
    expect(still).toHaveLength(2);
    await at("2026-10-06T08:00:00.000Z");
    const ticket = await db.prisma.lbOperatorTicket.findFirstOrThrow({ where: { projectId } });
    expect(ticket.status).toBe("skipped");
    const parkedHost = await db.prisma.lbHost.findFirstOrThrow({
      where: { projectId, registrableDomain: "parked.example" },
    });
    expect(parkedHost.status).toBe("dead");
    const tuesday = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-06" },
    });
    expect(tuesday.status).toBe("running");
    expect(tuesday.liveWeek).toBe(2);
    await note("Tue 10:00 ticket expired");

    await at("2026-10-06T16:00:00.000Z");
    expect(
      (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId, date: "2026-10-06" } })).status,
    ).toBe("overtime");
    await note("Tue 18:00 overtime");

    await at("2026-10-06T18:30:00.000Z");
    const tuesdayClosed = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-06" },
    });
    expect(tuesdayClosed.whyNot).toBeTruthy();
    expect(tuesdayClosed.status).not.toBe("succeeded");
    expect(tuesdayClosed.liveToday).toBe(0);
    expect(tuesdayClosed.liveWeek).toBe(2);
    await note("Tue 20:30 closed");

    credits = 10;
    await at("2026-10-07T08:00:00.000Z");
    expect((await db.prisma.lbProject.findUniqueOrThrow({ where: { id: projectId } })).status).toBe(
      "paused",
    );
    await at("2026-10-07T08:01:00.000Z");
    await at("2026-10-07T08:06:00.000Z");
    const alerts = await db.prisma.lbAlert.findMany({
      where: { projectId, kind: "project.paused" },
    });
    expect(alerts).toHaveLength(1);
    const hooks = await db.prisma.lbWebhookDelivery.findMany({
      where: { projectId, alert: { kind: "project.paused" } },
      orderBy: { attempt: "asc" },
    });
    expect(hooks.filter((row) => row.status === "failed")).toHaveLength(2);
    expect(hooks.filter((row) => row.status === "delivered")).toHaveLength(1);
    const signed = deliveries.find(
      (row) => row.status === 200 && row.body.includes('"kind":"project.paused"'),
    );
    expect(signed).toBeTruthy();
    expect(await verifyWebhookSignature(SECRET, signed?.body ?? "", signed?.signature)).toBe(true);
    await db.prisma.lbProject.update({ where: { id: projectId }, data: { status: "active" } });
    credits = 5_000;
    await at("2026-10-07T18:30:00.000Z");
    expect(
      (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId, date: "2026-10-07" } })).whyNot,
    ).toMatchObject({ proxy: "ok" });
    await note("Wed paused once");

    await at("2026-10-08T07:02:00.000Z");
    const removed = await db.prisma.lbPlacement.findFirstOrThrow({
      where: { projectId, postUrl: { contains: "p=1" } },
    });
    expect(removed.status).toBe("removed");
    expect(removed.counted).toBe(false);
    const thursday = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-08" },
    });
    expect(thursday.liveWeek).toBe(1);
    const mondayAfter = await db.prisma.lbRun.findFirstOrThrow({
      where: { projectId, date: "2026-10-05" },
    });
    expect(mondayAfter.liveToday).toBe(1);
    await at("2026-10-08T18:30:00.000Z");
    expect(
      (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId, date: "2026-10-08" } })).whyNot,
    ).toMatchObject({ parked: 0, spamBlocked: 0, proxy: "ok" });
    await note("Thu +3d removed");

    await at("2026-10-09T08:00:00.000Z");
    await at("2026-10-09T18:30:00.000Z");
    await note("Fri");

    await at("2026-10-10T08:00:00.000Z");
    await at("2026-10-11T08:00:00.000Z");
    expect(await db.prisma.lbRun.count({ where: { projectId, date: "2026-10-10" } })).toBe(0);
    expect(await db.prisma.lbRun.count({ where: { projectId, date: "2026-10-11" } })).toBe(0);
    await note("weekend");

    await at("2026-10-12T07:02:00.000Z");
    const gone = await db.prisma.lbPlacement.findFirstOrThrow({
      where: { projectId, postUrl: { contains: "p=2" } },
    });
    expect(gone.status).toBe("dead");
    expect(gone.counted).toBe(false);
    expect(
      (await db.prisma.lbRun.findFirstOrThrow({ where: { projectId, date: "2026-10-12" } }))
        .liveWeek,
    ).toBe(0);
    await note("Mon +7d dead");

    const summary = await summarizeLbCosts({ prisma: db.prisma, secrets } as never, actor, {
      projectId,
      range: "week",
    });
    const entries = await db.prisma.lbCostEntry.findMany({ where: { projectId } });
    const summed = entries.reduce(
      (acc, entry) => {
        if (entry.kind === "captell_credits") acc.captellCredits += entry.quantity;
        if (entry.kind === "model_tokens") acc.modelTokens += entry.quantity;
        if (entry.kind === "search_query") acc.searchQueries += entry.quantity;
        if (entry.kind === "proxy_lease_day") acc.proxyLeaseDays += entry.quantity;
        return acc;
      },
      { captellCredits: 0, modelTokens: 0, searchQueries: 0, proxyLeaseDays: 0 },
    );
    expect(summary.captellCredits).toBe(summed.captellCredits);
    expect(summary.modelTokens).toBe(40);
    expect(summary.proxyLeaseDays).toBeGreaterThanOrEqual(1);
    expect(summed.searchQueries).toBeGreaterThanOrEqual(1);
    expect(summed).toMatchObject({
      captellCredits: 12,
      modelTokens: 40,
    });

    await mkdir("/opt/cursor/artifacts", { recursive: true });
    await writeFile("/opt/cursor/artifacts/lb-m7-week.log", `${log.join("\n")}\n`);
  });
});
