import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IDLE_MS, sandboxIdleMs, sleepComputerIfIdle } from "./computer-idle.js";
import {
  e2bCreateOptions,
  isUnrecoverableSandboxError,
  openDesktopBrowser,
} from "./e2b-sandbox.js";

describe("sandbox idle", () => {
  it("defaults to two minutes when SANDBOX_IDLE_MS is unset", () => {
    const previous = process.env.SANDBOX_IDLE_MS;
    delete process.env.SANDBOX_IDLE_MS;
    try {
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
      expect(DEFAULT_SANDBOX_IDLE_MS).toBe(120_000);
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_IDLE_MS;
      else process.env.SANDBOX_IDLE_MS = previous;
    }
  });

  it("caps an e2b idle of ten minutes at two minutes", () => {
    const previousIdle = process.env.SANDBOX_IDLE_MS;
    const previousProvider = process.env.SANDBOX_PROVIDER;
    process.env.SANDBOX_IDLE_MS = "600000";
    process.env.SANDBOX_PROVIDER = "e2b";
    try {
      expect(sandboxIdleMs()).toBe(120_000);
    } finally {
      if (previousIdle === undefined) delete process.env.SANDBOX_IDLE_MS;
      else process.env.SANDBOX_IDLE_MS = previousIdle;
      if (previousProvider === undefined) delete process.env.SANDBOX_PROVIDER;
      else process.env.SANDBOX_PROVIDER = previousProvider;
    }
  });

  it("does not suspend a computer while a run is active", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.destroy).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not suspend the desktop while a link-builder step holds the lease", async () => {
    const harness = idleHarness();
    harness.prisma.lbRun.findFirst.mockResolvedValueOnce({ id: "lb-run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.destroy).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("destroys an idle e2b sandbox and nulls the row", async () => {
    const harness = idleHarness();
    harness.prisma.lbProject.findFirst.mockResolvedValue({ id: "project" });
    harness.prisma.lbRun.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.destroy).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: { id: harness.computer.id },
      data: {
        state: "stopped",
        providerRef: null,
        screenUrl: null,
        browserSeenAt: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
  });

  it("stops a docker computer without destroying it", async () => {
    const harness = idleHarness({ kind: "docker" });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.sandbox.destroy).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: { id: harness.computer.id },
      data: {
        state: "suspended",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.destroy).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it("rechecks the lease boundary after checkpointing before it suspends", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.destroy).toHaveBeenCalledOnce();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: { id: harness.computer.id },
      data: {
        state: "stopped",
        providerRef: null,
        screenUrl: null,
        browserSeenAt: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "stopped" } }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });
});

describe("e2b create options", () => {
  it("kills on timeout instead of pausing the sandbox", () => {
    const previous = process.env.SANDBOX_HARD_TIMEOUT_MS;
    delete process.env.SANDBOX_HARD_TIMEOUT_MS;
    try {
      const opts = e2bCreateOptions("bot-1", "e2b_test");
      expect(opts.lifecycle).toEqual({ onTimeout: "kill", autoResume: false });
      expect(opts.timeoutMs).toBe(300000);
      expect(opts.metadata.botId).toBe("bot-1");
      expect(opts.metadata.template).toBe("autoseo-browser-v1");
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_HARD_TIMEOUT_MS;
      else process.env.SANDBOX_HARD_TIMEOUT_MS = previous;
    }
  });

  it("only recreates when the sandbox is actually gone", () => {
    expect(isUnrecoverableSandboxError(new Error("sandbox not found"))).toBe(true);
    expect(isUnrecoverableSandboxError(new Error("Sandbox is probably not running anymore"))).toBe(
      true,
    );
    const named = new Error("gone");
    named.name = "SandboxNotFoundError";
    expect(isUnrecoverableSandboxError(named)).toBe(true);
    expect(isUnrecoverableSandboxError(new Error("ECONNRESET"))).toBe(false);
  });

  it("opens a browser on a new desktop", async () => {
    const launched: string[] = [];
    await openDesktopBrowser({
      launch: async (application) => {
        launched.push(application);
        if (application !== "firefox") throw new Error("missing");
      },
      open: async () => {
        throw new Error("should not fall back");
      },
    });
    expect(launched).toEqual(["google-chrome", "firefox"]);
  });

  it("does not open Google or about:blank when no browser binary launches", async () => {
    const opened: string[] = [];
    await openDesktopBrowser({
      launch: async () => {
        throw new Error("missing");
      },
      open: async (fileOrUrl) => {
        opened.push(fileOrUrl);
      },
    });
    expect(opened).toEqual([]);
  });
});

function idleHarness(options: { exportError?: Error; kind?: string } = {}) {
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    providerRef: "computer",
    kind: options.kind ?? "e2b",
    state: "running",
    workspaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    executionBotId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  let checkpointedAt = computer.updatedAt;
  const prisma = {
    computer: {
      findUnique: vi.fn(async () => ({ ...computer, updatedAt: checkpointedAt })),
      updateMany: vi.fn(async (args) => {
        if (args.data.updatedAt) checkpointedAt = args.data.updatedAt;
        if (args.data.state) computer.state = args.data.state;
        return { count: 1 };
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    lbProject: { findFirst: vi.fn().mockResolvedValue(null) },
    lbRun: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
    },
  };
  const sandbox = {
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  return {
    computer,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}
