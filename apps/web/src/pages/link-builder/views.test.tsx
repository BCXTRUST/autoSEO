import type {
  LbDraftView,
  LbHostView,
  LbOperatorTicketView,
  LbPlacementView,
  LbProjectDetail,
  LbProjectStatusView,
  LbRunStepView,
  LbWhyNot,
} from "@rakazo/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyDraft, emptyPage, PAGE_BOX_LIMIT } from "./model.js";
import { LinkBuilderPreview } from "./preview.js";
import {
  CreditPackagesView,
  DashboardView,
  matchesTaskQuery,
  OperatorView,
  ProjectView,
  WizardView,
  watchingFrameSrc,
} from "./views.js";

const noop = () => undefined;
const loadArtifact = async () => "data:image/png;base64,iVBO";

function step(index: number, kind: string, artifactIds: string[]): LbRunStepView {
  return {
    id: `step-${index}`,
    stepIndex: index,
    kind,
    hostId: "host-1",
    lastAction: kind,
    error: null,
    costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
    artifactIds,
    createdAt: "2026-10-05T12:00:00.000Z",
  };
}

describe("link builder screens", () => {
  it("shows proxy leases without credentials and names coherence and edge blocks", () => {
    const settings = renderToStaticMarkup(<LinkBuilderPreview screen="settings" />);
    expect(settings).toContain("static isp per persona");
    expect(settings).toContain("DE");
    expect(settings).toContain("static isp");
    expect(settings).toContain("iproyal");
    expect(settings).toContain('aria-label="Proxy leases"');
    expect(settings).toContain('aria-label="Settings"');
    expect(settings).toContain('aria-label="Page 1"');
    expect(settings).toContain('aria-label="Save settings"');
    expect(settings).toContain("New accounts per day");
    expect(settings).toContain('aria-label="Name on forums"');
    expect(settings).toContain('aria-label="Window start"');
    expect(settings).not.toContain("password");
    expect(settings).not.toContain("secret");
    expect(settings).not.toContain('role="tablist"');
    const runs = renderToStaticMarkup(<LinkBuilderPreview screen="runs" />);
    expect(runs).toContain("Coherence refused");
    expect(runs).toContain("Edge block");
    expect(runs).not.toContain('role="tablist"');
  });

  it("shows NEW and LIVE rings and hides a view-only operator count", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="dashboard" />);
    expect(html).toContain("Posting 1 of 2 links today");
    expect(html).toContain("Posting 0 of 1 links today");
    expect(html).not.toContain("New accounts per day");
    expect(html).not.toContain("Live links per day");
    expect(html).not.toContain("Live links per week");
    expect(html).not.toContain("needs operator");
    expect(html).toContain("Posting");
    expect(html).not.toContain("running");
    expect(html).not.toContain("Discovered");
    expect(html).not.toContain("Qualified");
    expect(html).not.toContain("Warming");
    expect(html).not.toContain("Parked");
  });

  it("names the site and runs the action when the user can help without the desktop", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        cards={[
          {
            id: "demo",
            name: "Nordlicht",
            slug: "nordlicht-wellness",
            status: "active",
            brandName: "Nordlicht",
            activity: "running",
            activityLabel: "needs operator ×4",
            newToday: 0,
            liveToday: 0,
            liveWeek: 0,
            newPerDay: 2,
            livePerDay: 2,
            liveWeekCap: 8,
            runStatus: "running",
            lastEvent: null,
            operatorQueue: 0,
            operatorHelp: {
              ticketId: "ticket-1",
              domain: "board.example",
              label: "Skip board.example",
              action: "skip",
            },
          },
        ]}
        loading={false}
        onOpen={noop}
        onNew={noop}
        onHelp={noop}
      />,
    );
    expect(html).toContain("Skip board.example");
    expect(html).toContain('aria-label="Skip board.example"');
    expect(html).not.toContain("needs operator");
  });

  it("puts the responsibility sentence under Start and does not render a checkbox", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="review" />);
    expect(html).toContain("Start");
    expect(html).toContain("responsible for this content");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Writes as the persona");
    expect(html).toContain("Live links per day");
    expect(html).not.toContain("New accounts per day");
    expect(html).not.toContain("inbox.example");
    expect(html).not.toContain("proxy.example");
    expect(html).not.toContain("New / day");
    expect(html).not.toContain("Week cap");
  });

  it("offers continue and skip on the operator ticket", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="operator" />);
    expect(html).toContain("I fixed it, continue");
    expect(html).toContain("Skip host");
    expect(html).toContain("Live screen");
    expect(html).toContain("fragen.nordlicht.example");
  });

  it("shows the latest step screenshot on the dashboard computer", () => {
    const html = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Nordlicht" } as LbProjectDetail}
        status={null}
        hosts={[]}
        placements={[]}
        steps={[
          step(0, "select_host", []),
          step(1, "open_session", ["a1"]),
          step(2, "post", ["a2"]),
        ]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        loadArtifact={loadArtifact}
        busy={false}
      />,
    );
    expect(html).toContain('data-frame="artifact"');
    expect(html).toContain('aria-label="Computer"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain(">Runs<");
  });

  it("embeds the team computer stream in the main pane", () => {
    const stream = "https://app.autoseo.run/novnc/remote/view/9.abc/vnc.html";
    const html = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Vitaminexpress", slug: "vitaminexpress" } as LbProjectDetail}
        status={null}
        hosts={[]}
        placements={[]}
        steps={[]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        busy={false}
        screenUrl={stream}
      />,
    );
    expect(html).toContain('data-frame="url"');
    expect(html).toContain(`src="${watchingFrameSrc(stream).replaceAll("&", "&amp;")}"`);
    expect(watchingFrameSrc(stream)).toContain("autoconnect=true");
    expect(watchingFrameSrc(stream)).toContain("reconnect=true");
    expect(watchingFrameSrc(stream)).toContain("path=novnc%2Fremote%2Fview%2F9.abc%2Fwebsockify");
    expect(html).toContain('title="Computer"');
    expect(html).toContain('data-desktop="browser"');
    expect(html).not.toContain('data-desktop="hidden"');
    expect(html).toContain("allow-scripts allow-same-origin");
    expect(html).not.toContain("No session");
    const failed = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Vitaminexpress", slug: "vitaminexpress" } as LbProjectDetail}
        status={null}
        hosts={[]}
        placements={[]}
        steps={[]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        busy={false}
        screenError="Failed to connect to server"
      />,
    );
    expect(failed).toContain("Failed to connect to server");
    expect(failed).not.toContain("<iframe");
    expect(failed).not.toContain("No session");
  });

  it("shows the parked screenshot on an operator ticket without a live screen", () => {
    const ticket = {
      id: "ticket-1",
      projectId: "demo",
      hostId: "host-1",
      domain: "fragen.nordlicht.example",
      runId: "run-1",
      reason: "captcha_unsolved",
      screenUrl: null,
      screenshotArtifactId: "shot-1",
      note: null,
      status: "open",
      expiresAt: "2026-10-05T18:00:00.000Z",
      createdAt: "2026-10-05T12:00:00.000Z",
    } satisfies LbOperatorTicketView;
    const props = {
      ticket,
      note: "",
      busy: false,
      done: null,
      onNote: noop,
      onContinue: noop,
      onSkip: noop,
    };
    const html = renderToStaticMarkup(<OperatorView {...props} loadArtifact={loadArtifact} />);
    expect(html).toContain("Screenshot");
    expect(html).not.toContain('aria-label="Live screen"');
    expect(renderToStaticMarkup(<OperatorView {...props} />)).toContain('aria-label="Live screen"');
  });

  it("does not ask the customer to solve a captcha", () => {
    const html = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Vitaminexpress" } as LbProjectDetail}
        status={null}
        hosts={[]}
        placements={[]}
        steps={[]}
        threads={[]}
        drafts={[]}
        tickets={[
          {
            id: "ticket-1",
            projectId: "demo",
            hostId: "host-1",
            domain: "fragen-1ej2xe.example",
            runId: "run-1",
            reason: "captcha_unsolved",
            screenUrl: null,
            screenshotArtifactId: null,
            note: null,
            status: "open",
            expiresAt: null,
            createdAt: "2026-10-05T12:00:00.000Z",
          },
          {
            id: "ticket-2",
            projectId: "demo",
            hostId: "host-2",
            domain: "board.example.org",
            runId: "run-1",
            reason: "missing_password",
            screenUrl: null,
            screenshotArtifactId: null,
            note: null,
            status: "open",
            expiresAt: null,
            createdAt: "2026-10-05T12:00:00.000Z",
          },
        ]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        busy={false}
      />,
    );
    expect(html).not.toContain("fragen-1ej2xe.example");
    expect(html).not.toContain("I've solved it");
    expect(html).toContain("Stuck. board.example.org needs a password.");
    expect(html).toContain("I fixed it, continue");
    expect(html).not.toContain("Open computer");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain(">Captchas<");
  });

  it("shows the forums and links the bot picked, and hides fixture boards", () => {
    const html = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Vitaminexpress", slug: "vitaminexpress" } as LbProjectDetail}
        status={null}
        hosts={
          [
            { id: "host-1", registrableDomain: "fragen-1ej2xe.example", status: "qualified" },
            {
              id: "host-2",
              registrableDomain: "rueckenforum.de",
              homepageUrl: "https://rueckenforum.de",
              status: "qualified",
            },
          ] as LbHostView[]
        }
        placements={
          [
            { id: "place-1", domain: "brett-1ej2xe.example", status: "live", rel: [] },
            { id: "place-2", domain: "board.example.org", status: "live", rel: [] },
          ] as LbPlacementView[]
        }
        steps={[]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="details"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        busy={false}
      />,
    );
    expect(html).toContain('aria-label="Forums"');
    expect(html).toContain("rueckenforum.de");
    expect(html).toContain('href="https://rueckenforum.de/"');
    expect(html).toContain("underline");
    expect(html).not.toContain("qualified");
    expect(html).not.toContain("Discovered");
    expect(html).not.toContain("Warming");
    expect(html).not.toContain("Parked");
    expect(html).toContain('aria-label="Links placed"');
    expect(html).toContain("board.example.org");
    expect(html).not.toContain("fragen-");
    expect(html).not.toContain("brett-");
    expect(html).not.toContain(">Hosts<");
    expect(html).not.toContain(">Placements<");
    expect(html).toContain('aria-label="Details"');
  });

  it("matches a task filter on host, status, and task text", () => {
    expect(matchesTaskQuery("", ["krank.de", "dead"])).toBe(true);
    expect(matchesTaskQuery("  krank.de ", ["krank.de", "dead"])).toBe(true);
    expect(matchesTaskQuery("KRANK", ["lifters-lounge.com", "dead"])).toBe(false);
    expect(matchesTaskQuery("pending email", ["frauenselbsthilfe.de", "pending_email"])).toBe(true);
    expect(matchesTaskQuery("Registrieren", ["Registrieren on phpbb.de", "done"])).toBe(true);
    expect(matchesTaskQuery("dead", ["medizin-forum.de", "warming"])).toBe(false);
  });

  it("does not open a captcha handoff on the dashboard", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="captchas" />);
    expect(html).not.toContain("placed_submitted");
    expect(html).not.toContain("Sandbox answer");
    expect(html).not.toContain(">Captchas<");
    expect(html).toContain('aria-label="Change schedule"');
  });

  it("gives each page its own box and stops the plus at 10", () => {
    const draft = emptyDraft();
    draft.allowedDomains = "nordlicht.example";
    const one = renderToStaticMarkup(
      <WizardView
        step={3}
        draft={draft}
        issues={[]}
        busy={false}
        started={false}
        onChange={noop}
        onBack={noop}
        onNext={noop}
        onStart={noop}
        onGoTo={noop}
      />,
    );
    expect(one).toContain("Keyword");
    expect(one).toContain("Rules");
    expect(one).toContain('aria-label="Page 1"');
    expect(one).toContain('aria-label="Add a page"');
    expect(one).not.toContain("Remove page");
    expect(one).not.toContain("Topic to write about");
    const full = {
      ...draft,
      pages: Array.from({ length: PAGE_BOX_LIMIT }, (_, index) => ({
        ...emptyPage(),
        id: `page-${index}`,
        url: index === 0 ? "https://nordlicht.example/schlaf" : "",
      })),
    };
    const ten = renderToStaticMarkup(
      <WizardView
        step={3}
        draft={full}
        issues={[]}
        busy={false}
        started={false}
        onChange={noop}
        onBack={noop}
        onNext={noop}
        onStart={noop}
        onGoTo={noop}
      />,
    );
    expect(ten).toContain('aria-label="Add a page" disabled');
    expect(ten).toContain('aria-label="Remove page 2"');
    expect(ten).not.toContain("Topic to write about");
  });

  it("renders the brand step", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="wizard" />);
    expect(html).toContain("Brand");
    expect(html).toContain("Who writes");
    expect(html).toContain("How many links");
    expect(html).toContain("Which pages");
    expect(html).toContain("Start");
    expect(html).not.toContain("Persona &amp; inbox");
    expect(html).not.toContain("Quotas &amp; schedule");
    expect(html).not.toContain("Policy");
    expect(html).not.toContain("Countries to post in");
    expect(html).not.toContain("Forums to skip");
    expect(html).not.toContain("How posts identify you");
    expect(html).toContain("nordlicht.example");
    expect(html).toContain('aria-label="Setup steps"');
    expect(html).toContain("Step 1 of 5");
    expect(html).not.toContain("M20 6 9 17 4 12");
    expect(emptyDraft().disclosureMode).toBe("undisclosed_persona");
  });

  it("marks earlier steps done beside the review form", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="review" />);
    expect(html.split("M20 6 9 17 4 12").length - 1).toBe(4);
    expect(html).not.toContain("Policy");
    expect(html).not.toContain("Captell token");
    expect(html).not.toContain("Check balance");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Step 5 of 5: Start");
  });

  it("shows the computer working and a growing feed instead of NEW/LIVE rings", () => {
    const discovered = step(0, "research", []);
    discovered.lastAction = "Opened Google search";
    const probed = step(1, "research", ["shot-1"]);
    probed.lastAction = "Opening Vitamin D im Winter?";
    const html = renderOverview(statusView({ activity: "running", activityLabel: "running" }), [
      discovered,
      probed,
    ]);
    expect(html).toContain("All time");
    expect(html).toContain("Today");
    expect(html).not.toContain("Links that count");
    expect(html).not.toContain("New accounts per day");
    expect(html).not.toContain("Live links today");
    expect(html).toContain(">0/1</span>");
    expect(html).not.toContain("New links today");
    expect(html).not.toContain("NEW ");
    expect(html).not.toContain("LIVE ");
    expect(html).toContain('aria-label="Computer"');
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('data-live-status="strip"');
    expect(html).toContain("Opening Vitamin D im Winter?");
    expect(html).not.toContain("top-3 right-3");
    expect(html).not.toContain("bottom-4 left-4");
    expect(html).not.toContain("1 link left today");
    expect(html).toContain('aria-label="Stage"');
    expect(html).toContain("Register");
    expect(html).toContain("Warmup");
    expect(html).toContain("Place");
    expect(html).toContain("Verify");
    expect(html).toContain('data-status="working"');
    expect(html).toContain('data-frame="artifact"');
    expect(html).not.toContain("forum-a.example");
    expect(html).not.toContain("Checking Google for on-topic forums");
    expect(html).not.toContain("Looking for threads");
    expect(html).not.toContain("Continuing");
    const log = html.slice(html.indexOf('data-pixel="log"'));
    expect(log.indexOf("Opening Vitamin D im Winter?")).toBeLessThan(
      log.indexOf("Opened Google search"),
    );
    expect(html).not.toContain("Why not");
    expect(html).not.toContain("Proxy ok");
    expect(html).not.toContain("Supply");
    expect(html).not.toContain("Live screen");
    expect(html).not.toContain("12 tokens");
  });

  it("shows the live forum posts in the done card", () => {
    const html = renderToStaticMarkup(
      <ProjectView
        project={{ name: "Vitaminexpress", slug: "vitaminexpress" } as LbProjectDetail}
        status={statusView()}
        hosts={[]}
        placements={
          [
            {
              id: "place-live",
              domain: "board.example.org",
              postUrl: "https://board.example.org/thread-9.html",
              threadUrl: "https://board.example.org/forum-2.html",
              status: "live",
              counted: true,
              rel: [],
            },
            {
              id: "place-fixture",
              domain: "brett-1ej2xe.example",
              postUrl: "https://brett-1ej2xe.example/t/1",
              threadUrl: "",
              status: "live",
              counted: true,
              rel: [],
            },
          ] as LbPlacementView[]
        }
        steps={[]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        loadArtifact={loadArtifact}
        busy={false}
      />,
    );
    expect(html).toContain('aria-label="Live links"');
    expect(html).toContain("https://board.example.org/thread-9.html");
    expect(html).toContain("board.example.org/thread-9.html");
    expect(html).not.toContain("brett-1ej2xe.example");
    expect(html).toContain(">0/1</span>");
  });

  it("describes the open desktop page instead of a finished reply", () => {
    const posted = step(0, "place", []);
    posted.lastAction = "Posted the reply";
    const base = statusView();
    const status = statusView({
      activity: "running",
      activityLabel: "running",
      lastEvent: "Posted the reply",
      run: {
        ...base.run!,
        lastAction: "Posted the reply",
        currentUrl: "https://www.nickles.de/consent.html",
      },
    });
    const stream = "https://app.autoseo.run/novnc/remote/view/9.abc/vnc.html";
    const html = renderOverview(status, [posted], [], stream);
    const strip = html.indexOf('data-live-status="strip"');
    const chip = html.slice(strip, strip + 400);
    expect(strip).toBeGreaterThan(-1);
    expect(chip).toContain("On nickles.de consent");
    expect(html).not.toContain('data-live-status="corner"');
    expect(html).not.toContain("top-3 right-3");
    expect(chip).not.toContain("Posted the reply");
    expect(html).not.toContain("bottom-4 left-4");
    expect(html).not.toContain('aria-label="Filter tasks"');
    const closed = renderOverview(status, [posted]);
    expect(closed).toContain("Posted the reply");
    expect(closed).not.toContain("On nickles.de consent");
  });

  it("shows the stage rail and the current action when no screen exists", () => {
    const reading = step(0, "research", []);
    reading.lastAction = "Opened Google search";
    const html = renderOverview(
      statusView({
        activity: "running",
        activityLabel: "running",
        lastEvent: "Opened Google search",
        run: {
          id: "run-1",
          date: "2026-10-06",
          status: "running",
          newToday: 0,
          liveToday: 0,
          liveWeek: 0,
          uniqueHosts: 0,
          lastAction: "Opened Google search",
          lastError: null,
        },
      }),
      [reading],
    );
    expect(html).toContain('data-frame="pending"');
    expect(html).toContain('data-stage="research"');
    expect(html).toContain('aria-label="Stage"');
    expect(html).toContain("Research");
    expect(html).toContain("Register");
    expect(html).toContain("Warmup");
    expect(html).toContain("Place");
    expect(html).toContain("Verify");
    expect(html).toContain('aria-label="Opened Google search"');
    expect(html).not.toContain("Checking Google for on-topic forums");
    expect(html.indexOf('data-live-status="strip"')).toBeLessThan(
      html.indexOf('aria-label="Opened Google search"'),
    );
    expect(html).toContain("Reconnecting");
    expect(html).not.toContain("Connecting the computer");
    expect(html).not.toContain("No session");
    expect(html).not.toContain("Failed to connect to server");
    expect(html).toContain('data-session="closed"');
    expect(html).toContain('data-pixel="trail"');
    expect(html).toContain('aria-label="Change schedule"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain(">Overview<");
    expect(html).not.toContain(">Targets<");
    expect(html).not.toContain(">Hosts<");
    expect(html).not.toContain(">Threads<");
    expect(html).not.toContain(">Placements<");
    expect(html).not.toContain(">Runs<");
    expect(html).not.toContain(">Captchas<");
    expect(html).not.toContain("I've solved it");
    expect(html).not.toContain("28px 28px");
  });

  it("shows a skipped forum on the dark pane while the project is active", () => {
    const run = {
      id: "run-1",
      date: "2026-10-16",
      status: "running" as const,
      newToday: 0,
      liveToday: 0,
      liveWeek: 0,
      uniqueHosts: 0,
      lastAction: "Skipped 2 denied forums",
      lastError: null,
    };
    const active = renderOverview(
      statusView({
        projectStatus: "active",
        activity: "running",
        activityLabel: "running",
        run,
      }),
      [],
    );
    expect(active).toContain("Skipped 2 denied forums");
    expect(active).not.toContain("Browser idle");
    const paused = renderOverview(
      statusView({
        projectStatus: "paused",
        activity: "paused",
        activityLabel: "paused",
        run,
      }),
      [],
    );
    expect(paused).toContain("Browser idle");
    expect(paused).not.toContain("Skipped 2 denied forums");
  });

  it("says the computer is off when nothing is running", () => {
    const html = renderOverview(
      statusView({ activity: "paused", activityLabel: "paused", run: null }),
      [],
    );
    expect(html).toContain("Browser idle");
    expect(html).not.toContain("Browser idle. It turns on when a post is being made.");
    expect(html).not.toContain("Failed to connect to server");
    expect(html).not.toContain("Connecting the computer");
  });

  it("distinguishes background research from a failed browser", () => {
    const run = {
      id: "run-1",
      date: "2026-10-16",
      status: "running" as const,
      newToday: 0,
      liveToday: 0,
      liveWeek: 0,
      uniqueHosts: 0,
      lastAction: "Researching with search service",
      lastError: null,
    };
    const research = renderOverview(
      statusView({ projectStatus: "active", run }),
      [],
      [],
      null,
      [],
      [],
      "off",
    );
    expect(research).toContain("Researching — no browser needed");
    expect(research).toContain("Campaign activity");
    expect(research).toContain("Live browser");
    const failure = renderOverview(
      statusView({
        projectStatus: "active",
        run: {
          ...run,
          lastAction: "Browser search failed: Sandbox is probably not running anymore",
        },
      }),
      [],
      [],
      null,
      [],
      [],
      "off",
    );
    expect(failure).toContain("Browser unavailable");
    expect(failure).not.toContain("Researching — no browser needed");
  });

  it("renders the computer from server screen state", () => {
    const stream = "https://app.autoseo.run/novnc/remote/view/9.abc/vnc.html";
    const states = [
      ["off", "Browser idle"],
      ["starting", "Starting"],
      ["no_browser", "Opening the browser"],
    ] as const;
    for (const [state, label] of states) {
      const html = renderOverview(statusView(), [], [], stream, [], [], state);
      expect(html).not.toContain("<iframe");
      expect(html).toContain('data-desktop="hidden"');
      expect(html).toContain('data-live-pane="dark"');
      expect(html).toContain(label);
    }
    const live = renderOverview(statusView(), [], [], stream, [], [], "live");
    expect(live).toContain("<iframe");
    expect(live).toContain('title="Computer"');
    expect(live).toContain('data-desktop="browser"');
    expect(live).not.toContain('data-desktop="hidden"');
    const liveWithoutUrl = renderOverview(statusView(), [], [], null, [], [], "live");
    expect(liveWithoutUrl).not.toContain("<iframe");
  });

  it("stays on research when Verify has no placement, and still shows a frame", () => {
    const reading = step(0, "research", []);
    reading.lastAction = "Opened Google search";
    const verify = step(1, "lb_verify", ["shot-9"]);
    verify.lastAction = "Verify";
    const html = renderOverview(
      statusView({
        activity: "running",
        activityLabel: "running",
        lastEvent: "Opened Google search",
        run: {
          id: "run-1",
          date: "2026-10-06",
          status: "running",
          newToday: 0,
          liveToday: 0,
          liveWeek: 0,
          uniqueHosts: 0,
          lastAction: "Opened Google search",
          lastError: null,
        },
      }),
      [reading, verify],
    );
    expect(html).toContain('data-stage="research"');
    expect(html).toContain('data-frame="artifact"');
    const workingAt = html.indexOf('data-status="working"');
    const row = html.slice(workingAt, workingAt + 2500);
    expect(row).toContain("Opened Google search");
    expect(html).not.toContain("Continuing");
    expect(row).not.toContain("Verify");
    expect(html).not.toContain("I've solved it");
    expect(html).not.toContain("fragen-");
    expect(html).toContain("All time");
    expect(html).toContain("Today");
    expect(html).not.toContain("Links that count");
    expect(html).not.toContain("New accounts per day");
    expect(html).not.toContain("Live links today");
  });

  it("shows the counted German problem search and keeps Verify off the working row", () => {
    const checking = step(0, "research", []);
    checking.lastAction = "Checking Google for on-topic forums";
    const looking = step(1, "research", []);
    looking.lastAction = "Looking for threads";
    const continuing = step(2, "research", []);
    continuing.lastAction = "Continuing";
    const opened = step(3, "research", []);
    opened.lastAction = "Opened Google search";
    const html = renderToStaticMarkup(
      <ProjectView
        project={
          {
            name: "Vitaminexpress",
            brandName: "Vitaminexpress",
            slug: "vitaminexpress",
            topicLanes: [{ tag: "Magnesium kaufen" }],
            targets: [
              {
                url: "https://www.vitaminexpress.org/de/magnesium",
                keywordClusters: ["magnesium kaufen"],
              },
            ],
          } as LbProjectDetail
        }
        status={statusView({
          activity: "running",
          activityLabel: "running",
          lastEvent: "Opened Google search",
          run: {
            id: "run-1",
            date: "2026-10-06",
            status: "running",
            newToday: 0,
            liveToday: 0,
            liveWeek: 0,
            uniqueHosts: 0,
            lastAction: "Opened Google search",
            lastError: null,
          },
        })}
        hosts={[]}
        placements={[]}
        steps={[checking, looking, continuing, opened]}
        threads={[]}
        drafts={[]}
        tickets={[]}
        surface="dashboard"
        onSurface={noop}
        onStart={noop}
        onPause={noop}
        onStop={noop}
        busy={false}
      />,
    );
    expect(html).toContain("Searched Google.de for Magnesium Krämpfe Forum");
    expect(html).not.toContain("Opened Google search");
    expect(html).not.toContain("Checking Google for on-topic forums");
    expect(html).not.toContain("Looking for threads");
    expect(html).not.toContain("Continuing");
    expect(html).not.toContain("kaufen");
    expect(html).toContain('data-stage="research"');
    const workingAt = html.indexOf('data-status="working"');
    const nextStatus = html.indexOf("data-status=", workingAt + 12);
    const row = html.slice(workingAt, nextStatus === -1 ? undefined : nextStatus);
    expect(row).toContain("Searched ");
    expect(row).toContain('href="https://google.de/"');
    expect(row).toContain("Google.de");
    expect(row).toContain("for Magnesium Krämpfe Forum");
    expect(row).not.toContain("Verify");
    expect(html).not.toContain('data-status="done"');
  });

  it("hides a fixture draft on a customer project", () => {
    const html = renderOverview(
      statusView({ activity: "running", activityLabel: "running" }),
      [],
      [
        {
          id: "draft-1",
          threadCandidateId: "thread-1",
          body: "Eine feste Uhrzeit hilft oft. Das hier erklärt es ganz gut.",
          status: "posted",
          linkSlot: "inline",
          modelLane: "draft",
          modelId: "fake-draft",
          targetUrl: null,
          anchorText: null,
          confidence: null,
          qualityChecks: {
            factsOnly: true,
            noBannedClaims: true,
            registerMatches: true,
            lengthOk: true,
            singleLink: true,
            notTestimonial: true,
            issues: [],
          },
        },
      ],
    );
    expect(html).not.toContain("feste Uhrzeit");
    expect(html).not.toContain("nordlicht.example");
  });

  it("keeps a calm computer when the run is paused and hides an all-zero why-not list", () => {
    const html = renderOverview(
      statusView({
        activity: "paused",
        activityLabel: "paused",
        lastEvent: "Looking for threads",
      }),
      [],
    );
    expect(html).not.toContain("bui-pixel-on");
    expect(html).toContain('aria-label="Computer"');
    expect(html).not.toContain("Looking for threads");
    expect(html).not.toContain("Checking Google for on-topic forums");
    expect(html).not.toContain(">Continuing<");
    expect(html).toContain("No events yet");
    expect(html).not.toContain(".example");
    expect(html).toContain("All time");
    expect(html).toContain("Today");
    expect(html).not.toContain("Links that count");
    expect(html).not.toContain("New links today");
    expect(html).not.toContain("Why not");
    expect(html).not.toContain("Parked 0");
    expect(html).not.toContain("Proxy ok");
  });

  it("puts real blockers in the feed after the computer", () => {
    const html = renderToStaticMarkup(<LinkBuilderPreview screen="overview" />);
    expect(html).toContain("All time");
    expect(html).toContain("Today");
    expect(html).not.toContain("Links that count");
    expect(html).not.toContain("New accounts per day");
    expect(html).not.toContain("Live links today");
    expect(html).not.toContain("New links today");
    expect(html).toContain("Skipped 1 site. Needs a person.");
    expect(html).not.toContain("2 accounts waiting for email.");
    expect(html).toContain("Skipped 1 site. Marked as spam.");
    expect(html).not.toContain("Why not");
    expect(html).not.toContain("Proxy ok");
    expect(html).not.toContain("Unsupported captcha 0");
    const computer = html.indexOf('aria-label="Computer"');
    expect(html.indexOf("Skipped 1 site. Needs a person.", computer)).toBeGreaterThan(computer);
    expect(html).not.toContain("40 tokens");
  });

  it("keeps a long post off the dashboard and puts the counts on top", () => {
    const post = step(0, "place", []);
    post.lastAction =
      "die Muskelfunktion, und ein Mangel kann sich unter anderem durch Muskelkrämpfe bemerkbar machen. Schätzungen gehen davon aus, dass bis zu 75 Prozent der Bevölkerung an einem Magnesiummangel leiden.";
    const html = renderOverview(statusView({ activity: "running", activityLabel: "running" }), [
      post,
    ]);
    expect(html).not.toContain("Muskelkrämpfe");
    expect(html).toContain(">0</span> registered");
    expect(html).toContain(">0</span> posted");
    expect(html).toContain(">0</span> skipped");
    expect(html).not.toContain("Filter");
    expect(html).not.toContain("waiting for an admin. Expected");
  });

  it("keeps named admin waits off the dashboard", () => {
    const html = renderOverview(
      statusView(),
      [],
      [],
      null,
      [],
      [
        { id: "h1", registrableDomain: "bulli-forum.com", status: "pending_admin" } as LbHostView,
        {
          id: "h2",
          registrableDomain: "frauenselbsthilfe.de",
          status: "pending_email",
        } as LbHostView,
        { id: "h3", registrableDomain: "macuser.de", status: "pending_admin" } as LbHostView,
      ],
    );
    expect(html).not.toContain("waiting for the site admin");
    expect(html).not.toContain("waiting for the confirmation email");
    expect(html).not.toContain("We check again later");
    expect(html).toContain(">3</span> registered");
  });

  it("shows credit packages with prices before a project exists", () => {
    const html = renderToStaticMarkup(
      <CreditPackagesView
        packages={[
          {
            id: "starter",
            name: "Starter",
            credits: 200,
            priceCents: 2900,
            currency: "eur",
            recommended: false,
          },
          {
            id: "growth",
            name: "Growth",
            credits: 1000,
            priceCents: 9900,
            currency: "eur",
            recommended: true,
          },
        ]}
        balance={80}
        reason="Checkout is not connected. No card was charged and credits were not added."
        busy={false}
        onBuy={() => undefined}
      />,
    );
    expect(html).toContain("€29");
    expect(html).toContain("€99");
    expect(html).toContain("200 credits");
    expect(html).toContain("1,000 credits");
    expect(html).toContain('aria-label="Buy Starter"');
    expect(html).toContain('aria-label="Buy Growth"');
    expect(html).toContain('aria-label="Setup"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Checkout is not connected");
    expect(html).not.toContain("Brand &amp; domains");
  });
});

const zeroWhy: LbWhyNot = {
  supply: { qualified: 0, ready: 0 },
  parked: 0,
  spamBlocked: 0,
  unsupportedCaptcha: 0,
  pendingEmail: 0,
  pendingAdmin: 0,
  modelErrors: 0,
  modelRefusals: 0,
  captchaBalance: null,
  proxy: "ok",
  reasons: ["host_supply_exhausted"],
};

function statusView(overrides: Partial<LbProjectStatusView> = {}): LbProjectStatusView {
  return {
    projectId: "demo",
    projectStatus: "active",
    activity: "running",
    activityLabel: "running",
    run: {
      id: "run-1",
      date: "2026-10-06",
      status: "running",
      newToday: 0,
      liveToday: 0,
      liveWeek: 0,
      uniqueHosts: 1,
      lastAction: "Probed brett-1ej2xe.example",
      lastError: null,
    },
    whyNot: zeroWhy,
    operatorQueue: 0,
    scheduleActive: true,
    scheduleReason: "in_window",
    newPerDay: 2,
    livePerDay: 1,
    liveWeekCap: 8,
    lastEvent: "Probed brett-1ej2xe.example",
    costs: {
      day: { captellCredits: 0, modelTokens: 12, searchQueries: 1, proxyLeaseDays: 0 },
      week: { captellCredits: 0, modelTokens: 12, searchQueries: 1, proxyLeaseDays: 0 },
    },
    ...overrides,
  };
}

function renderOverview(
  status: LbProjectStatusView,
  steps: LbRunStepView[],
  drafts: LbDraftView[] = [],
  screenUrl?: string | null,
  tickets: LbOperatorTicketView[] = [],
  hosts: LbHostView[] = [],
  screenState?: "off" | "starting" | "no_browser" | "live",
) {
  return renderToStaticMarkup(
    <ProjectView
      project={{ name: "Vitaminexpress" } as LbProjectDetail}
      status={status}
      hosts={hosts}
      placements={[]}
      steps={steps}
      threads={[]}
      drafts={drafts}
      tickets={tickets}
      surface="dashboard"
      onSurface={noop}
      onStart={noop}
      onPause={noop}
      onStop={noop}
      loadArtifact={loadArtifact}
      busy={false}
      screenUrl={screenUrl}
      screenState={screenState}
    />,
  );
}
