import type { Prisma, PrismaClient } from "./client.js";

/** Stable slug for the seeded wellness demo. Fake `.example` data only. */
export const LB_DEMO_SLUG = "nordlicht-wellness";

export interface LinkBuilderDemoSeed {
  workspaceId: string;
  userId: string;
  now?: Date;
}

/**
 * Inserts one DE wellness project with hosts across the funnel, a counted LIVE
 * placement, a run timeline, and an open operator ticket. Idempotent per workspace.
 */
export async function seedLinkBuilderDemo(
  prisma: PrismaClient,
  input: LinkBuilderDemoSeed,
): Promise<{ projectId: string; created: boolean }> {
  const existing = await prisma.lbProject.findFirst({
    where: { workspaceId: input.workspaceId, slug: LB_DEMO_SLUG },
    select: { id: true },
  });
  if (existing) return { projectId: existing.id, created: false };

  const now = input.now ?? new Date();
  const date = berlinDate(now);
  const workspaceId = input.workspaceId;
  const json = (value: unknown) => value as Prisma.InputJsonValue;

  const project = await prisma.lbProject.create({
    data: {
      workspaceId,
      createdByUserId: input.userId,
      name: "Nordlicht",
      slug: LB_DEMO_SLUG,
      status: "active",
      brandName: "Nordlicht",
      allowedDomains: ["nordlicht.example"],
      persona: json({
        displayName: "Mira Sol",
        bio: "Schläft früh, trinkt Tee, antwortet ruhig.",
        language: "de",
        register: "du",
      }),
      mailboxId: "mbx-nordlicht-demo",
      mailboxAddress: "mira.sol@inbox.example",
      captchaLowBalanceCredits: 500,
      quotas: json({ newPerDay: 2, livePerDay: 2, liveWeekCap: 8, maxLivePerHost: 1 }),
      schedule: json({
        timezone: "Europe/Berlin",
        weekdaysOnly: true,
        window: { start: "09:00", end: "22:00" },
        overtimeUntilLiveMet: false,
        hardStopHour: 24,
      }),
      topicLanes: json([
        {
          id: "lane-schlaf",
          tag: "Schlaf",
          description: "Abendroutinen und ruhige Schlafzimmer.",
          exampleQuestions: ["Wie wird eine Abendroutine fest?"],
        },
      ]),
      markets: json([
        { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
      ]),
      marketPolicy: "primary_first",
      disclosureMode: "undisclosed_persona",
      responsibilityAck: json({
        acceptedAt: now.toISOString(),
        acceptedByUserId: input.userId,
        textVersion: "2026-10-05",
      }),
      linkRatio: json({ links: 1, posts: 3 }),
      proxyPolicy: "static_isp_per_persona",
      countNofollow: true,
      targets: json([
        {
          url: "https://nordlicht.example/schlaf",
          priority: 80,
          description: "Abendroutine",
          keywordClusters: ["abendroutine", "einschlafen"],
        },
      ]),
      facts: ["Nordlicht verkauft eine dimmbare Nachttischlampe."],
      denyHosts: ["spam.nordlicht.example"],
      warmup: json({ minPostsBeforeLink: 3, minAccountAgeHours: 24 }),
      content: json({ toneNotes: "Ruhig, konkret.", bannedClaims: [], maxReplyChars: 1200 }),
      operator: json({ parkedHostTtlHours: 48, channels: ["push", "email"] }),
    },
    select: { id: true },
  });

  const hosts = await seedHosts(prisma, workspaceId, project.id);
  const account = await prisma.lbHostAccount.create({
    data: {
      workspaceId,
      projectId: project.id,
      hostId: hosts.used,
      username: "mira-sol",
      postCount: 3,
      linkPostCount: 1,
      emailVerifiedAt: now,
      firstPostAt: now,
      lastPostAt: now,
    },
    select: { id: true },
  });
  const thread = await prisma.lbThreadCandidate.create({
    data: {
      workspaceId,
      projectId: project.id,
      hostId: hosts.used,
      url: "https://forum.nordlicht.example/viewtopic.php?t=12",
      title: "Abendroutine bei unruhigen Nächten",
      excerpt: "Welche Lampe stört nicht?",
      relevance: 0.86,
      laneId: "lane-schlaf",
      openQuestion: true,
      status: "posted",
      lastActivityAt: now,
      replyCount: 4,
    },
    select: { id: true },
  });
  const draft = await prisma.lbDraft.create({
    data: {
      workspaceId,
      projectId: project.id,
      threadCandidateId: thread.id,
      modelLane: "draft",
      modelId: "fake-draft",
      body: "Eine feste Uhrzeit hilft oft. Das hier erklärt es ganz gut.",
      linkSlot: "inline",
      targetUrl: "https://nordlicht.example/schlaf",
      anchorText: "Nordlicht",
      qualityChecks: json({
        factsOnly: true,
        noBannedClaims: true,
        registerMatches: true,
        lengthOk: true,
        singleLink: true,
        notTestimonial: true,
        issues: [],
      }),
      status: "posted",
    },
    select: { id: true },
  });
  await prisma.lbPlacement.create({
    data: {
      workspaceId,
      projectId: project.id,
      hostId: hosts.used,
      hostAccountId: account.id,
      draftId: draft.id,
      threadUrl: "https://forum.nordlicht.example/viewtopic.php?t=12",
      postUrl: "https://forum.nordlicht.example/viewtopic.php?p=40#p40",
      targetUrl: "https://nordlicht.example/schlaf",
      anchorText: "Nordlicht",
      rel: ["ugc"],
      indexable: true,
      status: "nofollow_live",
      counted: true,
      verifiedAt: now,
      verifyMethod: "logged_out_fetch",
    },
  });

  const run = await prisma.lbRun.create({
    data: {
      workspaceId,
      projectId: project.id,
      date,
      status: "partial",
      newToday: 1,
      liveToday: 1,
      liveWeek: 1,
      uniqueHosts: 3,
      currentHostId: hosts.parked,
      lastAction: "Parked fragen.nordlicht.example for an operator",
      whyNot: json({
        supply: { qualified: 1, ready: 1 },
        parked: 1,
        spamBlocked: 0,
        unsupportedCaptcha: 0,
        pendingEmail: 0,
        pendingAdmin: 0,
        modelErrors: 0,
        modelRefusals: 0,
        captchaBalance: 2400,
        proxy: "ok",
        reasons: ["operator_parked"],
      }),
      startedAt: now,
      finishedAt: now,
    },
    select: { id: true },
  });

  const steps = [
    "Discovered forum.nordlicht.example",
    "Qualified forum.nordlicht.example",
    "Verified link on forum.nordlicht.example",
    "Parked fragen.nordlicht.example for an operator",
  ];
  await prisma.lbRunStep.createMany({
    data: steps.map((lastAction, stepIndex) => ({
      workspaceId,
      runId: run.id,
      stepIndex,
      kind: ["discover", "qualify", "verify", "park"][stepIndex] ?? "note",
      hostId: stepIndex === 3 ? hosts.parked : hosts.used,
      outcome: json({ lastAction }),
      costs: json({ credits: stepIndex === 2 ? 10 : 0, tokens: 0, bytes: 0, ms: 400 }),
    })),
  });
  await prisma.lbCaptchaEvent.createMany({
    data: [
      {
        workspaceId,
        projectId: project.id,
        hostId: hosts.used,
        runId: run.id,
        type: "recaptcha_v2",
        door: "page_helper",
        buttonTextObserved: "Placed. Submit the form.",
        humanCheckboxState: "checked",
        outcome: "placed_submitted",
        attempt: 1,
        creditsCharged: 10,
        helperVersion: "2026.10.4.16",
      },
      {
        workspaceId,
        projectId: project.id,
        hostId: hosts.parked,
        runId: run.id,
        type: "recaptcha_v2",
        door: "operator",
        humanCheckboxState: "none",
        outcome: "operator_parked",
        attempt: 2,
        creditsCharged: 0,
        helperVersion: "2026.10.4.16",
      },
    ],
  });
  return { projectId: project.id, created: true };
}

async function seedHosts(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<{ used: string; parked: string }> {
  const rows = [
    ["forum.nordlicht.example", "phpbb", "used", null],
    ["fragen.nordlicht.example", "woltlab", "parked_operator", "registering"],
    ["waerme.nordlicht.example", "xenforo", "ready", null],
    ["ruhe.nordlicht.example", "flarum", "warming", null],
    ["garten.nordlicht.example", "discourse", "qualified", null],
    ["nacht.nordlicht.example", "mybb", "discovered", null],
    ["spam.nordlicht.example", "unknown", "denied", null],
  ] as const;
  const ids = new Map<string, string>();
  for (const [domain, platform, status, parkedFrom] of rows) {
    const host = await prisma.lbHost.create({
      data: {
        workspaceId,
        projectId,
        registrableDomain: domain,
        homepageUrl: `https://${domain}/`,
        platform,
        language: "de",
        country: "DE",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        captchaType: platform === "phpbb" ? "image_letters" : "recaptcha_v2",
        registerUrl: `https://${domain}/ucp.php?mode=register`,
        topicTags: ["schlaf"],
        qualityScore: status === "denied" ? 0.1 : 0.7,
        hrefForNewMembers: status === "denied" ? "no" : "yes",
        relDefault: "ugc",
        status,
        parkedFrom,
        statusReason: status === "denied" ? "commercial links forbidden" : null,
      },
      select: { id: true, registrableDomain: true },
    });
    ids.set(host.registrableDomain, host.id);
  }
  return {
    used: ids.get("forum.nordlicht.example")!,
    parked: ids.get("fragen.nordlicht.example")!,
  };
}

function berlinDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export function linkBuilderDemoDomains(): string[] {
  return [
    "forum.nordlicht.example",
    "fragen.nordlicht.example",
    "waerme.nordlicht.example",
    "ruhe.nordlicht.example",
    "garten.nordlicht.example",
    "nacht.nordlicht.example",
    "spam.nordlicht.example",
  ];
}
