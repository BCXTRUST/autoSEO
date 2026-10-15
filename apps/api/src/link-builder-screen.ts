import { ORPCError } from "@orpc/server";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  ComputerBusyError,
  type E2BFleet,
  isUnrecoverableSandboxError,
  provisionComputer,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { choosePersonaComputer } from "@rakazo/linkbuilder-core";
import { addScreenProxyCapability } from "./screen-proxy.js";

/** Must match SCREEN_PROXY_TTL_MS in screen-proxy.ts. A stored URL older than this is dead. */
const SCREEN_CAPABILITY_TTL_MS = 60 * 60_000;
const SCREEN_URL_MAX_AGE_MS = 15_000;
/** How long this request waits. The sandbox call keeps running so an abort cannot kill it. */
const SCREEN_REQUEST_MS = 90_000;

export type ScreenState = "off" | "starting" | "no_browser" | "live";

export interface ScreenResult {
  url: string | null;
  error: string | null;
  state: ScreenState;
}

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
  /** Absent in tests and Docker, where there is no E2B key. The liveness check is skipped. */
  fleet?: E2BFleet;
}

type TeamComputer = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
  screenUrl: string | null;
  scope: string;
  browserSeenAt: Date | null;
};

const BROWSER_SEEN_FRESH_MS = 30_000;

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

/** The dashboard computer. Reads the team machine. It does not create or replace a sandbox. */
export async function openProjectComputerScreen(
  deps: ProjectScreenDeps,
  actor: Actor,
  projectId: string,
  _boot: typeof provisionComputer = provisionComputer,
): Promise<ScreenResult> {
  const project = await deps.prisma.lbProject.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!project) throw new ORPCError("NOT_FOUND");
  const flightKey = `${actor.workspaceId}:${projectId}`;
  const existing = screenFlights.get(flightKey);
  const flight =
    existing ??
    openScreen(deps, actor).finally(() => {
      screenFlights.delete(flightKey);
    });
  if (!existing) screenFlights.set(flightKey, flight);
  const deadline = startDeadline(SCREEN_REQUEST_MS, "The computer took too long to start");
  try {
    return await Promise.race([flight, deadline.promise]);
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (isStillStarting(error)) return { url: null, error: null, state: "starting" };
    return quietScreenFailure(error);
  } finally {
    deadline.cancel();
  }
}

const screenFlights = new Map<string, Promise<ScreenResult>>();

async function openScreen(deps: ProjectScreenDeps, actor: Actor): Promise<ScreenResult> {
  try {
    const computer = await teamComputer(deps, actor);
    if (!computer || (computer.state !== "running" && computer.state !== "booting")) {
      return { url: null, error: null, state: "off" };
    }
    const seenAt = computer.browserSeenAt?.getTime() ?? null;
    const fresh = seenAt !== null && Date.now() - seenAt <= BROWSER_SEEN_FRESH_MS;
    if (!fresh || !computer.providerRef) {
      return {
        url: null,
        error: null,
        state: computer.state === "booting" ? "starting" : "no_browser",
      };
    }
    const domain = process.env.E2B_DOMAIN?.trim() || "e2b.app";
    const raw = `https://6080-${computer.providerRef}.${domain}/vnc.html?autoconnect=true&view_only=true&resize=scale&reconnect=true`;
    const url = addScreenProxyCapability(
      raw,
      deps.env.screenProxySecret,
      deps.env.webOrigin,
      undefined,
      { proxyExternal: true },
    );
    return { url, error: null, state: "live" };
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof ComputerBusyError) return { url: null, error: null, state: "off" };
    return quietScreenFailure(error);
  }
}

function quietScreenFailure(error: unknown): ScreenResult {
  const message = publicScreenError(error);
  console.error("link builder screen", error instanceof Error ? error.name : "Error", message);
  if (message === "Failed to connect to server") return { url: null, error: null, state: "off" };
  return { url: null, error: message, state: "off" };
}

function isStillStarting(error: unknown): boolean {
  return error instanceof Error && error.message === "The computer took too long to start";
}

/** E2B's missing-sandbox error. The message does not always say "not found". */
export function isDeadSandboxError(error: unknown): boolean {
  if (isUnrecoverableSandboxError(error)) return true;
  return error instanceof Error && error.name === "SandboxNotFoundError";
}

async function teamComputer(deps: ProjectScreenDeps, actor: Actor): Promise<TeamComputer | null> {
  const rows = await deps.prisma.computer.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  return choosePersonaComputer(rows) ?? rows.find((row) => row.scope === "team") ?? rows[0] ?? null;
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
