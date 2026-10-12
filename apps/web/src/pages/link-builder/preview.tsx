import type {
  LbDraftView,
  LbHostView,
  LbOperatorTicketView,
  LbProjectCard,
  LbProjectDetail,
  LbProjectStatusView,
  LbThreadView,
} from "@rakazo/contracts";
import { useState } from "react";
import { emptyDraft, WIZARD_STEPS } from "./model.js";
import { DashboardView, OperatorView, ProjectView, WizardView } from "./views.js";

const card: LbProjectCard = {
  id: "demo",
  name: "Nordlicht",
  slug: "nordlicht-wellness",
  status: "active",
  brandName: "Nordlicht",
  activity: "running",
  activityLabel: "running",
  newToday: 1,
  liveToday: 1,
  liveWeek: 1,
  newPerDay: 2,
  livePerDay: 2,
  liveWeekCap: 8,
  runStatus: "partial",
  lastEvent: "Working on fragen.nordlicht.example",
  operatorQueue: 0,
};

const ticket: LbOperatorTicketView = {
  id: "ticket-1",
  projectId: "demo",
  hostId: "host-1",
  domain: "fragen.nordlicht.example",
  runId: "run-1",
  reason: "captcha_unsolved",
  screenUrl: null,
  screenshotArtifactId: null,
  note: null,
  status: "open",
  expiresAt: "2026-10-05T17:12:00.000Z",
  createdAt: "2026-10-05T12:00:00.000Z",
};

const PREVIEW_NOW = Date.parse("2026-10-05T12:00:00.000Z");

const vitaminexpressCard: LbProjectCard = {
  id: "vitaminexpress",
  name: "Vitaminexpress",
  slug: "vitaminexpress",
  status: "active",
  brandName: "Vitaminexpress",
  activity: "running",
  activityLabel: "running",
  newToday: 0,
  liveToday: 0,
  liveWeek: 0,
  newPerDay: 2,
  livePerDay: 1,
  liveWeekCap: 8,
  runStatus: "running",
  lastEvent: "Searched Google.de for Magnesium Krämpfe Forum",
  operatorQueue: 0,
};

const vitaminexpressProject = {
  name: "Vitaminexpress",
  slug: "vitaminexpress",
  brandName: "Vitaminexpress",
  allowedDomains: ["vitaminexpress.org"],
  persona: { displayName: "Lena Kraft", bio: "Ruhig", register: "du", language: "de" },
  mailboxAddress: "lena.kraft@inbox.example",
  mailboxId: "mbx-vitaminexpress-demo",
  captchaConfigured: true,
  quotas: { newPerDay: 2, livePerDay: 1, liveWeekCap: 8, maxLivePerHost: 1 },
  schedule: {
    timezone: "Europe/Berlin",
    weekdaysOnly: true,
    window: { start: "09:00", end: "22:00" },
    overtimeUntilLiveMet: false,
    hardStopHour: 24,
  },
  targets: [
    {
      url: "https://www.vitaminexpress.org/de/magnesium",
      priority: 50,
      description: "Krämpfe",
      keywordClusters: ["magnesium kaufen"],
    },
  ],
  facts: ["Magnesium"],
  topicLanes: [{ id: "lane-mg", tag: "Magnesium kaufen", description: "Krämpfe" }],
  markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
  marketPolicy: "primary_first",
  disclosureMode: "undisclosed_persona",
  linkRatio: { links: 1, posts: 3 },
  proxyPolicy: "static_isp_per_persona",
  denyHosts: [],
} as unknown as LbProjectDetail;

