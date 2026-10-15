import { join } from "node:path";
import { ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  ComputerBusyError,
  isUnrecoverableSandboxError,
  provisionComputer,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  browserProcessCommand,
  browserWindowPresentCommand,
  chromeKioskStampCommand,
  detachedBrowserCommand,
  listVisibleWindowsCommand,
  parseVisibleWindows,
  prepareKioskDesktopCommand,
  raiseBrowserWindowCommand,
  refreshVendorStreamCommand,
  repaintBlackKioskCommand,
  repairBlackStreamCommand,
  streamedDisplayCommand,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  choosePersonaComputer,
  desktopShowsForumSearch,
  desktopShowsProblemSearch,
  forumSearchUrlFromProject,
  isCannedResearchLine,
  isStaleResearchLine,
  primaryProblemQueryFromProject,
  searchedGoogleLine,
  shopNames,
} from "@rakazo/linkbuilder-core";
import { addScreenProxyCapability, shouldProxyComputerScreen } from "./screen-proxy.js";

/** Must match SCREEN_PROXY_TTL_MS in screen-proxy.ts. A stored URL older than this is dead. */
const SCREEN_CAPABILITY_TTL_MS = 60 * 60_000;
const SCREEN_URL_MAX_AGE_MS = 15_000;
/** How long this request waits. The sandbox call keeps running so an abort cannot kill it. */
const SCREEN_REQUEST_MS = 90_000;

export interface ProjectScreenDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir: string;
  env: {
    webOrigin: string;
    screenProxySecret: string;
    sandboxProvider: string;
  };
}

type TeamComputer = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
  screenUrl: string | null;
  scope: string;
};

/**
 * A proxied noVNC URL minted in the last few seconds. An older address can point
 * at a stream that already died, and noVNC then shows "Failed to connect".
 */
export function reusableScreenUrl(url: string | null | undefined, now = Date.now()): string | null {
  if (!url) return null;
  let path = url;
  try {
    if (url.startsWith("https://") || url.startsWith("http://")) path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith("/novnc/")) return null;
  const match = path.match(/\/(?:view|control)\/(\d+)\./);
  if (!match) return null;
  const expires = Number(match[1]);
  const remaining = expires - now;
  const age = SCREEN_CAPABILITY_TTL_MS - remaining;
  if (!Number.isFinite(age) || remaining <= 0 || age > SCREEN_URL_MAX_AGE_MS) return null;
  return url;
}

/** A sentence the dashboard can show. Strips credentials and provider secrets. */
export function publicScreenError(error: unknown): string {
  const raw =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Could not open the computer";
  if (
    /signal:\s*terminated|operation was aborted|took too long to start|failed to connect/i.test(raw)
  ) {
    return "Failed to connect to server";
  }
  const cleaned = raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted")
    .replace(/e2b_[A-Za-z0-9_-]+/gi, "e2b_redacted")
    .replace(/https?:\/\/\S+/gi, (value) => {
      try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "https://redacted";
      }
    })
    .replace(/\b(api[_-]?key|secret|token|password|authorization)\b[^.,]*/gi, "$1 redacted")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "Could not open the computer";
}

type ScreenProject = {
  id: string;
  name: string | null;
  brandName: string | null;
  topicLanes: unknown;
  targets: unknown;
};

/**
 * The dashboard computer. Reuses the workspace team machine and the existing
 * screen proxy. Opens Google search for the stored topic. Does not change the
 * link-builder driver, register an account, post, or place a link.
 */
export async function openProjectComputerScreen(
  deps: ProjectScreenDeps,
  actor: Actor,
  projectId: string,
  boot: typeof provisionComputer = provisionComputer,
): Promise<{ url: string | null; error: string | null }> {
  const project = await deps.prisma.lbProject.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId, archivedAt: null },
    select: { id: true, name: true, brandName: true, topicLanes: true, targets: true },
  });
  if (!project) throw new ORPCError("NOT_FOUND");
  const flightKey = `${actor.workspaceId}:${projectId}`;
  const existing = screenFlights.get(flightKey);
  const flight =
    existing ??
    openScreen(deps, actor, project, boot).finally(() => {
      screenFlights.delete(flightKey);
    });
  if (!existing) screenFlights.set(flightKey, flight);
  const deadline = startDeadline(SCREEN_REQUEST_MS, "The computer took too long to start");
  try {
    return await Promise.race([flight, deadline.promise]);
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (isStillStarting(error)) return { url: null, error: null };
    return quietScreenFailure(error);
  } finally {
    deadline.cancel();
  }
}

const screenFlights = new Map<string, Promise<{ url: string | null; error: string | null }>>();

