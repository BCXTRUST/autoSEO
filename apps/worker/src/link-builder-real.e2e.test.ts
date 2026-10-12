import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterContext, FakeCaptchaSolver, type TextModel } from "@rakazo/adapter-kit";
import {
  AgentMailEmulator,
  EncryptedSecretStore,
  LocalArtifactStore,
  RecordedTextModel,
  StaticPlanProvider,
  textModelFixtureKey,
} from "@rakazo/adapters";
import {
  createLbProject,
  grantExplicitProjectAllowance,
  listLbRunSteps,
  startLbProject,
  updateLbProject,
} from "@rakazo/api/link-builder";
import { type Actor, LbProjectPatchSchema } from "@rakazo/contracts";
import { createPgliteDb, type TestDatabase } from "@rakazo/db/pglite";
import { LocalBrowserSessionFactory } from "@rakazo/linkbuilder-browser";
import { browserTestGate, FIXTURE_PAGE_HELPER_DIR } from "@rakazo/linkbuilder-browser/testing";
import { draftPrompt, fitPrompt, relevancePrompt, TEST_PACING } from "@rakazo/linkbuilder-core";
import { VERIFY_USER_AGENT } from "@rakazo/linkbuilder-drivers";
import {
  type FixtureMail,
  type MarkupFixture,
  startMybbFixture,
  startPhpbbFixture,
  startXenforoFixture,
} from "@rakazo/linkbuilder-drivers/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkBuilderRealRunner } from "./link-builder-real.js";

type ApiDeps = Parameters<typeof createLbProject>[0];

