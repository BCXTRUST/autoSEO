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

function deps(prisma: PrismaClient, sandbox: Record<string, unknown> = {}): ProjectScreenDeps {
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
  };
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

  it("returns the stored team screen without opening another machine", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const connectScreen = vi.fn();
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, { connectScreen, keepAlive: vi.fn() }),
      actor,
      "project-1",
    );
    expect(result).toEqual({ url, error: null });
    expect(connectScreen).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes a stale screen instead of serving a dead stream", async () => {
    const stale = `https://app.autoseo.run/novnc/remote/view/${Date.now() + 30 * 60_000}.capability/vnc.html`;
    const connectScreen = vi.fn(async () => ({
      url: "https://49982-user.e2b.app/vnc.html?autoconnect=true",
    }));
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: stale })),
        findMany: vi.fn(async () => [computer({ screenUrl: stale })]),
        update: vi.fn(async () => computer()),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen,
        execute: async function* () {
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-1",
    );
    expect(connectScreen).toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.url).toContain("/novnc/remote/view/");
    expect(result.url).not.toBe(stale);
  });

  it("replaces one dead sandbox and does not leave the old id running", async () => {
    const dead = new Error("Sandbox is probably not running anymore");
    dead.name = "SandboxNotFoundError";
    const connectScreen = vi.fn().mockRejectedValueOnce(dead).mockResolvedValueOnce({
      url: "https://49982-user.e2b.app/vnc.html?autoconnect=true",
    });
    const provision = vi.fn(async () => ({
      id: "sandbox-2",
      botId: "team-workspace-1",
      kind: "e2b" as const,
      providerRef: "sandbox-2",
      fresh: true,
    }));
    const destroy = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findMany: vi.fn(async () => [computer()]),
        updateMany,
        update: vi.fn(async () => computer()),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, { connectScreen, provision, destroy }),
      actor,
      "project-1",
    );
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0]?.[0]).toMatchObject({ botId: "team-workspace-1" });
    expect(provision.mock.calls[0]?.[0]).not.toHaveProperty("providerRef");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.calls[0]?.[0]).toMatchObject({ providerRef: "sandbox-1" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "computer-1", state: "running", providerRef: "sandbox-1" },
        data: { state: "booting", providerRef: null, screenUrl: null },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.url).toContain("/novnc/remote/view/");
  });

  it("drops a fresh screen url when that sandbox is already gone", async () => {
    const expires = Date.now() + 60 * 60_000;
    const stale = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const dead = new Error("Sandbox is probably not running anymore");
    dead.name = "SandboxNotFoundError";
    const provision = vi.fn(async () => ({
      id: "sandbox-2",
      botId: "team-workspace-1",
      kind: "e2b" as const,
      providerRef: "sandbox-2",
      fresh: true,
    }));
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findMany: vi.fn(async () => [computer({ screenUrl: stale })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => computer()),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(async () => ({
          url: "https://49982-user.e2b.app/vnc.html?autoconnect=true",
        })),
        provision,
        destroy: vi.fn(async () => undefined),
        execute: async function* () {
          throw dead;
        },
      }),
      actor,
      "project-1",
    );
    expect(provision).toHaveBeenCalledTimes(1);
    expect(result.url).toContain("/novnc/remote/view/");
    expect(result.url).not.toBe(stale);
  });

  it("does not write a dead sandbox id back when replacement fails", async () => {
    const dead = new Error("Sandbox is probably not running anymore");
    dead.name = "SandboxNotFoundError";
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findMany: vi.fn(async () => [computer()]),
        updateMany,
      },
      bot: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(async () => {
          throw dead;
        }),
        provision: vi.fn(async () => {
          throw new Error("create failed");
        }),
        destroy: vi.fn(async () => undefined),
      }),
      actor,
      "project-1",
    );
    expect(result.url).toBeNull();
    expect(result.error).toContain("create failed");
    const restored = updateMany.mock.calls.some((call) => {
      const data = (call[0] as { data?: { providerRef?: string | null } }).data;
      return data?.providerRef === "sandbox-1";
    });
    expect(restored).toBe(false);
  });

  it("does not start a second sandbox when another request already claimed the computer", async () => {
    const dead = new Error("Sandbox is probably not running anymore");
    dead.name = "SandboxNotFoundError";
    const provision = vi.fn();
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findMany: vi.fn(async () => [computer()]),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      bot: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(async () => {
          throw dead;
        }),
        provision,
        destroy: vi.fn(),
      }),
      actor,
      "project-1",
    );
    expect(result).toEqual({ url: null, error: null });
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not replace a sandbox when the stream error is transient", async () => {
    const provision = vi.fn();
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findMany: vi.fn(async () => [computer()]),
        updateMany: vi.fn(),
      },
      bot: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(async () => {
          throw new Error("ECONNRESET");
        }),
        provision,
      }),
      actor,
      "project-1",
    );
    expect(provision).not.toHaveBeenCalled();
    expect(result.url).toBeNull();
    expect(result.error).toContain("ECONNRESET");
  });

  it("does not start a computer just to show the dashboard", async () => {
    const connectScreen = vi.fn();
    const keepAlive = vi.fn();
    const boot = vi.fn();
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findFirst: vi.fn(async () =>
          computer({ state: "stopped", providerRef: null, screenUrl: null }),
        ),
        findMany: vi.fn(async () => [
          computer({ state: "stopped", providerRef: null, screenUrl: null }),
        ]),
      },
      bot: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, { connectScreen, keepAlive }),
      actor,
      "project-1",
      boot,
    );
    expect(result).toEqual({ url: null, error: null });
    expect(boot).not.toHaveBeenCalled();
    expect(connectScreen).not.toHaveBeenCalled();
    expect(keepAlive).not.toHaveBeenCalled();
  });

  it("wakes a stopped sandbox instead of leaving the pane dark", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findFirst: vi.fn(async () => computer({ state: "stopped", screenUrl: url })),
        findMany: vi.fn(async () => [computer({ state: "stopped", screenUrl: url })]),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return { count: 1 };
        }),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(),
        keepAlive: vi.fn(),
        execute: async function* () {
          yield { type: "stdout" as const, data: "ok\n" };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-1",
    );
    expect(result).toEqual({ url, error: null });
    expect(updates[0]).toMatchObject({ state: "running" });
  });

  it("opens Google search for the stored topic and skips example hosts", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const scripts: string[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => ({
          id: "project-google",
          name: "Vitaminexpress",
          brandName: "Vitaminexpress",
          topicLanes: [{ tag: "Magnesium kaufen" }],
          targets: [
            {
              url: "https://www.vitaminexpress.org/de/magnesium",
              keywordClusters: ["magnesium kaufen", "brett-abc.example"],
            },
          ],
        })),
      },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const result = await openProjectComputerScreen(
      deps(prisma, {
        connectScreen: vi.fn(),
        keepAlive: vi.fn(),
        execute: async function* (_ref: unknown, request: { argv: string[] }) {
          const script = request.argv.at(-1) ?? "";
          scripts.push(script);
          yield {
            type: "stdout" as const,
            data: script.includes("xdotool search") ? "1\t1\tHome\n" : "",
          };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-google",
    );
    expect(result).toEqual({ url, error: null });
    await vi.waitFor(() => {
      expect(scripts.some((script) => script.includes("google.de/search"))).toBe(true);
    });
    const opened = scripts.find((script) => script.includes("google.de/search"));
    expect(opened).toContain("Magnesium");
    expect(opened).toContain("Forum");
    expect(opened).not.toMatch(/Vitaminexpress|kaufen/i);
    expect(opened).toContain("RAKAZO_DETACH_BROWSER");
    expect(opened).toContain("/usr/bin/google-chrome");
    expect(opened).toContain("setsid -f");
    expect(opened).toContain("--kiosk");
    expect(opened).toContain("TranslateEnabled");
    expect(opened).toContain("--disable-gpu");
    expect(opened).toContain("rakazo-chrome-kiosk-v6");
    expect(opened).not.toContain("key --window");
    expect(scripts.join("\n")).not.toContain("key Escape");
    expect(opened).toContain("--start-fullscreen");
    expect(opened).toContain("--no-first-run");
    expect(opened).toContain("--disable-fre");
    expect(opened).toContain("--no-default-browser-check");
    expect(opened).toContain("OutdatedBuildDetector");
    expect(scripts.some((script) => script.includes("Can't update Chrome"))).toBe(true);
    expect(opened).not.toContain("nohup");
    expect(opened).not.toContain(".example");
    expect(scripts.some((script) => script.includes("FULLSCREEN"))).toBe(true);
    expect(scripts.some((script) => script.includes("xfce4-panel"))).toBe(true);
    expect(scripts.join("\n")).not.toMatch(/register|signup|post/i);
  });

  it("leaves the persona browser alone while it is working", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const scripts: string[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => ({
          id: "project-registering",
          name: "Vitaminexpress",
          brandName: "Vitaminexpress",
          topicLanes: [{ tag: "Magnesium kaufen" }],
          targets: [{ url: "https://www.vitaminexpress.org/de/magnesium", keywordClusters: [] }],
        })),
      },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await openProjectComputerScreen(
      deps(prisma, {
        keepAlive: vi.fn(),
        execute: async function* (_ref: unknown, request: { argv: string[] }) {
          const script = request.argv.at(-1) ?? "";
          scripts.push(script);
          const data =
            script.includes("--onlyvisible --class") || script.includes("search --class")
              ? "browser\n"
              : script.includes("xdotool search")
                ? "4\t1\tRegistrieren\n"
                : script.includes("x11vnc")
                  ? ":0\n"
                  : "runner\n";
          yield { type: "stdout" as const, data };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-registering",
    );
    await vi.waitFor(() => {
      expect(scripts.some((script) => script.includes("[r]akazo-lb-browser"))).toBe(true);
    });
    expect(scripts.join("\n")).not.toContain("killall -q chrome");
    expect(scripts.some((script) => script.includes("google.de/search"))).toBe(false);
  });

  it("leaves a Google search that is already on the computer", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const scripts: string[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => ({
          id: "project-searching",
          name: "Vitaminexpress",
          brandName: "Vitaminexpress",
          topicLanes: [{ tag: "Magnesium kaufen" }],
          targets: [{ url: "https://www.vitaminexpress.org/de/magnesium", keywordClusters: [] }],
        })),
      },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await openProjectComputerScreen(
      deps(prisma, {
        keepAlive: vi.fn(),
        execute: async function* (_ref: unknown, request: { argv: string[] }) {
          scripts.push(request.argv.at(-1) ?? "");
          yield {
            type: "stdout" as const,
            data: request.argv.at(-1)?.includes("rakazo-chrome-kiosk-v6")
              ? "ok\n"
              : request.argv.at(-1)?.includes("search --class") ||
                  request.argv.at(-1)?.includes("--onlyvisible --class")
                ? "browser\n"
                : "9\t1\tMagnesium Krämpfe Forum - Google Suche\n",
          };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-searching",
    );
    await vi.waitFor(() => {
      expect(scripts.some((script) => script.includes("FULLSCREEN"))).toBe(true);
    });
    expect(scripts.some((script) => script.includes("google.de/search"))).toBe(false);
    expect(scripts.join("\n")).not.toMatch(/Vitaminexpress|kaufen/i);
    expect(scripts.join("\n")).not.toContain("killall -q chrome");
    expect(scripts.some((script) => script.includes("FULLSCREEN"))).toBe(true);
    expect(scripts.some((script) => script.includes("xfce4-panel"))).toBe(true);
    expect(scripts.join("\n")).not.toMatch(/register|signup|post/i);
  });

  it("leaves a forum page in place instead of typing the search again", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const scripts: string[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => ({
          id: "project-forum",
          name: "Vitaminexpress",
          brandName: "Vitaminexpress",
          topicLanes: [{ tag: "Magnesium kaufen" }],
          targets: [{ url: "https://www.vitaminexpress.org/de/magnesium", keywordClusters: [] }],
        })),
      },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await openProjectComputerScreen(
      deps(prisma, {
        keepAlive: vi.fn(),
        execute: async function* (_ref: unknown, request: { argv: string[] }) {
          const script = request.argv.at(-1) ?? "";
          scripts.push(script);
          yield {
            type: "stdout" as const,
            data:
              script.includes("search --class") || script.includes("--onlyvisible --class")
                ? "browser\n"
                : "9\t1\tWie lang kann man Creatin täglich einnehmen - paradisi.de\n",
          };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-forum",
    );
    await vi.waitFor(() => {
      expect(scripts.some((script) => script.includes("x11vnc"))).toBe(true);
    });
    expect(scripts.some((script) => script.includes("ctrl+l"))).toBe(false);
    expect(scripts.join("\n")).not.toMatch(/register|signup|post/i);
  });

  it("replaces a firefox process that never mapped a window", async () => {
    const expires = Date.now() + 60 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    const scripts: string[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => ({
          id: "project-windowless",
          name: "Vitaminexpress",
          brandName: "Vitaminexpress",
          topicLanes: [{ tag: "Magnesium kaufen" }],
          targets: [{ url: "https://www.vitaminexpress.org/de/magnesium", keywordClusters: [] }],
        })),
      },
      computer: {
        findFirst: vi.fn(async () => computer({ screenUrl: url })),
        findMany: vi.fn(async () => [computer({ screenUrl: url })]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await openProjectComputerScreen(
      deps(prisma, {
        keepAlive: vi.fn(),
        execute: async function* (_ref: unknown, request: { argv: string[] }) {
          const script = request.argv.at(-1) ?? "";
          scripts.push(script);
          const data = script.includes("ps -o stat=")
            ? "up\n"
            : script.includes("onlyvisible --class")
              ? "none\n"
              : script.includes("[r]akazo-lb-browser")
                ? ""
                : "";
          yield { type: "stdout" as const, data };
          yield { type: "exit" as const, code: 0 };
        },
      }),
      actor,
      "project-windowless",
    );
    await vi.waitFor(() => {
      expect(scripts.some((script) => script.includes("rakazo-ff-recover"))).toBe(true);
    });
    expect(scripts.some((script) => script.includes("RAKAZO_DETACH_BROWSER"))).toBe(false);
    expect(scripts.join("\n")).not.toMatch(/register|signup|post/i);
  });
});
