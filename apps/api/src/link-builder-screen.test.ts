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

function fleetInfo(info: { state: "running" | "paused" } | null): E2BFleet {
  return {
    listComputers: vi.fn(async () => []),
    info: vi.fn(async () =>
      info
        ? {
            id: "sandbox-1",
            state: info.state,
            startedAt: new Date("2026-10-15T14:00:00.000Z"),
            template: "desktop",
          }
        : null,
    ),
    kill: vi.fn(async () => {
      throw new Error("kill");
    }),
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

  it("does not touch the sandbox when the stored id is gone", async () => {
    const sandbox = throwingSandbox();
    const fleet = fleetInfo(null);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const first = await openProjectComputerScreen(
        deps(screenPrisma(computer()), sandbox, fleet),
        actor,
        "project-1",
      );
      const second = await openProjectComputerScreen(
        deps(screenPrisma(computer()), sandbox, fleet),
        actor,
        "project-1",
      );
      expect(first).toEqual({ url: null, error: null, state: "off" });
      expect(second).toEqual({ url: null, error: null, state: "off" });
      expectSandboxUntouched(sandbox);
      expect(sandbox.connectScreen).not.toHaveBeenCalled();
      expect(fleet.kill).not.toHaveBeenCalled();
      const gone = info.mock.calls.filter((call) =>
        call.some((part) => String(part).includes("screen saw gone sandbox")),
      );
      expect(gone).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it("does not touch the sandbox for a cached url on a running computer", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const sandbox = throwingSandbox();
    const fleet = fleetInfo({ state: "running" });
    const result = await openProjectComputerScreen(
      deps(screenPrisma(computer({ screenUrl: url })), sandbox, fleet),
      actor,
      "project-1",
    );
    expectSandboxUntouched(sandbox);
    expect(fleet.kill).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.state).toBe("live");
    expect(result.url).toContain("/novnc/remote/view/");
  });

  it("does not touch the sandbox when the row is stopped", async () => {
    const sandbox = throwingSandbox();
    const fleet = fleetInfo({ state: "running" });
    const result = await openProjectComputerScreen(
      deps(screenPrisma(computer({ state: "stopped", providerRef: "sandbox-1" })), sandbox, fleet),
      actor,
      "project-1",
    );
    expect(result).toEqual({ url: null, error: null, state: "off" });
    expectSandboxUntouched(sandbox);
    expect(sandbox.connectScreen).not.toHaveBeenCalled();
    expect(fleet.info).not.toHaveBeenCalled();
  });

  it("does not touch the sandbox when the row is suspended", async () => {
    const sandbox = throwingSandbox();
    const fleet = fleetInfo({ state: "running" });
    const result = await openProjectComputerScreen(
      deps(
        screenPrisma(computer({ state: "suspended", providerRef: "sandbox-1" })),
        sandbox,
        fleet,
      ),
      actor,
      "project-1",
    );
    expect(result).toEqual({ url: null, error: null, state: "off" });
    expectSandboxUntouched(sandbox);
    expect(sandbox.connectScreen).not.toHaveBeenCalled();
    expect(fleet.info).not.toHaveBeenCalled();
  });
});
