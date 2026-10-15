import { join } from "node:path";
import {
  type AdapterContext,
  type AdapterDescriptor,
  type BrowserPersona,
  BrowserPersonaSchema,
  type BrowserSession,
  type BrowserSessionCapabilities,
  type BrowserSessionFactory,
  type ComputerRef,
  type ProxyEndpoint,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PacingPolicy } from "@rakazo/linkbuilder-core";
import {
  type BrowserEngine,
  type BrowserProxy,
  launchPlaywrightSession,
} from "./playwright-session.js";
import {
  type BrowserRpcRequest,
  type BrowserRpcResponse,
  BrowserRpcResponseSchema,
  RpcBrowserSession,
} from "./rpc.js";
import { encodeEnvJson, LAUNCH_ENV, REQUEST_ENV, type RunnerLaunch } from "./runner-cli.js";

/** Turns a leased proxy endpoint into launch settings, reading its credentials from the vault. */
export type ProxyResolver = (
  proxy: ProxyEndpoint,
  context: AdapterContext,
) => Promise<BrowserProxy>;

const ADAPTER_VERSION = "0.1.0";

export class LocalBrowserRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalBrowserRefused";
  }
}

/**
 * The local factory runs the persona browser on the worker host, outside any sandbox. It needs an
 * explicit `LINK_BUILDER_BROWSER=local` and is refused in production unless
 * `LINK_BUILDER_ALLOW_LOCAL_BROWSER=true` is also set.
 */
export function assertLocalBrowserAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LINK_BUILDER_BROWSER !== "local") {
    throw new LocalBrowserRefused(
      "Set LINK_BUILDER_BROWSER=local to run the persona browser on this host",
    );
  }
  if (env.NODE_ENV === "production" && env.LINK_BUILDER_ALLOW_LOCAL_BROWSER !== "true") {
    throw new LocalBrowserRefused(
      "The local persona browser is refused in production; use the sandbox browser",
    );
  }
}

async function resolveProxy(
  persona: BrowserPersona,
  resolver: ProxyResolver | undefined,
  context: AdapterContext,
): Promise<BrowserProxy | undefined> {
  if (!persona.proxy) return undefined;
  if (!resolver) throw new Error("A proxy was leased but no proxy resolver is configured");
  return resolver(persona.proxy, context);
}

export interface LocalBrowserSessionFactoryOptions {
  /** Parent of the per-persona profile directories. */
  profileRoot: string;
  /** Default helper extensions when the persona does not name its own. */
  helperDirs?: readonly string[];
  headless?: boolean;
  pacing?: PacingPolicy;
  random?: () => number;
  executablePath?: string;
  /** Camoufox binary. Falls back to `LINK_BUILDER_CAMOUFOX_PATH`. */
  camoufoxPath?: string;
  engine?: BrowserEngine;
  proxyResolver?: ProxyResolver;
  env?: NodeJS.ProcessEnv;
}

export class LocalBrowserSessionFactory implements BrowserSessionFactory {
  readonly mode = "local" as const;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: LocalBrowserSessionFactoryOptions) {
    this.env = options.env ?? process.env;
    assertLocalBrowserAllowed(this.env);
  }

  describe(): AdapterDescriptor<BrowserSessionCapabilities> {
    return {
      id: "playwright-local",
      contractVersion: "1",
      adapterVersion: ADAPTER_VERSION,
      capabilities: { extensions: true, persistentProfile: true, liveScreen: false },
    };
  }

  async open(persona: BrowserPersona, context: AdapterContext): Promise<BrowserSession> {
    assertLocalBrowserAllowed(this.env);
    const parsed = BrowserPersonaSchema.parse(persona);
    return launchPlaywrightSession(
      {
        profileDir: join(this.options.profileRoot, parsed.profileKey),
        helperDirs: parsed.extensionPaths ?? this.options.helperDirs ?? [],
        locale: parsed.locale,
        timezoneId: parsed.timezoneId,
        acceptLanguage: parsed.acceptLanguage,
        proxy: await resolveProxy(parsed, this.options.proxyResolver, context),
        headless: this.options.headless,
        pacing: this.options.pacing,
        random: this.options.random,
        executablePath:
          parsed.engine === "camoufox"
            ? (this.options.camoufoxPath ?? this.env.LINK_BUILDER_CAMOUFOX_PATH)
            : this.options.executablePath,
        engine: parsed.engine === "camoufox" ? "camoufox" : this.options.engine,
      },
      this.env,
    );
  }
}

