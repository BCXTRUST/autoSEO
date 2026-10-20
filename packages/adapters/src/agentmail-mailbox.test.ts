import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { AgentMailEmulator, parseAgentMailWebhook } from "./agentmail-mailbox.js";
import { personMailboxAddress } from "./person-mailbox.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const webhook = (overrides: Record<string, unknown> = {}) => ({
  event_type: "message.received",
  event_id: "evt_1",
  message: {
    inbox_id: "persona@inbox.example",
    from: [{ email: "noreply@board.example.test", name: "Board" }],
    subject: "Welcome",
    text: "Activate: http://board.example.test/ucp.php?mode=activate&u=2&k=X",
    timestamp: "2026-10-05T10:00:00.000Z",
    ...overrides,
  },
});

describe("AgentMail mailbox", () => {
  it("translates message.received webhooks", () => {
    expect(parseAgentMailWebhook(webhook())).toEqual({
      inboxId: "persona@inbox.example",
      from: "noreply@board.example.test",
      subject: "Welcome",
      textBody: "Activate: http://board.example.test/ucp.php?mode=activate&u=2&k=X",
      receivedAt: "2026-10-05T10:00:00.000Z",
    });
    expect(parseAgentMailWebhook({ event_type: "message.sent", message: {} })).toBeNull();
    expect(parseAgentMailWebhook({ event_type: "message.received" })).toBeNull();
  });

  it("stores mail for known inboxes once and lists it by time", async () => {
    const mailbox = new AgentMailEmulator();
    mailbox.registerInbox("project-1", {
      inboxId: "persona@inbox.example",
      address: "persona@inbox.example",
    });
    expect(await mailbox.ensureInbox("project-1", context)).toEqual({
      inboxId: "persona@inbox.example",
      address: "persona@inbox.example",
    });
    expect(mailbox.receiveWebhook(webhook())).toBe(true);
    expect(mailbox.receiveWebhook(webhook())).toBe(false);
    expect(mailbox.receiveWebhook(webhook({ inbox_id: "other@inbox.example" }))).toBe(false);
    expect(
      mailbox.receiveWebhook({
        ...webhook({ timestamp: "2026-10-05T09:00:00.000Z" }),
        event_id: "evt_0",
      }),
    ).toBe(true);
    const all = await mailbox.listMessages("persona@inbox.example", {}, context);
    expect(all.map((mail) => mail.receivedAt)).toEqual([
      "2026-10-05T09:00:00.000Z",
      "2026-10-05T10:00:00.000Z",
    ]);
    const recent = await mailbox.listMessages(
      "persona@inbox.example",
      { since: new Date("2026-10-05T09:30:00.000Z") },
      context,
    );
    expect(recent).toHaveLength(1);
    expect(mailbox.inboxForAddress("PERSONA@inbox.example")?.inboxId).toBe("persona@inbox.example");
  });

  it("creates a stable inbox per project", async () => {
    const mailbox = new AgentMailEmulator();
    const first = await mailbox.ensureInbox("Proj_1", context);
    expect(first.address).toBe(personMailboxAddress("Proj_1:0", "inbox.example"));
    expect(first.address.startsWith("lb-")).toBe(false);
    expect(await mailbox.ensureInbox("Proj_1", context)).toBe(first);
  });

  it("redacts captcha solver tokens", () => {
    const store = new EncryptedSecretStore("k".repeat(32));
    expect(store.redact("token ct_live_abcdef123456 here")).toBe("token [redacted] here");
  });
});
