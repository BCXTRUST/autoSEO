import type { E2BFleet } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  openProjectComputerScreen,
  type ProjectScreenDeps,
  publicScreenError,
  reusableScreenUrl,
} from "./link-builder-screen.js";

const actor = {
  workspaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function computer(overrides: Record<string, unknown> = {}) {
  return {
    id: "computer-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    scope: "team",
    scopeKey: "team:workspace-1",
    homeKey: "team-workspace-1",
    homeRevision: "empty",
    kind: "e2b",
    providerRef: "sandbox-1",
    state: "running",
    screenUrl: null,
    createdAt: new Date("2026-10-06T12:00:00.000Z"),
    updatedAt: new Date("2026-10-06T12:00:00.000Z"),
    ...overrides,
  };
}

function throwingSandbox() {
  return {
    provision: vi.fn(async () => {
      throw new Error("provision");
    }),
    destroy: vi.fn(async () => {
      throw new Error("destroy");
    }),
    execute: vi.fn(() => {
      throw new Error("execute");
    }),
    connectScreen: vi.fn(async () => ({
      url: "https://49982-user.e2b.app/vnc.html?autoconnect=true",
    })),
  };
}

function deps(
  prisma: PrismaClient,
  sandbox: Record<string, unknown>,
  fleet?: E2BFleet,
): ProjectScreenDeps {
  return {
    prisma,
    events: {} as ProjectScreenDeps["events"],
    jobs: { enqueue: vi.fn() } as unknown as ProjectScreenDeps["jobs"],
    sandbox: sandbox as ProjectScreenDeps["sandbox"],
    home: {} as ProjectScreenDeps["home"],
    dataDir: "/tmp/rakazo-link-builder-screen",
    env: {
      webOrigin: "https://app.autoseo.run",
      screenProxySecret: "test-screen-secret",
      sandboxProvider: "e2b",
    },
    ...(fleet ? { fleet } : {}),
  };
}

function screenPrisma(row: ReturnType<typeof computer>) {
  return {
    lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
    computer: {
      findMany: vi.fn(async () => [row]),
      update: vi.fn(async () => row),
      updateMany: vi.fn(async () => {
        throw new Error("updateMany");
      }),
    },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
  } as unknown as PrismaClient;
}

function expectSandboxUntouched(sandbox: ReturnType<typeof throwingSandbox>) {
  expect(sandbox.provision).not.toHaveBeenCalled();
  expect(sandbox.destroy).not.toHaveBeenCalled();
  expect(sandbox.execute).not.toHaveBeenCalled();
}

describe("project computer screen", () => {
  it("reuses a fresh proxied stream and ignores raw provider urls", () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    expect(reusableScreenUrl(url)).toBe(url);
    expect(reusableScreenUrl(url, expires - 60_000)).toBeNull();
    expect(
      reusableScreenUrl(
        `https://app.autoseo.run/novnc/remote/view/${Date.now() + 30 * 60_000}.capability/vnc.html`,
      ),
    ).toBeNull();
    expect(reusableScreenUrl("https://desktop.test/vnc.html?password=secret")).toBeNull();
    expect(publicScreenError(new Error("bad e2b_livekey postgres://user:pass@db/railway"))).toBe(
      "bad e2b_redacted postgres://redacted",
    );
    expect(publicScreenError(new Error("signal: terminated"))).toBe("Failed to connect to server");
    expect(publicScreenError(new Error("The computer took too long to start"))).toBe(
      "Failed to connect to server",
    );
  });

  it("reports off, starting, no browser, and live without calling the sandbox", async () => {
    const sandbox = throwingSandbox();
    const seen = new Date();
    const cases = [
      { row: computer({ state: "stopped" }), state: "off" },
      { row: computer({ state: "booting", browserSeenAt: null }), state: "starting" },
      { row: computer({ state: "running", browserSeenAt: null }), state: "no_browser" },
      {
        row: computer({
          state: "running",
          browserSeenAt: new Date(Date.now() - 60_000),
        }),
        state: "no_browser",
      },
      { row: computer({ state: "running", browserSeenAt: seen }), state: "live" },
    ] as const;
    for (const item of cases) {
      const result = await openProjectComputerScreen(
        deps(screenPrisma(item.row), sandbox),
        actor,
        "project-1",
      );
      expect(result.state).toBe(item.state);
      expect(result.error).toBeNull();
      if (item.state === "live") expect(result.url).toContain("/novnc/remote/view/");
      else expect(result.url).toBeNull();
    }
    expectSandboxUntouched(sandbox);
    expect(sandbox.connectScreen).not.toHaveBeenCalled();
  });
});
