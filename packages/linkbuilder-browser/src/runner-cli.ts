import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "@rakazo/linkbuilder-core";
import { z } from "zod";
import { launchPlaywrightSession } from "./playwright-session.js";
import { BrowserRpcServer } from "./rpc.js";
import {
  postRpc,
  RunnerStateSchema,
  startRpcHttpServer,
  writeRunnerState,
} from "./session-runner.js";

/*
 * `rakazo-lb-browser serve --state <file>` owns one persona browser inside the sandbox.
 * `rakazo-lb-browser call --state <file>` forwards one request to it and prints the response.
 * Launch options and requests travel in environment variables, never in argv, because they can
 * carry proxy and forum passwords and argv is visible to every process on the computer.
 */

export const LAUNCH_ENV = "RAKAZO_LB_LAUNCH";
export const REQUEST_ENV = "RAKAZO_LB_RPC";
const DEFAULT_IDLE_MS = 30 * 60_000;

const DelayRangeSchema = z.object({ minMs: z.number().int(), maxMs: z.number().int() }).strict();

export const RunnerLaunchSchema = z
  .object({
    profileDir: z.string().min(1),
    helperDirs: z.array(z.string().min(1)).default([]),
    locale: z.string().min(2),
    timezoneId: z.string().min(1),
    acceptLanguage: z.string().min(1).optional(),
    engine: z.enum(["playwright", "patchright", "camoufox"]).optional(),
    proxy: z
      .object({
        server: z.string().min(1),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .strict()
      .optional(),
    headless: z.boolean().optional(),
    executablePath: z.string().min(1).optional(),
    pacing: z
      .object({
        keystroke: DelayRangeSchema,
        beforeAction: DelayRangeSchema,
        maxActionsPerMinute: z.number().int(),
      })
      .strict()
      .optional(),
    idleMs: z.number().int().min(1_000).optional(),
  })
  .strict();
export type RunnerLaunch = z.infer<typeof RunnerLaunchSchema>;

export function encodeEnvJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeEnvJson(value: string | undefined): unknown {
  if (!value) throw new Error("missing payload");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function stateArg(argv: readonly string[]): string {
  const index = argv.indexOf("--state");
  const path = index >= 0 ? argv[index + 1] : undefined;
  if (!path) throw new Error("--state <file> is required");
  return path;
}

export interface RunnerIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const processIo: RunnerIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export function describeCall(
  request: unknown,
  response: { ok: boolean; error?: string },
  ms: number,
): string {
  const call = (request ?? {}) as { method?: unknown; selector?: unknown; url?: unknown };
  const method = typeof call.method === "string" ? call.method : "invalid";
  const target =
    typeof call.selector === "string"
      ? call.selector
      : typeof call.url === "string"
        ? call.url
        : "";
  const outcome = response.ok ? "ok" : `error ${response.error ?? ""}`;
  return `${new Date().toISOString()} ${method} ${target} ${ms}ms ${outcome}`.replace(/\s+/g, " ");
}

async function serve(statePath: string, env: NodeJS.ProcessEnv, io: RunnerIo): Promise<number> {
  const launch = RunnerLaunchSchema.parse(decodeEnvJson(env[LAUNCH_ENV]));
  const session = await launchPlaywrightSession(launch, env).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const password = launch.proxy?.password ?? "";
    const username = launch.proxy?.username ?? "";
    const userinfo = username && password ? `${username}:${password}` : "";
    const atHost = userinfo && launch.proxy?.server ? `${userinfo}@${launch.proxy.server}` : "";
    throw new Error(redactSecrets(message, [password, username, userinfo, atHost]));
  });
  const rpc = new BrowserRpcServer(session);
  let idleTimer: NodeJS.Timeout | undefined;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const idleMs = launch.idleMs ?? DEFAULT_IDLE_MS;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(0), idleMs);
  };
  const isClose = (request: unknown) =>
    (request as { method?: unknown } | null)?.method === "close";
  let closing = false;
  const server = await startRpcHttpServer(
    async (request) => {
      armIdle();
      if (isClose(request)) closing = true;
      const started = Date.now();
      const response = await rpc.handle(request);
      // Method, selector and timing only; text and tokens never reach the log.
      io.stderr(describeCall(request, response, Date.now() - started));
      return response;
    },
    (request) => {
      if (isClose(request)) finish(0);
    },
  );
  session.onClosed(() => {
    if (!closing) finish(0);
  });
  await writeRunnerState(statePath, {
    port: server.port,
    token: server.token,
    pid: process.pid,
    sessionId: session.id,
  });
  io.stderr(`browser runner ready (session ${session.id})`);
  armIdle();
  const stop = () => finish(0);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const code = await finished;
  clearTimeout(idleTimer);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await rm(statePath, { force: true });
  await server.close();
  await session.close().catch(() => undefined);
  return code;
}

async function call(statePath: string, env: NodeJS.ProcessEnv, io: RunnerIo): Promise<number> {
  let state: z.infer<typeof RunnerStateSchema>;
  try {
    state = RunnerStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  } catch {
    io.stdout(JSON.stringify({ ok: false, error: "runner not running" }));
    return 3;
  }
  const response = await postRpc(state, decodeEnvJson(env[REQUEST_ENV]));
  io.stdout(JSON.stringify(response));
  return 0;
}

export async function runRunnerCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RunnerIo = processIo,
): Promise<number> {
  const [command] = argv;
  try {
    if (command === "serve") return await serve(stateArg(argv), env, io);
    if (command === "call") return await call(stateArg(argv), env, io);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.stderr("usage: rakazo-lb-browser serve|call --state <file>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRunnerCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
