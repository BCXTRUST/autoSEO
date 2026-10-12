import type { AdapterContext, FormFieldInfo, InboundMail } from "@rakazo/adapter-kit";
import { FakeCaptchaSolver } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { planRegistration, registrationProfile } from "./generic.js";
import { boardDriverFor } from "./index.js";
import { runGenericRegistrationJourney } from "./registration-flow.js";
import { startCustomForumFixture } from "./testing/custom-forum-fixture.js";
import { HtmlBrowserSession } from "./testing/html-session.js";
import { startPhpbbFixture } from "./testing/phpbb-fixture.js";
import {
  startAdminActivationFixture,
  startCustomPhpBoardFixture,
  startPhpbbCustomThemeFixture,
  startPhpbbProsilverFixture,
  startXenforo2Fixture,
} from "./testing/registration-fixtures.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const profile = registrationProfile({
  username: "sophie_braun85",
  email: "mira@inbox.example",
  password: "Fx-Pass-Word-77",
  givenName: "Sophie",
  familyName: "Braun",
  birthday: { day: "15", month: "6", year: "1990" },
  securityAnswer: "nordlicht",
});

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
  const imported = (await import(
    new URL("../../adapters/src/agentmail-mailbox.ts", import.meta.url).href
  )) as { AgentMailEmulator: new (domain?: string) => FixtureMailbox };
  return new imported.AgentMailEmulator();
}

