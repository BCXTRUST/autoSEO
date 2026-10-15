import { randomBytes } from "node:crypto";
import { Sandbox, TimeoutError } from "@e2b/desktop";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import {
  boundedSandboxCommandTimeoutMs,
  exposeBrowserDesktopCommand,
  focusBrowserAndOpenUrlCommand,
  focusedWindowLabelCommand,
  isFileManagerLabel,
  isHttpUrl,
  listVisibleWindowsCommand,
  looksLikeDesktopBrowserApp,
  parseVisibleWindows,
  repairDesktopDisplayCommand,
} from "@rakazo/core";
import { sandboxHardTimeoutMs, sandboxIdleMs } from "./computer-idle.js";
import { ComputerScreenUnavailableError, screenSessionKey } from "./computer-screens.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  normalizeWorkspacePath,
  shellQuote,
  workspacePath,
} from "./computer-support.js";
import {
  PORTABLE_BROWSER_STOP_COMMAND,
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import {
  allocateExtraDisplayCommand,
  ensureExtraDisplayCommand,
  ensurePrimaryViewCommand,
  extraDisplayActionCommand,
  extraDisplayControlStartCommand,
  extraDisplayControlStopCommand,
  extraDisplayInputCommand,
  extraDisplayLayout,
  observeExtraDisplayCommand,
  PRIMARY_WATCH_VIEW_PORT,
  parseAllocatedExtraDisplay,
  parseExtraDisplayObservation,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
  screenControlKey,
} from "./extra-displays.js";

const E2B_WORKSPACE = "/home/user/rakazo-home";
const E2B_BROWSER_PROFILES = `${E2B_WORKSPACE}/.browser-profiles`;

export interface E2BSandboxSdk {
  create(options: ReturnType<typeof e2bCreateOptions>): Promise<Sandbox>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>;
  pause(id: string, options: { apiKey: string }): Promise<void>;
}

/** The desktop SDK throws on a non-zero exit. Callers still need that stdout, for example a runner ping. */
function recoverableScreenFailure(error: unknown): boolean {
  if (error instanceof ComputerScreenUnavailableError) return true;
  const failed = commandFailure(error);
  if (failed?.exitCode === 1) return true;
  const message = error instanceof Error ? error.message : "";
  return /exit status 1\b/.test(message);
}

function commandFailure(
  error: unknown,
): { exitCode: number; stdout?: string; stderr?: string } | null {
  if (!error || typeof error !== "object" || !("result" in error)) return null;
  const result = (error as { result?: { exitCode?: unknown; stdout?: unknown; stderr?: unknown } })
    .result;
  if (!result || typeof result.exitCode !== "number") return null;
  return {
    exitCode: result.exitCode,
    ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}),
    ...(typeof result.stderr === "string" ? { stderr: result.stderr } : {}),
  };
}

export function e2bTemplate(): string {
  return process.env.E2B_TEMPLATE?.trim() || "desktop";
}

export function e2bCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxHardTimeoutMs(),
    metadata: { botId, rakazo: "computer", template: e2bTemplate() },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "kill" as const, autoResume: false },
  };
}

export function isUnrecoverableSandboxError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "SandboxNotFoundError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404|not_found|killed|doesn't exist|sandbox not found|not running anymore/i.test(
    message,
  );
}

export const E2B_BROWSER_APPS = ["google-chrome", "firefox", "chromium"] as const;

export async function openDesktopBrowser(desktop: {
  launch: (application: string, uri?: string) => Promise<void>;
  open: (fileOrUrl: string) => Promise<void>;
  display?: string;
  commands?: { run: (command: string) => Promise<unknown> };
}): Promise<void> {
  for (const app of E2B_BROWSER_APPS) {
    try {
      // Launch with no URI. about:blank and google.com both fail or trap the
      // desktop on a CAPTCHA; open_path supplies the task URL next.
      await desktop.launch(app);
      await exposeBrowserDesktop(desktop);
      return;
    } catch {
      // try the next installed browser
    }
  }
  await exposeBrowserDesktop(desktop);
}