export interface SandboxBrowserSessionFactoryOptions {
  sandbox: SandboxProvider;
  /** The computer whose sandbox hosts this persona's browser. */
  resolveComputer(persona: BrowserPersona, context: AdapterContext): Promise<ComputerRef>;
  /** Runner command inside the sandbox; `serve` / `call` and flags are appended. */
  runnerArgv?: readonly string[];
  /** Inside the computer workspace, so profiles are quiesced and checkpointed with it. */
  profileRoot?: string;
  stateRoot?: string;
  /** Helper extension directories inside the sandbox. */
  helperDirs?: readonly string[];
  executablePath?: string;
  /** Use Playwright's bundled Chromium instead of SANDBOX_CHROMIUM. */
  bundledChromium?: boolean;
  camoufoxPath?: string;
  headless?: boolean;
  pacing?: PacingPolicy;
  proxyResolver?: ProxyResolver;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  callTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const SANDBOX_PROFILE_ROOT = "/home/rakazo/.browser-profiles";
export const SANDBOX_STATE_ROOT = "/tmp/rakazo-lb";
export const SANDBOX_CHROMIUM = "/usr/bin/chromium";

const START_SCRIPT =
  'state="$1"; shift; mkdir -p "$(dirname "$state")" && chmod 700 "$(dirname "$state")" && ' +
  'export DISPLAY="${DISPLAY:-:0}" && ' +
  'setsid -f "$@" serve --state "$state" </dev/null >"$state.log" 2>&1';

async function collect(
  events: AsyncIterable<{ type: string; data?: string; code?: number }>,
): Promise<{ stdout: string; code: number }> {
  let stdout = "";
  let code = -1;
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data ?? "";
    if (event.type === "exit") code = event.code ?? -1;
  }
  return { stdout, code };
}

/**
 * Drives a session runner inside the computer sandbox: one detached `serve` per persona profile,
 * then one `call` exec per `BrowserSession` operation. Only the sandbox's exec API is used, so it
 * works on every provider that passes `env` to commands.
 */
export class SandboxBrowserSessionFactory implements BrowserSessionFactory {
  readonly mode = "sandbox" as const;
  private readonly runnerArgv: readonly string[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SandboxBrowserSessionFactoryOptions) {
    this.runnerArgv = options.runnerArgv ?? ["rakazo-lb-browser"];
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  describe(): AdapterDescriptor<BrowserSessionCapabilities> {
    return {
      id: "playwright-sandbox",
      contractVersion: "1",
      adapterVersion: ADAPTER_VERSION,
      capabilities: { extensions: true, persistentProfile: true, liveScreen: true },
    };
  }

  private statePath(persona: BrowserPersona): string {
    return `${this.options.stateRoot ?? SANDBOX_STATE_ROOT}/${persona.profileKey}.json`;
  }

  private transport(
    computer: ComputerRef,
    statePath: string,
    context: AdapterContext,
  ): (request: BrowserRpcRequest) => Promise<BrowserRpcResponse> {
    return async (request) => {
      const { stdout } = await collect(
        this.options.sandbox.execute(
          computer,
          {
            argv: [...this.runnerArgv, "call", "--state", statePath],
            env: { [REQUEST_ENV]: encodeEnvJson(request) },
            timeoutMs: this.options.callTimeoutMs ?? 180_000,
          },
          context,
        ),
      );
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        return BrowserRpcResponseSchema.parse(JSON.parse(line));
      } catch {
        return { ok: false, error: "runner returned no response" };
      }
    };
  }

  async open(persona: BrowserPersona, context: AdapterContext): Promise<BrowserSession> {
    const parsed = BrowserPersonaSchema.parse(persona);
    const computer = await this.options.resolveComputer(parsed, context);
    const statePath = this.statePath(parsed);
    const transport = this.transport(computer, statePath, context);
    const ping = async () => {
      const response = await transport({ method: "ping" });
      return response.ok ? (response.value as { sessionId?: unknown }).sessionId : undefined;
    };

    let sessionId = await ping();
    if (typeof sessionId !== "string") {
      const launch: RunnerLaunch = {
        profileDir: `${this.options.profileRoot ?? SANDBOX_PROFILE_ROOT}/${parsed.profileKey}`,
        helperDirs: [...(parsed.extensionPaths ?? this.options.helperDirs ?? [])],
        locale: parsed.locale,
        timezoneId: parsed.timezoneId,
        acceptLanguage: parsed.acceptLanguage,
        proxy: await resolveProxy(parsed, this.options.proxyResolver, context),
        headless: this.options.headless,
        executablePath:
          parsed.engine === "camoufox"
            ? (this.options.camoufoxPath ?? process.env.LINK_BUILDER_CAMOUFOX_PATH)
            : this.options.executablePath === undefined && this.options.bundledChromium === true
              ? undefined
              : (this.options.executablePath ?? SANDBOX_CHROMIUM),
        engine: parsed.engine === "camoufox" ? "camoufox" : undefined,
        pacing: this.options.pacing,
      };
      const started = await collect(
        this.options.sandbox.execute(
          computer,
          {
            argv: ["sh", "-c", START_SCRIPT, "sh", statePath, ...this.runnerArgv],
            env: { [LAUNCH_ENV]: encodeEnvJson(launch) },
            timeoutMs: 30_000,
          },
          context,
        ),
      );
      if (started.code !== 0)
        throw new Error(`Browser runner did not start (exit ${started.code})`);
      const deadline = Date.now() + (this.options.startTimeoutMs ?? 60_000);
      while (typeof sessionId !== "string") {
        if (Date.now() > deadline) throw new Error("Browser runner did not become ready in time");
        await this.sleep(this.options.pollIntervalMs ?? 500);
        sessionId = await ping();
      }
    }
    return new RpcBrowserSession(sessionId, transport);
  }
}