async function mailbox() {
  const emulator = await loadMailbox();
  const inbox = { inboxId: profile.email, address: profile.email };
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

function control(partial: Partial<FormFieldInfo> & Pick<FormFieldInfo, "selector">): FormFieldInfo {
  return {
    selector: partial.selector,
    tag: partial.tag ?? "input",
    type: partial.type ?? "text",
    name: partial.name ?? null,
    id: partial.id ?? null,
    autocomplete: partial.autocomplete ?? null,
    label: partial.label ?? "",
    role: partial.role ?? null,
    required: partial.required ?? false,
    group: partial.group,
    value: partial.value,
    options: partial.options,
    hidden: partial.hidden,
  };
}

const identity = [
  control({ selector: "#username", name: "username", label: "Username" }),
  control({ selector: "#email", name: "email", type: "email", label: "Email" }),
  control({ selector: "#password", name: "password", type: "password", label: "Password" }),
  control({ selector: "#submit", tag: "button", type: "submit", label: "Register" }),
];

describe("generic registration flow", () => {
  it("uses the unknown platform driver and parks instead of guessing", () => {
    expect(boardDriverFor("unknown")?.platform).toBe("unknown");
    const tied = planRegistration(
      [
        control({ selector: "#username", name: "username", label: "Username" }),
        control({ selector: "#login", name: "login", label: "Username" }),
        ...identity.slice(1),
      ],
      profile,
    );
    expect(tied).toMatchObject({ ok: false, reason: "tie" });

    const unknown = planRegistration(
      [
        ...identity,
        control({
          selector: "#member_number",
          name: "member_number",
          label: "Member number",
          required: true,
        }),
      ],
      profile,
    );
    expect(unknown).toMatchObject({
      ok: false,
      reason: "unknown_required",
      label: "Member number",
    });

    const named = planRegistration(
      [...identity, control({ selector: "#full", name: "full_name", label: "Full name" })],
      profile,
    );
    expect(named.ok).toBe(true);
    if (named.ok) {
      expect(named.actions).toContainEqual({
        selector: "#full",
        kind: "fill",
        value: "Sophie Braun",
      });
    }
  });

  it("submits a form with no captcha without calling Captell", async () => {
    const board = await startCustomForumFixture();
    const solver = new FakeCaptchaSolver();
    const session = new HtmlBrowserSession("none");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        await loadMailbox(),
        profile.email,
        reply,
      );
      expect(result.detected).toEqual({ kind: "none" });
      expect(solver.requests).toHaveLength(0);
      expect(solver.questions).toHaveLength(0);
      expect(result.registration).toEqual(["pending_email"]);
      expect(result.outcome).toBe("parked");
      expect(result.parkReason).toBe("verification_mail_missing");
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("retries a refused phpBB image captcha, then posts after the mail logs in", async () => {
    const mail = await mailbox();
    const board = await startPhpbbProsilverFixture({ deliverMail: mail.deliverMail });
    const solver = new FakeCaptchaSolver({ outcomes: ["WRONG", board.captchaAnswer] });
    const session = new HtmlBrowserSession("prosilver");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(solver.requests.map((request) => request.type)).toEqual([
        "ImageToText",
        "ImageToText",
      ]);
      expect(solver.questions).toHaveLength(0);
      expect(result.registration).toEqual(["captcha_rejected", "pending_email"]);
      expect(result.activation).toBe("logged_in");
      expect(result.outcome).toBe("posted");
      expect(result.permalink).toMatch(/viewtopic\.php\?p=/);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("answers the phpBB question, fills the extra required fields, and logs in from the mail link", async () => {
    const mail = await mailbox();
    const board = await startPhpbbCustomThemeFixture({ deliverMail: mail.deliverMail });
    const solver = new FakeCaptchaSolver({ answers: { hauptstadt: board.captchaAnswer } });
    const session = new HtmlBrowserSession("custom-theme");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(solver.requests).toHaveLength(0);
      expect(solver.questions.map((question) => question.question).join("\n")).toMatch(
        /Hauptstadt/,
      );
      expect(result.registration).toEqual(["pending_email"]);
      expect(result.activation).toBe("login_form");
      expect(result.outcome).toBe("posted");
      expect(result.permalink).toMatch(/viewtopic\.php\?p=/);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("sends reCAPTCHA v2 and its site key, then posts after the mail logs in", async () => {
    const mail = await mailbox();
    const board = await startXenforo2Fixture({ deliverMail: mail.deliverMail });
    const solver = new FakeCaptchaSolver();
    const session = new HtmlBrowserSession("xenforo");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(solver.requests).toEqual([
        expect.objectContaining({
          type: "recaptcha_v2",
          websiteKey: "fixture-site-key",
          websiteURL: expect.stringContaining("/register"),
        }),
      ]);
      expect(result.registration).toEqual(["pending_email"]);
      expect(result.activation).toBe("logged_in");
      expect(result.outcome).toBe("posted");
      expect(result.permalink).toMatch(/\/threads\/membership\.1\/post-/);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("sends hCaptcha and its site key, then posts after the mail link lands on login", async () => {
    const mail = await mailbox();
    const board = await startCustomPhpBoardFixture({ deliverMail: mail.deliverMail });
    const solver = new FakeCaptchaSolver();
    const session = new HtmlBrowserSession("custom-php");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(solver.requests).toEqual([
        expect.objectContaining({ type: "hcaptcha", websiteKey: "fixture-site-key" }),
      ]);
      expect(result.activation).toBe("login_form");
      expect(result.outcome).toBe("posted");
      expect(result.permalink).toMatch(/\/thread\/1#post/);
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("treats a German administrator hold as pending admin even when the search form stays", async () => {
    const mail = await mailbox();
    const board = await startPhpbbFixture({
      boardName: "Admin After Submit",
      challenge: "widget",
      widget: "hcaptcha",
      activation: "admin",
      adminNotice: "result",
      deliverMail: mail.deliverMail,
    });
    const solver = new FakeCaptchaSolver();
    const session = new HtmlBrowserSession("admin-result");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(result.outcome).toBe("pending_admin");
      expect(result.fromForm).toBe(false);
      expect(result.registration).toEqual(["pending_admin"]);
      expect(result.permalink).toBeNull();
    } finally {
      await session.close();
      await board.close();
    }
  });

  it("reads admin activation from the form and does not spend a captcha attempt", async () => {
    const mail = await mailbox();
    const board = await startAdminActivationFixture({ deliverMail: mail.deliverMail });
    const solver = new FakeCaptchaSolver();
    const session = new HtmlBrowserSession("admin");
    try {
      const result = await runGenericRegistrationJourney(
        session,
        board.origin,
        profile,
        solver,
        context,
        mail.emulator,
        mail.inboxId,
        reply,
      );
      expect(result.outcome).toBe("pending_admin");
      expect(result.fromForm).toBe(true);
      expect(result.detected).toEqual({
        kind: "widget",
        type: "turnstile",
        siteKey: "fixture-site-key",
      });
      expect(result.solved).toBe(0);
      expect(solver.requests).toHaveLength(0);
      expect(solver.questions).toHaveLength(0);
      expect(result.registration).toEqual([]);
    } finally {
      await session.close();
      await board.close();
    }
  });
});
