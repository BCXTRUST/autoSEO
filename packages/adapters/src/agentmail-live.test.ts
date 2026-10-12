import { describe, expect, it } from "vitest";
import { agentMailLiveClient } from "./agentmail-live.js";

const inbox = "persona@inbox.example";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("agentMailLiveClient", () => {
  it("loads each listed message body so an activation link can be read without a webhook", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/messages?limit=20&include_spam=true")) {
        return json({ count: 1, messages: [{ message_id: "msg_1" }] });
      }
      return json({
        message_id: "msg_1",
        from: "board@medizin-forum.de",
        subject: "Aktivierung",
        timestamp: "2026-10-09T10:22:00.000Z",
        text: "https://www.medizin-forum.de/phpbb/ucp.php?mode=activate&u=1&k=token",
        html: "<a href=\"https://www.medizin-forum.de/phpbb/ucp.php?mode=activate&u=1&k=token\">open</a>",
      });
    };
    const client = agentMailLiveClient("am_test_key", fetchImpl);
    await expect(client.listMessages?.(inbox)).resolves.toEqual([
      {
        inboxId: inbox,
        from: "board@medizin-forum.de",
        subject: "Aktivierung",
        textBody: "https://www.medizin-forum.de/phpbb/ucp.php?mode=activate&u=1&k=token",
        htmlBody:
          "<a href=\"https://www.medizin-forum.de/phpbb/ucp.php?mode=activate&u=1&k=token\">open</a>",
        receivedAt: "2026-10-09T10:22:00.000Z",
      },
    ]);
    expect(calls).toEqual([
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages?limit=20&include_spam=true`,
      `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/msg_1`,
    ]);
  });
});
