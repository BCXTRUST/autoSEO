import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  DaytonaSandboxProvider,
  type DaytonaSandboxSdk,
  E2BSandboxProvider,
  type E2BSandboxSdk,
} from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { SandboxBrowserSessionFactory } from "./factory.js";
import { LAUNCH_ENV, REQUEST_ENV } from "./runner-cli.js";

const context: AdapterContext = {
  operationId: "sandbox",
  traceId: "sandbox",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

interface RecordedCall {
  command: string;
  env?: Record<string, string>;
}

/**
 * Fake SDK clients. They record the command and env the provider forwards and return the
 * shell's exit immediately, which is what a detached `nohup … &` start must do.
 */
function scripted(options: { startExit?: number; answerPing?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  let started = false;
  const answer = (command: string, env?: Record<string, string>) => {
    calls.push({ command, env });
    if (command.includes("nohup")) {
      started = (options.startExit ?? 0) === 0;
      return { exitCode: options.startExit ?? 0, stdout: "" };
    }
    if (!started || options.answerPing === false) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: false, error: "runner not running" })}\n`,
      };
    }
    const raw = env?.[REQUEST_ENV] ?? "";
    const request = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { method?: string };
    const value = request.method === "ping" ? { sessionId: "sess-1" } : "hello";
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, value })}\n` };
  };
  return { calls, answer };
}

function daytona(script: ReturnType<typeof scripted>): DaytonaSandboxProvider {
  const executeCommand = vi.fn(
    async (command: string, _cwd?: string, env?: Record<string, string>) => {
      const result = script.answer(command, env);
      return { exitCode: result.exitCode, result: result.stdout };
    },
  );
  const sandbox = {
    id: "daytona-box",
    state: "started",
    process: { executeCommand },
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getWorkDir: vi.fn(async () => "/home/daytona"),
  };
  const sdk: DaytonaSandboxSdk = {
    create: vi.fn(async () => sandbox) as unknown as DaytonaSandboxSdk["create"],
    get: vi.fn(async () => sandbox) as unknown as DaytonaSandboxSdk["get"],
  };
  return new DaytonaSandboxProvider({ apiKey: "test-key" }, sdk);
}

function e2b(script: ReturnType<typeof scripted>): E2BSandboxProvider {
  const run = vi.fn(async (command: string, options?: { envs?: Record<string, string> }) => {
    const result = script.answer(command, options?.envs);
    return { stdout: result.stdout, stderr: "", exitCode: result.exitCode };
  });
  const desktop = {
    sandboxId: "e2b-box",
    commands: { run },
    setTimeout: vi.fn(async () => undefined),
  };
  const sdk: E2BSandboxSdk = {
    create: vi.fn(async () => desktop) as unknown as E2BSandboxSdk["create"],
    connect: vi.fn(async () => desktop) as unknown as E2BSandboxSdk["connect"],
    pause: vi.fn(async () => undefined),
  };
  return new E2BSandboxProvider("test-key", sdk);
}

async function open(
  provider: DaytonaSandboxProvider | E2BSandboxProvider,
  options: { startTimeoutMs?: number } = {},
) {
  const computer = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
  const factory = new SandboxBrowserSessionFactory({
    sandbox: provider,
    resolveComputer: async () => computer,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    startTimeoutMs: options.startTimeoutMs ?? 1_000,
  });
  return factory.open(
    {
      projectId: "project-1",
      profileKey: "project-1",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    },
    context,
  );
}

function expectServeContract(calls: RecordedCall[]) {
  const start = calls.find((call) => call.command.includes("nohup"));
  expect(start?.command).toContain("rakazo-lb-browser");
  expect(start?.command).toContain("/tmp/rakazo-lb/project-1.json");
  expect(start?.command).toContain("chmod 700");
  const launch = JSON.parse(
    Buffer.from(start?.env?.[LAUNCH_ENV] ?? "", "base64").toString("utf8"),
  ) as { profileDir: string; executablePath: string };
  expect(launch).toMatchObject({
    profileDir: "/home/rakazo/.browser-profiles/project-1",
    executablePath: "/usr/bin/chromium",
  });
  const ping = calls.find((call) => call.env?.[REQUEST_ENV]);
  expect(ping?.env?.[REQUEST_ENV]).toBeTruthy();
}

describe("Daytona and E2B honor the browser serve contract", () => {
  it.each([
    ["daytona", daytona],
    ["e2b", e2b],
  ] as const)("%s forwards env and the detached start script", async (_name, build) => {
    const script = scripted();
    const session = await open(build(script));
    expect(await session.text("p")).toBe("hello");
    expectServeContract(script.calls);
  });

  it.each([
    ["daytona", daytona],
    ["e2b", e2b],
  ] as const)("%s fails when the start script exits non-zero", async (_name, build) => {
    const script = scripted({ startExit: 7 });
    await expect(open(build(script))).rejects.toThrow(/exit 7/);
    expect(script.calls.some((call) => call.command.includes("nohup"))).toBe(true);
  });

  it.each([
    ["daytona", daytona],
    ["e2b", e2b],
  ] as const)("%s fails when the runner never answers ping", async (_name, build) => {
    const script = scripted({ answerPing: false });
    await expect(open(build(script), { startTimeoutMs: -1 })).rejects.toThrow(
      /did not become ready/,
    );
  });
});
