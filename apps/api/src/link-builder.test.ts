import { RPCHandler } from "@orpc/server/fetch";
import { CaptellEmulator, captellCues, StaticPlanProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { LB_RESPONSIBILITY_ACK_TEXT_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  workspaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

const other = { ...actor, workspaceId: "workspace-2", userId: "user-2" };

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    workspaceId: "workspace-1",
    createdByUserId: "user-1",
    name: "Nordlicht",
    slug: "nordlicht",
    status: "draft",
    brandName: "Nordlicht",
    allowedDomains: ["nordlicht.example"],
    persona: { displayName: "Mira", bio: "", language: "de", register: "du" },
    mailboxId: "mbx-1",
    mailboxAddress: "mira@inbox.example",
    captchaSecretId: "secret-1",
    captchaSecret: null,
    captchaLowBalanceCredits: 500,
    quotas: { newPerDay: 1, livePerDay: 1, maxLivePerHost: 1 },
    schedule: {
      timezone: "Europe/Berlin",
      weekdaysOnly: true,
      window: { start: "09:00", end: "22:00" },
      overtimeUntilLiveMet: false,
      hardStopHour: 24,
    },
    topicLanes: [{ id: "lane-schlaf", tag: "Schlaf", description: "Abend", exampleQuestions: [] }],
    markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
    marketPolicy: "primary_first",
    disclosureMode: "undisclosed_persona",
    responsibilityAck: null,
    linkRatio: { links: 1, posts: 3 },
    proxyPolicy: "static_isp_per_persona",
    countNofollow: true,
    targets: [],
    facts: [],
    denyHosts: [],
    preferHosts: [],
    warmup: { minPostsBeforeLink: 2, minAccountAgeHours: 24 },
    spamRetry: { maxRetries: 1, sentences: ["No soup for you!"] },
    content: { toneNotes: "", bannedClaims: [], maxReplyChars: 1200 },
    operator: { parkedHostTtlHours: 48, channels: ["push", "email"] },
    archivedAt: null,
    createdAt: new Date("2026-10-05T10:00:00.000Z"),
    updatedAt: new Date("2026-10-05T10:00:00.000Z"),
    ...overrides,
  };
}

function deps(
  prisma: PrismaClient,
  secrets?: { load: (value: string) => string; put: () => Promise<unknown> },
) {
  return {
    prisma,
    secrets: secrets ?? { load: () => "", put: vi.fn() },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-link-builder-test",
  } as unknown as RouterDeps;
}

async function call(routerDeps: RouterDeps, who: Actor, path: string, body: unknown = {}) {
  const handler = new RPCHandler(createRouter(routerDeps));
  return handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor: who } },
  );
}

