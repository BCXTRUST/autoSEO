import { describe, expect, it } from "vitest";
import { createE2BFleet, type E2BFleetSandboxInfo, type E2BFleetSdk } from "./e2b-fleet.js";

const pageOne: E2BFleetSandboxInfo[] = [
  {
    sandboxId: "sb-1",
    state: "running",
    startedAt: new Date("2026-10-15T12:00:00.000Z"),
    templateId: "tpl-desktop",
    name: "desktop",
  },
];

const pageTwo: E2BFleetSandboxInfo[] = [
  {
    sandboxId: "sb-2",
    state: "paused",
    startedAt: new Date("2026-10-15T12:05:00.000Z"),
    templateId: "tpl-browser",
  },
];

function notFound(id: string): Error {
  const error = new Error(`sandbox ${id} not found`);
  error.name = "SandboxNotFoundError";
  return error;
}

function fakeSdk(): E2BFleetSdk {
  let page = 0;
  const pages = [pageOne, pageTwo];
  return {
    list(opts) {
      expect(opts.query).toEqual({
        metadata: { rakazo: "computer" },
        state: ["running", "paused"],
      });
      expect(opts.apiKey).toBe("test-key");
      return {
        get hasNext() {
          return page < pages.length;
        },
        nextItems: async () => pages[page++] ?? [],
      };
    },
    async getInfo(id) {
      throw notFound(id);
    },
    async kill(id) {
      throw notFound(id);
    },
  };
}

describe("createE2BFleet", () => {
  it("lists every page of computer sandboxes", async () => {
    const fleet = createE2BFleet("test-key", fakeSdk());
    await expect(fleet.listComputers()).resolves.toEqual([
      {
        id: "sb-1",
        state: "running",
        startedAt: pageOne[0]?.startedAt,
        template: "desktop",
      },
      {
        id: "sb-2",
        state: "paused",
        startedAt: pageTwo[0]?.startedAt,
        template: "tpl-browser",
      },
    ]);
  });

  it("returns null when the sandbox is not found", async () => {
    const fleet = createE2BFleet("test-key", fakeSdk());
    await expect(fleet.info("missing")).resolves.toBeNull();
  });

  it("returns false when kill misses the sandbox", async () => {
    const fleet = createE2BFleet("test-key", fakeSdk());
    await expect(fleet.kill("missing")).resolves.toBe(false);
  });
});
