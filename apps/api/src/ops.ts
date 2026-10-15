import { createHash, timingSafeEqual } from "node:crypto";
import { type E2BFleet, type E2BFleetComputer, sandboxIdleMs } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { type BuildOptions, type LogEntry, Template } from "e2b";
import type { Hono } from "hono";
import { autoseoBrowserTemplate } from "../../../infra/sandboxes/e2b-browser/template.js";
import { runBrowserSpike, type SpikeResult } from "./browser-spike.js";

export interface OpsDeps {
  prisma: PrismaClient;
  fleet: E2BFleet;
}

export interface OpsState {
  revision: string | null;
  sandboxes: Array<{
    id: string;
    state: E2BFleetComputer["state"];
    startedAt: string;
    template: string;
  }>;
  computers: Array<{
    id: string;
    workspaceId: string;
    state: string;
    providerRef: string | null;
    browserSeenAt: string | null;
  }>;
  activeProjects: Array<{ id: string; name: string; status: string }>;
  config: {
    driver: string | null;
    browser: string;
    search: string | null;
    sandboxProvider: string | null;
    template: string | null;
    idleMs: number;
  };
  hosts?: Array<{ domain: string; status: string; logins: number }>;
}

export function opsAuthorized(
  header: string | undefined,
  token: string | undefined,
): "ok" | "missing" | "denied" {
  if (!token || token.length < 32) return "missing";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const presented = match?.[1] ?? "";
  if (!presented) return "denied";
  const actual = createHash("sha256").update(presented).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, expected) ? "ok" : "denied";
}

export function opsRevision(env: NodeJS.ProcessEnv): string | null {
  const value =
    env.GIT_SHA?.trim() ||
    env.RAKAZO_GIT_SHA?.trim() ||
    env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    env.RAILWAY_GIT_SHA?.trim() ||
    "";
  return value || null;
}

export function opsConfig(env: NodeJS.ProcessEnv): OpsState["config"] {
  return {
    driver: env.LINK_BUILDER_DRIVER?.trim() || null,
    browser: env.LINK_BUILDER_BROWSER?.trim() || "sandbox",
    search: env.LINK_BUILDER_SEARCH?.trim() || null,
    sandboxProvider: env.SANDBOX_PROVIDER?.trim() || null,
    template: env.E2B_TEMPLATE?.trim() || null,
    idleMs: sandboxIdleMs(),
  };
}

