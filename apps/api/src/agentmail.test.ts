import { describe, expect, it, vi } from "vitest";
import { assignAgentMailInbox, listAgentMailInboxes } from "./agentmail.js";

describe("agentmail helper", () => {
  it("lists inboxes and maps rakazoBotId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          inboxes: [
            {
              inbox_id: "link.b@faircroft.us",
              email: "link.b@faircroft.us",
              display_name: "Link Builder",
              metadata: { rakazoBotId: "bot-1" },
            },
          ],
        }),
      })),
    );
    await expect(listAgentMailInboxes("key")).resolves.toEqual([
      {
        inboxId: "link.b@faircroft.us",
        email: "link.b@faircroft.us",
        displayName: "Link Builder",
        assignedBotId: "bot-1",
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("assigns an inbox and clears the previous bot mapping", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => ({
            inboxes: [
              {
                inbox_id: "old@faircroft.us",
                email: "old@faircroft.us",
                metadata: { rakazoBotId: "bot-1" },
              },
              {
                inbox_id: "link.b@faircroft.us",
                email: "link.b@faircroft.us",
                display_name: "Link Builder",
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      assignAgentMailInbox("key", {
        inboxId: "link.b@faircroft.us",
        botId: "bot-1",
        workspaceId: "ws-1",
      }),
    ).resolves.toMatchObject({
      email: "link.b@faircroft.us",
      assignedBotId: "bot-1",
    });
    const patches = fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH");
    expect(patches.length).toBe(2);
    vi.unstubAllGlobals();
  });
});