async function openScreen(
  deps: ProjectScreenDeps,
  actor: Actor,
  project: ScreenProject,
  _boot: typeof provisionComputer,
): Promise<{ url: string | null; error: string | null }> {
  try {
    const computer = await teamComputer(deps, actor);
    if (computer?.state !== "running" || !computer?.providerRef) {
      return { url: null, error: null };
    }
    const cached = liveCachedUrl(computer);
    if (cached) {
      void showForumSearchOnce(deps, actor, project, computer);
      return { url: cached, error: null };
    }
    let machine = computer;
    let url: string | null;
    try {
      url = await connectTeamScreen(deps, actor, machine);
    } catch (error) {
      if (!isDeadSandboxError(error)) throw error;
      const replaced = await replaceDeadTeamSandbox(deps, actor, machine);
      if (!replaced) return { url: null, error: null };
      machine = replaced;
      url = await connectTeamScreen(deps, actor, machine);
    }
    if (!url) return { url: null, error: null };
    void showForumSearchOnce(deps, actor, project, machine);
    return { url, error: null };
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof ComputerBusyError) return { url: null, error: null };
    return quietScreenFailure(error);
  }
}

function quietScreenFailure(error: unknown): { url: null; error: string | null } {
  const message = publicScreenError(error);
  console.error("link builder screen", error instanceof Error ? error.name : "Error", message);
  if (message === "Failed to connect to server") return { url: null, error: null };
  return { url: null, error: message };
}

function isStillStarting(error: unknown): boolean {
  return error instanceof Error && error.message === "The computer took too long to start";
}

/** E2B's missing-sandbox error. The message does not always say "not found". */
export function isDeadSandboxError(error: unknown): boolean {
  if (isUnrecoverableSandboxError(error)) return true;
  return error instanceof Error && error.name === "SandboxNotFoundError";
}

function liveCachedUrl(computer: TeamComputer): string | null {
  if (computer.state !== "running" || !computer.providerRef) return null;
  return reusableScreenUrl(computer.screenUrl);
}

async function teamComputer(deps: ProjectScreenDeps, actor: Actor): Promise<TeamComputer | null> {
  const rows = await deps.prisma.computer.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return choosePersonaComputer(rows) ?? rows.find((row) => row.scope === "team") ?? rows[0] ?? null;
}

