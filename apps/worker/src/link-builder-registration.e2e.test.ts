import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBrowserSessionFactory } from "@rakazo/linkbuilder-browser";
import { browserTestGate } from "@rakazo/linkbuilder-browser/testing";
import { TEST_PACING } from "@rakazo/linkbuilder-core";
import { PhpbbDriver } from "@rakazo/linkbuilder-drivers";
import { type FixtureMail, startPhpbbFixture } from "@rakazo/linkbuilder-drivers/testing";
import { describe, expect, it } from "vitest";

const gate = browserTestGate();
it.runIf(gate.required)("has Chromium for the controlled registration journey", () =>
  expect(gate.available).toBe(true),
);
describe.skipIf(!gate.available)("controlled English forum registration and posting", () => {
  it("creates exactly one account, activates email, logs in, and verifies one relevant reply", async () => {
    const mail: FixtureMail[] = [];
    const root = await mkdtemp(join(tmpdir(), "research-forum-test-"));
    const forum = await startPhpbbFixture({
      boardName: "English Research Test Forum",
      topicTitle: "How should PEMF studies be compared?",
      topicBody: "Which study details matter when comparing different PEMF devices?",
      deliverMail: (message) => {
        mail.push(message);
      },
    });
    const factory = new LocalBrowserSessionFactory({
      profileRoot: root,
      headless: true,
      engine: "playwright",
      pacing: TEST_PACING,
      ...(process.env.LB_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.LB_TEST_CHROMIUM_PATH }
        : {}),
      env: { LINK_BUILDER_BROWSER: "local" },
    });
    const session = await factory.open(
      {
        projectId: "controlled-test",
        profileKey: "controlled-test",
        country: "US",
        locale: "en-US",
        timezoneId: "America/New_York",
        acceptLanguage: "en-US,en;q=0.9",
      },
      {
        operationId: "controlled-test",
        traceId: "controlled-test",
        workspaceId: "test",
        userId: "test",
        signal: AbortSignal.timeout(90000),
      },
    );
    try {
      const driver = new PhpbbDriver();
      const account = {
        username: "ResearchTester",
        email: "researcher@example.test",
        password: "Fixture-only-password-012345",
      };
      const registrationPage = await driver.openRegistration(session, forum.origin);
      expect(registrationPage).toBe("form");
      await driver.fillRegistration(session, account);
      expect((await driver.detectCaptcha(session)).kind).toBe("image");
      await session.fill("#confirm_code", "K7XQ2");
      expect((await driver.submitRegistration(session)).kind).toBe("pending_email");
      const activation = mail
        .map((message) => message.textBody)
        .join("\n")
        .match(/https?:\/\/[^\s]+mode=activate[^\s]*/)?.[0];
      expect(activation).toBeTruthy();
      await session.goto(activation!);
      expect(await driver.activationResult(session)).toBe("active");
      expect(await driver.login(session, forum.origin, account)).toBe(true);
      const thread = {
        url: `${forum.origin}/viewtopic.php?t=1`,
        title: "How should PEMF studies be compared?",
      };
      expect(await driver.openReply(session, thread)).toBe(true);
      const body =
        "Compare the study population, control group, field strength, pulse frequency, treatment schedule, and measured outcomes. Results from one device or protocol should not be assumed to apply to another. This is a research comparison, not medical advice.";
      await driver.fillReply(session, body);
      const result = await driver.submitReply(session);
      expect(result.kind).toBe("posted");
      if (result.kind !== "posted")
        throw new Error("Reply was not published in the controlled fixture");
      await session.goto(result.permalink);
      expect(await session.pageText()).toContain(body);
      expect(forum.registrationSubmits()).toBe(1);
      expect(forum.replySubmits()).toBe(1);
      expect(forum.users.size).toBe(1);
      expect(
        [...forum.posts.values()].filter((post) => post.author === account.username),
      ).toHaveLength(1);
      expect((await session.elementScreenshotPng("body")).length).toBeGreaterThan(200);
    } finally {
      await session.close();
      await forum.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