async function exposeBrowserDesktop(
  desktop: {
    display?: string;
    commands?: { run: (command: string) => Promise<unknown> };
  },
  display = desktop.display ?? ":0",
): Promise<void> {
  if (!desktop.commands?.run) return;
  await desktop.commands.run(exposeBrowserDesktopCommand(display)).catch(() => undefined);
}

async function maybeClearFileManager(
  desktop: Sandbox,
  display = desktop.display ?? ":0",
): Promise<void> {
  const probe = await desktop.commands
    .run(focusedWindowLabelCommand(display))
    .catch(() => ({ stdout: "" }));
  if (isFileManagerLabel(typeof probe.stdout === "string" ? probe.stdout : "")) {
    await exposeBrowserDesktop(desktop, display);
  }
}

async function listDesktopWindows(desktop: Sandbox, display = desktop.display ?? ":0") {
  const listed = await desktop.commands
    .run(listVisibleWindowsCommand(display))
    .catch(() => ({ stdout: "" }));
  return parseVisibleWindows(typeof listed.stdout === "string" ? listed.stdout : "");
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly boxes = new Map<string, Sandbox>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly controlStreams = new Map<string, { password: string; controlToken: string }>();

  constructor(
    private readonly apiKey: string,
    private readonly sdk: E2BSandboxSdk = Sandbox as unknown as E2BSandboxSdk,
  ) {}

  describe() {
    return {
      id: "e2b",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef): Promise<Sandbox> {
    const id = computer.providerRef || computer.id;
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      if (Date.now() - lastTouched >= 60_000) {
        await existing.setTimeout(sandboxHardTimeoutMs()).catch(() => undefined);
        this.lastTouchedAt.set(id, Date.now());
      }
      return existing;
    }
    const connected = await this.sdk.connect(id, {
      apiKey: this.apiKey,
      timeoutMs: sandboxHardTimeoutMs(),
    });
    this.boxes.set(connected.sandboxId, connected);
    this.lastTouchedAt.set(connected.sandboxId, Date.now());
    return connected;
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef && request.providerKind === "e2b") {
      try {
        const desktop = await this.sdk.connect(request.providerRef, {
          apiKey: this.apiKey,
          timeoutMs: sandboxIdleMs(),
        });
        this.boxes.set(desktop.sandboxId, desktop);
        this.lastTouchedAt.set(desktop.sandboxId, Date.now());
        return {
          id: desktop.sandboxId,
          botId: request.botId,
          kind: "e2b",
          providerRef: desktop.sandboxId,
          fresh: false,
        };
      } catch (error) {
        this.boxes.delete(request.providerRef);
        if (!isUnrecoverableSandboxError(error)) throw error;
      }
    }
    const desktop = await this.sdk.create(e2bCreateOptions(request.botId, this.apiKey));
    this.boxes.set(desktop.sandboxId, desktop);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
    return {
      id: desktop.sandboxId,
      botId: request.botId,
      kind: "e2b",
      providerRef: desktop.sandboxId,
      fresh: true,
    };
  }

  async prepare(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const desktop = await this.box(computer);
    await ensureE2BWorkspace(desktop);
    await keepDesktopDisplay(desktop);
    const profilesChanged = await configurePortableBrowserProfiles(desktop);
    if (!computer.fresh && profilesChanged) await openDesktopBrowser(desktop);
    await exposeBrowserDesktop(desktop);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const desktop = await this.box(computer);
    const cmd = request.argv.map(shellQuote).join(" ");
    if (cmd.includes("RAKAZO_DETACH_BROWSER")) {
      await ensureE2BWorkspace(desktop);
      await keepDesktopDisplay(desktop);
      const handle = await runDesktopCommand(desktop, cmd, {
        cwd: e2bCwd(request.cwd),
        background: true,
        timeoutMs: 0,
        signal: context.signal,
      });
      if (!("disconnect" in handle)) throw new Error("detached browser did not stay up");
      await handle.disconnect();
      yield { type: "exit", code: 0 };
      return;
    }
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await runDesktopCommand(desktop, cmd, {
        cwd: e2bCwd(request.cwd),
        envs: request.env,
        signal: context.signal,
        timeoutMs,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.exitCode ?? 0 };
    } catch (error) {
      const failed = commandFailure(error);
      if (failed) {
        if (failed.stdout) yield { type: "stdout", data: failed.stdout };
        if (failed.stderr) yield { type: "stderr", data: failed.stderr };
        yield { type: "exit", code: failed.exitCode };
        return;
      }
      if (error instanceof TimeoutError) {
        yield {
          type: "stderr",
          data: `command timed out after ${timeoutMs} ms\n`,
        };
        yield { type: "exit", code: 124 };
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const desktop = await this.box(computer);
    await ensureE2BWorkspace(desktop);
    await keepDesktopDisplay(desktop);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(
      desktop,
      screenKey,
      context.screenLeaseId,
      context.signal,
    );
    if (layout.isPrimary) {
      if (request.interactive) {
        if (!request.controlToken) throw new Error("interactive screen requires a control token");
        const password = await this.startControlStream(desktop, request.controlToken, screenKey);
        const url = new URL(`https://${desktop.getHost(layout.controlPort)}/vnc.html`);
        url.searchParams.set("autoconnect", "true");
        url.searchParams.set("resize", "scale");
        url.searchParams.set("password", password);
        return {
          url: url.toString(),
          mimeType: "text/html",
          close: async () => undefined,
        };
      }
      return this.primaryWatchSession(desktop, layout, context);
    }
    try {
      return await this.extraWatchSession(desktop, layout, request, screenKey, context);
    } catch (error) {
      // A saved slot above the primary display exits 1 and used to replace
      // the browser. The signup page is on the primary display.
      if (request.interactive || !recoverableScreenFailure(error)) throw error;
      await keepDesktopDisplay(desktop);
      return this.primaryWatchSession(
        desktop,
        extraDisplayLayout(0, desktop.display ?? ":0"),
        context,
      );
    }
  }

  private async primaryWatchSession(
    desktop: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const vendor = await this.vendorWatchUrl(desktop);
    if (vendor) {
      return { url: vendor, mimeType: "text/html", close: async () => undefined };
    }
    const viewPassword = await this.ensurePrimaryView(desktop, layout, context);
    const url = new URL(`https://${desktop.getHost(PRIMARY_WATCH_VIEW_PORT)}/vnc.html`);
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", "true");
    url.searchParams.set("password", viewPassword);
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  private async extraWatchSession(
    desktop: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
    request: ScreenRequest,
    screenKey: string,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const viewPassword = await this.ensureExtraDisplay(desktop, layout, context);
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      const password = await this.startControlStream(
        desktop,
        request.controlToken,
        screenKey,
        layout,
      );
      const url = new URL(`https://${desktop.getHost(layout.controlPort)}/vnc.html`);
      url.searchParams.set("autoconnect", "true");
      url.searchParams.set("resize", "scale");
      url.searchParams.set("password", password);
      return {
        url: url.toString(),
        mimeType: "text/html",
        close: async () => undefined,
      };
    }
    const url = new URL(`https://${desktop.getHost(layout.viewPort)}/vnc.html`);
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", "true");
    url.searchParams.set("password", viewPassword);
    return {
      url: url.toString(),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    const desktop = await this.box(computer);
    const screenKey = screenSessionKey(context);
    const layout = await this.resolveLayout(
      desktop,
      screenKey,
      context.screenLeaseId,
      context.signal,
    );
    if (layout.isPrimary) {
      if (interactive) {
        if (!controlToken) throw new Error("interactive screen requires a control token");
        await this.startControlStream(desktop, controlToken, screenKey);
      } else {
        await this.stopControlStream(desktop, controlToken, screenKey);
      }
      return;
    }
    await this.ensureExtraDisplay(desktop, layout, context);
    if (interactive) {
      if (!controlToken) throw new Error("interactive screen requires a control token");
      await this.startControlStream(desktop, controlToken, screenKey, layout);
    } else {
      await this.stopControlStream(desktop, controlToken, screenKey, layout);
    }
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
      context.signal,
    );
    if (layout.isPrimary) {
      await applyE2BAction(desktop, input);
      return;
    }
    await this.ensureExtraDisplay(desktop, layout, context);
    const result = await desktop.commands.run(extraDisplayInputCommand(layout, input), {
      signal: context.signal,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "extra display input failed");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const desktop = await this.box(computer);
    if (context.operationId === "preview") {
      return observeE2BDesktop(desktop, context);
    }
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
      context.signal,
    );
    if (layout.isPrimary) {
      await maybeClearFileManager(desktop);
      return observeE2BDesktop(desktop, context);
    }
    await this.ensureExtraDisplay(desktop, layout, context);
    await maybeClearFileManager(desktop, layout.display);
    const result = await desktop.commands.run(observeExtraDisplayCommand(layout), {
      signal: context.signal,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "extra display observation failed");
    const parsed = parseExtraDisplayObservation(result.stdout);
    const windows = await listDesktopWindows(desktop, layout.display);
    return computerObservation(parsed.image, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: parsed.cursor,
      ...(windows.length ? { windows } : {}),
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const desktop = await this.box(computer);
    const layout = await this.resolveLayout(
      desktop,
      screenSessionKey(context),
      context.screenLeaseId,
      context.signal,
    );
    const actions = boundedComputerActions(request.actions);
    let completed = 0;
    if (!layout.isPrimary) {
      await this.ensureExtraDisplay(desktop, layout, context);
      await maybeClearFileManager(desktop, layout.display);
    } else await maybeClearFileManager(desktop);
    for (const action of actions) {
      if (context.signal.aborted)
        throw context.signal.reason ?? new Error("computer action aborted");
      if (layout.isPrimary) await applyE2BAction(desktop, action);
      else {
        const script = extraDisplayActionCommand(layout, action);
        const result = await desktop.commands.run(`bash -lc ${shellQuote(script)}`, {
          signal: context.signal,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr || "extra display action failed");
      }
      completed += 1;
    }
    if (request.settleMs) await desktop.wait(clampRounded(request.settleMs, 0, 5_000));
    return {
      completed,
      ...(request.observe === false ? {} : { observation: await this.observe(computer, context) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const desktop = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, relative), {
      signal: context.signal,
    });
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          size: entry.size,
          ...(entry.type === "file" && entry.mode & 0o100 ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const desktop = await this.box(computer);
    const target = workspacePath(E2B_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const info = await desktop.files.getInfo(target, {
        signal: context.signal,
      });
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    return desktop.files.read(target, {
      format: "bytes",
      signal: context.signal,
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const desktop = await this.box(computer);
    await writeE2BFiles(desktop, [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await stopDesktopBrowsers(desktop);
    try {
      yield* walkE2BWorkspace(desktop, "", context);
    } finally {
      if (context.operationId !== "stop" && context.operationId !== "computer.sleep") {
        await openDesktopBrowser(desktop);
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const desktop = await this.box(computer);
    await stopDesktopBrowsers(desktop);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await writeE2BFiles(desktop, batch, context);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (
        batch.length >= 32 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    await openDesktopBrowser(desktop);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const desktop = await this.box(computer);
    await desktop.setTimeout(sandboxHardTimeoutMs()).catch(() => undefined);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const screenKey = screenSessionKey(context);
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    if (!desktop) return;
    const released = await desktop.commands
      .run(releaseExtraDisplayCommand(screenKey, context.screenLeaseId))
      .catch(() => undefined);
    const index = released ? parseReleasedExtraDisplay(released.stdout) : undefined;
    if (index === undefined) return;
    const controlKey = screenControlKey(id, screenKey);
    this.controlStreams.delete(controlKey);
    if (index === 0) return;
    // Non-primary teardown runs inside the registry lock before the slot is reusable.
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id);
    this.forget(id);
    if (desktop) {
      await desktop.pause().catch(() => undefined);
      return;
    }
    await this.sdk.pause(id, { apiKey: this.apiKey }).catch(() => undefined);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const desktop = this.boxes.get(id) ?? (await this.box(computer).catch(() => undefined));
    this.forget(id);
    await desktop?.kill();
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.lastTouchedAt.delete(id);
    for (const key of [...this.controlStreams.keys()]) {
      if (key.startsWith(`${id}:`)) this.controlStreams.delete(key);
    }
  }

  private async resolveLayout(
    desktop: Sandbox,
    screenKey: string,
    leaseId?: string,
    signal?: AbortSignal,
  ) {
    let allocation: { exitCode?: number; stdout?: string; stderr?: string } = {
      exitCode: 1,
      stdout: "",
      stderr: "",
    };
    try {
      allocation = await desktop.commands.run(allocateExtraDisplayCommand(screenKey, leaseId), {
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const failed = commandFailure(error);
      const message = error instanceof Error ? error.message : "";
      // A slot script that exits 1 used to surface as "exit status 1" and
      // replace the live browser. The primary display is still there.
      if ((failed && failed.exitCode === 1) || /exit status 1\b/.test(message)) {
        return extraDisplayLayout(0, desktop.display ?? ":0");
      }
      if (!failed) throw error;
      allocation = failed;
    }
    if ((allocation.exitCode ?? 0) === 0 && allocation.stdout) {
      try {
        return extraDisplayLayout(
          parseAllocatedExtraDisplay(allocation.stdout),
          desktop.display ?? ":0",
        );
      } catch (error) {
        if (!(error instanceof ComputerScreenUnavailableError)) throw error;
      }
    }
    if (allocation.exitCode === 75) throw new ComputerScreenUnavailableError();
    return extraDisplayLayout(0, desktop.display ?? ":0");
  }

  /** The vendor desktop stream (E2B noVNC). Falls back to the local watcher when it is down. */
  private async vendorWatchUrl(desktop: Sandbox): Promise<string | null> {
    const stream = desktop.stream;
    if (!stream || typeof stream.getUrl !== "function") return null;
    const read = (): string | null => {
      try {
        return watchUrl(stream.getUrl({ autoConnect: true, viewOnly: true, resize: "scale" }));
      } catch {
        return null;
      }
    };
    const existing = read();
    if (existing) return existing;
    if (typeof stream.start !== "function") return null;
    try {
      await stream.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // The SDK only keeps the URL in memory. A live x11vnc from an older
      // connection still serves the desktop on the standard noVNC port.
      if (/already running|exit status \d+/i.test(message) && (await tcpOpen(desktop, 6080))) {
        return watchUrl(`https://${desktop.getHost(6080)}/vnc.html`);
      }
      if (!/already running/i.test(message)) return null;
      if (await tcpOpen(desktop, 6080))
        return watchUrl(`https://${desktop.getHost(6080)}/vnc.html`);
      await stream.stop?.().catch(() => undefined);
      try {
        await stream.start();
      } catch {
        return null;
      }
    }
    return read();
  }

  private async ensurePrimaryView(
    desktop: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
    context: AdapterContext,
  ): Promise<string> {
    let last = new ComputerScreenUnavailableError("primary view failed");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await desktop.commands.run(
          ensurePrimaryViewCommand(layout, randomBytes(9).toString("base64url")),
          { timeoutMs: 20_000, signal: context.signal },
        );
        if (result.exitCode === 0) return parseExtraDisplayViewPassword(result.stdout);
        last = new ComputerScreenUnavailableError(
          screenFailureDetail(result.stderr, result.stdout),
        );
      } catch (error) {
        if (error instanceof ComputerScreenUnavailableError) {
          last = error;
        } else {
          const failed = commandFailure(error);
          const record = error as { stderr?: string; stdout?: string };
          last = new ComputerScreenUnavailableError(
            screenFailureDetail(
              failed?.stderr ?? record?.stderr,
              failed?.stdout ?? record?.stdout,
              error instanceof Error ? error.message : "",
            ),
          );
        }
      }
      if (attempt === 0) await keepDesktopDisplay(desktop);
    }
    throw last;
  }

  private async ensureExtraDisplay(
    desktop: Sandbox,
    layout: ReturnType<typeof extraDisplayLayout>,
    context: AdapterContext,
  ): Promise<string> {
    if (layout.isPrimary) throw new Error("primary display does not use an extra view password");
    const result = await desktop.commands.run(
      ensureExtraDisplayCommand(
        layout,
        {
          homeDir: "/home/user",
          browserProfilesDir: E2B_BROWSER_PROFILES,
        },
        randomBytes(9).toString("base64url"),
      ),
      { signal: context.signal },
    );
    if (result.exitCode !== 0) throw new ComputerScreenUnavailableError();
    return parseExtraDisplayViewPassword(result.stdout);
  }

  private async startControlStream(
    desktop: Sandbox,
    controlToken: string,
    screenKey: string,
    layout = extraDisplayLayout(0, desktop.display ?? ":0"),
  ): Promise<string> {
    const controlKey = screenControlKey(desktop.sandboxId, screenKey);
    const existing = this.controlStreams.get(controlKey);
    if (existing?.controlToken === controlToken) return existing.password;
    const password = randomBytes(6).toString("base64url");
    if (layout.isPrimary) {
      const passwordFile = "/tmp/rakazo-control.vncpass";
      const tokenFile = "/tmp/rakazo-control.token";
      const command = [
        controlStreamStopCommand(),
        `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
        `x11vnc -storepasswd ${shellQuote(password)} ${passwordFile} >/dev/null`,
        `( x11vnc -bg -display ${shellQuote(desktop.display)} -forever -wait 50 -shared -rfbport ${layout.controlVncPort} -rfbauth ${passwordFile} ) </dev/null >/tmp/rakazo-control-x11vnc.log 2>&1`,
        `( cd /opt/noVNC/utils && exec ./novnc_proxy --vnc localhost:${layout.controlVncPort} --listen ${layout.controlPort} --web /opt/noVNC ) </dev/null >/tmp/rakazo-control-novnc.log 2>&1 &`,
        `for i in $(seq 1 50); do netstat -tuln | grep -q ':${layout.controlPort} ' && exit 0; sleep 0.1; done`,
        "exit 1",
      ].join("\n");
      const result = await desktop.commands.run(command);
      if (result.exitCode !== 0) throw new Error(result.stderr || "control stream failed to start");
    } else {
      const result = await desktop.commands.run(
        extraDisplayControlStartCommand(layout, controlToken, password),
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || "control stream failed to start");
    }
    this.controlStreams.set(controlKey, { password, controlToken });
    return password;
  }

  private async stopControlStream(
    desktop: Sandbox,
    controlToken: string | undefined,
    screenKey: string,
    layout = extraDisplayLayout(0, desktop.display ?? ":0"),
  ): Promise<void> {
    const controlKey = screenControlKey(desktop.sandboxId, screenKey);
    if (layout.isPrimary) {
      await desktop.commands.run(controlStreamStopCommand(controlToken));
    } else {
      await desktop.commands.run(extraDisplayControlStopCommand(layout, controlToken));
    }
    const existing = this.controlStreams.get(controlKey);
    if (!controlToken || existing?.controlToken === controlToken) {
      this.controlStreams.delete(controlKey);
    }
  }
}

function screenFailureDetail(...parts: Array<string | undefined>): string {
  const detail = parts.filter(Boolean).join("\n");
  const tagged = detail.match(/RAKAZO_SCREEN_ERROR=(\S+)/)?.[1];
  if (tagged) return tagged;
  return (
    detail
      .replace(/RAKAZO_SCREEN_PASSWORD=\S+/g, "RAKAZO_SCREEN_PASSWORD=redacted")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || "primary view failed"
  );
}

function watchUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.startsWith("https://")) return null;
  const url = new URL(raw);
  if (!url.searchParams.has("autoconnect")) url.searchParams.set("autoconnect", "true");
  if (!url.searchParams.has("reconnect")) url.searchParams.set("reconnect", "true");
  if (!url.searchParams.has("resize")) url.searchParams.set("resize", "scale");
  url.searchParams.set("view_only", "true");
  return url.toString();
}

async function tcpOpen(desktop: Sandbox, port: number): Promise<boolean> {
  const result = await desktop.commands
    .run(
      `python3 -c 'import socket,sys;s=socket.socket();s.settimeout(0.4);s.connect(("127.0.0.1",int(sys.argv[1])))' ${port}`,
      { timeoutMs: 5_000 },
    )
    .catch(() => undefined);
  return result?.exitCode === 0;
}

function controlStreamStopCommand(controlToken?: string) {
  const stop = [
    "pkill -f '^x11vnc .* -rfbport 5901' || true",
    "pkill -f '^/usr/bin/python3 .*websockify.*6081' || true",
    "rm -f /tmp/rakazo-control.vncpass",
    "rm -f /tmp/rakazo-control.token",
  ].join("; ");
  if (!controlToken) return stop;
  return `[ -f /tmp/rakazo-control.token ] && [ "$(cat /tmp/rakazo-control.token)" != ${shellQuote(controlToken)} ] || { ${stop}; }`;
}

async function observeE2BDesktop(
  desktop: Sandbox,
  context: AdapterContext,
): Promise<ComputerObservation> {
  const [image, size, cursor, windowId] = await Promise.all([
    desktop.screenshot("bytes"),
    desktop.getScreenSize().catch(() => ({ width: 1280, height: 800 })),
    desktop.getCursorPosition().catch(() => undefined),
    desktop.getCurrentWindowId().catch(() => undefined),
  ]);
  if (context.signal.aborted)
    throw context.signal.reason ?? new Error("computer observation aborted");
  const title = windowId
    ? await desktop.getWindowTitle(windowId).catch(() => undefined)
    : undefined;
  const windows = await listDesktopWindows(desktop);
  return computerObservation(image, {
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    cursor,
    activeWindow: windowId ? { id: windowId, title } : undefined,
    ...(windows.length ? { windows } : {}),
  });
}

async function writeE2BFiles(
  desktop: Sandbox,
  files: readonly PortableFile[],
  context: AdapterContext,
) {
  if (!files.length) return;
  await desktop.files.write(
    files.map((file) => ({
      path: workspacePath(E2B_WORKSPACE, file.path),
      data: toArrayBuffer(file.content),
    })),
    { signal: context.signal },
  );
  const executable = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(workspacePath(E2B_WORKSPACE, file.path)));
  if (executable.length) {
    await desktop.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
      signal: context.signal,
    });
  }
}

async function configurePortableBrowserProfiles(desktop: Sandbox): Promise<boolean> {
  const chromium = `${E2B_BROWSER_PROFILES}/chromium`;
  const chrome = chromium;
  const firefox = `${E2B_BROWSER_PROFILES}/firefox`;
  const configured = await desktop.commands
    .run(
      [
        `test "$(readlink -f /home/user/.config/google-chrome 2>/dev/null)" = ${shellQuote(chrome)}`,
        `test "$(readlink -f /home/user/.config/chromium 2>/dev/null)" = ${shellQuote(chromium)}`,
        `test "$(readlink -f /home/user/.mozilla 2>/dev/null)" = ${shellQuote(firefox)}`,
      ].join(" && "),
    )
    .then(
      () => true,
      () => false,
    );
  if (configured) return false;
  await stopDesktopBrowsers(desktop);
  await desktop.commands.run(
    [
      `mkdir -p ${shellQuote(chrome)} ${shellQuote(chromium)} ${shellQuote(firefox)} /home/user/.config`,
      "rm -rf /home/user/.config/google-chrome /home/user/.config/chromium /home/user/.mozilla",
      `ln -s ${shellQuote(chrome)} /home/user/.config/google-chrome`,
      `ln -s ${shellQuote(chromium)} /home/user/.config/chromium`,
      `ln -s ${shellQuote(firefox)} /home/user/.mozilla`,
    ].join(" && "),
  );
  return true;
}

async function stopDesktopBrowsers(desktop: Sandbox): Promise<void> {
  await desktop.commands.run(PORTABLE_BROWSER_STOP_COMMAND).catch(() => undefined);
}

async function applyE2BAction(desktop: Sandbox, action: ComputerAction): Promise<void> {
  if (action.kind === "key") {
    await desktop.press([...(action.modifiers ?? []), action.key]);
    return;
  }
  if (action.kind === "pointer") {
    if (action.type === "move") await desktop.moveMouse(action.x, action.y);
    else if (action.type === "down") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mousePress(action.button ?? "left");
    } else if (action.type === "up") {
      await desktop.moveMouse(action.x, action.y);
      await desktop.mouseRelease(action.button ?? "left");
    } else {
      await desktop.moveMouse(action.x, action.y);
      if (action.button === "right") await desktop.rightClick();
      else await desktop.leftClick();
    }
    return;
  }
  if (action.kind === "clipboard") {
    await desktop.write(action.text);
    return;
  }
  if (action.kind === "scroll") {
    await desktop.scroll(action.direction, clampRounded(action.amount ?? 3, 1, 20));
    return;
  }
  if (action.kind === "wait") {
    await desktop.wait(clampRounded(action.ms, 0, 5_000));
    return;
  }
  if (action.kind === "open") {
    const value = isHttpUrl(action.path)
      ? action.path.trim()
      : workspacePath(E2B_WORKSPACE, action.path);
    if (isHttpUrl(value)) {
      const script = focusBrowserAndOpenUrlCommand(desktop.display ?? ":0", value);
      const result = await desktop.commands
        .run(`bash -lc ${shellQuote(script)}`)
        .catch(() => ({ exitCode: 1 }));
      if ((result as { exitCode?: number }).exitCode !== 0) {
        let launched = false;
        for (const app of E2B_BROWSER_APPS) {
          try {
            await desktop.launch(app, value);
            launched = true;
            break;
          } catch {
            // try the next installed browser
          }
        }
        if (!launched) await desktop.open(value);
      }
      await exposeBrowserDesktop(desktop);
      return;
    }
    await desktop.open(value);
    return;
  }
  await desktop.launch(action.application, action.uri);
  if (
    looksLikeDesktopBrowserApp(action.application) ||
    (action.uri !== undefined && isHttpUrl(action.uri))
  ) {
    await exposeBrowserDesktop(desktop);
  }
}

async function* walkE2BWorkspace(
  desktop: Sandbox,
  directory: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  const entries = await desktop.files.list(workspacePath(E2B_WORKSPACE, directory), {
    signal: context.signal,
  });
  const files: Array<{ relative: string; mode: number }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative)) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative, mode: entry.mode });
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative, mode }) => {
        const content = await desktop.files
          .read(workspacePath(E2B_WORKSPACE, relative), {
            format: "bytes",
            signal: context.signal,
          })
          .catch((error) => {
            if (relative.startsWith(".browser-profiles/")) return undefined;
            throw error;
          });
        if (!content) return undefined;
        return { path: relative, content, executable: Boolean(mode & 0o100) };
      }),
    );
    for (const file of batch) {
      if (file) yield file;
    }
  }
  for (const relative of directories) yield* walkE2BWorkspace(desktop, relative, context);
}

function isMissingWorkspaceCwd(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /invalid_argument/i.test(message) && /cwd/i.test(message) && /does not exist/i.test(message)
  );
}

/** The folder is created on a fresh boot only. A resumed sandbox can lose it, and every command then dies. */
async function ensureE2BWorkspace(desktop: Sandbox): Promise<void> {
  if (!desktop.files?.makeDir) return;
  await desktop.files.makeDir(E2B_WORKSPACE).catch(() => undefined);
}

async function keepDesktopDisplay(desktop: Sandbox): Promise<void> {
  if (!desktop.commands?.run) return;
  await desktop.commands
    .run(repairDesktopDisplayCommand(desktop.display ?? ":0"), { timeoutMs: 20_000 })
    .catch(() => undefined);
}

async function runDesktopCommand(
  desktop: Sandbox,
  cmd: string,
  options: {
    cwd?: string;
    background?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    envs?: Record<string, string>;
  },
) {
  try {
    return await desktop.commands.run(cmd, options);
  } catch (error) {
    if (!isMissingWorkspaceCwd(error)) throw error;
    await ensureE2BWorkspace(desktop);
    return await desktop.commands.run(cmd, options);
  }
}

function e2bCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === "/home/user" ||
    cwd === E2B_WORKSPACE
  ) {
    return E2B_WORKSPACE;
  }
  const relative = cwd.startsWith(`${E2B_WORKSPACE}/`)
    ? cwd.slice(E2B_WORKSPACE.length + 1)
    : cwd.startsWith("/home/rakazo/")
      ? cwd.slice("/home/rakazo/".length)
      : cwd;
  return workspacePath(E2B_WORKSPACE, relative);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