const gate = browserTestGate();
const actor: Actor = {
  userId: "user_owner",
  workspaceId: "org_e2e",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const CAPTCHA_ANSWER = "K7XQ2";
const FAKE_CAPTELL_TOKEN = "ct_live_FAKE00example00token";

/** All-day window in a zone that is far from local midnight now, so the run never closes mid-test. */
function scheduleTimezone(): string {
  const hour = new Date().getUTCHours();
  return hour >= 21 || hour < 2 ? "Pacific/Honolulu" : "UTC";
}

function webhookFor(mail: FixtureMail, inboxId: string) {
  return {
    event_type: "message.received",
    event_id: `evt_${randomUUID()}`,
    message: {
      inbox_id: inboxId,
      message_id: `msg_${randomUUID()}`,
      from: mail.from,
      subject: mail.subject,
      text: mail.textBody,
      html: mail.htmlBody,
      timestamp: new Date().toISOString(),
    },
  };
}

interface Harness {
  db: TestDatabase;
  deps: ApiDeps;
  root: string;
  artifacts: LocalArtifactStore;
  secrets: EncryptedSecretStore;
  emulator: AgentMailEmulator;
  factory: LocalBrowserSessionFactory;
}

async function createHarness(): Promise<Harness> {
  const db = await createPgliteDb();
  await db.prisma.organization.create({
    data: { id: actor.workspaceId, name: "E2E", slug: "e2e", createdAt: new Date() },
  });
  await db.prisma.user.create({ data: { id: actor.userId, name: "Owner", email: actor.email } });
  const root = await mkdtemp(join(tmpdir(), "rakazo-lb-e2e-"));
  const secrets = new EncryptedSecretStore("e2e-placeholder-encryption-key-not-a-secret");
  const artifacts = new LocalArtifactStore(root);
  return {
    db,
    deps: {
      prisma: db.prisma,
      secrets,
      artifacts,
      plan: new StaticPlanProvider({
        name: "e2e",
        caps: { projects: 100, live_per_day: 100, personas: 100 },
      }),
    } as unknown as ApiDeps,
    root,
    artifacts,
    secrets,
    emulator: new AgentMailEmulator(),
    factory: new LocalBrowserSessionFactory({
      profileRoot: join(root, ".browser-profiles"),
      helperDirs: [FIXTURE_PAGE_HELPER_DIR],
      headless: true,
      pacing: TEST_PACING,
      env: { LINK_BUILDER_BROWSER: "local" },
    }),
  };
}

/** The wizard's calls, through the M1 API functions, then a qualified board for discovery's output. */
async function wizardProject(
  h: Harness,
  fixture: { origin: string },
  name: string,
  personaName: string,
  platform = "phpbb",
) {
  await grantExplicitProjectAllowance(h.db.prisma, actor.workspaceId);
  const created = await createLbProject(h.deps, actor, {
    name,
    brandName: "Vereinsplaner",
    allowedDomains: ["vereinsplaner.example"],
    markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
  });
  const patch = LbProjectPatchSchema.parse({
    persona: { displayName: personaName, register: "du" },
    quotas: { newPerDay: 1, livePerDay: 1 },
    schedule: {
      timezone: scheduleTimezone(),
      weekdaysOnly: false,
      window: { start: "00:00", end: "23:59" },
    },
    topicLanes: [{ id: "lane-members", tag: "members", description: "Member lists for clubs" }],
    targets: [{ url: "https://vereinsplaner.example/mitglieder", priority: 80 }],
    linkRatio: { links: 1, posts: 1 },
    warmup: { minPostsBeforeLink: 0, minAccountAgeHours: 0 },
    captchaToken: FAKE_CAPTELL_TOKEN,
    provisionMailbox: true,
  });
  const updated = await updateLbProject(h.deps, actor, { projectId: created.id, ...patch });
  const row = await h.db.prisma.lbProject.findUniqueOrThrow({ where: { id: created.id } });
  h.emulator.registerInbox(created.id, { inboxId: row.mailboxId!, address: row.mailboxAddress! });
  await startLbProject(h.deps, actor, created.id);
  const host = await h.db.prisma.lbHost.create({
    data: {
      workspaceId: actor.workspaceId,
      projectId: created.id,
      registrableDomain: new URL(fixture.origin).hostname,
      homepageUrl: `${fixture.origin}/`,
      platform,
      language: "de",
      country: "DE",
      status: "qualified",
      qualityScore: 0.7,
    },
  });
  return { project: updated, host, mailboxId: row.mailboxId! };
}

const RECORDED_REPLY = {
  body: "Eine gemeinsame Liste, die der ganze Vorstand bearbeiten kann, erspart das Hin und Her im Verein. [REF]",
  linkSlot: "inline" as const,
  targetUrlIndex: 0,
  anchorText: "Mitgliederliste",
  confidence: 0.86,
};

/** Writes hash-keyed fixtures for the thread the phpBB board actually shows. */
async function recordedDraftModel(displayName: string): Promise<TextModel> {
  const root = await mkdtemp(join(tmpdir(), "lb-e2e-model-"));
  const title = "Which software do you use for club membership lists?";
  const facts: string[] = [];
  const targets = [{ url: "https://vereinsplaner.example/mitglieder", description: "" }];
  const relevance = relevancePrompt({
    laneTag: "members",
    laneDescription: "Member lists for clubs",
    title,
    excerpt: "",
    replies: [],
  });
  const draft = draftPrompt({
    displayName,
    bio: "",
    register: "du",
    language: "de",
    country: "DE",
    toneNotes: "",
    facts,
    targets,
    title,
    excerpt: "",
    citeSource: true,
    maxChars: 1200,
  });
  const fit = fitPrompt({ title, excerpt: "", body: RECORDED_REPLY.body, facts });
  await mkdir(join(root, "classify"), { recursive: true });
  await mkdir(join(root, "draft"), { recursive: true });
  await writeFile(
    join(
      root,
      "classify",
      `${textModelFixtureKey("classify", relevance.system, relevance.user)}.json`,
    ),
    JSON.stringify({
      modelId: "recorded-classify",
      value: {
        relevance: 0.91,
        openQuestion: true,
        reasons: ["The thread asks how clubs keep member lists."],
      },
    }),
  );
  await writeFile(
    join(root, "draft", `${textModelFixtureKey("draft", draft.system, draft.user)}.json`),
    JSON.stringify({ modelId: "recorded-draft", value: RECORDED_REPLY }),
  );
  await writeFile(
    join(root, "classify", `${textModelFixtureKey("classify", fit.system, fit.user)}.json`),
    JSON.stringify({
      modelId: "recorded-classify",
      value: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
    }),
  );
  return new RecordedTextModel(root);
}

function deliverTo(h: Harness) {
  return (mail: FixtureMail) => {
    const inbox = h.emulator.inboxForAddress(mail.to);
    if (inbox) h.emulator.receiveWebhook(webhookFor(mail, inbox.inboxId));
  };
}

async function tickUntil(
  runner: LinkBuilderRealRunner,
  done: () => Promise<boolean>,
  maxTicks = 40,
): Promise<number> {
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    await runner.tick();
    if (await done()) return tick;
  }
  throw new Error(`Not done after ${maxTicks} ticks`);
}

