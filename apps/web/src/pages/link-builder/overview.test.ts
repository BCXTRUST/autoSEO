import type { LbRunStepView, LbWhyNot } from "@rakazo/contracts";
import type { ScheduleWindow } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import {
  cornerLabel,
  dashboardSummary,
  homeLine,
  homeStatus,
  latestFirst,
  liveLinkRows,
  overviewAction,
  overviewFeed,
  overviewFrame,
  overviewHasPlacement,
  overviewPace,
  overviewStage,
  overviewWorking,
  personTicket,
  showOnDashboard,
  stuckHelp,
  whyNotFeedLines,
} from "./overview.js";

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

function step(index: number, lastAction: string, artifactIds: string[] = []): LbRunStepView {
  return {
    id: `step-${index}`,
    stepIndex: index,
    kind: "probe",
    hostId: null,
    lastAction,
    error: null,
    costs: { credits: 0, tokens: 0, bytes: 0, ms: 0 },
    artifactIds,
    createdAt: "2026-10-06T12:00:00.000Z",
  };
}

describe("overview feed", () => {
  it("names the home as posting, waiting, needs you, or paused", () => {
    expect(homeStatus({ activity: "running" })).toBe("Posting");
    expect(homeStatus({ activity: "overtime" })).toBe("Posting");
    expect(homeStatus({ intent: "working" })).toBe("Posting");
    expect(homeStatus({ activity: "paused" })).toBe("Paused");
    expect(homeStatus({ intent: "paused", activity: "running" })).toBe("Paused");
    expect(homeStatus({ activity: "needs_operator" })).toBe("Needs you");
    expect(homeStatus({ activityLabel: "needs operator ×4", activity: "running" })).toBe(
      "Needs you",
    );
    expect(homeStatus({ needsYou: true, activity: "running" })).toBe("Needs you");
    expect(homeStatus({ activity: "idle" })).toBe("Waiting");
    expect(homeStatus({ activity: "stopped" })).toBe("Waiting");
    expect(homeStatus({ activity: "out_of_window" })).toBe("Waiting");
    expect(homeStatus({})).toBe("Waiting");
  });

  it("says what is stuck and hides captcha from the home box", () => {
    expect(homeLine({ status: "Posting", liveToday: 1, livePerDay: 2 })).toBe(
      "Posting 1 of 2 links today",
    );
    expect(stuckHelp({ domain: "example.com", reason: "missing_password" })).toEqual({
      stuck: "Stuck. example.com needs a password.",
      next: "Add the password, then continue.",
    });
    expect(
      personTicket([
        { status: "open", reason: "captcha_unsolved" },
        { status: "open", reason: "missing_password" },
      ]),
    ).toEqual({ status: "open", reason: "missing_password" });
    expect(personTicket([{ status: "open", reason: "captcha_unsolved" }])).toBeNull();
    expect(personTicket([{ status: "open", reason: "admin_approval" }])).toBeNull();
  });

  it("puts done counts on top and keeps a post off the screen", () => {
    const summary = dashboardSummary({
      hosts: [],
      placements: [],
      steps: [],
      whyNot: { ...zeroWhy, unsupportedCaptcha: 3, pendingEmail: 2, pendingAdmin: 2 },
    });
    expect(summary.done).toEqual({ registered: 4, posted: 0, skipped: 3 });
    expect(
      liveLinkRows(
        [
          {
            id: "fixture",
            domain: "brett-1ej2xe.example",
            postUrl: "https://brett-1ej2xe.example/t/1",
            threadUrl: "",
            status: "live",
            counted: true,
          },
          {
            id: "live",
            domain: "board.example.org",
            postUrl: "https://board.example.org/thread-9.html",
            threadUrl: "",
            status: "live",
            counted: true,
          },
          {
            id: "pending",
            domain: "office-fragen.de",
            postUrl: "",
            threadUrl: "https://www.office-fragen.de/thread-1.html",
            status: "pending",
            counted: false,
          },
          {
            id: "dead",
            domain: "gone.example.org",
            postUrl: "https://gone.example.org/t/1",
            threadUrl: "",
            status: "dead",
            counted: false,
          },
        ],
        "vitaminexpress",
      ),
    ).toEqual([
      {
        id: "live",
        href: "https://board.example.org/thread-9.html",
        label: "board.example.org/thread-9.html",
      },
    ]);
    expect(summary.notes.map((note) => note.text).join(" ")).toContain("site admin");
    expect(summary.notes.map((note) => note.text).join(" ")).not.toContain("Expected");
    expect(cornerLabel("2 accounts waiting for an admin. Expected.", "Warmup")).toBe("Warmup");
    expect(cornerLabel("Opening yamedo.de", "Warmup")).toBe("Opening yamedo.de");
    expect(
      showOnDashboard(
        "die Muskelfunktion, und ein Mangel kann sich unter anderem durch Muskelkrämpfe bemerkbar machen. Schätzungen gehen davon aus.",
      ),
    ).toBe(false);
  });

  it("hides an all-zero why-not report and keeps real blockers", () => {
    expect(whyNotFeedLines(zeroWhy)).toEqual([]);
    expect(whyNotFeedLines(null)).toEqual([]);
    expect(
      whyNotFeedLines({
        ...zeroWhy,
        parked: 1,
        pendingEmail: 2,
        spamBlocked: 1,
        proxy: "degraded",
        reasons: ["operator_parked", "pending_email", "spam_filtered", "proxy_degraded"],
      }),
    ).toEqual([
      "Skipped 1 site. Needs a person.",
      "Skipped 1 site. Marked as spam.",
      "The connection is weak.",
    ]);
  });

  it("appends steps in order and marks the latest one working", () => {
    const items = overviewFeed({
      steps: [step(1, "Opening Vitamin D im Winter?"), step(0, "Opened Google search")],
      lastEvent: "Opening Vitamin D im Winter?",
      working: true,
      blockers: [],
    });
    expect(items.map((item) => item.label)).toEqual([
      "Opened Google search",
      "Opening Vitamin D im Winter?",
    ]);
    expect(items.map((item) => item.status)).toEqual(["done", "working"]);
    expect(overviewAction(items, true)).toBe("Opening Vitamin D im Winter?");
  });

  it("puts the newest check or X first", () => {
    const early = step(0, "Opened diabetes-forum.de");
    early.createdAt = "2026-10-12T06:00:02.000Z";
    const failed = step(1, "Step failed, retrying");
    failed.createdAt = "2026-10-12T06:00:39.000Z";
    failed.error = "retry";
    const opened = step(2, "Opened nickles.de");
    opened.createdAt = "2026-10-12T06:02:40.000Z";
    const items = overviewFeed({
      steps: [early, failed, opened],
      lastEvent: null,
      working: false,
      blockers: [],
    });
    expect(latestFirst(items).map((item) => item.label)).toEqual([
      "Opened nickles.de",
      "Step failed, retrying",
      "Opened diabetes-forum.de",
    ]);
  });

  it("drops fixture hosts and does not invent a research line before any step arrives", () => {
    const starting = overviewFeed({
      steps: [],
      lastEvent: null,
      working: true,
      blockers: [],
    });
    expect(starting).toEqual([]);
    const blocked = overviewFeed({
      steps: [step(0, "Opened Google search"), step(1, "Discovered forum-a.example")],
      lastEvent: "Discovered forum-a.example",
      working: false,
      blockers: ["Parked 1"],
    });
    expect(blocked.map((item) => item.label)).toEqual(["Opened Google search", "Parked 1"]);
    const customer = overviewFeed({
      steps: [step(0, "Looking for threads"), step(1, "LIVE quota met")],
      lastEvent: "Parked the host for an operator",
      working: true,
      blockers: [],
      hideExampleCopy: true,
    });
    expect(customer).toEqual([]);
    expect(blocked[1]?.status).toBe("blocked");
    expect(overviewAction(blocked, false)).toBe("Opened Google search");
  });

  it("shows the Google line only after a search is counted", () => {
    const steps = [
      step(0, "Checking Google for on-topic forums"),
      step(1, "Looking for threads"),
      step(2, "Continuing"),
    ];
    const quiet = overviewFeed({
      steps,
      lastEvent: "Checking Google for on-topic forums",
      working: true,
      blockers: [],
      searches: 0,
    });
    expect(quiet.map((item) => item.label)).toEqual([]);
    expect(overviewAction(quiet, true)).toBe("Working");
    const opened = step(3, "Opened Google search");
    const counted = overviewFeed({
      steps: [...steps, opened],
      lastEvent: "Opened Google search",
      working: true,
      blockers: [],
      searches: 1,
    });
    expect(counted.map((item) => item.label)).toEqual(["Opened Google search"]);
    expect(counted[0]?.status).toBe("working");
    expect(counted.some((item) => item.status === "done")).toBe(false);
    expect(counted.map((item) => item.label).join("\n")).not.toMatch(
      /Checking Google for on-topic forums|Looking for threads|Continuing/,
    );
    const problem = overviewFeed({
      steps,
      lastEvent: "Checking Google for on-topic forums",
      working: true,
      blockers: [],
      searches: 1,
      searchQuery: "Magnesium Krämpfe Forum",
    });
    expect(problem.map((item) => item.label)).toEqual([
      "Searched Google.de for Magnesium Krämpfe Forum",
    ]);
    expect(problem.map((item) => item.label).join("\n")).not.toMatch(
      /Checking Google|Looking for threads|Continuing|Vitaminexpress|kaufen/,
    );
    const uncounted = overviewFeed({
      steps,
      lastEvent: "Searched Google.de for Magnesium Krämpfe Forum",
      working: true,
      blockers: [],
      searches: 0,
      searchQuery: "Magnesium Krämpfe Forum",
    });
    expect(uncounted).toEqual([]);
  });

  it("drops the canned three-line loop even when those steps are stored", () => {
    const repeat = step(1, "Checking Google for on-topic forums");
    repeat.createdAt = "2026-10-06T12:00:20.000Z";
    const later = step(2, "Looking for threads");
    later.createdAt = "2026-10-06T12:00:40.000Z";
    const again = step(3, "Continuing");
    again.createdAt = "2026-10-06T12:01:10.000Z";
    const opened = step(4, "Opened Google search");
    opened.createdAt = "2026-10-06T12:02:10.000Z";
    const items = overviewFeed({
      steps: [step(0, "Checking Google for on-topic forums"), repeat, later, again, opened],
      lastEvent: "Continuing",
      working: true,
      blockers: [],
    });
    expect(items.map((item) => item.label)).toEqual(["Opened Google search"]);
    expect(items.at(-1)?.status).toBe("working");
    expect(overviewAction(items, true)).toBe("Opened Google search");
    expect(items.map((item) => item.label).join("\n")).not.toMatch(
      /Checking Google for on-topic forums|Looking for threads|Continuing/,
    );
    const quiet = overviewFeed({
      steps: [step(0, "Checking Google for on-topic forums"), opened],
      lastEvent: "Opened Google search",
      working: true,
      blockers: [],
      searches: 0,
    });
    expect(quiet).toEqual([]);
    expect(quiet.some((item) => item.status === "done")).toBe(false);
  });

  it("follows an explicit start or pause before the server status changes", () => {
    expect(overviewWorking({ activity: "paused", intent: "working" })).toBe(true);
    expect(overviewWorking({ activity: "running", intent: "paused" })).toBe(false);
    expect(overviewWorking({ activity: "running", intent: null })).toBe(true);
    expect(overviewWorking({ activity: "paused", intent: null })).toBe(false);
  });

  it("prefers a live screen, then the newest screenshot", () => {
    const steps = [step(0, "Open", ["older"]), step(1, "Post", ["newer"])];
    expect(
      overviewFrame({
        steps,
        tickets: [
          {
            id: "ticket-1",
            projectId: "demo",
            hostId: "host-1",
            domain: "brett.example",
            runId: "run-1",
            reason: "captcha_unsolved",
            screenUrl: "https://screens.example/live",
            screenshotArtifactId: "shot",
            note: null,
            status: "open",
            expiresAt: null,
            createdAt: "2026-10-06T12:00:00.000Z",
          },
        ],
      }),
    ).toEqual({ kind: "url", url: "https://screens.example/live" });
    expect(overviewFrame({ steps, tickets: [] })).toEqual({
      kind: "artifact",
      artifactId: "newer",
    });
    expect(overviewFrame({ steps: [], tickets: [] })).toBeNull();
    const stream = "https://app.autoseo.run/novnc/remote/view/9.abc/vnc.html";
    expect(overviewFrame({ steps, tickets: [], screenUrl: stream })).toEqual({
      kind: "url",
      url: stream,
    });
    expect(
      overviewFrame({
        steps: [],
        tickets: [],
        screenUrl: "http://127.0.0.1:6080/vnc.html",
      }),
    ).toBeNull();
  });

  it("prefers the newest sentence and keeps the older lines", () => {
    const items = overviewFeed({
      steps: [
        step(0, "Opened Google search"),
        step(1, "Opening Vitamin D im Winter?"),
        step(2, "Continuing"),
        step(3, "Still researching"),
      ],
      lastEvent: "Still researching",
      working: true,
      blockers: [],
      hasPlacement: false,
    });
    expect(items.map((item) => item.label)).toEqual([
      "Opened Google search",
      "Opening Vitamin D im Winter?",
    ]);
    expect(items.find((item) => item.status === "working")?.label).toBe(
      "Opening Vitamin D im Winter?",
    );
    expect(overviewAction(items, true)).toBe("Opening Vitamin D im Winter?");
  });

  it("adds a found line only for a real name", () => {
    const named = overviewFeed({
      steps: [
        step(0, "Checking Google for on-topic forums"),
        step(1, "Looking for threads"),
        step(2, "Continuing"),
      ],
      lastEvent: null,
      working: true,
      blockers: [],
      forumName: "gutefrage.net",
      threadName: "Vitamin D im Winter?",
    });
    expect(named.map((item) => item.label)).toEqual([
      "Found forum gutefrage.net",
      "Found Vitamin D im Winter?",
    ]);
    expect(overviewAction(named, true)).toBe("Found Vitamin D im Winter?");
    const invented = overviewFeed({
      steps: [step(0, "Checking Google for on-topic forums"), step(1, "Continuing")],
      lastEvent: "Found forum forum-a.example",
      working: true,
      blockers: [],
      forumName: "forum-a.example",
      threadName: "brett-a.example",
    });
    expect(invented.map((item) => item.label).join("\n")).not.toContain(".example");
    expect(invented.some((item) => item.label.startsWith("Found"))).toBe(false);
    expect(invented.map((item) => item.label)).not.toContain("Continuing");
    expect(overviewAction(invented, true)).toBe("Working");
    const brand = overviewFeed({
      steps: [
        step(0, "Checking Google for on-topic forums"),
        step(1, "Looking for threads"),
        step(2, "Found Vitaminexpress"),
        step(3, "Continuing"),
      ],
      lastEvent: "Found Vitaminexpress",
      working: true,
      blockers: [],
    });
    expect(brand.map((item) => item.label)).toEqual([]);
    expect(overviewAction(brand, true)).toBe("Working");
  });

  it("does not verify, or spin on Verify, when nothing was placed", () => {
    const verify = step(5, "Verify");
    verify.kind = "lb_verify";
    const registered = step(6, "Registered");
    registered.kind = "register";
    const items = overviewFeed({
      steps: [
        step(0, "Researching topics"),
        step(1, "Still researching"),
        Object.assign(step(2, "Register"), { kind: "lb_register" }),
        Object.assign(step(3, "Warmup"), { kind: "lb_warmup" }),
        Object.assign(step(4, "Place"), { kind: "lb_place" }),
        verify,
        registered,
      ],
      lastEvent: "Verify",
      working: true,
      blockers: [],
      hideExampleCopy: true,
      hasPlacement: false,
    });
    expect(items.map((item) => item.label)).toEqual(["Registered"]);
    expect(items.some((item) => item.label === "Verify")).toBe(false);
    expect(items.find((item) => item.status === "working")?.label).toBe("Registered");
    expect(overviewHasPlacement([], "vitaminexpress")).toBe(false);
    expect(overviewHasPlacement(["fragen-1ej2xe.example"], "vitaminexpress")).toBe(false);
    expect(
      overviewStage({
        runStatus: "running",
        lastAction: "Verify",
        stepKinds: ["research", "lb_register", "lb_warmup", "lb_place", "lb_verify"],
        hasPlacement: false,
      }),
    ).toBe("research");
  });

  it("keeps a verify line and a frame when a placement or a screenshot exists", () => {
    const verify = step(1, "Verify", ["shot"]);
    verify.kind = "verify";
    const items = overviewFeed({
      steps: [step(0, "Reading threads"), verify],
      lastEvent: "Verify",
      working: true,
      blockers: [],
      hasPlacement: true,
    });
    expect(items.at(-1)).toMatchObject({ label: "Verify", status: "working" });
    expect(overviewFrame({ steps: [verify], tickets: [] })).toEqual({
      kind: "artifact",
      artifactId: "shot",
    });
    expect(overviewHasPlacement(["www.vitaminexpress.org"], "vitaminexpress")).toBe(true);
    expect(
      overviewStage({
        runStatus: "running",
        lastAction: "Verify",
        stepKinds: ["verify"],
        hasPlacement: true,
      }),
    ).toBe("verify");
  });
});

