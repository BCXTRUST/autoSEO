import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaptchaSolverError } from "@rakazo/adapter-kit";
import { warmupThreadEligible } from "@rakazo/linkbuilder-core";
import { formErrorTextFromHtml, threadMetaFromHtml } from "@rakazo/linkbuilder-drivers";
import { describe, expect, it } from "vitest";
import { publicSolverFailure } from "./link-builder-discovery.js";
import { threadKey } from "./link-builder-page-move.js";
import { REAL_STEP_HANDLERS, type StepContext } from "./link-builder-real-steps.js";
import {
  distinctWarmupThreads,
  replyBodyBlocked,
  warmupPaceBlocked,
} from "./link-builder-warmup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../test/fixtures/forums");
const now = new Date("2026-10-19T16:00:00.000Z");
const banned = ["Danke", "für", "den", "Hinweis"].join(" ");

const lane = {
  name: "Vitaminexpress",
  brandName: "Vitaminexpress",
  topicLanes: [
    {
      id: "thyroid",
      tag: "Hashimoto",
      description: "Schilddrüse Hashimoto",
      exampleQuestions: ["Hashimoto Erfahrung"],
    },
  ],
  targets: [],
};

function freshMeta(author = "Ratchet30") {
  return {
    lastActivityAt: now.toISOString(),
    posts: [{ author, at: now.toISOString() }],
    closed: false,
    section: null,
  };
}

describe("warmup thread gate", () => {
  it("drops intro, game and chat titles, including ones on the med2 listing", () => {
    const home = readFileSync(path.join(fixtures, "med2-forum.de/home.html"), "utf8");
    const titles = [...home.matchAll(/class="messageGroupLink wbbTopicLink"[^>]*>([^<]+)</g)].map(
      (match) => match[1] ?? "",
    );
    const blocked = [
      "Der Filme-Thread",
      "Städtekette ABC",
      "Tiere A-Z",
      "Was kocht ihr heute?",
      "Serienjunkies",
    ];
    for (const title of blocked) {
      expect(titles.includes(title) || title === "Städtekette ABC" || title === "Tiere A-Z").toBe(
        true,
      );
      const gate = warmupThreadEligible({
        title,
        firstPost: "Hashimoto Schilddrüse",
        meta: freshMeta(),
        username: "Sophie",
        now,
        project: lane,
      });
      expect(gate).toEqual({ ok: false, reason: "intro_or_game" });
    }
    expect(titles).toEqual(expect.arrayContaining(["Der Filme-Thread", "Hashimoto - Austausch"]));
  });

  it("keeps Hashimoto only when another person posted within 14 days", () => {
    const html = readFileSync(path.join(fixtures, "med2-forum.de/hashimoto.html"), "utf8");
    const meta = threadMetaFromHtml(html, "woltlab", now);
    const gate = warmupThreadEligible({
      title: "Hashimoto - Austausch",
      section: meta.section,
      firstPost: meta.firstPost,
      meta,
      username: "Sophie Braun",
      now,
      project: lane,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).not.toBe("intro_or_game");
    const recent = new Date(now.getTime() - 86_400_000).toISOString();
    const opened = warmupThreadEligible({
      title: "Hashimoto - Austausch",
      section: meta.section,
      firstPost: meta.firstPost || "Hashimoto und die Schilddrüse",
      meta: {
        ...meta,
        lastActivityAt: recent,
        posts: [...meta.posts, { author: "Ratchet30", at: recent }],
        closed: false,
      },
      username: "Sophie Braun",
      now,
      project: lane,
    });
    expect(opened).toEqual({ ok: true });
  });

  it("treats the diabetes hello thread as an introduction and one thread key", () => {
    const html = readFileSync(path.join(fixtures, "diabetes-forum.de/hallo-erst-mal.html"), "utf8");
    expect(html).toContain("Hallo erst mal");
    const gate = warmupThreadEligible({
      title: "Hallo erst mal",
      firstPost: "Hallo erst mal, ich bin neu",
      meta: freshMeta(),
      username: "Sophie",
      now,
      project: lane,
    });
    expect(gate).toEqual({ ok: false, reason: "intro_or_game" });
    const left = "https://www.diabetes-forum.de/forum/topic/20559/Hallo-erst-mal?page=2#m_136994";
    const right = "https://www.diabetes-forum.de/forum/topic/20559/Hallo-erst-mal#m_137000";
    expect(threadKey(left)).toBe(threadKey(right));
    expect(threadKey(left)).toBe("https://www.diabetes-forum.de/forum/topic/20559/");
  });

  it("counts canned diabetes rows as zero distinct threads", () => {
    const key = "https://www.diabetes-forum.de/forum/topic/20559/";
    expect(
      distinctWarmupThreads([
        { url: `${key}#m_136994`, modelId: "warmup-fixed", status: "posted" },
        { url: `${key}hallo#m_137000`, modelId: "warmup-fixed", status: "posted" },
      ]),
    ).toBe(0);
    expect(
      distinctWarmupThreads([
        { url: `${key}#m_1`, modelId: "draft", status: "posted", verified: false },
        {
          url: "https://www.med2-forum.de/forum/thread/3160-hashimoto/#post1",
          modelId: "draft",
          status: "posted",
        },
        {
          url: "https://www.med2-forum.de/forum/thread/3160-hashimoto/?postID=9#post9",
          modelId: "draft",
          status: "posted",
        },
      ]),
    ).toBe(1);
  });
});

describe("warmup reply rules", () => {
  it("fails when the canned sentence is still in the worker source", () => {
    const root = path.resolve(here);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "fixtures") continue;
          walk(full);
          continue;
        }
        if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    const hits = files.filter((file) => readFileSync(file, "utf8").includes(banned));
    expect(hits).toEqual([]);
  });

  it("refuses a short or repeated body on the host", () => {
    const earlier = "a".repeat(140);
    expect(replyBodyBlocked("too short", [earlier])).toBe("short");
    expect(replyBodyBlocked(`  ${earlier.toUpperCase()}  `, [earlier])).toBe("duplicate");
    expect(replyBodyBlocked(`${"b".repeat(140)} mehr`, [earlier])).toBeNull();
  });

  it("refuses a third warmup post on the same Berlin day", () => {
    const posted = [new Date("2026-10-19T08:00:00.000Z"), new Date("2026-10-19T09:30:00.000Z")];
    expect(warmupPaceBlocked(posted, now, "Europe/Berlin")).toBe(true);
    expect(warmupPaceBlocked([posted[0]!], now, "Europe/Berlin")).toBe(false);
    expect(warmupPaceBlocked([new Date(now.getTime() - 60 * 60_000)], now, "Europe/Berlin")).toBe(
      true,
    );
  });
});

