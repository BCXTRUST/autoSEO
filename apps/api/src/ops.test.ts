import type { E2BFleet } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  mountOpsRoutes,
  type OpsDeps,
  resetE2BTemplateBuildForTests,
  setE2BTemplateBuildForTests,
  stopEverything,
} from "./ops.js";

const RIGHT = "0123456789abcdef0123456789abcdef";

interface Recorded {
  name: string;
  args: unknown;
}

function recordingPrisma(calls: Recorded[]) {
  return {
    lbProject: {
      updateMany: async (args: unknown) => {
        calls.push({ name: "lbProject.updateMany", args });
        return { count: 2 };
      },
      findMany: async (args: unknown) => {
        calls.push({ name: "lbProject.findMany", args });
        return [{ id: "project-1", name: "Vitaminexpress", status: "active" }];
      },
    },
    lbRun: {
      updateMany: async (args: unknown) => {
        calls.push({ name: "lbRun.updateMany", args });
        return { count: 1 };
      },
    },
    computer: {
      updateMany: async (args: unknown) => {
        calls.push({ name: "computer.updateMany", args });
        return { count: 1 };
      },
      findMany: async (args: unknown) => {
        calls.push({ name: "computer.findMany", args });
        return [
          {
            id: "computer-1",
            workspaceId: "workspace-1",
            state: "stopped",
            providerRef: null,
          },
        ];
      },
    },
    lbHost: {
      findMany: async () => [
        { id: "host-1", registrableDomain: "forum.example", status: "active" },
      ],
    },
    siteLogin: {
      count: async () => 1,
    },
  } as unknown as PrismaClient;
}

function recordingFleet(calls: Recorded[], pages: string[][]): E2BFleet {
  let listed = 0;
  return {
    async listComputers() {
      const ids = pages[listed] ?? [];
      listed += 1;
      calls.push({ name: "fleet.listComputers", args: { page: listed } });
      return ids.map((id) => ({
        id,
        state: "running" as const,
        startedAt: new Date("2026-10-15T14:00:00.000Z"),
        template: "desktop",
      }));
    },
    async info() {
      return null;
    },
    async kill(id) {
      calls.push({ name: "fleet.kill", args: id });
      return id !== "missing";
    },
  };
}

function appFor(deps: OpsDeps) {
  const app = new Hono();
  mountOpsRoutes(app, deps);
  return app;
}

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/;

function assertNoSecrets(body: string): void {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    if (body.includes(value)) {
      throw new Error(`ops response contains the value of ${name}`);
    }
  }
}

describe("stopEverything", () => {
  it("pauses projects, pauses runs, kills sandboxes, then nulls rows", async () => {
    const calls: Recorded[] = [];
    const result = await stopEverything({
      prisma: recordingPrisma(calls),
      fleet: recordingFleet(calls, [["sb-1", "missing"], []]),
    });
    expect(calls.map((call) => call.name)).toEqual([
      "lbProject.updateMany",
      "lbRun.updateMany",
      "fleet.listComputers",
      "fleet.kill",
      "fleet.kill",
      "computer.updateMany",
      "fleet.listComputers",
    ]);
    expect(calls[0]?.args).toEqual({
      where: { status: "active" },
      data: { status: "paused" },
    });
    expect(calls[1]?.args).toEqual({
      where: { status: { in: ["queued", "running", "overtime"] } },
      data: { status: "paused" },
    });
    const rowCall = calls.findIndex((call) => call.name === "computer.updateMany");
    const killCall = calls.findIndex((call) => call.name === "fleet.kill");
    expect(killCall).toBeGreaterThan(-1);
    expect(rowCall).toBeGreaterThan(killCall);
    expect(calls[rowCall]?.args).toEqual({
      where: { kind: "e2b", providerRef: { not: null } },
      data: { state: "stopped", providerRef: null, screenUrl: null },
    });
    expect(result).toEqual({ projectsPaused: 2, runsPaused: 1, killed: 1, remaining: 0 });
  });
});