/** Dev-only fixture screens for visual checks. Not linked from the product. */
export function LinkBuilderPreview({ screen }: { screen: string }) {
  const [current, setCurrent] = useState(screen);
  if (current === "computer") {
    return <VitaminexpressComputer onProjects={() => setCurrent("dashboard")} />;
  }
  if (current === "wizard") {
    const draft = emptyDraft();
    draft.name = "Nordlicht";
    draft.brandName = "Nordlicht";
    draft.allowedDomains = "nordlicht.example";
    return (
      <div className="min-h-screen bg-[#050506]">
        <WizardView
          step={0}
          draft={draft}
          issues={[]}
          busy={false}
          started={false}
          onChange={() => undefined}
          onBack={() => undefined}
          onNext={() => undefined}
          onStart={() => undefined}
          onGoTo={() => undefined}
        />
      </div>
    );
  }
  if (current === "review") {
    const draft = emptyDraft();
    draft.name = "Nordlicht";
    draft.brandName = "Nordlicht";
    draft.allowedDomains = "nordlicht.example";
    draft.displayName = "Mira Sol";
    draft.mailboxAddress = "mira.sol@inbox.example";
    draft.mailboxId = "mbx-nordlicht-demo";
    draft.captchaConfigured = true;
    draft.pages = [
      {
        id: "page-schlaf",
        url: "https://nordlicht.example/schlaf",
        keyword: "Schlaf",
        rules: "Abend",
      },
    ];
    return (
      <div className="min-h-screen bg-[#050506]">
        <WizardView
          step={WIZARD_STEPS.length - 1}
          draft={draft}
          issues={[]}
          busy={false}
          started={false}
          onChange={() => undefined}
          onBack={() => undefined}
          onNext={() => undefined}
          onStart={() => undefined}
          onGoTo={() => undefined}
        />
      </div>
    );
  }
  if (current === "captchas") {
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={{ name: "Nordlicht" } as LbProjectDetail}
          status={null}
          hosts={[]}
          placements={[]}
          steps={[]}
          threads={[]}
          drafts={[]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "hosts") {
    const host: LbHostView = {
      id: "host-1",
      registrableDomain: "rueckenforum.example",
      homepageUrl: "https://rueckenforum.example/",
      platform: "phpbb",
      country: "DE",
      language: "de",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      status: "qualified",
      parkedFrom: null,
      qualityScore: 0.9,
      topicTags: ["Rückenschmerzen"],
      captchaType: "image_letters",
      hrefForNewMembers: "after_n_posts",
      relDefault: "ugc",
      signatureLinks: false,
      minPostsForLinks: 2,
      registerUrl: "https://rueckenforum.example/ucp.php?mode=register",
      statusReason: null,
    };
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={{ name: "Nordlicht", disclosureMode: "undisclosed_persona" } as LbProjectDetail}
          status={null}
          hosts={[
            host,
            {
              ...host,
              id: "host-2",
              registrableDomain: "arkose-board.example",
              status: "unsupported_captcha",
              captchaType: "unsupported",
              statusReason: "unsupported_captcha",
            },
          ]}
          placements={[]}
          steps={[]}
          threads={[]}
          drafts={[]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "threads") {
    const thread: LbThreadView = {
      id: "thread-1",
      hostId: "host-1",
      domain: "rueckenforum.example",
      url: "https://rueckenforum.example/viewtopic.php?t=11",
      title: "Was hilft bei Rückenschmerzen?",
      excerpt: "Nach dem Büro wird es steif.",
      status: "candidate",
      relevance: 0.86,
      openQuestion: true,
      laneId: "lane-ruecken",
      rejectReason: null,
    };
    const draft: LbDraftView = {
      id: "draft-1",
      threadCandidateId: thread.id,
      body: "Kurze Pausen und Dehnen helfen vielen. Schau mal hier, da ist das ganz gut erklärt.",
      status: "drafted",
      linkSlot: "inline",
      modelLane: "draft",
      modelId: "recorded-draft",
      targetUrl: "https://nordlicht.example/ruecken",
      anchorText: "Dehnen",
      confidence: 0.84,
      qualityChecks: {
        factsOnly: false,
        noBannedClaims: true,
        registerMatches: true,
        lengthOk: true,
        singleLink: true,
        notTestimonial: true,
        issues: ["facts_only"],
      },
    };
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={{ name: "Nordlicht", disclosureMode: "drafts_only" } as LbProjectDetail}
          status={null}
          hosts={[]}
          placements={[]}
          steps={[]}
          threads={[thread]}
          drafts={[draft]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          onDecideDraft={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "settings") {
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={
            {
              name: "Nordlicht",
              slug: "nordlicht-wellness",
              brandName: "Nordlicht",
              allowedDomains: ["nordlicht.example"],
              persona: { displayName: "Mira Sol", bio: "Calm", register: "du", language: "de" },
              mailboxAddress: "mira.sol@inbox.example",
              mailboxId: "mbx-nordlicht-demo",
              captchaConfigured: true,
              quotas: { newPerDay: 2, livePerDay: 1, liveWeekCap: 5, maxLivePerHost: 1 },
              schedule: {
                timezone: "Europe/Berlin",
                weekdaysOnly: true,
                window: { start: "09:00", end: "22:00" },
                overtimeUntilLiveMet: false,
                hardStopHour: 24,
              },
              targets: [
                {
                  url: "https://nordlicht.example/schlaf",
                  priority: 50,
                  description: "Abend",
                  keywordClusters: ["Schlaf"],
                },
              ],
              facts: ["Abend"],
              topicLanes: [],
              markets: [
                { country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" },
              ],
              marketPolicy: "primary_first",
              disclosureMode: "undisclosed_persona",
              linkRatio: { links: 1, posts: 3 },
              proxyPolicy: "static_isp_per_persona",
              denyHosts: [],
            } as unknown as LbProjectDetail
          }
          status={null}
          hosts={[]}
          placements={[]}
          steps={[]}
          threads={[]}
          drafts={[]}
          leases={[
            {
              id: "lease-de",
              country: "DE",
              kind: "static_isp",
              providerId: "iproyal",
              expiresAt: "2026-10-12T12:00:00.000Z",
              status: "active",
            },
            {
              id: "lease-us",
              country: "US",
              kind: "residential",
              providerId: "oxylabs",
              expiresAt: "2026-10-06T12:00:00.000Z",
              status: "active",
            },
          ]}
          tickets={[]}
          surface="settings"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "runs") {
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={{ name: "Nordlicht" } as LbProjectDetail}
          status={null}
          hosts={[]}
          placements={[]}
          steps={[
            {
              id: "step-1",
              stepIndex: 0,
              kind: "coherence_refused",
              hostId: "host-1",
              lastAction: "Coherence refused",
              error: null,
              costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
              artifactIds: [],
              createdAt: "2026-10-05T12:00:00.000Z",
            },
            {
              id: "step-2",
              stepIndex: 1,
              kind: "edge_block",
              hostId: "host-2",
              lastAction: "Edge block",
              error: null,
              costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
              artifactIds: [],
              createdAt: "2026-10-05T12:05:00.000Z",
            },
          ]}
          threads={[]}
          drafts={[]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "overview") {
    const status: LbProjectStatusView = {
      projectId: "demo",
      projectStatus: "active",
      activity: "out_of_window",
      activityLabel: "out of window",
      run: {
        id: "run-1",
        date: "2026-10-05",
        status: "partial",
        newToday: 1,
        liveToday: 1,
        liveWeek: 1,
        uniqueHosts: 2,
        lastAction: "Day closed",
        lastError: null,
      },
      whyNot: {
        supply: { qualified: 3, ready: 0 },
        parked: 1,
        spamBlocked: 1,
        unsupportedCaptcha: 0,
        pendingEmail: 2,
        pendingAdmin: 0,
        modelErrors: 0,
        modelRefusals: 0,
        captchaBalance: 120,
        proxy: "ok",
        reasons: ["host_supply_exhausted", "pending_email", "operator_parked", "spam_filtered"],
      },
      operatorQueue: 1,
      scheduleActive: false,
      scheduleReason: "after_window",
      newPerDay: 2,
      livePerDay: 2,
      liveWeekCap: 8,
      lastEvent: "Paused, Captell balance is low",
      costs: {
        day: { captellCredits: 12, modelTokens: 40, searchQueries: 1, proxyLeaseDays: 1 },
        week: { captellCredits: 28, modelTokens: 90, searchQueries: 4, proxyLeaseDays: 2 },
      },
    };
    return (
      <div className="min-h-screen bg-[#050506]">
        <ProjectView
          project={{ name: "Nordlicht", disclosureMode: "undisclosed_persona" } as LbProjectDetail}
          status={status}
          hosts={[]}
          placements={[]}
          steps={[]}
          threads={[]}
          drafts={[]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "tasks") {
    const longPost = Array.from({ length: 12 }, () =>
      "Durch das Registrieren auf diesem Board erklärst du dich mit den Nutzungsbedingungen einverstanden. Bitte lies den gesamten Text, bevor du fortfährst.",
    ).join(" ");
    const hosts = [
      ["frauenselbsthilfe.de", "pending_email"],
      ["krank.de", "dead"],
      ["lifters-lounge.com", "dead"],
      ["medizin-forum.de", "warming"],
      ["phpbb.de", "qualified"],
      ["xendach.de", "qualified"],
    ] as const;
    return (
      <div className="h-dvh bg-[#050506]">
        <ProjectView
          project={{ name: "Vitaminexpress", slug: "vitaminexpress" } as LbProjectDetail}
          status={null}
          hosts={hosts.map(([domain, status], index) => ({
            id: `host-${index}`,
            registrableDomain: domain,
            status,
          })) as unknown as LbHostView[]}
          placements={[]}
          steps={Array.from({ length: 18 }, (_, index) => ({
            id: `step-${index}`,
            stepIndex: index,
            kind: "register",
            hostId: null,
            lastAction:
              index === 17
                ? "Opened registration on phpbb.de"
                : `Checked board ${index + 1} before the long post`,
            error: null,
            costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
            artifactIds: [],
            createdAt: "2026-10-09T18:00:00.000Z",
          }))}
          threads={[
            {
              id: "thread-1",
              domain: "phpbb.de",
              title: "Vitamin D im Winter",
            } as LbThreadView,
          ]}
          drafts={[
            {
              id: "draft-1",
              threadCandidateId: "thread-1",
              body: longPost,
              status: "drafted",
              linkSlot: "none",
              modelLane: "draft",
              modelId: "preview",
              targetUrl: null,
              anchorText: null,
              confidence: null,
              qualityChecks: {},
            } as unknown as LbDraftView,
          ]}
          tickets={[]}
          surface="dashboard"
          onSurface={() => undefined}
          onStart={() => undefined}
          onPause={() => undefined}
          onStop={() => undefined}
          busy={false}
        />
      </div>
    );
  }
  if (current === "operator") {
    return (
      <div className="min-h-screen bg-[#050506]">
        <OperatorView
          ticket={ticket}
          note=""
          busy={false}
          done={null}
          onNote={() => undefined}
          onContinue={() => undefined}
          onSkip={() => undefined}
          now={PREVIEW_NOW}
        />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-[#050506]">
      <DashboardView
        cards={[card, vitaminexpressCard]}
        loading={false}
        onOpen={(item) => setCurrent(item.slug === "vitaminexpress" ? "computer" : "overview")}
        onNew={() => setCurrent("wizard")}
      />
    </div>
  );
}

function VitaminexpressComputer({ onProjects }: { onProjects: () => void }) {
  const [surface, setSurface] = useState<"dashboard" | "details" | "settings">("dashboard");
  const status: LbProjectStatusView = {
    projectId: "vitaminexpress",
    projectStatus: "active",
    activity: "running",
    activityLabel: "running",
    run: {
      id: "run-vx",
      date: "2026-10-06",
      status: "running",
      newToday: 0,
      liveToday: 0,
      liveWeek: 0,
      uniqueHosts: 0,
      lastAction: "Opened Google search",
      lastError: null,
    },
    whyNot: {
      supply: { qualified: 0, ready: 0 },
      parked: 0,
      spamBlocked: 0,
      unsupportedCaptcha: 0,
      pendingEmail: 0,
      pendingAdmin: 0,
      modelErrors: 0,
      modelRefusals: 0,
      captchaBalance: 0,
      proxy: "ok",
      reasons: [],
    },
    operatorQueue: 0,
    scheduleActive: true,
    scheduleReason: "in_window",
    newPerDay: 2,
    livePerDay: 1,
    liveWeekCap: 8,
    lastEvent: "Checking Google for on-topic forums",
    costs: {
      day: { captellCredits: 0, modelTokens: 0, searchQueries: 1, proxyLeaseDays: 0 },
      week: { captellCredits: 0, modelTokens: 0, searchQueries: 1, proxyLeaseDays: 0 },
    },
  };
  return (
    <div className="min-h-screen bg-[#050506]">
      {surface === "dashboard" ? (
        <div className="mx-auto flex w-full max-w-[1400px] px-4 pt-4">
          <button
            type="button"
            aria-label="Projects"
            className="text-[13px] text-[#A6A6AD]"
            onClick={onProjects}
          >
            Projects
          </button>
        </div>
      ) : null}
      <ProjectView
        project={vitaminexpressProject}
        status={status}
        hosts={[]}
        placements={[]}
        steps={[
          {
            id: "step-check",
            stepIndex: 0,
            kind: "research",
            hostId: null,
            lastAction: "Checking Google for on-topic forums",
            error: null,
            costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
            artifactIds: [],
            createdAt: "2026-10-06T12:00:00.000Z",
          },
          {
            id: "step-look",
            stepIndex: 1,
            kind: "research",
            hostId: null,
            lastAction: "Looking for threads",
            error: null,
            costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
            artifactIds: [],
            createdAt: "2026-10-06T12:00:20.000Z",
          },
          {
            id: "step-open",
            stepIndex: 2,
            kind: "research",
            hostId: null,
            lastAction: "Opened Google search",
            error: null,
            costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
            artifactIds: [],
            createdAt: "2026-10-06T12:01:00.000Z",
          },
        ]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface={surface}
        onSurface={setSurface}
        onStart={() => undefined}
        onPause={() => undefined}
        onStop={() => undefined}
        busy={false}
      />
    </div>
  );
}
