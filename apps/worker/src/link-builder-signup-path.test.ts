import type {
  BrowserSession,
  ClickableControl,
  FormFieldInfo,
  SearchProvider,
} from "@rakazo/adapter-kit";
import { personMailboxAddress } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { startRunCounters } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import { discoverDueProjects } from "./link-builder-discovery.js";
import { keptRunLastAction } from "./link-builder-real.js";
import {
  type HostRow,
  type ProjectConfig,
  REAL_STEP_HANDLERS,
  recoverStuckStep,
  type StepContext,
} from "./link-builder-real-steps.js";

const FORM_URL = "https://aquacomputer.de/ucp.php?mode=register&agreed=1";
const RULES_URL = "https://aquacomputer.de/ucp.php?mode=register";

function control(partial: Partial<FormFieldInfo> & Pick<FormFieldInfo, "selector">): FormFieldInfo {
  return {
    selector: partial.selector,
    tag: partial.tag ?? "input",
    type: partial.type ?? "text",
    name: partial.name ?? null,
    id: partial.id ?? null,
    autocomplete: partial.autocomplete ?? null,
    label: partial.label ?? "",
    role: partial.role ?? null,
    required: partial.required ?? false,
    hidden: partial.hidden,
  };
}

interface Page {
  text: string;
  fields: FormFieldInfo[];
  clickables: ClickableControl[];
}

class ScriptedSession {
  held = false;
  readonly visits: string[] = [];
  readonly fills: Array<{ selector: string; value: string }> = [];
  current: string;
  private readonly pages = new Map<string, Page>();
  private readonly empty: Page = { text: "Forum", fields: [], clickables: [] };

  constructor(start: string, pages: Record<string, Page>) {
    this.current = start;
    for (const [url, page] of Object.entries(pages)) this.pages.set(url, page);
  }

  async goto(url: string): Promise<void> {
    if (this.held) return;
    this.current = url;
    this.visits.push(url);
  }

  async url(): Promise<string> {
    return this.current;
  }

  async pageText(): Promise<string> {
    return (this.pages.get(this.current) ?? this.empty).text;
  }

  async formFields(): Promise<FormFieldInfo[]> {
    return (this.pages.get(this.current) ?? this.empty).fields.map((field) => ({ ...field }));
  }

  async clickables(): Promise<ClickableControl[]> {
    return (this.pages.get(this.current) ?? this.empty).clickables.map((control) => ({
      ...control,
    }));
  }

  async exists(selector: string): Promise<boolean> {
    const page = this.pages.get(this.current) ?? this.empty;
    return (
      page.fields.some((field) => field.selector === selector) ||
      page.clickables.some((control) => control.selector === selector)
    );
  }

  async click(selector: string): Promise<void> {
    if (selector !== "#agree") return;
    this.current = FORM_URL;
    this.visits.push(FORM_URL);
  }

  async fill(selector: string, value: string): Promise<void> {
    this.fills.push({ selector, value });
  }

  async text(): Promise<string | null> {
    return null;
  }

  async attribute(): Promise<string | null> {
    return null;
  }

  async screenshotPng(): Promise<Uint8Array> {
    return new Uint8Array([1]);
  }

  async holdForm(): Promise<void> {
    this.held = true;
  }