describe("ops routes", () => {
  const previous = {
    OPS_TOKEN: process.env.OPS_TOKEN,
    E2B_API_KEY: process.env.E2B_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    LINK_BUILDER_DRIVER: process.env.LINK_BUILDER_DRIVER,
    LINK_BUILDER_SEARCH: process.env.LINK_BUILDER_SEARCH,
    SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER,
    E2B_TEMPLATE: process.env.E2B_TEMPLATE,
  };

  function restore(): void {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  it("returns 404 when the token is unset or short, 401 when it is wrong, and 200 when it matches", async () => {
    const calls: Recorded[] = [];
    const deps = {
      prisma: recordingPrisma(calls),
      fleet: recordingFleet(calls, [[]]),
    };
    const app = appFor(deps);
    try {
      delete process.env.OPS_TOKEN;
      const unset = await app.request("/api/ops/state");
      expect(unset.status).toBe(404);

      process.env.OPS_TOKEN = "too-short";
      const short = await app.request("/api/ops/state", {
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(short.status).toBe(404);

      process.env.OPS_TOKEN = RIGHT;
      const wrong = await app.request("/api/ops/state", {
        headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token" },
      });
      expect(wrong.status).toBe(401);

      process.env.E2B_API_KEY = "e2b-secret-value-not-for-output";
      process.env.DATABASE_URL = "postgres://user:secret-db-password@localhost/db";
      process.env.RESEND_API_KEY = "re_secret_value_not_for_output";
      process.env.RAILWAY_GIT_COMMIT_SHA = "abc123def456";
      process.env.LINK_BUILDER_DRIVER = "real";
      process.env.LINK_BUILDER_SEARCH = "dataforseo";
      process.env.SANDBOX_PROVIDER = "e2b";
      process.env.E2B_TEMPLATE = "desktop";
      const right = await app.request("/api/ops/state?projectId=project-1", {
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(right.status).toBe(200);
      const body = await right.text();
      assertNoSecrets(body);
      expect(body).not.toContain(RIGHT);
      const json = JSON.parse(body) as {
        revision: string;
        config: { driver: string; browser: string; search: string };
        hosts: Array<{ domain: string; logins: number }>;
        computers: Array<{ browserSeenAt: string | null }>;
      };
      expect(json.revision).toBe("abc123def456");
      expect(json.config).toMatchObject({
        driver: "real",
        browser: "sandbox",
        search: "dataforseo",
        sandboxProvider: "e2b",
        template: "desktop",
        idleMs: 120000,
      });
      expect(json.hosts).toEqual([{ domain: "forum.example", status: "active", logins: 1 }]);
      expect(json.computers[0]?.browserSeenAt).toBeNull();

      const stopped = await app.request("/api/ops/stop-all", {
        method: "POST",
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(stopped.status).toBe(200);
      const stoppedBody = await stopped.text();
      assertNoSecrets(stoppedBody);
      expect(stoppedBody).not.toContain(RIGHT);
    } finally {
      restore();
    }
  });

  it("builds the browser template in the background and redacts secrets from logs", async () => {
    resetE2BTemplateBuildForTests();
    const calls: Recorded[] = [];
    const deps = {
      prisma: recordingPrisma(calls),
      fleet: recordingFleet(calls, [[]]),
    };
    const app = appFor(deps);
    let finish: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const seen: Array<Record<string, unknown>> = [];
    setE2BTemplateBuildForTests((_template, options) => {
      seen.push({ ...options, onBuildLogs: undefined });
      options.onBuildLogs?.({
        message: `using ${process.env.E2B_API_KEY}`,
        timestamp: new Date(),
        level: "info",
      } as never);
      return new Promise((resolve, reject) => {
        finish = () => resolve(undefined);
        fail = reject;
      });
    });
    const savedToken = process.env.OPS_TOKEN;
    const savedKey = process.env.E2B_API_KEY;
    process.env.OPS_TOKEN = RIGHT;
    process.env.E2B_API_KEY = "e2b-secret-value-not-for-output";
    try {
      const denied = await app.request("/api/ops/e2b-template");
      expect(denied.status).toBe(401);

      const started = await app.request("/api/ops/e2b-template", {
        method: "POST",
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ status: "building" });
      expect(seen[0]).toMatchObject({
        alias: "autoseo-browser-v1",
        cpuCount: 2,
        memoryMB: 4096,
        apiKey: "e2b-secret-value-not-for-output",
      });

      const again = await app.request("/api/ops/e2b-template", {
        method: "POST",
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(await again.json()).toEqual({ status: "building" });
      expect(seen).toHaveLength(1);

      const during = await app.request("/api/ops/e2b-template", {
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      const duringBody = await during.text();
      assertNoSecrets(duringBody);
      expect(duringBody).not.toContain("e2b-secret-value-not-for-output");
      expect(JSON.parse(duringBody)).toMatchObject({
        status: "building",
        logs: ["using [redacted]"],
      });

      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ready = await app.request("/api/ops/e2b-template", {
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(await ready.json()).toMatchObject({ status: "ready" });

      resetE2BTemplateBuildForTests();
      setE2BTemplateBuildForTests(() => Promise.reject(new Error("build broke")));
      const failing = await app.request("/api/ops/e2b-template", {
        method: "POST",
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      expect(failing.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const errored = await app.request("/api/ops/e2b-template", {
        headers: { authorization: `Bearer ${RIGHT}` },
      });
      const erroredBody = await errored.text();
      assertNoSecrets(erroredBody);
      expect(JSON.parse(erroredBody).status).toBe("error");
      expect(fail).toBeTypeOf("function");
    } finally {
      resetE2BTemplateBuildForTests();
      if (savedToken === undefined) delete process.env.OPS_TOKEN;
      else process.env.OPS_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = savedKey;
    }
  });
});
