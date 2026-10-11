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
    const expires = Date.now() + 30 * 60_000;
    const url = `https://app.autoseo.run/novnc/remote/view/${expires}.capability/vnc.html`;
    expect(reusableScreenUrl(url)).toBe(url);
    expect(reusableScreenUrl(url, expires - 60_000)).toBeNull();
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
    const expires = Date.now() + 30 * 60_000;
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
  });

  it("boots a stopped team computer and publishes a proxied stream", async () => {
    const connectScreen = vi.fn(async () => ({
      url: "https://desktop.test/vnc.html?password=secret",
      mimeType: "text/html",
      close: async () => undefined,
    }));
    const stored: { screenUrl?: string } = {};
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => ({ id: "project-1" })) },
      computer: {
        findFirst: vi.fn(async () =>
          computer({ state: "stopped", providerRef: null, screenUrl: null }),
        ),
        findMany: vi.fn(async () => [
          computer({ state: "stopped", providerRef: null, screenUrl: null }),
        ]),
        findUnique: vi.fn(async () => computer({ state: "running", providerRef: "sandbox-1" })),
        update: vi.fn(async ({ data }: { data: { screenUrl?: string } }) => {
          stored.screenUrl = data.screenUrl;
          return computer({ screenUrl: data.screenUrl });
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const boot = vi.fn(async () => ({
      id: "sandbox-1",
      botId: "team-workspace-1",
      kind: "e2b" as const,
      providerRef: "sandbox-1",
    }));
    const result = await openProjectComputerScreen(
      deps(prisma, { connectScreen, keepAlive: vi.fn() }),
      actor,
      "project-1",
      boot,
    );
    expect(boot).toHaveBeenCalledOnce();
    expect(connectScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "sandbox-1", kind: "e2b" }),
      { view: "stream", interactive: false },
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
    expect(result.error).toBeNull();
    expect(result.url).toContain("/novnc/remote/view/");
    expect(result.url).not.toContain("password=");
    expect(stored.screenUrl).toBe(result.url);
  });

  it("opens Google search for the stored topic and skips example hosts", async () => {
    const expires = Date.now() + 30 * 60_000;
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
    expect(opened).toContain("exec /usr/bin/google-chrome");
    expect(opened).toContain("--kiosk");
    expect(opened).toContain("TranslateEnabled");
    expect(opened).toContain("rakazo-chrome-kiosk-v3");
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
    const expires = Date.now() + 30 * 60_000;
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
          scripts.push(request.argv.at(-1) ?? "");
          yield { type: "stdout" as const, data: "runner\n" };
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
    const expires = Date.now() + 30 * 60_000;
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
            data: request.argv.at(-1)?.includes("rakazo-chrome-kiosk-v3")
              ? "ok\n"
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
});