  async releaseForm(): Promise<void> {
    this.held = false;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function fieldPage(text: string, fields: FormFieldInfo[]): Page {
  return { text, fields, clickables: [] };
}

function homeWithRegister(): ScriptedSession {
  return new ScriptedSession("https://aquacomputer.de/", {
    "https://aquacomputer.de/": {
      text: "Aquacomputer Forum",
      fields: [],
      clickables: [
        {
          selector: "a.register",
          tag: "a",
          role: "link",
          type: null,
          text: "Registrieren",
          href: "/ucp.php?mode=register",
          inHeader: true,
        },
      ],
    },
    [RULES_URL]: fieldPage("Regeln. Bitte zustimmen.", [
      control({ selector: "#agree", tag: "button", type: "submit", label: "Ich stimme zu" }),
    ]),
    [FORM_URL]: fieldPage("Registrierung", [
      control({ selector: "#username", name: "username", label: "Username" }),
      control({ selector: "#email", name: "email", type: "email", label: "Email" }),
      control({ selector: "#password", name: "password", type: "password", label: "Password" }),
      control({ selector: "#submit", tag: "button", type: "submit", label: "Register" }),
    ]),
  });
}

function homeWithoutRegister(origin: string): ScriptedSession {
  return new ScriptedSession(`${origin}/`, {
    [`${origin}/`]: { text: "Forum home", fields: [], clickables: [] },
  });
}

interface StoredHost {
  id: string;
  registrableDomain: string;
  status: string;
  statusReason: string | null;
  accounts: unknown[];
  placements: unknown[];
  platform: string;
  qualityScore: number;
  homepageUrl: string;
  createdAt: Date;
  language: string;
  country: string;
  locale: string;
  timezoneId: string;
  parkedFrom: null;
}

function storedHost(
  partial: Partial<StoredHost> & Pick<StoredHost, "id" | "registrableDomain">,
): StoredHost {
  return {
    status: "qualified",
    statusReason: null,
    accounts: [],
    placements: [],
    platform: "unknown",
    qualityScore: 1,
    homepageUrl: `https://${partial.registrableDomain}/`,
    createdAt: new Date("2026-10-16T12:00:00.000Z"),
    language: "de",
    country: "DE",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    parkedFrom: null,
    ...partial,
  };
}

function project(): ProjectConfig {
  return {
    id: "p1",
    workspaceId: "w1",
    ownerUserId: "user-1",
    name: "Nordlicht",
    brandName: "Nordlicht",
    allowedDomains: ["nordlicht.example"],
    persona: { displayName: "Sophie Braun", language: "de" },
    markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
    quotas: { newPerDay: 2, livePerDay: 1 },
    schedule: { timezone: "Europe/Berlin", windows: [] },
    warmup: { minPostsBeforeLink: 1, minAccountAgeHours: 24 },
    targets: [],
    facts: [],
    content: { topics: [] },
    disclosureMode: "always",
    linkRatio: "sometimes",
    topicLanes: [],
    countNofollow: false,
    denyHosts: ["frauenselbsthilfe.de"],
    preferHosts: [],
    mailboxId: "box",
    mailboxAddress: null,
    captchaLowBalanceCredits: 0,
    operatorTtlHours: 24,
    ticketTtlHours: 24,
    spamSentences: [],
    spamMaxRetries: 0,
    proxyPolicy: "off",
  } as unknown as ProjectConfig;
}

function harness(hosts: StoredHost[]) {
  const pauses: string[] = [];
  const prisma = {
    lbHost: {
      findMany: async () => hosts,
      updateMany: async (args: { where: { id: string; status: string }; data: StoredHost }) => {
        const row = hosts.find(
          (host) => host.id === args.where.id && host.status === args.where.status,
        );
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    lbHostAccount: {
      findUnique: async () => null,
      count: async () => 0,
      create: async () => ({ id: "acct-1" }),
    },
    lbRunStep: {
      findMany: async () => [],
      count: async () => 0,
    },
    lbProject: {
      update: async () => ({}),
      updateMany: async (args: { data: { status: string } }) => {
        pauses.push(args.data.status);
        return { count: 1 };
      },
      findUnique: async () => ({ status: "active" }),
    },
    siteLogin: {
      findUnique: async () => null,
      count: async () => 0,
      create: async (args: { data: { host: string; username: string } }) => ({
        id: "login-1",
        host: args.data.host,
        url: null,
        username: args.data.username,
        share: "workspace",
        createdByBotId: null,
        createdAt: new Date("2026-10-16T12:00:00.000Z"),
        updatedAt: new Date("2026-10-16T12:00:00.000Z"),
      }),
    },
    secret: {
      create: async () => ({ id: "sec-1" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma, pauses };
}

function registerCtx(host: StoredHost, session: ScriptedSession, prisma: unknown): StepContext {
  return {
    now: new Date("2026-10-16T12:00:00.000Z"),
    stepIndex: 1,
    run: { id: "run-1", counters: startRunCounters(), status: "running" },
    project: project(),
    host: host as unknown as HostRow,
    pool: () => ({
      session: session as unknown as BrowserSession,
      hostId: host.id,
      helperConnected: true,
      cookieChecked: true,
      registerFormReady: false,
    }),
    services: {
      prisma,
      secrets: { put: async () => ({ id: "sec-1", ciphertext: "cipher" }) },
    },
    storeArtifact: async () => "artifact-1",
    secrets: [],
  } as unknown as StepContext;
}

describe("signup path", () => {
  it("follows a register link and a rules step onto the form", async () => {
    const previous = process.env.RESEND_INBOUND_DOMAIN;
    process.env.RESEND_INBOUND_DOMAIN = "sideinbox.email";
    try {
      const hosts = [
        storedHost({
          id: "aqua",
          registrableDomain: "aquacomputer.de",
          createdAt: new Date("2026-10-16T12:00:00.000Z"),
        }),
      ];
      const { prisma } = harness(hosts);
      const session = homeWithRegister();
      const result = await REAL_STEP_HANDLERS.register(registerCtx(hosts[0]!, session, prisma));
      expect(result.kind).toBe("step");
      if (result.kind !== "step") return;
      expect(result.lastAction).toBe("Filled the registration form");
      expect(result.lastAction.startsWith("No signup form")).toBe(false);
      await expect(session.url()).resolves.toBe(FORM_URL);
      expect(session.visits).toContain(RULES_URL);
      expect(session.held).toBe(true);
      expect(session.fills.find((fill) => fill.selector === "#email")?.value).toBe(
        personMailboxAddress("p1:0", "sideinbox.email"),
      );
      expect(
        session.visits.some((url) =>
          /medizin-forum|phpbb\.de|macuser|lifters-lounge|frauenselbsthilfe|bulli-forum/.test(url),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RESEND_INBOUND_DOMAIN;
      else process.env.RESEND_INBOUND_DOMAIN = previous;
    }
  });

  it("records a miss and opens the next stored forum, then the one after that", async () => {
    const hosts = [
      storedHost({
        id: "denied",
        registrableDomain: "medizin-forum.de",
        status: "ready",
        accounts: [{ id: "acct-denied" }],
        platform: "phpbb",
        qualityScore: 9,
        createdAt: new Date("2026-10-16T08:00:00.000Z"),
      }),
      storedHost({
        id: "science",
        registrableDomain: "science-fitness.de",
        qualityScore: 8,
        createdAt: new Date("2026-10-16T09:00:00.000Z"),
      }),
      storedHost({
        id: "aqua",
        registrableDomain: "aquacomputer.de",
        accounts: [{ id: "acct-aqua" }],
        qualityScore: 1,
        createdAt: new Date("2026-10-16T12:00:00.000Z"),
      }),
      storedHost({
        id: "edu",
        registrableDomain: "edubily.de",
        qualityScore: 5,
        createdAt: new Date("2026-10-16T11:00:00.000Z"),
      }),
    ];
    const { prisma, pauses } = harness(hosts);
    let searches = 0;
    const search = {
      describe: () => ({
        id: "fake-search",
        contractVersion: "1",
        adapterVersion: "0",
        capabilities: { maxDepth: 10, operators: false },
      }),
      search: async () => {
        searches += 1;
        throw new Error("DataForSEO must not run");
      },
    } satisfies SearchProvider;
    const discover = () =>
      discoverDueProjects({
        prisma: {
          ...prisma,
          lbProject: {
            ...prisma.lbProject,
            findMany: async () => [
              {
                id: "p1",
                workspaceId: "w1",
                name: "Nordlicht",
                brandName: "Nordlicht",
                status: "active",
                archivedAt: null,
                lastDiscoveredAt: new Date("2026-10-15T09:10:11.995Z"),
                schedule: { timezone: "Europe/Berlin" },
                markets: [
                  { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
                ],
                topicLanes: [{ id: "lane", tag: "Magnesium", description: "Magnesium Schlaf" }],
                marketPolicy: "primary_first",
                quotas: { livePerDay: 1 },
                denyHosts: ["frauenselbsthilfe.de"],
              },
            ],
          },
          lbRun: { findFirst: async () => null },
        } as unknown as PrismaClient,
        search,
        now: new Date("2026-10-16T12:00:00.000Z"),
        openBrowser: async () => {
          throw new Error("browser search must not open");
        },
      });
    await discover();
    expect(searches).toBe(0);

    const select = (host: StoredHost | null) =>
      REAL_STEP_HANDLERS.select_host({
        now: new Date("2026-10-16T12:00:00.000Z"),
        run: { id: "run-1", counters: startRunCounters() },
        project: project(),
        host: host as unknown as HostRow,
        pool: () => undefined,
        services: { prisma },
      } as unknown as StepContext);

    const first = await select(null);
    expect(first).toMatchObject({ hostId: "aqua", lastAction: "Working on aquacomputer.de" });

    const missed = await REAL_STEP_HANDLERS.register(
      registerCtx(
        hosts.find((host) => host.id === "aqua")!,
        homeWithoutRegister("https://aquacomputer.de"),
        prisma,
      ),
    );
    expect(missed).toMatchObject({
      kind: "step",
      lastAction: "No signup form on aquacomputer.de",
    });
    if (missed.kind === "step") await missed.apply?.(prisma as never);
    expect(hosts.find((host) => host.id === "aqua")?.status).toBe("dead");
    expect(pauses).toEqual([]);
    await discover();
    expect(searches).toBe(0);

    const second = await select(hosts.find((host) => host.id === "aqua") ?? null);
    expect(second).toMatchObject({ hostId: "edu", lastAction: "Working on edubily.de" });

    const edu = hosts.find((host) => host.id === "edu")!;
    const missedEdu = await REAL_STEP_HANDLERS.register(
      registerCtx(edu, homeWithoutRegister("https://edubily.de"), prisma),
    );
    expect(missedEdu).toMatchObject({ lastAction: "No signup form on edubily.de" });
    if (missedEdu.kind === "step") await missedEdu.apply?.(prisma as never);
    const third = await select(edu);
    expect(third).toMatchObject({
      hostId: "science",
      lastAction: "Working on science-fitness.de",
    });
    await discover();
    expect(searches).toBe(0);

    const science = hosts.find((host) => host.id === "science")!;
    const missedScience = await REAL_STEP_HANDLERS.register(
      registerCtx(science, homeWithoutRegister("https://science-fitness.de"), prisma),
    );
    expect(missedScience).toMatchObject({
      lastAction: "No signup form on science-fitness.de",
    });
    if (missedScience.kind === "step") await missedScience.apply?.(prisma as never);
    expect(pauses).toEqual(["paused"]);
    expect(
      keptRunLastAction("No signup form on science-fitness.de", "Skipped 1 denied forums"),
    ).toBe("No signup form on science-fitness.de");
  });

  it("does not use the stuck pause before a later stored forum is tried", async () => {
    const hosts = [
      storedHost({ id: "aqua", registrableDomain: "aquacomputer.de" }),
      storedHost({ id: "edu", registrableDomain: "edubily.de" }),
    ];
    const { prisma, pauses } = harness(hosts);
    const result = await recoverStuckStep({
      now: new Date("2026-10-16T12:00:00.000Z"),
      run: { id: "run-1" },
      project: project(),
      host: hosts[0] as unknown as HostRow,
      pool: () => ({ registerFormReady: false }),
      services: {
        prisma: {
          ...prisma,
          lbRunStep: {
            findMany: async () => [
              {
                outcome: { lastAction: "Step failed, retrying" },
                error: "Browser action timed out",
                createdAt: new Date("2026-10-16T11:00:00.000Z"),
                kind: "register",
              },
            ],
          },
        },
      },
    } as unknown as StepContext);
    expect(result?.kind).toBe("step");
    if (result?.kind !== "step") return;
    expect(result.lastAction).toBe("No signup form on aquacomputer.de");
    await result.apply?.(prisma as never);
    expect(pauses).toEqual([]);
    expect(hosts[0]?.status).toBe("dead");
  });
});