const berlin: ScheduleWindow = {
  timezone: "Europe/Berlin",
  weekdaysOnly: true,
  window: { start: "09:00", end: "22:00" },
  overtimeUntilLiveMet: false,
  hardStopHour: 24,
};

describe("overview pace", () => {
  it("names the time left in the window and a pace from recent steps", () => {
    const lines = overviewPace({
      now: new Date("2026-10-05T08:00:00Z"),
      schedule: berlin,
      steps: [
        { createdAt: "2026-10-05T07:00:00.000Z" },
        { createdAt: "2026-10-05T07:10:00.000Z" },
        { createdAt: "2026-10-05T07:20:00.000Z" },
      ],
      liveToday: 0,
      livePerDay: 2,
      newToday: 0,
      newPerDay: 4,
    });
    expect(lines[0]).toBe("12h left today");
    expect(lines[1]).toBe("About 20m for 2 links");
  });

  it("keeps a long pace inside the window and names the next run when closed", () => {
    const open = overviewPace({
      now: new Date("2026-10-05T17:30:00Z"),
      schedule: berlin,
      steps: [
        { createdAt: "2026-10-05T16:00:00.000Z" },
        { createdAt: "2026-10-05T16:40:00.000Z" },
        { createdAt: "2026-10-05T17:20:00.000Z" },
      ],
      liveToday: 0,
      livePerDay: 4,
      newToday: 1,
      newPerDay: 2,
    });
    expect(open[0]).toBe("2h 30m left today");
    expect(open[1]).toBe("4 links still open");
    const closed = overviewPace({
      now: new Date("2026-10-10T12:00:00Z"),
      schedule: berlin,
      steps: [],
      liveToday: 0,
      livePerDay: 1,
      newToday: 0,
      newPerDay: 2,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/^Next run Mon 09:00/);
  });

  it("names the open desktop page instead of a finished action", () => {
    const items = overviewFeed({
      steps: [step(0, "Posted the reply")],
      lastEvent: "Posted the reply",
      working: false,
      blockers: [],
    });
    expect(overviewAction(items, false)).toBe("Posted the reply");
    expect(overviewAction(items, true, "https://www.nickles.de/consent.html")).toBe(
      "On nickles.de consent",
    );
    expect(overviewAction(items, false, "https://www.nickles.de/register")).toBe(
      "On nickles.de registration",
    );
    expect(overviewAction(items, false, "https://www.nickles.de/forum/ucp.php?mode=register")).toBe(
      "On nickles.de registration",
    );
    expect(
      overviewAction(
        items,
        false,
        "https://www.nickles.de/forum/office-word-excel-und-co/2026/office-2016-nicht-lizenziertes-produkt-539346749.html",
      ),
    ).toBe("On nickles.de reply");
    expect(overviewAction(items, false, "https://app.autoseo.run/novnc/remote/vnc.html")).toBe(
      "Posted the reply",
    );
  });

  it("shows the real step when the page is already open", () => {
    const items = overviewFeed({
      steps: [
        step(2, "No open thread on this board"),
        step(1, "Opened office-fragen.de"),
        step(0, "Working on office-fragen.de"),
      ],
      lastEvent: "No open thread on this board",
      working: true,
      blockers: [],
    });
    expect(overviewAction(items, true, "https://www.office-fragen.de/")).toBe(
      "No open thread on this board",
    );
    expect(
      overviewAction(
        items,
        true,
        "https://www.office-fragen.de/",
        "Looking for a thread on office-fragen.de",
      ),
    ).toBe("Looking for a thread on office-fragen.de");
    expect(overviewAction(items, true, "https://www.office-fragen.de/")).not.toMatch(/^Opening /);
  });
});
