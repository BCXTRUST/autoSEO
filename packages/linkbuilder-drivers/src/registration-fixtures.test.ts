import type { AdapterContext, InboundMail } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { CaptchaChallenge } from "./driver.js";
import { PhpbbDriver } from "./phpbb.js";
import { HtmlBrowserSession } from "./testing/html-session.js";
import {
  type RegistrationBoard,
  registrationFixtureCatalog,
  startAdminActivationFixture,
  startCustomPhpBoardFixture,
  startPhpbbCustomThemeFixture,
  startPhpbbProsilverFixture,
  startXenforo2Fixture,
} from "./testing/registration-fixtures.js";
import { XenforoDriver } from "./xenforo.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const account = {
  username: "mira_sol42",
  password: "Fx-Pass-Word-77",
  email: "mira@inbox.example",
};

const reply = "A shared list is easier for the whole committee.";

interface FixtureMailbox {
  registerInbox(projectId: string, inbox: { inboxId: string; address: string }): void;
  receiveWebhook(body: unknown): boolean;
  listMessages(
    inboxId: string,
    options: { since?: Date },
    context: AdapterContext,
  ): Promise<InboundMail[]>;
}

async function loadMailbox(): Promise<FixtureMailbox> {
  // Loaded by URL so this package does not take the adapters sources into its typecheck root.
  const imported = (await import(
    new URL("../../adapters/src/agentmail-mailbox.ts", import.meta.url).href
  )) as { AgentMailEmulator: new (domain?: string) => FixtureMailbox };
  return new imported.AgentMailEmulator();
}

async function mailbox() {
  const emulator = await loadMailbox();
  const inbox = { inboxId: account.email, address: account.email };
  emulator.registerInbox("fixture-project", inbox);
  let seq = 0;
  const deliverMail = (mail: {
    from: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
  }) => {
    seq += 1;
    const accepted = emulator.receiveWebhook({
      event_type: "message.received",
      event_id: `reg-${seq}`,
      message: {
        inbox_id: inbox.inboxId,
        message_id: `msg-${seq}`,
        from: mail.from,
        subject: mail.subject,
        text: mail.textBody,
        html: mail.htmlBody,
        timestamp: "2026-10-09T12:00:00.000Z",
      },
    });
    if (!accepted) throw new Error("AgentMail emulator rejected the fixture mail");
  };
  return { emulator, inboxId: inbox.inboxId, deliverMail };
}

async function newestText(emulator: FixtureMailbox, inboxId: string): Promise<string> {
  const rows = await emulator.listMessages(inboxId, {}, context);
  return rows.at(-1)?.textBody ?? "";
}

function activationLink(text: string): string | null {
  return /https?:\/\/\S+/.exec(text)?.[0] ?? null;
}

async function passDoor(session: HtmlBrowserSession, door: CaptchaChallenge, answer: string) {
  if (door.kind === "image" || door.kind === "question") {
    await session.fill(door.answerSelector, answer);
  }
  if (door.kind === "widget") {
    const field =
      door.type === "hcaptcha"
        ? "h-captcha-response"
        : door.type === "turnstile"
          ? "cf-turnstile-response"
          : "g-recaptcha-response";
    await session.fill(`[name='${field}']`, "fixture-token");
  }
}

async function fillCustomTheme(session: HtmlBrowserSession) {
  await session.fill("#bdayday", "15");
  await session.fill("#bdaymonth", "6");
  await session.fill("#bdayyear", "1990");
  await session.fill("#sec_answer", "nordlicht");
  await session.click("#newsletter_no");
}