function browserSeenAt(row: { browserSeenAt?: Date | string | null }): string | null {
  const value = row.browserSeenAt;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

export async function stopEverything(deps: OpsDeps): Promise<{
  projectsPaused: number;
  runsPaused: number;
  killed: number;
  remaining: number;
}> {
  const projects = await deps.prisma.lbProject.updateMany({
    where: { status: "active" },
    data: { status: "paused" },
  });
  const runs = await deps.prisma.lbRun.updateMany({
    where: { status: { in: ["queued", "running", "overtime"] } },
    data: { status: "paused" },
  });
  const listed = await deps.fleet.listComputers();
  let killed = 0;
  for (const computer of listed) {
    if (await deps.fleet.kill(computer.id)) killed += 1;
  }
  await deps.prisma.computer.updateMany({
    where: { kind: "e2b", providerRef: { not: null } },
    data: { state: "stopped", providerRef: null, screenUrl: null },
  });
  const remaining = await deps.fleet.listComputers();
  return {
    projectsPaused: projects.count,
    runsPaused: runs.count,
    killed,
    remaining: remaining.length,
  };
}

export async function opsState(
  deps: OpsDeps & { env: NodeJS.ProcessEnv; projectId?: string | null },
): Promise<OpsState> {
  const [sandboxes, computers, activeProjects] = await Promise.all([
    deps.fleet.listComputers(),
    deps.prisma.computer.findMany({
      where: { kind: "e2b" },
      select: {
        id: true,
        workspaceId: true,
        state: true,
        providerRef: true,
      },
    }),
    deps.prisma.lbProject.findMany({
      where: { status: "active" },
      select: { id: true, name: true, status: true },
    }),
  ]);
  const state: OpsState = {
    revision: opsRevision(deps.env),
    sandboxes: sandboxes.map((sandbox) => ({
      id: sandbox.id,
      state: sandbox.state,
      startedAt: sandbox.startedAt.toISOString(),
      template: sandbox.template,
    })),
    computers: computers.map((computer) => ({
      id: computer.id,
      workspaceId: computer.workspaceId,
      state: computer.state,
      providerRef: computer.providerRef,
      browserSeenAt: browserSeenAt(computer),
    })),
    activeProjects,
    config: opsConfig(deps.env),
  };
  const projectId = deps.projectId?.trim();
  if (!projectId) return state;
  const hosts = await deps.prisma.lbHost.findMany({
    where: { projectId },
    select: { id: true, registrableDomain: true, status: true },
  });
  state.hosts = await Promise.all(
    hosts.map(async (host) => ({
      domain: host.registrableDomain,
      status: host.status,
      logins: await deps.prisma.siteLogin.count({
        where: { lbHostAccounts: { some: { hostId: host.id } } },
      }),
    })),
  );
  return state;
}

function opsStatus(header: string | undefined): 200 | 401 | 404 {
  const verdict = opsAuthorized(header, process.env.OPS_TOKEN);
  if (verdict === "missing") return 404;
  if (verdict === "denied") return 401;
  return 200;
}

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/;
const TEMPLATE_LOG_LIMIT = 200;

export type E2BTemplateBuildStatus = "idle" | "building" | "ready" | "error";

export interface E2BTemplateBuildSnapshot {
  status: E2BTemplateBuildStatus;
  logs: string[];
}

type TemplateBuild = (
  template: ReturnType<typeof autoseoBrowserTemplate>,
  options: BuildOptions,
) => Promise<unknown>;

const templateBuild: E2BTemplateBuildSnapshot = { status: "idle", logs: [] };

function defaultTemplateBuild(
  template: ReturnType<typeof autoseoBrowserTemplate>,
  options: BuildOptions,
): Promise<unknown> {
  return Template.build(template, options);
}

let templateBuildImpl: TemplateBuild = defaultTemplateBuild;
let browserSpikeImpl: () => Promise<SpikeResult> = () => runBrowserSpike();

export function redactOpsSecrets(line: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = line;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function appendTemplateLog(line: string): void {
  templateBuild.logs.push(redactOpsSecrets(line));
  if (templateBuild.logs.length > TEMPLATE_LOG_LIMIT) {
    templateBuild.logs.splice(0, templateBuild.logs.length - TEMPLATE_LOG_LIMIT);
  }
}

export function e2bTemplateBuildSnapshot(): E2BTemplateBuildSnapshot {
  return { status: templateBuild.status, logs: [...templateBuild.logs] };
}

export function resetE2BTemplateBuildForTests(): void {
  templateBuild.status = "idle";
  templateBuild.logs = [];
  templateBuildImpl = defaultTemplateBuild;
}

export function setE2BTemplateBuildForTests(build: TemplateBuild): void {
  templateBuildImpl = build;
}

export function setBrowserSpikeForTests(run: (() => Promise<SpikeResult>) | null): void {
  browserSpikeImpl = run ?? (() => runBrowserSpike());
}

export function startE2BTemplateBuild(): { status: E2BTemplateBuildStatus } {
  if (templateBuild.status === "building") return { status: "building" };
  templateBuild.status = "building";
  templateBuild.logs = [];
  const apiKey = process.env.E2B_API_KEY;
  try {
    const pending = templateBuildImpl(autoseoBrowserTemplate(), {
      alias: "autoseo-browser-v1",
      cpuCount: 2,
      memoryMB: 4096,
      apiKey,
      onBuildLogs: (entry: LogEntry) => appendTemplateLog(entry.message),
    });
    void Promise.resolve(pending).then(
      () => {
        if (templateBuild.status === "building") templateBuild.status = "ready";
      },
      (error: unknown) => {
        templateBuild.status = "error";
        appendTemplateLog(error instanceof Error ? error.message : "template build failed");
      },
    );
  } catch (error) {
    templateBuild.status = "error";
    appendTemplateLog(error instanceof Error ? error.message : "template build failed");
  }
  return { status: templateBuild.status };
}

export function mountOpsRoutes(app: Hono, deps: OpsDeps): void {
  app.get("/api/ops/state", async (c) => {
    const status = opsStatus(c.req.header("authorization"));
    if (status !== 200)
      return c.json({ error: status === 404 ? "not found" : "unauthorized" }, status);
    return c.json(
      await opsState({
        ...deps,
        env: process.env,
        projectId: c.req.query("projectId"),
      }),
    );
  });
  app.post("/api/ops/stop-all", async (c) => {
    const status = opsStatus(c.req.header("authorization"));
    if (status !== 200)
      return c.json({ error: status === 404 ? "not found" : "unauthorized" }, status);
    return c.json(await stopEverything(deps));
  });
  app.post("/api/ops/e2b-template", (c) => {
    const status = opsStatus(c.req.header("authorization"));
    if (status !== 200)
      return c.json({ error: status === 404 ? "not found" : "unauthorized" }, status);
    return c.json(startE2BTemplateBuild());
  });
  app.get("/api/ops/e2b-template", (c) => {
    const status = opsStatus(c.req.header("authorization"));
    if (status !== 200)
      return c.json({ error: status === 404 ? "not found" : "unauthorized" }, status);
    return c.json(e2bTemplateBuildSnapshot());
  });
  app.post("/api/ops/browser-spike", async (c) => {
    const status = opsStatus(c.req.header("authorization"));
    if (status !== 200)
      return c.json({ error: status === 404 ? "not found" : "unauthorized" }, status);
    return c.json(await browserSpikeImpl());
  });
}
