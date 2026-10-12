import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { startLinkBuilderFakeRunner } from "./link-builder-fake.js";
import { isLinkBuilderRealEnabled, startLinkBuilderRealRunner } from "./link-builder-real.js";
import {
  browserFactoryFromEnv,
  camoufoxAvailable,
  captchaSolverForProject,
  proxyProviderFromEnv,
  proxyResolverFor,
  releasePersonaComputer,
  searchProviderFromEnv,
} from "./link-builder-real-wiring.js";
import { dnsHostnameResolver } from "./webhook-dns.js";

loadRootEnv();

import {
  AgentMailEmulator,
  AgentMailMailbox,
  agentMailLiveClient,
  ResendMailbox,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createPostgresReconciliationLeadership,
  createRunExecutor,
  createRunSandbox,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  lanesFromEnv,
  McpConnector,
  McpOAuthBroker,
  OpenRouterTextModel,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  ScriptedAgentRuntime,
  WorkspaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { createDb, createThreadEvents } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(databaseUrl);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const events = createThreadEvents(prisma, realtime);
  const runtime =
    process.env.AGENT_RUNTIME === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const dataDir = process.env.DATA_DIR ?? "./data";
  const sandbox = createRunSandbox(process.env.SANDBOX_PROVIDER ?? "docker", {
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    e2bApiKey: process.env.E2B_API_KEY,
    daytonaApiKey: process.env.DAYTONA_API_KEY,
    daytonaApiUrl: process.env.DAYTONA_API_URL,
    daytonaTarget: process.env.DAYTONA_TARGET,
    boxApiKey: process.env.BOX_API_KEY,
    boxApiUrl: process.env.BOX_API_URL ?? process.env.BOX_BASE_URL,
    dataDir,
    prisma,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const mcpOAuth = new McpOAuthBroker(prisma, secrets);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  const stack = createConnectorStack(isComposioEnabled(process.env.COMPOSIO_API_KEY), undefined, [
    new InstalledConnectorProvider(prisma, secrets),
    ...(pipedream ? [pipedream] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  const memoryProviders = new WorkspaceMemoryProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(databaseUrl);
  const jobHost: JobWorkerHost = inMemoryJobs ?? new GraphileJobWorkerHost(databaseUrl);
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [process.env.OPENROUTER_API_KEY ?? "", process.env.COMPOSIO_API_KEY ?? ""].filter(
      Boolean,
    ),
    secretStore: secrets,
    deploymentModelKey: process.env.OPENROUTER_API_KEY,
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
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
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: process.env.OPENROUTER_API_KEY,
  });
  await jobHost.start(jobHandlers);
  const linkBuilder = startLinkBuilderFakeRunner({ prisma, realtime });
  const linkBuilderProxySecrets: string[] = [];
  const linkBuilderProxies = await proxyProviderFromEnv({
    env: process.env,
    prisma,
    secrets,
  });
  const linkBuilderReal = isLinkBuilderRealEnabled()
    ? startLinkBuilderRealRunner({
        prisma,
        secrets,
        artifacts,
        realtime,
        browsers: browserFactoryFromEnv({
          env: process.env,
          dataDir,
          sandbox,
          prisma,
          secrets,
          proxyResolver: proxyResolverFor({
            prisma,
            secrets,
            provider: linkBuilderProxies,
            revealed: linkBuilderProxySecrets,
          }),
        }),
        proxies: linkBuilderProxies,
        revealedSecrets: linkBuilderProxySecrets,
        camoufoxAvailable: camoufoxAvailable(),
        resolveCaptcha: (project, redact) =>
          captchaSolverForProject({
            prisma,
            secrets,
            projectId: project.id,
            workspaceId: project.workspaceId,
            redact,
            env: process.env,
          }),
        mailbox: {
          describe: () => ({
            id: process.env.RESEND_INBOUND_DOMAIN ? "resend" : "agentmail",
            contractVersion: "1",
            adapterVersion: "0.1.0",
            capabilities: { inbound: "webhook" as const },
          }),
          ensureInbox: (projectId, context) => {
            const domain = process.env.RESEND_INBOUND_DOMAIN?.trim();
            const key = process.env.RESEND_API_KEY?.trim();
            if (domain && key) return new ResendMailbox({ domain, apiKey: key, prisma }).ensureInbox(projectId, context);
            if (process.env.AGENTMAIL_API_KEY) {
              return new AgentMailMailbox(agentMailLiveClient(process.env.AGENTMAIL_API_KEY), prisma).ensureInbox(projectId, context);
            }
            return new AgentMailEmulator().ensureInbox(projectId, context);
          },
          listMessages: (inboxId, options, context) => {
            const domain = process.env.RESEND_INBOUND_DOMAIN?.trim().toLowerCase();
            const key = process.env.RESEND_API_KEY?.trim();
            const host = inboxId.split("@")[1]?.toLowerCase();
            if (domain && key && host === domain) {
              return new ResendMailbox({ domain, apiKey: key, prisma }).listMessages(inboxId, options);
            }
            if (process.env.AGENTMAIL_API_KEY) {
              return new AgentMailMailbox(agentMailLiveClient(process.env.AGENTMAIL_API_KEY), prisma).listMessages(inboxId, options, context);
            }
            return new AgentMailEmulator().listMessages(inboxId, options, context);
          },
        },
        notifications: new ExpoPushProvider(dataDir),
        resolveHostname: dnsHostnameResolver,
        workerId: `worker-${process.pid}`,
        releaseDesktop: (projectId, context, mode) =>
          releasePersonaComputer({
            prisma,
            sandbox,
            projectId,
            context,
            mode,
          }),
        search: searchProviderFromEnv({ env: process.env, prisma, secrets }),
        textModel: process.env.OPENROUTER_API_KEY
          ? new OpenRouterTextModel({
              apiKey: async () => process.env.OPENROUTER_API_KEY ?? "",
              onSecret: (secret) => secrets.redact(secret),
              models: lanesFromEnv(process.env),
            })
          : undefined,
      })
    : null;
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    leadership: createPostgresReconciliationLeadership(pool),
  });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await reconciler.stop();
    linkBuilder.stop();
    await linkBuilderReal?.stop();
    await jobHost.stop();
    await jobs.close();
    await realtime.close();
    await connector.stop();
    await mcp.close();
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  console.log("rakazo worker ready");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