describe("publish warmup guards", () => {
  it("refuses the next warmup when two replies were already posted today", async () => {
    const result = await REAL_STEP_HANDLERS.warmup_post(paceContext(2));
    expect(result).toMatchObject({
      kind: "step",
      lastAction: "Next reply waits",
      outcome: { refused: "warmup_pace" },
      run: { currentHostId: null },
    });
  });

  it("creates no thread row when opening the page throws", async () => {
    const upserts: unknown[] = [];
    const result = await REAL_STEP_HANDLERS.warmup_post(gotoContext(upserts));
    expect(result).toMatchObject({ kind: "step", lastAction: "No thread passed selection" });
    if (result.kind !== "step") return;
    await result.apply?.({
      lbThreadCandidate: {
        upsert: async (args: unknown) => {
          upserts.push(args);
          return { id: "row" };
        },
      },
    } as never);
    expect(upserts).toEqual([]);
  });

  it("stores the visible refusal when the board returns no messages", async () => {
    const html = readFileSync(path.join(fixtures, "register-refused.html"), "utf8");
    expect(formErrorTextFromHtml(html)).toContain("nicht gespeichert");
    const stored: string[] = [];
    const result = await REAL_STEP_HANDLERS.captcha(formContext(html, stored));
    expect(result).toMatchObject({
      kind: "step",
      lastAction: "The board refused the registration",
    });
    if (result.kind !== "step") return;
    expect(result.outcome?.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("nicht gespeichert")]),
    );
    const updates: Array<{ data?: { statusReason?: string } }> = [];
    await result.apply?.({
      lbHost: {
        updateMany: async (args: { data?: { statusReason?: string } }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    } as never);
    expect(updates[0]?.data?.statusReason).toContain("nicht gespeichert");
    expect(stored.some((name) => name.endsWith(".html"))).toBe(true);
    expect(stored.some((name) => name.endsWith(".png"))).toBe(true);
  });

  it("moves on after two Captell solves on the host today", async () => {
    let solved = 0;
    const result = await REAL_STEP_HANDLERS.captcha(
      captchaContext(2, () => {
        solved += 1;
      }),
    );
    expect(solved).toBe(0);
    expect(result).toMatchObject({
      kind: "step",
      lastAction: "Captcha budget reached",
      outcome: { refused: "captcha_cap" },
      run: { currentHostId: null },
    });
  });
});

describe("captell public failure", () => {
  it("puts the Captell status and code on the step, not error error", () => {
    const failure = publicSolverFailure(
      new CaptchaSolverError("invalid_request", "Captell 422 ERROR_CAPTCHA_UNSOLVABLE workers"),
    );
    const line = `Browser search captcha failed: recaptcha_v2 site ${failure.code} ${failure.message}`;
    expect(line).toContain("Captell 422 ERROR_CAPTCHA_UNSOLVABLE");
    expect(line).not.toContain("error error");
  });
});

