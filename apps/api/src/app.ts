import { rm } from "node:fs/promises";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  JobPublisher,
  ManagedConnectorProvider,
  RealtimeFanout,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  AgentMailMailbox,
  type ComposioProvider,
  type ConnectorRegistry,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createRunExecutor,
  createRunSandbox,
  type DestinationEmulator,
  destroyBot,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  isComposioEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  PiAgentRuntime,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  pushTokenPath,
  type RemoteConnectorDependencies,
  ScriptedAgentRuntime,
  WorkspaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { blockedAuthPaths, createAuth } from "@rakazo/auth";
import { createDb, createThreadEvents, type PrismaClient, requireMembership } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAgentMailInbox, listAgentMailInboxes } from "./agentmail.js";
import { type AppEnv, loadEnv } from "./env.js";
import { ingestInboundMail, verifyInboundMailSignature } from "./link-builder-mail.js";
import {
  anonymousRateKey,
  LINK_BUILDER_POLL_RATE_LIMIT,
  LINK_BUILDER_RATE_LIMIT,
  LINK_BUILDER_RATE_WINDOW_MS,
  takeLinkBuilderRequest,
  WorkspaceRateLimiter,
} from "./link-builder-rate-limit.js";
import { createRouter } from "./router.js";
import { mountVoiceHttpRoutes } from "./voice.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  executor: ReturnType<typeof createRunExecutor>;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    remoteConnectors?: RemoteConnectorDependencies;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    remoteConnectors,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl);
  const { prisma } = created;
  created.pool?.on("error", () => undefined);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const events = createThreadEvents(prisma, realtime);
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs = inMemoryJobs ?? new GraphileJobPublisher(env.databaseUrl);
  const sandbox: SandboxProvider = createRunSandbox(env.sandboxProvider, {
    supervisorUrl: env.sandboxSupervisorUrl,
    supervisorToken: env.sandboxSupervisorToken,
    e2bApiKey: env.e2bApiKey,
    daytonaApiKey: env.daytonaApiKey,
    daytonaApiUrl: env.daytonaApiUrl,
    daytonaTarget: env.daytonaTarget,
    boxApiKey: env.boxApiKey,
    boxApiUrl: env.boxApiUrl,
    dataDir: env.dataDir,
    prisma,
  });
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, remoteConnectors);
  const memoryProviders = new WorkspaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      network: remoteConnectors,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  const installed = new InstalledConnectorProvider(prisma, secrets, remoteConnectors);
  const stack = createConnectorStack(isComposioEnabled(env.composioApiKey), composioOverride, [
    installed,
    ...(pipedream ? [pipedream] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  void stack.composio?.warmDirectory().catch(() => undefined);
  void pipedream?.warmDirectory?.().catch(() => undefined);
  const runtime =
    env.agentRuntime === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const notifications = new ExpoPushProvider(env.dataDir);
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    extraOrigins: [
      "rakazo://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, workspaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              workspaceId: bot.workspaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
    },
  });
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory,
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [env.openRouterKey ?? "", env.composioApiKey ?? ""].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey: env.openRouterKey,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: "api",
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: env.openRouterKey,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs ? createJobReconciler({ prisma, jobs }) : undefined;
  reconciler?.start();

  const mailbox = env.agentMailApiKey
    ? new AgentMailMailbox(
        {
          listInboxes: async () => {
            const rows = await listAgentMailInboxes(env.agentMailApiKey ?? "");
            return rows.map((row) => ({
              inboxId: row.inboxId,
              email: row.email,
              projectId: row.projectId,
              workspaceId: null,
            }));
          },
          createInbox: (input) => createAgentMailInbox(env.agentMailApiKey ?? "", input),
        },
        prisma,
      )
    : undefined;

  const router = createRouter({
    prisma,
    events,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    realtime,
    mailbox,
    dataDir: env.dataDir,
    env: {
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      openRouterKey: env.openRouterKey,
      webOrigin: env.webOrigin,
      screenProxySecret: env.authSecret,
      sandboxProvider: env.sandboxProvider,
      agentMailApiKey: env.agentMailApiKey,
    },
  });
  const rpc = new RPCHandler(router);
  const linkBuilderLimiters = {
    page: new WorkspaceRateLimiter(LINK_BUILDER_RATE_LIMIT, LINK_BUILDER_RATE_WINDOW_MS),
    poll: new WorkspaceRateLimiter(LINK_BUILDER_POLL_RATE_LIMIT, LINK_BUILDER_RATE_WINDOW_MS),
  };
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id).catch(() => null)
      : null;
    const decision = takeLinkBuilderRequest(linkBuilderLimiters, {
      pathname: new URL(c.req.url).pathname,
      member: Boolean(actor),
      clientKey: anonymousRateKey(c.req.header("x-forwarded-for"), c.req.header("x-real-ip")),
    });
    if (!decision.ok) {
      return c.json({ error: "Too many requests" }, 429, {
        "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)),
      });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: c.req.raw.signal },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user) return null;
    return requireMembership(prisma, session.user.id).catch(() => null);
  });
  app.post("/api/link-builder/resend", async (c) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const apiKey = process.env.RESEND_API_KEY;
    const raw = await c.req.text();
    const { verifyResendSignature, parseResendReceivedEvent } = await import("@rakazo/adapters");
    const ok = secret
      ? verifyResendSignature(secret, raw, {
          id: c.req.header("svix-id") ?? null,
          timestamp: c.req.header("svix-timestamp") ?? null,
          signature: c.req.header("svix-signature") ?? null,
        })
      : false;
    if (!ok || !apiKey) return c.json({ error: "invalid signature" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ ok: true, stored: false });
    }
    const event = parseResendReceivedEvent(body);
    if (!event) return c.json({ ok: true, stored: false });
    const response = await fetch(`https://api.resend.com/emails/receiving/${event.emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) return c.json({ error: "mail unavailable" }, 502);
    const received = (await response.json()) as {
      from?: string;
      to?: string[];
      subject?: string;
      text?: string;
      html?: string;
      created_at?: string;
    };
    const to = received.to?.[0] ?? event.to[0];
    if (!to) return c.json({ ok: true, stored: false });
    const { ingestResendMail } = await import("./link-builder-mail.js");
    return c.json(
      await ingestResendMail(prisma, {
        to,
        from: received.from ?? "unknown",
        subject: received.subject ?? "",
        text: received.text ?? "",
        html: received.html,
        receivedAt: received.created_at ?? new Date().toISOString(),
        eventId: event.emailId,
      }),
    );
  });
  app.post("/api/link-builder/mail", async (c) => {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
    const raw = await c.req.text();
    const header = c.req.header("X-AgentMail-Signature") ?? null;
    if (!secret || !(await verifyInboundMailSignature(secret, raw, header))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    return c.json(await ingestInboundMail(prisma, raw));
  });
  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      pipedream: Boolean(pipedream),
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    executor,
    stop: async () => {
      oauthLogins.abortAll();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
    },
  };
}

function isTrustedOrigin(origin: string, env: AppEnv) {
  if (!origin) return true;
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (origin.startsWith("rakazo://") || origin.startsWith("exp://")) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}
