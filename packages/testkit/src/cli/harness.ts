import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.CI = "1";
    process.env.CAMPAIGN_AI_DRAFTING_ENABLED = "false";
    process.env.CAMPAIGN_PAID_CHALLENGES_ENABLED = "false";
    process.env.CAMPAIGN_DISCOURSE_PUBLISHING_ENABLED = "false";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      process.env.CAMPAIGN_PG_TEST_URL = databaseUrl;
      execSync(
        [
          "pnpm exec vitest run --no-file-parallelism",
          "packages/testkit/src/journeys.test.ts",
          "packages/testkit/src/authorization.test.ts",
          "packages/testkit/src/attachments.test.ts",
          "packages/testkit/src/voice.test.ts",
          "packages/testkit/src/search.test.ts",
          "packages/testkit/src/executor-lifecycle.test.ts",
          "packages/testkit/src/connections.test.ts",
          "packages/adapters/src/wakeup.postgres.test.ts",
          "packages/adapters/src/realtime.postgres.test.ts",
          "packages/adapters/src/job-reconciler.postgres.test.ts",
          "packages/db/src/campaigns.integration.test.ts",
          "packages/adapters/src/campaign-worker.postgres.test.ts",
          "packages/db/src/campaign-challenges.integration.test.ts",
          "packages/db/src/campaign-publications.integration.test.ts",
          "apps/api/src/campaigns.test.ts",
          "apps/api/src/campaign-challenges.test.ts",
        ].join(" "),
        {
          stdio: "inherit",
          env: process.env,
        },
      );
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    const [
      {
        CampaignCatalogError,
        CampaignResearchError,
        ComposioEmulator,
        PipedreamConnector,
        ThirdPartyConnectorEmulator,
        createCampaignWorker,
        inspectCampaignOpportunity,
      },
      { createApp },
    ] = await Promise.all([import("@rakazo/adapters"), import("../../../../apps/api/src/app.ts")]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
    });
    let blockedCatalogReads = 0;
    let blockedDiscoveryCandidateReads = 0;
    const catalogFixtureLinks = [
      { url: "https://catalog.example.test/products/mesh-router", label: "Mesh router product" },
      { url: "https://catalog.example.test/articles/setup-guide", label: "Setup guide" },
      { url: "https://catalog.example.test/app/blocked", label: "Restricted app page" },
      { url: "https://external.example.test/shop", label: "External shop candidate" },
    ];
    const catalogResearch = async (
      url: string,
      request: { allowedOrigin: string; allowedUrl?: (candidate: string) => boolean },
    ) => {
      const catalogOrigin = "https://catalog.example.test";
      const discoveryOrigin = "https://discovery.example.test";
      if (![catalogOrigin, discoveryOrigin].includes(request.allowedOrigin)) {
        throw new CampaignCatalogError("transient", "fixture_unavailable");
      }
      if (new URL(url).origin !== request.allowedOrigin) {
        throw new CampaignCatalogError("unsupported", "fixture_unavailable");
      }
      if (url.endsWith("/robots.txt")) {
        const robotsText = "User-agent: AutoSEO\nAllow: /\n";
        return {
          url,
          title: "robots.txt",
          text: robotsText,
          robotsText,
          contentType: "text/plain" as const,
          fetchedAt: new Date().toISOString(),
          links: [],
          httpStatus: 200,
        };
      }
      if (!request.allowedUrl?.(url)) {
        throw new CampaignCatalogError("unsupported", "robots_disallowed");
      }
      if (request.allowedOrigin === discoveryOrigin) {
        if (url === `${discoveryOrigin}/llms.txt` || url.endsWith("/sitemap.xml")) {
          throw new CampaignCatalogError("unsupported", "page_absent");
        }
        if (url === `${discoveryOrigin}/`) {
          return {
            url,
            title: "Acme Mesh Router Product",
            text: "Acme mesh router with secure Wi-Fi setup for home.",
            contentType: "text/html" as const,
            fetchedAt: new Date().toISOString(),
            links: [
              {
                url: `${discoveryOrigin}/products/mesh-router`,
                label: "Acme Mesh Router Product",
              },
            ],
            httpStatus: 200,
          };
        }
        if (url === `${discoveryOrigin}/products/mesh-router`) {
          return {
            url,
            title: "Acme Mesh Router Product",
            text: "Acme mesh router with secure Wi-Fi setup for home and device pairing.",
            contentType: "text/html" as const,
            fetchedAt: new Date().toISOString(),
            links: [],
            httpStatus: 200,
          };
        }
        throw new CampaignCatalogError("transient", "fixture_unavailable");
      }
      if (url === "https://catalog.example.test/llms.txt") {
        throw new CampaignCatalogError("unsupported", "page_absent");
      }
      if (url === "https://catalog.example.test/") {
        return {
          url,
          title: "Catalog Fixture Home",
          text: "Catalog fixture homepage for a mesh router service.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: catalogFixtureLinks,
          httpStatus: 200,
        };
      }
      if (url === "https://catalog.example.test/sitemap.xml") {
        return {
          url,
          title: "Catalog sitemap",
          text: "Fixture sitemap listing product and article pages.",
          contentType: "application/xml" as const,
          fetchedAt: new Date().toISOString(),
          links: catalogFixtureLinks.slice(0, 2),
          httpStatus: 200,
        };
      }
      if (url === "https://catalog.example.test/app/blocked" && blockedCatalogReads++ === 0) {
        throw new CampaignCatalogError("unsupported", "page_forbidden");
      }
      if (url === "https://catalog.example.test/products/mesh-router") {
        return {
          url,
          title: "Mesh Router Product",
          text: "Fixture facts: dual-band mesh router, white shell, and 2.4/5 GHz support.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: [],
          httpStatus: 200,
        };
      }
      if (url === "https://catalog.example.test/articles/setup-guide") {
        return {
          url,
          title: "Setup Guide",
          text: "Fixture guidance: place the router centrally.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: [],
          httpStatus: 200,
        };
      }
      if (url === "https://catalog.example.test/app/blocked") {
        return {
          url,
          title: "Restricted Collection",
          text: "Catalog fixture recovered after an explicit human retry.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: [],
          httpStatus: 200,
        };
      }
      throw new CampaignCatalogError("transient", "fixture_unavailable");
    };
    const discoveryFetchPage = async (
      url: string,
      request: {
        allowedOrigin: string;
        allowedUrl?: (candidate: string) => boolean;
      },
      blockPrivateCandidate = false,
    ) => {
      const origin = "https://community.discovery.example.test";
      if (request.allowedOrigin !== origin || new URL(url).origin !== origin) {
        throw new CampaignCatalogError("unsupported", "fixture_unavailable");
      }
      if (url === `${origin}/robots.txt`) {
        const robotsText = blockPrivateCandidate
          ? "User-agent: AutoSEO\nDisallow: /private/\nAllow: /\n"
          : "User-agent: AutoSEO\nAllow: /\n";
        return {
          url,
          title: "robots.txt",
          text: robotsText,
          robotsText,
          contentType: "text/plain" as const,
          fetchedAt: new Date().toISOString(),
          links: [],
          httpStatus: 200,
        };
      }
      if (!request.allowedUrl?.(url)) {
        throw new CampaignCatalogError("unsupported", "robots_disallowed");
      }
      const privateUrl = `${origin}/private/router-board`;
      const discussionUrl = `${origin}/t/mesh-router-setup`;
      if (url === privateUrl) {
        return {
          url,
          title: "Private Router Board",
          text: "Fixture evidence: router owners discuss mesh setup and device pairing.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: [{ url: `${origin}/guidelines/router-setup`, label: "Community guidelines" }],
          httpStatus: 200,
        };
      }
      if (url === discussionUrl) {
        return {
          url,
          title: "Mesh Router Setup Discussion",
          text: "Fixture evidence: owners describe setting up the Acme mesh router.",
          contentType: "text/html" as const,
          fetchedAt: new Date().toISOString(),
          links: [{ url: `${origin}/guidelines/router-setup`, label: "Community rules" }],
          httpStatus: 200,
        };
      }
      throw new CampaignCatalogError("unsupported", "fixture_unavailable");
    };
    const discoverySearchProvider = {
      async search(request: { query: string; limit: number }) {
        const observedAt = new Date().toISOString();
        if (!request.query.includes("discovery.example.test")) {
          return { query: request.query, provider: "fixture-search", observedAt, results: [] };
        }
        return {
          query: request.query,
          provider: "fixture-search",
          observedAt,
          results: [
            {
              url: "https://community.discovery.example.test/private/router-board",
              title: "Private Router Board",
              snippet: "A candidate community discussing router setup.",
              rank: 1,
            },
            {
              url: "https://community.discovery.example.test/t/mesh-router-setup",
              title: "Mesh Router Setup Discussion",
              snippet: "A candidate discussion about mesh router setup.",
              rank: 2,
            },
          ].slice(0, Math.min(4, request.limit)),
        };
      },
    };
    const inspectDiscoveryFixture = async (input: {
      url: string;
      signal?: AbortSignal;
      now?: () => Date;
    }) => {
      const isPrivateCandidate =
        input.url === "https://community.discovery.example.test/private/router-board";
      const blockPrivateCandidate = isPrivateCandidate && blockedDiscoveryCandidateReads === 0;
      if (isPrivateCandidate) blockedDiscoveryCandidateReads += 1;
      return inspectCampaignOpportunity({
        ...input,
        fetchCatalogPage: (url, request) => discoveryFetchPage(url, request, blockPrivateCandidate),
      });
    };
    const researchDiscoveryFixture = async (url: string) => {
      const facts = new Map([
        [
          "https://community.discovery.example.test/private/router-board",
          {
            title: "Private Router Board",
            text: "Fixture evidence: router owners discuss mesh setup and device pairing.",
          },
        ],
        [
          "https://community.discovery.example.test/t/mesh-router-setup",
          {
            title: "Mesh Router Setup Discussion",
            text: "Fixture evidence: owners describe setting up the Acme mesh router.",
          },
        ],
      ]);
      const evidence = facts.get(url);
      if (!evidence) throw new CampaignResearchError("invalid_input", "fixture_unavailable");
      return {
        url,
        ...evidence,
        contentType: "text/html" as const,
        fetchedAt: new Date().toISOString(),
      };
    };
    const campaignWorker = createCampaignWorker({
      prisma: handles.prisma,
      workerId: "testkit-e2e-campaign-worker",
      research: researchDiscoveryFixture,
      catalogResearch,
      discovery: {
        enabled: true,
        searchProviderId: "fixture-search",
        searchProvider: discoverySearchProvider,
        inspectOpportunity: inspectDiscoveryFixture,
      },
    });
    campaignWorker.start();
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@rakazo/web",
            "exec",
            "playwright",
            "test",
            ...(e2eSpec ? [e2eSpec] : []),
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
          ],
          {
            ...process.env,
            CI: "1",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await campaignWorker.stop().catch(() => undefined);
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                workspaceId: computer.workspaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<
  ReturnType<typeof import("../../../../apps/api/src/app.ts")["createApp"]>
>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, workspaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