function paceContext(posted: number): StepContext {
  return {
    now,
    project: {
      id: "project-1",
      schedule: { timezone: "Europe/Berlin" },
      warmup: { minPostsBeforeLink: 4, minAccountAgeHours: 24 },
    },
    host: {
      id: "host-1",
      status: "warming",
      platform: "phpbb",
      registrableDomain: "forum.example",
      homepageUrl: "https://forum.example/",
    },
    account: {
      id: "acct-1",
      username: "Sophie",
      postCount: posted,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      siteLoginId: "login-1",
    },
    services: {
      prisma: {
        lbDraft: {
          findMany: async () =>
            Array.from({ length: posted }, (_, index) => ({
              body: `reply ${index} ${"c".repeat(140)}`,
              status: "posted",
              createdAt: new Date(`2026-10-19T0${8 + index}:00:00.000Z`),
              modelId: "draft",
              qualityChecks: {},
              threadCandidate: { url: `https://forum.example/viewtopic.php?t=${index + 1}` },
            })),
        },
      },
    },
  } as unknown as StepContext;
}

function gotoContext(upserts: unknown[]): StepContext {
  const base = paceContext(0);
  return {
    ...base,
    run: { id: "run-1" },
    secrets: [],
    pool: () => ({
      hostId: "host-1",
      profileSet: true,
      session: {
        goto: async () => {
          throw new Error("navigation failed");
        },
        url: async () => "https://forum.example/",
        pageText: async () => "",
        exists: async () => false,
      },
      driver: {
        login: async () => true,
        listThreads: async () => [
          {
            url: "https://forum.example/viewtopic.php?t=9&sid=abc#p1",
            title: "Magnesium und Schlaf",
          },
        ],
        openReply: async () => true,
        probeLinkRule: () => ({
          hrefForNewMembers: "unknown",
          minPosts: null,
          relDefault: "unknown",
        }),
      },
    }),
    services: {
      prisma: {
        lbDraft: { findMany: async () => [] },
        lbThreadCandidate: {
          findMany: async () => [],
          upsert: async (args: unknown) => {
            upserts.push(args);
            return { id: "row" };
          },
        },
        lbRun: { updateMany: async () => ({ count: 1 }) },
        siteLogin: {
          findFirst: async () => ({
            id: "login-1",
            host: "forum.example",
            url: "https://forum.example/",
            username: "Sophie",
            share: "workspace",
            createdByBotId: null,
            createdAt: new Date("2026-10-01T00:00:00.000Z"),
            updatedAt: new Date("2026-10-01T00:00:00.000Z"),
            secret: { ciphertext: "cipher" },
          }),
        },
      },
      secrets: { load: () => "pw" },
    },
  } as unknown as StepContext;
}

function formContext(html: string, stored: string[]): StepContext {
  return {
    now,
    stepIndex: 3,
    run: { id: "run-1" },
    project: {
      id: "project-1",
      workspaceId: "w1",
      spamSentences: [],
      spamMaxRetries: 0,
      schedule: { timezone: "Europe/Berlin" },
    },
    host: {
      id: "host-1",
      status: "registering",
      platform: "unknown",
      homepageUrl: "https://forum.example/",
      registrableDomain: "forum.example",
      parkedFrom: null,
    },
    secrets: [],
    storeArtifact: async (name: string) => {
      stored.push(name);
      return name;
    },
    pool: () => ({
      hostId: "host-1",
      session: {
        url: async () => "https://forum.example/register",
        pageHtml: async () => html,
        pageText: async () => "",
        screenshotPng: async () => new Uint8Array([1, 2, 3]),
        exists: async () => false,
      },
      driver: {
        detectCaptcha: async () => ({ kind: "none" }),
        submitRegistration: async () => ({ kind: "form_error", messages: [] }),
      },
    }),
    services: {
      prisma: { lbCaptchaEvent: { count: async () => 0 } },
    },
  } as unknown as StepContext;
}

function captchaContext(solves: number, onSolve: () => void): StepContext {
  return {
    now,
    project: { id: "project-1", schedule: { timezone: "Europe/Berlin" } },
    host: { id: "host-1", status: "registering", platform: "unknown" },
    services: {
      prisma: { lbCaptchaEvent: { count: async () => solves } },
      captcha: {
        solve: async () => {
          onSolve();
          return { answer: "token", credits: 1, balance: 1, taskId: "task" };
        },
      },
    },
    pool: () => ({
      hostId: "host-1",
      session: {},
      driver: { detectCaptcha: async () => ({ kind: "widget" }) },
    }),
  } as unknown as StepContext;
}