async function connectTeamScreen(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
): Promise<string | null> {
  if (!computer.providerRef) return null;
  const bot = await deps.prisma.bot.findFirst({
    where: { workspaceId: actor.workspaceId, computerId: computer.id, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const session = await deps.sandbox.connectScreen(
    toComputerRef(computer),
    { view: "stream", interactive: false },
    screenContext(actor, bot?.id, new AbortController().signal),
  );
  if (!session.url) return null;
  const viewUrl = withViewOnly(session.url, true);
  const proxied = addScreenProxyCapability(
    viewUrl,
    deps.env.screenProxySecret,
    deps.env.webOrigin,
    undefined,
    { proxyExternal: shouldProxyComputerScreen(viewUrl, computer.kind) },
  );
  const published = publishableScreenUrl(proxied);
  if (!published) return null;
  await deps.prisma.computer.update({
    where: { id: computer.id },
    data: { screenUrl: published },
  });
  return published;
}

/**
 * The stored id is gone. Start one fresh sandbox, save it, then destroy the
 * dead id. A second caller that loses the claim does not create another.
 */
async function replaceDeadTeamSandbox(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
): Promise<TeamComputer | null> {
  const deadRef = computer.providerRef;
  if (!deadRef) return null;
  const claimed = await deps.prisma.computer.updateMany({
    where: { id: computer.id, state: "running", providerRef: deadRef },
    data: { state: "booting", providerRef: null, screenUrl: null },
  });
  if (claimed.count !== 1) return null;
  const context = screenContext(actor, undefined, new AbortController().signal);
  let created: ComputerRef | null = null;
  try {
    created = await deps.sandbox.provision(
      {
        botId: computer.homeKey,
        homePath: join(deps.dataDir, "computer-home", computer.homeKey),
      },
      context,
    );
    if (!created.providerRef) throw new Error("replacement sandbox has no id");
    const saved = await deps.prisma.computer.updateMany({
      where: { id: computer.id, state: "booting", providerRef: null },
      data: {
        state: "running",
        providerRef: created.providerRef,
        kind: created.kind,
        screenUrl: null,
      },
    });
    if (saved.count !== 1) {
      await deps.sandbox.destroy(created, context).catch(() => undefined);
      return null;
    }
    await deps.sandbox
      .destroy(toComputerRef({ ...computer, providerRef: deadRef }), context)
      .catch(() => undefined);
    console.info("link builder screen replaced dead sandbox");
    return {
      ...computer,
      state: "running",
      providerRef: created.providerRef,
      kind: created.kind,
      screenUrl: null,
    };
  } catch (error) {
    if (created?.providerRef) {
      await deps.sandbox.destroy(created, context).catch(() => undefined);
    }
    await deps.prisma.computer
      .updateMany({
        where: { id: computer.id, state: "booting", providerRef: null },
        data: { state: "running", providerRef: deadRef },
      })
      .catch(() => undefined);
    throw error;
  }
}

function publishableScreenUrl(url: string): string | null {
  if (!url.startsWith("/novnc/") && !url.includes("/novnc/")) return null;
  if (/password=|api[_-]?key=|token=/i.test(url)) return null;
  if (url.startsWith("/novnc/") || url.startsWith("https://")) return url;
  return null;
}

function screenContext(
  actor: Actor,
  botId: string | undefined,
  signal: AbortSignal,
): AdapterContext {
  return {
    operationId: "link-builder.screen",
    traceId: "link-builder.screen",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    ...(botId ? { botId } : {}),
    signal,
  };
}

function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}

const DESKTOP_DISPLAY = ":0";

/** The display the sandbox is already streaming. A second display would show a black pane. */
async function sandboxDisplay(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
): Promise<string> {
  try {
    const out = await runDesktop(deps, actor, computer, streamedDisplayCommand());
    const found = out
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^:\d+(?:\.\d+)?$/.test(line));
    if (found) return found;
  } catch {
    // The primary desktop is still the one Chrome and the stream share.
  }
  return DESKTOP_DISPLAY;
}

const kioskBusy = new Set<string>();

/** One kiosk launch at a time. A second poll used to kill Chrome before it mapped. */
function showForumSearchOnce(
  deps: ProjectScreenDeps,
  actor: Actor,
  project: ScreenProject,
  computer: TeamComputer,
): Promise<void> {
  const key = computer.providerRef ?? computer.id;
  if (kioskBusy.has(key)) return Promise.resolve();
  kioskBusy.add(key);
  return showForumSearch(deps, actor, project, computer).finally(() => {
    kioskBusy.delete(key);
  });
}

/** Open Chrome on the display the vendor stream is watching. */
async function showForumSearch(
  deps: ProjectScreenDeps,
  actor: Actor,
  project: ScreenProject,
  computer: TeamComputer,
): Promise<void> {
  if (!computer.providerRef || (computer.state !== "running" && computer.state !== "booting")) {
    return;
  }
  if (typeof deps.sandbox.execute !== "function") return;
  const url = forumSearchUrlFromProject(project);
  if (!url.startsWith("https://www.google.de/search?")) return;
  const display = await sandboxDisplay(deps, actor, computer);
  const query = primaryProblemQueryFromProject(project);
  const shops = shopNames(project);
  const onProblem = (titles: readonly string[]) =>
    query ? desktopShowsProblemSearch(titles, query, shops) : desktopShowsForumSearch(titles);
  try {
    let titles = await visibleTitles(deps, actor, computer, display);
    const stamp = await runDesktop(deps, actor, computer, chromeKioskStampCommand()).catch(
      () => "",
    );
    const persona = await personaBrowserOwnsDesktop(deps, actor, computer);
    const present = await runDesktop(deps, actor, computer, browserWindowPresentCommand(display)).catch(
      () => "",
    );
    const browserUp = present.includes("browser");
    const starting = await runDesktop(deps, actor, computer, browserProcessCommand()).catch(
      () => "",
    );
    let launched = false;
    if (!persona && !(browserUp && stamp.includes("ok")) && !starting.includes("ff-up")) {
      await runDesktop(deps, actor, computer, prepareKioskDesktopCommand(display));
      await runDesktop(deps, actor, computer, detachedBrowserCommand(display, url));
      launched = true;
      titles = await visibleTitles(deps, actor, computer, display);
      if (!onProblem(titles)) {
        await runDesktop(deps, actor, computer, typeSearchUrlCommand(display, url));
        titles = await visibleTitles(deps, actor, computer, display);
      }
    } else if (!persona && !onProblem(titles)) {
      await runDesktop(deps, actor, computer, typeSearchUrlCommand(display, url));
      titles = await visibleTitles(deps, actor, computer, display);
    }
    try {
      await runDesktop(deps, actor, computer, raiseBrowserWindowCommand(display));
    } catch {
      // The kiosk window can still be opening. The next screen open tries again.
    }
    if (!persona && (launched || !onProblem(titles))) {
      await runDesktop(deps, actor, computer, repaintBlackKioskCommand(display, url)).catch(
        () => undefined,
      );
    }
    await runDesktop(deps, actor, computer, repairBlackStreamCommand(display)).catch(
      () => undefined,
    );
    await runDesktop(deps, actor, computer, refreshVendorStreamCommand(display, launched)).catch(
      () => undefined,
    );
    titles = await visibleTitles(deps, actor, computer, display);
    const paint = await runDesktop(
      deps,
      actor,
      computer,
      "printf 'paint:%s ff:%s up:%s names:%s\\n' \"$(cat /tmp/rakazo-paint 2>/dev/null)\" \"$(command -v firefox-esr || command -v firefox || echo missing)\" \"$(pgrep -x firefox-esr >/dev/null && echo ff || echo none)\" \"$(DISPLAY=:0 xdotool search --name . 2>/dev/null | head -5 | while read -r id; do xdotool getwindowname \"$id\" 2>/dev/null | tr '\\n' ' '; done)\"",
    ).catch(() => "");
    console.info(
      "link builder screen browser",
      `display=${display}`,
      `windows=${titles.length}`,
      launched ? "opened" : "raised",
      `paint=${paint.replace(/\s+/g, " ").trim().slice(0, 180) || "unknown"}`,
    );
    if (query && desktopShowsProblemSearch(titles, query, shops)) {
      await noteDesktopSearch(deps, actor, project.id, query);
    }
  } catch (error) {
    console.error("link builder screen", "forum search", publicScreenError(error));
  }
}

/** Wallpaper, icons, and panels are the desktop shell, not the browser window. */
function isDesktopShellTitle(title: string): boolean {
  const text = title.trim();
  if (!text) return true;
  return (
    /^(home|trash|file system|desktop|xfce4-panel|xfdesktop)$/i.test(text) ||
    /fluxbox|xfce|e2b/i.test(text)
  );
}

/** The link-builder persona browser is already on this display. Replacing it would close the registration. */
async function personaBrowserOwnsDesktop(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
): Promise<boolean> {
  try {
    const out = await runDesktop(
      deps,
      actor,
      computer,
      "pgrep -f '[r]akazo-lb-browser' >/dev/null && printf '%s\\n' runner || true",
    );
    return out.includes("runner");
  } catch {
    return false;
  }
}

async function visibleTitles(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
  display: string,
): Promise<string[]> {
  try {
    const listed = await runDesktop(deps, actor, computer, listVisibleWindowsCommand(display));
    return parseVisibleWindows(listed).flatMap((window) => (window.title ? [window.title] : []));
  } catch {
    return [];
  }
}

/** Put the search URL in the address bar when Chrome opened on a welcome or blank tab. */
function typeSearchUrlCommand(display: string, url: string): string {
  const quotedDisplay = `'${display.replace(/'/g, `'"'"'`)}'`;
  const quotedUrl = `'${url.replace(/'/g, `'"'"'`)}'`;
  return [
    `export DISPLAY=${quotedDisplay}`,
    "id=$(xdotool search --onlyvisible --class google-chrome 2>/dev/null | awk 'NR==1{print; exit}')",
    "if [ -z \"$id\" ]; then id=$(xdotool search --onlyvisible --class Chromium 2>/dev/null | awk 'NR==1{print; exit}'); fi",
    'if [ -z "$id" ]; then exit 0; fi',
    'xdotool windowactivate --sync "$id"',
    "sleep 0.2",
    "xdotool key ctrl+l",
    "sleep 0.15",
    `xdotool type --delay 1 -- ${quotedUrl}`,
    "xdotool key Return",
    "sleep 2",
  ].join("\n");
}

/** Count the search once the Google results page is actually on the computer. */
async function noteDesktopSearch(
  deps: ProjectScreenDeps,
  actor: Actor,
  projectId: string,
  query: string,
): Promise<void> {
  const create = deps.prisma.lbCostEntry?.create;
  if (!create) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  try {
    await create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        kind: "search_query",
        quantity: 1,
        sourceKey: `desktop-google:${projectId}:${day}`,
        occurredAt: now,
      },
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : "";
    if (code !== "P2002") throw error;
  }
  const run = await deps.prisma.lbRun?.findFirst?.({
    where: { projectId, workspaceId: actor.workspaceId },
    orderBy: { date: "desc" },
    select: { id: true, lastAction: true },
  });
  const line = searchedGoogleLine(query);
  const current = run?.lastAction ?? "";
  const replace =
    !current ||
    isCannedResearchLine(current) ||
    isStaleResearchLine(current) ||
    /^opened google search$/i.test(current) ||
    /google/i.test(current);
  if (!run || !replace || current === line) return;
  await deps.prisma.lbRun.update({
    where: { id: run.id },
    data: { lastAction: line },
  });
}

async function runDesktop(
  deps: ProjectScreenDeps,
  actor: Actor,
  computer: TeamComputer,
  script: string,
): Promise<string> {
  let stdout = "";
  const events = deps.sandbox.execute(
    toComputerRef(computer),
    { argv: ["bash", "-lc", script], timeoutMs: 45_000 },
    screenContext(actor, undefined, new AbortController().signal),
  );
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit" && event.code !== 0) throw new Error("desktop command failed");
  }
  return stdout;
}

function startDeadline(ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
    },
  };
}