describe("registration fixtures", () => {
  it("covers five captcha kinds and the three activation modes", () => {
    expect(registrationFixtureCatalog).toHaveLength(5);
    expect(new Set(registrationFixtureCatalog.map((row) => row.captcha)).size).toBe(5);
    expect(new Set(registrationFixtureCatalog.map((row) => row.activation))).toEqual(
      new Set(["mail_logs_in", "mail_login_form", "admin"]),
    );
  });

  it("drives phpBB prosilver from the mail link that logs in through the first post", async () => {
    const mail = await mailbox();
    const board = await startPhpbbProsilverFixture({ deliverMail: mail.deliverMail });
    const driver = new PhpbbDriver();
    const session = new HtmlBrowserSession("prosilver");
    try {
      await registerWithPhpbb(session, driver, board);
      const text = await newestText(mail.emulator, mail.inboxId);
      const link = activationLink(text);
      expect(link).toBeTruthy();
      await session.goto(link!);
      expect(await driver.activationResult(session)).toBe("active");
      expect(await driver.isLoggedIn(session)).toBe(true);
      expect(await driver.login(session, board.origin, account)).toBe(true);
      await postWithPhpbb(session, driver, board.origin);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("requires the custom theme fields, then lands the mail link on login", async () => {
    const mail = await mailbox();
    const board = await startPhpbbCustomThemeFixture({ deliverMail: mail.deliverMail });
    const driver = new PhpbbDriver();
    const session = new HtmlBrowserSession("custom-theme");
    try {
      expect(await driver.openRegistration(session, board.origin)).toBe("form");
      await driver.fillRegistration(session, account);
      const door = await driver.detectCaptcha(session);
      expect(door).toMatchObject({
        kind: "question",
        question: expect.stringMatching(/Hauptstadt/),
      });
      await passDoor(session, door, board.captchaAnswer);
      const missing = await driver.submitRegistration(session);
      expect(missing.kind).toBe("form_error");
      if (missing.kind === "form_error") {
        expect(missing.messages.join("\n")).toMatch(/birthday/i);
      }
      await driver.fillRegistration(session, account);
      await passDoor(session, await driver.detectCaptcha(session), board.captchaAnswer);
      await fillCustomTheme(session);
      expect((await driver.submitRegistration(session)).kind).toBe("pending_email");
      const link = activationLink(await newestText(mail.emulator, mail.inboxId));
      expect(link).toBeTruthy();
      await session.goto(link!);
      expect(await driver.activationResult(session)).toBe("active");
      expect(await session.exists("form#login")).toBe(true);
      expect(await driver.isLoggedIn(session)).toBe(false);
      expect(await driver.login(session, board.origin, account)).toBe(true);
      await postWithPhpbb(session, driver, board.origin);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("drives XenForo 2 from the mail link that logs in through the first post", async () => {
    const mail = await mailbox();
    const board = await startXenforo2Fixture({ deliverMail: mail.deliverMail });
    const driver = new XenforoDriver();
    const session = new HtmlBrowserSession("xenforo");
    try {
      expect(await driver.openRegistration(session, board.origin)).toBe("form");
      expect(driver.detect(session.html(), await session.url())).toBe(true);
      await driver.fillRegistration(session, account);
      const door = await driver.detectCaptcha(session);
      expect(door).toMatchObject({
        kind: "widget",
        type: "recaptcha_v2",
        siteKey: "fixture-site-key",
      });
      await passDoor(session, door, board.captchaAnswer);
      expect((await driver.submitRegistration(session)).kind).toBe("pending_email");
      const link = activationLink(await newestText(mail.emulator, mail.inboxId));
      expect(link).toBeTruthy();
      await session.goto(link!);
      expect(await driver.activationResult(session)).toBe("active");
      expect(await driver.isLoggedIn(session)).toBe(true);
      expect(await driver.login(session, board.origin, account)).toBe(true);
      const threads = await driver.listThreads(session, board.origin);
      expect(threads[0]?.title).toMatch(/membership lists/);
      expect(await driver.openReply(session, threads[0]!)).toBe(true);
      await driver.fillReply(session, reply);
      const posted = await driver.submitReply(session);
      expect(posted.kind).toBe("posted");
      if (posted.kind === "posted")
        expect(posted.permalink).toMatch(/\/threads\/membership\.1\/post-/);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("serves the custom PHP board through hCaptcha, a login-form mail link, and a first post", async () => {
    const mail = await mailbox();
    const board = await startCustomPhpBoardFixture({ deliverMail: mail.deliverMail });
    const session = new HtmlBrowserSession("custom-php");
    try {
      await session.goto(`${board.origin}/register`);
      expect(new PhpbbDriver().detect(session.html(), await session.url())).toBe(false);
      expect(new XenforoDriver().detect(session.html(), await session.url())).toBe(false);
      expect(await session.exists(".h-captcha")).toBe(true);
      await session.fill("#handle", account.username);
      await session.fill("#mail", account.email);
      await session.fill("#secret", account.password);
      await session.fill("#secret2", account.password);
      await session.fill("[name='h-captcha-response']", "fixture-token");
      await session.click("#agree");
      await session.click("#join-submit");
      expect(await session.pageText()).toMatch(/activation key has been sent/i);
      const link = activationLink(await newestText(mail.emulator, mail.inboxId));
      expect(link).toBeTruthy();
      await session.goto(link!);
      expect(await session.exists("form#signin")).toBe(true);
      expect(await session.exists("a.logout")).toBe(false);
      expect(await session.pageText()).toMatch(/now been activated/i);
      await session.fill("#login-name", account.username);
      await session.fill("#login-pass", account.password);
      await session.click("#login-submit");
      expect(await session.exists("a.logout")).toBe(true);
      await session.goto(`${board.origin}/thread/1`);
      await session.fill("#message", reply);
      await session.click("#reply-submit");
      expect(await session.pageText()).toMatch(/posted successfully/i);
      const href = await session.attribute("a.permalink", "href");
      await session.goto(new URL(href ?? "/thread/1", board.origin).href);
      expect(await session.pageText()).toContain(reply);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("keeps an admin-activation board logged out until the account is approved", async () => {
    const mail = await mailbox();
    const board = await startAdminActivationFixture({ deliverMail: mail.deliverMail });
    const driver = new PhpbbDriver();
    const session = new HtmlBrowserSession("admin");
    try {
      await registerWithPhpbb(session, driver, board, "pending_admin");
      const text = await newestText(mail.emulator, mail.inboxId);
      expect(text).toMatch(/administrator must activate/i);
      expect(activationLink(text)).toBeNull();
      expect(await driver.login(session, board.origin, account)).toBe(false);
      expect(board.approve(account.username)).toBe(true);
      expect(await driver.login(session, board.origin, account)).toBe(true);
      await postWithPhpbb(session, driver, board.origin);
    } finally {
      await session.close();
      await board.close();
    }
  });
});

async function registerWithPhpbb(
  session: HtmlBrowserSession,
  driver: PhpbbDriver,
  board: RegistrationBoard,
  pending: "pending_email" | "pending_admin" = "pending_email",
) {
  expect(await driver.openRegistration(session, board.origin)).toBe("form");
  expect(driver.detect(session.html(), await session.url())).toBe(true);
  await driver.fillRegistration(session, account);
  const door = await driver.detectCaptcha(session);
  if (board.captcha === "phpbb_image") expect(door.kind).toBe("image");
  if (board.captcha === "turnstile")
    expect(door).toMatchObject({ kind: "widget", type: "turnstile" });
  await passDoor(session, door, board.captchaAnswer);
  expect((await driver.submitRegistration(session)).kind).toBe(pending);
}

async function postWithPhpbb(session: HtmlBrowserSession, driver: PhpbbDriver, origin: string) {
  const threads = await driver.listThreads(session, origin);
  expect(threads).toHaveLength(1);
  expect(await driver.openReply(session, threads[0]!)).toBe(true);
  await driver.fillReply(session, reply);
  const posted = await driver.submitReply(session);
  expect(posted.kind).toBe("posted");
  if (posted.kind === "posted") expect(posted.permalink).toMatch(/viewtopic\.php\?p=/);
}
