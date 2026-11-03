import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import {
  createAntiCaptchaAdapter,
  createBackgroundJobHandlers,
  createBingCampaignSearchProvider,
  createCampaignChallengeWorker,
  createCampaignDraftProvider,
  createCampaignPublicationWorker,
  createCampaignWorker,
  createConnectorStack,
  createDiscourseCampaignAdapter,
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
  McpConnector,
  McpOAuthBroker,
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
  const campaignAiEnabled = process.env.CAMPAIGN_AI_DRAFTING_ENABLED === "true";
  const campaignAiReservationMicros = safePositiveInteger(
    process.env.CAMPAIGN_AI_RESERVATION_MICROS,
  );
  const campaignDraftProvider = createCampaignDraftProvider({
    enabled: campaignAiEnabled,
    providerId: process.env.CAMPAIGN_AI_PROVIDER_ID,
    modelId: process.env.CAMPAIGN_AI_MODEL_ID,
    apiKey: process.env.CAMPAIGN_AI_API_KEY ?? process.env.OPENROUTER_API_KEY,
    timeoutMs: 12_000,
  });
  const campaignWorker = createCampaignWorker({
    prisma,
    workerId: process.pid.toString(),
    aiDrafting: {
      enabled: campaignAiEnabled,
      ownerUserId: process.env.CAMPAIGN_AI_OWNER_USER_ID,
      maxReservationMicros: campaignAiReservationMicros,
      provider: campaignDraftProvider,
    },
    discovery: {
      enabled: process.env.CAMPAIGN_DISCOVERY_ENABLED !== "false",
      searchProviderId: "bing-rss",
      searchProvider:
        process.env.CAMPAIGN_DISCOVERY_ENABLED === "false"
          ? undefined
          : createBingCampaignSearchProvider(),
    },
  });
  campaignWorker.start();
  const antiCaptchaKey = process.env.ANTI_CAPTCHA_API_KEY?.trim();
  const campaignChallengeWorker = createCampaignChallengeWorker({
    prisma,
    provider: antiCaptchaKey ? createAntiCaptchaAdapter({ clientKey: antiCaptchaKey }) : undefined,
    secrets,
  });
  campaignChallengeWorker.start();
  const publicationAdapter = createDiscoursePublicationAdapter();
  const campaignPublicationWorker = createCampaignPublicationWorker({
    prisma,
    adapter: publicationAdapter,
  });
  campaignPublicationWorker.start();
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
    await campaignPublicationWorker.stop();
    await campaignChallengeWorker.stop();
    await campaignWorker.stop();
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

function safePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function createDiscoursePublicationAdapter() {
  const baseUrl = process.env.DISCOURSE_BASE_URL?.trim();
  const apiKey = process.env.DISCOURSE_API_KEY?.trim();
  const apiUsername = process.env.DISCOURSE_API_USERNAME?.trim();
  if (!baseUrl || !apiKey || !apiUsername) return undefined;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return createDiscourseCampaignAdapter({
      baseUrl,
      apiKey,
      apiUsername,
      authorizedSite: true,
      timeoutMs: 9_000,
    });
  } catch {
    return undefined;
  }
}