describe("link builder routes", () => {
  it("scopes project lookup to the caller workspace", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { lbProject: { findFirst } } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), other, "linkBuilder/projects/get", {
      projectId: "project-1",
    });
    expect(response.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-1", workspaceId: "workspace-2", archivedAt: null },
      }),
    );
  });

  it("records responsibility acceptance when Start building is clicked", async () => {
    const row = projectRow();
    const updates: unknown[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => row),
        count: vi.fn(async () => 0),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          Object.assign(row, data);
          return row;
        }),
      },
      lbRun: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: { status: string } }) => data),
      },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/projects/start", {
      projectId: "project-1",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: { status: string; captchaConfigured: boolean };
    };
    expect(body.json.status).toBe("active");
    expect(body.json.captchaConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("ct_live_");
    expect(updates[0]).toMatchObject({
      status: "active",
      responsibilityAck: expect.objectContaining({
        acceptedByUserId: "user-1",
        textVersion: LB_RESPONSIBILITY_ACK_TEXT_VERSION,
      }),
    });
    expect(prisma.lbRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: "workspace-1", status: "running" }),
      }),
    );
  });

  it("replaces a brand-derived persona name when Start building is clicked", async () => {
    const row = projectRow({
      name: "Vitaminexpress",
      slug: "vitaminexpress-3096",
      brandName: "Vitaminexpress",
      allowedDomains: ["vitaminexpress.org"],
      persona: { displayName: "Vitaminexpress", bio: "", language: "de", register: "du" },
    });
    const updates: unknown[] = [];
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => row),
        count: vi.fn(async () => 0),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          Object.assign(row, data);
          return row;
        }),
      },
      lbRun: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: { status: string } }) => data),
      },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/projects/start", {
      projectId: "project-1",
    });
    expect(response.status).toBe(200);
    const saved = updates[0] as { persona?: { displayName?: string } };
    expect(saved.persona?.displayName).toMatch(/\s/);
    expect(saved.persona?.displayName?.toLowerCase()).not.toMatch(/vitamin|express/);
    const body = JSON.stringify(await response.json());
    expect(body.toLowerCase()).not.toContain("vitaminexpress47");
  });

  it("returns active proxy leases without credentials", async () => {
    const row = projectRow();
    const findMany = vi.fn(async () => [
      {
        id: "lease-1",
        country: "DE",
        kind: "static_isp",
        provider: "iproyal",
        renewsAt: new Date("2026-10-12T12:00:00.000Z"),
        status: "active",
        endpointSecretId: "secret-proxy",
        password: "s3cret-proxy-password",
        stickyKey: "user:s3cret-proxy-password@proxy.example:8080",
      },
    ]);
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => row) },
      lbProxyLease: { findMany },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/proxyLeases/list", {
      projectId: "project-1",
    });
    expect(response?.status).toBe(200);
    const text = JSON.stringify(await response?.json());
    expect(text).toContain("iproyal");
    expect(text).toContain("DE");
    expect(text).not.toContain("s3cret-proxy-password");
    expect(text).not.toContain("secret-proxy");
    expect(text).not.toContain("proxy.example");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          country: true,
          kind: true,
          provider: true,
          renewsAt: true,
          status: true,
        },
      }),
    );
  });

  it("refuses to start when the plan cap is already full", async () => {
    const row = projectRow();
    const prisma = {
      lbProject: {
        findFirst: vi.fn(async () => row),
        count: vi.fn(async () => 1),
        update: vi.fn(),
      },
    } as unknown as PrismaClient;
    const { response } = await call(
      {
        ...deps(prisma),
        plan: new StaticPlanProvider({
          name: "starter",
          caps: { projects: 1, live_per_day: 1, personas: 3 },
        }),
      },
      actor,
      "linkBuilder/projects/start",
      { projectId: "project-1" },
    );
    expect(response.status).toBe(403);
    expect(prisma.lbProject.update).not.toHaveBeenCalled();
  });

  it("refuses to start a project that is missing a mailbox or Captell seat", async () => {
    const row = projectRow({ mailboxId: null, captchaSecretId: null });
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => row), update: vi.fn() },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/projects/start", {
      projectId: "project-1",
    });
    expect(response.status).toBe(400);
    expect(prisma.lbProject.update).not.toHaveBeenCalled();
  });

  it("continues an operator ticket inside the workspace and can skip it", async () => {
    const row = projectRow({ status: "active" });
    const ticket = {
      id: "ticket-1",
      projectId: "project-1",
      hostId: "host-1",
      runId: "run-1",
      reason: "captcha_unsolved",
      screenUrl: null,
      note: null,
      status: "open",
      createdAt: new Date("2026-10-05T12:00:00.000Z"),
      host: {
        id: "host-1",
        status: "parked_operator",
        parkedFrom: "registering",
        registrableDomain: "fragen.nordlicht.example",
      },
    };
    const hostUpdate = vi.fn();
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => row) },
      lbOperatorTicket: {
        findFirst: vi.fn(async (query: { where: { workspaceId: string } }) =>
          query.where.workspaceId === "workspace-1" ? ticket : null,
        ),
      },
      lbRunStep: {
        findMany: vi.fn(async () => [
          {
            runId: "run-1",
            hostId: "host-1",
            artifactIds: ["shot-1"],
            createdAt: ticket.createdAt,
            stepIndex: 4,
          },
        ]),
      },
      artifact: { findMany: vi.fn(async () => [{ id: "shot-1" }]) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          lbHost: { update: hostUpdate },
          lbOperatorTicket: {
            update: vi.fn(async () => ({
              ...ticket,
              status: "resolved",
              note: "solved",
              host: { registrableDomain: "fragen.nordlicht.example" },
            })),
          },
        }),
      ),
    } as unknown as PrismaClient;
    const continued = await call(deps(prisma), actor, "linkBuilder/operator/continue", {
      projectId: "project-1",
      ticketId: "ticket-1",
      note: "solved",
    });
    expect(continued.response.status).toBe(200);
    const continuedBody = (await continued.response.json()) as {
      json: { status: string; screenshotArtifactId: string | null };
    };
    expect(continuedBody.json.status).toBe("resolved");
    expect(continuedBody.json.screenshotArtifactId).toBe("shot-1");
    expect(hostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "registering", parkedFrom: null } }),
    );

    ticket.host.status = "parked_operator";
    ticket.host.parkedFrom = "registering";
    hostUpdate.mockClear();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (fn) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        lbHost: { update: hostUpdate },
        lbOperatorTicket: {
          update: vi.fn(async () => ({
            ...ticket,
            status: "skipped",
            host: { registrableDomain: "fragen.nordlicht.example" },
          })),
        },
      }),
    );
    const skipped = await call(deps(prisma), actor, "linkBuilder/operator/skip", {
      projectId: "project-1",
      ticketId: "ticket-1",
    });
    expect(skipped.response.status).toBe(200);
    expect(hostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "dead", parkedFrom: null } }),
    );

    const foreign = await call(deps(prisma), other, "linkBuilder/operator/continue", {
      projectId: "project-1",
      ticketId: "ticket-1",
    });
    expect(foreign.response.status).toBe(404);
  });

  it("serves only artifacts referenced by the project's steps or placements", async () => {
    const row = projectRow({ status: "active" });
    const get = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => row) },
      lbRunStep: {
        findFirst: vi.fn(async (query: { where: { artifactIds: { has: string } } }) =>
          query.where.artifactIds.has === "shot-1" ? { id: "step-1" } : null,
        ),
      },
      lbPlacement: { findFirst: vi.fn(async () => null) },
      artifact: {
        findFirst: vi.fn(async () => ({
          id: "shot-1",
          name: "step-4-parked.png",
          mimeType: "image/png",
          storageKey: "stored-1",
        })),
      },
    } as unknown as PrismaClient;
    const routerDeps = { ...deps(prisma), artifacts: { get } } as unknown as RouterDeps;
    const shown = await call(routerDeps, actor, "linkBuilder/artifacts/get", {
      projectId: "project-1",
      artifactId: "shot-1",
    });
    expect(shown.response.status).toBe(200);
    const body = (await shown.response.json()) as { json: { contentBase64: string } };
    expect(Buffer.from(body.json.contentBase64, "base64")).toEqual(Buffer.from([137, 80, 78, 71]));

    const unrelated = await call(routerDeps, actor, "linkBuilder/artifacts/get", {
      projectId: "project-1",
      artifactId: "chat-attachment",
    });
    expect(unrelated.response.status).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("checks Captell balance through the HTTP solver and never returns the token", async () => {
    const token = "ct_live_placeholder";
    const load = vi.fn(() => token);
    const emulator = new CaptellEmulator([captellCues.balance(812)]);
    const prisma = {
      lbProject: { findFirst: vi.fn(async () => projectRow()) },
      secret: { findFirst: vi.fn(async () => ({ ciphertext: "ciphertext-not-the-token" })) },
    } as unknown as PrismaClient;
    const routerDeps = deps(prisma, { load, put: vi.fn() });
    routerDeps.captellFetch = emulator.fetch;
    const { response } = await call(routerDeps, actor, "linkBuilder/captell/checkBalance", {
      projectId: "project-1",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { credits: number; helperVersion: string } };
    expect(body.json.helperVersion).toBe("2026.10.4.16");
    expect(body.json.credits).toBe(812);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain("ciphertext");
    expect(emulator.requests[0]?.authorization).toBe(`Bearer ${token}`);
    expect(emulator.requests[0]?.url).toBe("https://captell.run/api/v1/balance");
    expect(load).toHaveBeenCalledWith("ciphertext-not-the-token");
    expect(prisma.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "secret-1", workspaceId: "workspace-1" } }),
    );
  });

  it("refuses a new project until a package is purchased", async () => {
    const create = vi.fn();
    const prisma = {
      lbCreditPurchase: { findMany: vi.fn(async () => []) },
      lbProject: { create },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/projects/create", {
      name: "New",
      brandName: "New",
      allowedDomains: ["nordlicht.example"],
    });
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a project when an explicit allowance is already stored", async () => {
    const row = projectRow();
    const prisma = {
      lbCreditPurchase: {
        findMany: vi.fn(async () => [{ billing: "allowance", chargeId: null, credits: 0 }]),
      },
      lbProject: { create: vi.fn(async () => row) },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/projects/create", {
      name: "New",
      brandName: "New",
      allowedDomains: ["nordlicht.example"],
    });
    expect(response.status).toBe(200);
    expect(prisma.lbProject.create).toHaveBeenCalled();
  });

  it("does not charge or store a purchase while checkout is disconnected", async () => {
    const create = vi.fn();
    const prisma = {
      lbRunStep: { findMany: vi.fn(async () => []) },
      lbCreditPurchase: { findMany: vi.fn(async () => []), create },
    } as unknown as PrismaClient;
    const { response } = await call(deps(prisma), actor, "linkBuilder/billing/checkout", {
      packageId: "growth",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      json: { charged: boolean; entitled: boolean; balance: number; reason: string; checkoutUrl: null };
    };
    expect(body.json.charged).toBe(false);
    expect(body.json.entitled).toBe(false);
    expect(body.json.balance).toBe(80);
    expect(body.json.checkoutUrl).toBeNull();
    expect(body.json.reason).toMatch(/not connected/i);
    expect(body.json.reason).toMatch(/not added/i);
    expect(create).not.toHaveBeenCalled();
  });
});