const adapterContext: AdapterContext = {
  operationId: "e2e",
  traceId: "e2e",
  workspaceId: actor.workspaceId,
  userId: actor.userId,
  signal: new AbortController().signal,
};

it.runIf(gate.required)("has Chromium when the browser end to end test is required", () => {
  expect(gate.reason).toBeUndefined();
});

describe.skipIf(!gate.available)(
  `link builder real driver end to end${gate.reason ? ` (${gate.reason})` : ""}`,
  () => {
    let h: Harness;
    const fixtures: Array<{ close(): Promise<void> }> = [];
    const runners: LinkBuilderRealRunner[] = [];

    beforeAll(async () => {
      h = await createHarness();
    }, 60_000);

    afterAll(async () => {
      await Promise.all(runners.map((runner) => runner.close()));
      await Promise.all(fixtures.map((fixture) => fixture.close()));
      await h?.db.close();
      if (h?.root) await rm(h.root, { recursive: true, force: true });
    });

    it("registers, verifies mail, posts and counts one LIVE placement", async () => {
      const fixture = await startPhpbbFixture({
        rel: "ugc",
        cookieWall: true,
        linkRuleMinPosts: 0,
        captchaAnswer: CAPTCHA_ANSWER,
        deliverMail: deliverTo(h),
      });
      fixtures.push(fixture);
      const { project, host, mailboxId } = await wizardProject(
        h,
        fixture,
        "Vereinsplaner Forum",
        "Mira Sol",
      );
      const captcha = new FakeCaptchaSolver({ outcomes: [CAPTCHA_ANSWER] });
      const runner = new LinkBuilderRealRunner({
        prisma: h.db.prisma,
        secrets: h.secrets,
        artifacts: h.artifacts,
        browsers: h.factory,
        captcha,
        mailbox: h.emulator,
        textModel: await recordedDraftModel("Mira Sol"),
        allowPrivateVerify: true,
        verifyDelayMs: 0,
        pageHelperPollMs: 50,
        workerId: "e2e-worker-a",
      });
      runners.push(runner);
      const { prisma } = h.db;
      const run = await prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });

      await tickUntil(runner, async () => {
        const current = await prisma.lbRun.findUniqueOrThrow({ where: { id: run.id } });
        return current.status === "succeeded";
      });

      const placements = await prisma.lbPlacement.findMany({ where: { projectId: project.id } });
      expect(placements).toHaveLength(1);
      const placement = placements[0]!;
      expect(placement.status).toBe("nofollow_live");
      expect(placement.rel).toEqual(["ugc"]);
      expect(placement.counted).toBe(true);
      expect(placement.verifyMethod).toBe("logged_out_fetch");
      expect(placement.postUrl).toBe(`${fixture.origin}/viewtopic.php?p=2#p2`);
      expect(placement.targetUrl).toBe("https://vereinsplaner.example/mitglieder");
      const drafts = await prisma.lbDraft.findMany({ where: { projectId: project.id } });
      expect(drafts[0]?.modelId).toBe("recorded-draft");
      expect(drafts[0]?.body).toContain("vereinsplaner.example/mitglieder");

      const finalHost = await prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
      expect(finalHost.status).toBe("used");
      const finalRun = await prisma.lbRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(finalRun).toMatchObject({ newToday: 1, liveToday: 1, uniqueHosts: 1 });

      const events = await prisma.lbCaptchaEvent.findMany({ where: { projectId: project.id } });
      const placed = events.find((event) => event.outcome === "placed_submitted");
      expect(placed).toMatchObject({
        type: "image_letters",
        door: "https_api",
        taskId: "fake-task-1",
      });
      expect(JSON.stringify(placed)).not.toContain(FAKE_CAPTELL_TOKEN);
      expect(JSON.stringify(placed)).not.toContain(CAPTCHA_ANSWER);

      const steps = await prisma.lbRunStep.findMany({
        where: { runId: run.id },
        orderBy: { stepIndex: "asc" },
      });
      expect(steps.find((step) => step.kind === "helper_connected")?.outcome).toMatchObject({
        helperVersion: "2026.10.4.16",
      });
      expect(steps.map((step) => step.kind)).toEqual([
        "select_host",
        "open_session",
        "helper_connected",
        "cookie_wall",
        "register",
        "captcha",
        "email_verify",
        "warmup",
        "post",
        "verify",
        "close",
      ]);
      expect(steps.every((step) => step.error === null)).toBe(true);
      const shots = steps.flatMap((step) => step.artifactIds);
      const shotRows = await prisma.artifact.findMany({ where: { id: { in: shots } } });
      expect(shotRows.filter((row) => row.mimeType === "image/png").length).toBeGreaterThanOrEqual(
        6,
      );
      const postStep = steps.find((step) => step.kind === "post")!;
      expect(postStep.artifactIds).toHaveLength(2);

      const snapshot = await prisma.artifact.findUniqueOrThrow({
        where: { id: placement.snapshotArtifactId! },
      });
      expect(snapshot.mimeType).toBe("text/html");
      const snapshotHtml = new TextDecoder().decode(
        await h.artifacts.get(snapshot.storageKey, adapterContext),
      );
      expect(snapshotHtml).toContain('href="https://vereinsplaner.example/mitglieder"');

      // Logged-out verification: no persona cookie, the verifier's own user agent.
      const verifyRequests = fixture.requests.filter((r) => r.userAgent === VERIFY_USER_AGENT);
      expect(verifyRequests.length).toBeGreaterThan(0);
      expect(verifyRequests.every((r) => r.cookie === null)).toBe(true);

      // Credentials live only in the encrypted vault and never reach step outcomes.
      const account = await prisma.lbHostAccount.findUniqueOrThrow({ where: { hostId: host.id } });
      const login = await prisma.siteLogin.findUniqueOrThrow({
        where: { id: account.siteLoginId! },
        include: { secret: true },
      });
      const password = h.secrets.load(login.secret.ciphertext);
      expect(fixture.users.get(account.username)?.password).toBe(password);
      expect(JSON.stringify(steps)).not.toContain(password);
      expect(login.secret.ciphertext).not.toContain(password);
      expect(account).toMatchObject({ postCount: 1, linkPostCount: 1 });
      expect(account.emailVerifiedAt).not.toBeNull();
      expect(h.emulator.listMessages).toBeDefined();
      expect(
        (await h.emulator.listMessages(mailboxId, {}, adapterContext)).some(
          (m) => m.subject.length > 0,
        ),
      ).toBe(true);

      const captchaEvents = await prisma.lbCaptchaEvent.findMany({
        where: { projectId: project.id },
      });
      expect(captchaEvents).toMatchObject([
        { type: "image_letters", door: "https_api", outcome: "placed_submitted", attempt: 1 },
      ]);
      expect(captcha.requests[0]?.type).toBe("ImageToText");

      expect(existsSync(join(h.root, ".browser-profiles", project.id))).toBe(true);

      // The partial unique index keeps it at one counted placement per host.
      await expect(
        prisma.lbPlacement.create({
          data: {
            workspaceId: actor.workspaceId,
            projectId: project.id,
            hostId: host.id,
            hostAccountId: account.id,
            threadUrl: placement.threadUrl,
            postUrl: `${fixture.origin}/viewtopic.php?p=99#p99`,
            targetUrl: placement.targetUrl,
            anchorText: placement.anchorText,
            status: "live",
            counted: true,
          },
        }),
      ).rejects.toThrow();

      const viewSteps = await listLbRunSteps(h.deps, actor, {
        projectId: project.id,
        runId: run.id,
      });
      expect(viewSteps.find((step) => step.kind === "post")?.artifactIds).toEqual(
        postStep.artifactIds,
      );

      const artifactDir = process.env.LB_E2E_ARTIFACT_DIR;
      if (artifactDir) {
        const shot = await prisma.artifact.findUniqueOrThrow({
          where: { id: postStep.artifactIds.at(-1)! },
        });
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          join(artifactDir, "lb-m2-board-after-reply.png"),
          await h.artifacts.get(shot.storageKey, adapterContext),
        );
        await writeFile(join(artifactDir, "lb-m2-verification-snapshot.html"), snapshotHtml);
      }
    }, 180_000);

    it("skips a forum when Captell cannot solve the captcha", async () => {
      const fixture = await startPhpbbFixture({
        rel: "follow",
        linkRuleMinPosts: 0,
        captchaAnswer: CAPTCHA_ANSWER,
        deliverMail: deliverTo(h),
      });
      fixtures.push(fixture);
      const { project, host } = await wizardProject(
        h,
        fixture,
        "Vereinsplaner Operator",
        "Jonas Brandt",
      );
      const runner = new LinkBuilderRealRunner({
        prisma: h.db.prisma,
        secrets: h.secrets,
        artifacts: h.artifacts,
        browsers: h.factory,
        captcha: new FakeCaptchaSolver({ outcomes: ["WRONG1", "WRONG2"] }),
        mailbox: h.emulator,
        textModel: await recordedDraftModel("Jonas Brandt"),
        allowPrivateVerify: true,
        verifyDelayMs: 0,
        workerId: "e2e-worker-b",
      });
      runners.push(runner);
      const { prisma } = h.db;
      const hostStatus = async () =>
        (await prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } })).status;

      await tickUntil(runner, async () => (await hostStatus()) === "unsupported_captcha");
      expect(fixture.registrationSubmits()).toBe(2);
      expect(
        await prisma.lbOperatorTicket.count({
          where: { projectId: project.id, reason: "captcha_unsolved" },
        }),
      ).toBe(0);
      const skipped = await prisma.lbHost.findUniqueOrThrow({ where: { id: host.id } });
      expect(skipped.parkedFrom).toBeNull();
      expect(skipped.statusReason).toBe("captcha_unsolved");
    }, 180_000);

    it("records placed_submitted when the fixture Page Helper places the check", async () => {
      const fixture = await startPhpbbFixture({
        challenge: "widget",
        activation: "none",
        cookieWall: false,
        linkRuleMinPosts: 0,
        deliverMail: () => undefined,
      });
      fixtures.push(fixture);
      const { project } = await wizardProject(h, fixture, "Widget Board", "Noa Feld");
      const runner = new LinkBuilderRealRunner({
        prisma: h.db.prisma,
        secrets: h.secrets,
        artifacts: h.artifacts,
        browsers: h.factory,
        captcha: new FakeCaptchaSolver(),
        mailbox: h.emulator,
        allowPrivateVerify: true,
        verifyDelayMs: 0,
        pageHelperPollMs: 50,
        workerId: "e2e-worker-widget",
      });
      runners.push(runner);
      const run = await h.db.prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
      await tickUntil(runner, async () => {
        const rows = await h.db.prisma.lbCaptchaEvent.findMany({
          where: { projectId: project.id },
        });
        return rows.some(
          (event) => event.outcome === "placed_submitted" && event.door === "page_helper",
        );
      });
      const event = await h.db.prisma.lbCaptchaEvent.findFirstOrThrow({
        where: { projectId: project.id, outcome: "placed_submitted" },
      });
      expect(event).toMatchObject({
        door: "page_helper",
        type: "recaptcha_v2",
        buttonTextObserved: "Placed. Submit the form.",
        siteKeyFound: true,
        helperVersion: "2026.10.4.16",
      });
      expect(event.taskId).toBeNull();
      expect(JSON.stringify(event)).not.toContain("fixture-token");
      const current = await h.db.prisma.lbRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(current.status === "succeeded" || current.status === "running").toBe(true);
    }, 180_000);

    it("registers on MyBB, solves the image captcha and posts", async () => {
      await runFixtureBoard({
        h,
        fixtures,
        runners,
        platform: "mybb",
        persona: "Nia Feld",
        name: "MyBB members",
        start: () =>
          startMybbFixture({
            rel: "ugc",
            captchaAnswer: CAPTCHA_ANSWER,
            deliverMail: deliverTo(h),
          }),
        permalink: /\/showthread\.php\?tid=1&pid=\d+#pid\d+$/,
        captcha: { type: "image_letters", door: "https_api" },
        artifact: "lb-m5-mybb-after-reply.png",
      });
    }, 120_000);

    it("registers on XenForo, passes the widget helper and posts", async () => {
      await runFixtureBoard({
        h,
        fixtures,
        runners,
        platform: "xenforo",
        persona: "Leo Hart",
        name: "XenForo members",
        start: () =>
          startXenforoFixture({
            rel: "ugc",
            deliverMail: deliverTo(h),
          }),
        permalink: /\/threads\/membership\.1\/post-\d+$/,
        captcha: { type: "recaptcha_v2", door: "page_helper" },
        artifact: "lb-m5-xenforo-after-reply.png",
      });
    }, 120_000);
  },
);

async function runFixtureBoard(input: {
  h: Harness;
  fixtures: Array<{ close(): Promise<void> }>;
  runners: LinkBuilderRealRunner[];
  platform: string;
  persona: string;
  name: string;
  start: () => Promise<MarkupFixture>;
  permalink: RegExp;
  captcha: { type: string; door: string };
  artifact: string;
}): Promise<void> {
  const fixture = await input.start();
  input.fixtures.push(fixture);
  const { project } = await wizardProject(
    input.h,
    fixture,
    input.name,
    input.persona,
    input.platform,
  );
  const captcha = new FakeCaptchaSolver({ outcomes: [CAPTCHA_ANSWER] });
  const runner = new LinkBuilderRealRunner({
    prisma: input.h.db.prisma,
    secrets: input.h.secrets,
    artifacts: input.h.artifacts,
    browsers: input.h.factory,
    captcha,
    mailbox: input.h.emulator,
    textModel: await recordedDraftModel(input.persona),
    allowPrivateVerify: true,
    verifyDelayMs: 0,
    pageHelperPollMs: 50,
    workerId: `e2e-${input.platform}`,
  });
  input.runners.push(runner);
  const { prisma } = input.h.db;
  const run = await prisma.lbRun.findFirstOrThrow({ where: { projectId: project.id } });
  await tickUntil(runner, async () => {
    const current = await prisma.lbRun.findUniqueOrThrow({ where: { id: run.id } });
    return current.status === "succeeded";
  });
  const placement = await prisma.lbPlacement.findFirstOrThrow({ where: { projectId: project.id } });
  expect(placement.status).toBe("nofollow_live");
  expect(placement.counted).toBe(true);
  expect(placement.postUrl).toMatch(input.permalink);
  const event = await prisma.lbCaptchaEvent.findFirstOrThrow({
    where: { projectId: project.id, outcome: "placed_submitted" },
  });
  expect(event).toMatchObject(input.captcha);
  const postStep = await prisma.lbRunStep.findFirstOrThrow({
    where: { runId: run.id, kind: "post" },
  });
  const artifactDir = process.env.LB_E2E_ARTIFACT_DIR;
  if (artifactDir) {
    const shot = await prisma.artifact.findUniqueOrThrow({
      where: { id: postStep.artifactIds.at(-1)! },
    });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, input.artifact),
      await input.h.artifacts.get(shot.storageKey, adapterContext),
    );
  }
}
