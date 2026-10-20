import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaptchaSolverError } from "@rakazo/adapter-kit";
import { LbFitCheckSchema, LbThreadRelevanceSchema } from "@rakazo/contracts";
import { startRunCounters, warmupThreadEligible } from "@rakazo/linkbuilder-core";
import {
  formErrorTextFromHtml,
  GenericFormDriver,
  threadMetaFromHtml,
} from "@rakazo/linkbuilder-drivers";
import { describe, expect, it } from "vitest";
import { publicSolverFailure } from "./link-builder-discovery.js";
import { threadKey } from "./link-builder-page-move.js";
import { REAL_STEP_HANDLERS, type StepContext } from "./link-builder-real-steps.js";
import {
  distinctWarmupThreads,
  replyBodyBlocked,
  replyVisibility,
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

  it("keeps a health title that never says the lane word, and still drops chat", () => {
    const live = {
      name: "Vitaminexpress",
      brandName: "Vitaminexpress",
      topicLanes: [
        {
          id: "kw-01",
          tag: "Creatin EEM",
          description:
            "sleep, pain, cramps, sport and training, children, mood, pregnancy, deficiency, energy",
          exampleQuestions: [],
        },
      ],
      targets: [],
    };
    const kept = ["Hashimoto - Austausch", "Verstopfung?"];
    for (const title of kept) {
      expect(
        warmupThreadEligible({
          title,
          firstPost: "Heute war ein normaler Tag.",
          meta: freshMeta(),
          username: "Sophie",
          now,
          project: live,
        }),
      ).toEqual({ ok: true });
    }
    for (const title of [
      "Trash-TV - Der Diskussionsfaden",
      "Alles rund ums Klettern",
      "Klimawandel",
      "Tops und Flops im Supermarkt",
      "Worüber ich mich heute gefreut habe",
    ]) {
      expect(
        warmupThreadEligible({
          title,
          firstPost: "Mein Arzt sagt, alles ist in Ordnung.",
          meta: freshMeta(),
          username: "Sophie",
          now,
          project: live,
        }),
      ).toEqual({ ok: false, reason: "off_topic_thread" });
    }
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
    expect(result).toMatchObject({
      kind: "step",
      lastAction: "No thread passed selection",
      outcome: { refused: "no_thread_today" },
      run: { currentHostId: null },
    });
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

describe("R1 thread reading", () => {
  const readAt = new Date("2026-10-20T08:00:00.000Z");

  it("reads Verstopfung as open and Hashimoto's last page as active", () => {
    const open = threadMetaFromHtml(
      readFileSync(path.join(fixtures, "med2-forum.de/verstopfung.html"), "utf8"),
      "woltlab",
      readAt,
    );
    expect(open.closed).toBe(false);
    const last = threadMetaFromHtml(
      readFileSync(path.join(fixtures, "med2-forum.de/hashimoto-lastpost.html"), "utf8"),
      "woltlab",
      readAt,
    );
    expect(last.lastActivityAt?.slice(0, 10)).toBe("2026-10-19");
    expect(
      warmupThreadEligible({
        title: "Hashimoto - Austausch",
        section: last.section,
        firstPost: last.firstPost,
        meta: last,
        username: "NichtDabei",
        now: readAt,
        project: lane,
      }),
    ).toEqual({ ok: true });
  });

  it("reads the diabetes GLP-1 thread and still rejects the hello thread", async () => {
    const html = readFileSync(path.join(fixtures, "diabetes-forum.de/glp1.html"), "utf8");
    const meta = await new GenericFormDriver().readThreadMeta({
      pageHtml: async () => html,
    } as never);
    expect(meta.posts).toHaveLength(3);
    expect(meta.posts.every((post) => post.author.length > 0)).toBe(true);
    expect(meta.lastActivityAt?.slice(0, 10)).toBe("2026-10-10");
    expect(
      warmupThreadEligible({
        title: "Supplements bei GLP-1 Therapien",
        firstPost: meta.firstPost,
        meta,
        username: "NichtDabei",
        now: readAt,
        project: lane,
      }),
    ).toEqual({ ok: true });
    expect(
      warmupThreadEligible({
        title: "Hallo erst mal",
        firstPost: "Hallo, ich bin neu hier",
        meta,
        username: "NichtDabei",
        now: readAt,
        project: lane,
      }),
    ).toEqual({ ok: false, reason: "intro_or_game" });
  });

  it("does not treat a public moderator log as our post waiting for review", () => {
    const html = readFileSync(path.join(fixtures, "med2-forum.de/verstopfung.html"), "utf8");
    const body = "Bei mir hat eine ruhige Abendroutine mehr gebracht als noch ein Mittel.";
    const withPost = `${html}<article class="message" id="post999"><a class="username">Sophie</a><div class="messageText">${body}</div></article>`;
    expect(
      replyVisibility({
        pageText: withPost,
        html: withPost,
        username: "Sophie",
        body,
        permalink: "https://www.med2-forum.de/forum/thread/13777/?postID=999#post999",
      }),
    ).toBe("posted");
  });
});

describe("R1 host rotation and unproven replies", () => {
  function warmingHost(id: string, domain: string) {
    return {
      id,
      registrableDomain: domain,
      status: "warming",
      statusReason: null,
      platform: "woltlab",
      qualityScore: 1,
      homepageUrl: `https://${domain}/`,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      language: "de",
      country: "DE",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      parkedFrom: null,
      placements: [],
      accounts: [
        {
          emailVerifiedAt: new Date("2026-10-10T00:00:00.000Z"),
          adminApprovedAt: null,
          postCount: 1,
          createdAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      ],
    };
  }

  it("picks the other warming host after a daily refusal, then waits", async () => {
    const hosts = [
      warmingHost("host-a", "med2-forum.de"),
      warmingHost("host-b", "diabetes-forum.de"),
    ];
    const steps: Array<{ hostId: string; outcome: unknown; createdAt: Date }> = [];
    const prisma = {
      lbHost: { findMany: async () => hosts },
      lbRunStep: {
        findMany: async () => steps,
        count: async () => 0,
      },
      lbDraft: { findMany: async () => [] },
    };
    const ctx = {
      now,
      run: { id: "run-1", counters: { ...startRunCounters(), newToday: 1 } },
      project: {
        id: "project-1",
        denyHosts: [],
        preferHosts: [],
        schedule: { timezone: "Europe/Berlin" },
        warmup: { minPostsBeforeLink: 4, minAccountAgeHours: 24, activityDays: 30 },
        quotas: { newPerDay: 1 },
      },
      host: null,
      pool: () => undefined,
      services: { prisma },
    } as unknown as StepContext;
    steps.push({
      hostId: "host-a",
      outcome: { refused: "no_thread_today" },
      createdAt: now,
    });
    const next = await REAL_STEP_HANDLERS.select_host(ctx);
    expect(next).toMatchObject({ kind: "step", hostId: "host-b" });
    steps.push({
      hostId: "host-b",
      outcome: { refused: "warmup_pace" },
      createdAt: now,
    });
    const done = await REAL_STEP_HANDLERS.select_host(ctx);
    expect(done).toEqual({ kind: "wait", reason: "nothing_today" });
  });

  it("stores a draft when the submitted reply is not on the public page", async () => {
    const body =
      "Ich kenne das aus dem Alltag und bei mir hat eine ruhige Abendroutine mehr gebracht als noch ein weiteres Mittel auszuprobieren, gerade wenn der Schlaf unruhig bleibt.";
    const created: Array<{ data: { status: string; qualityChecks: { verified?: boolean } } }> = [];
    const accountUpdates: Array<{ data: { lastPostAt?: Date } }> = [];
    const placements: unknown[] = [];
    const result = await REAL_STEP_HANDLERS.warmup_post(
      proofContext({
        warmup: true,
        created,
        accountUpdates,
        placements,
        body,
      }),
    );
    expect(result).toMatchObject({ kind: "step", lastAction: "Reply not visible" });
    if (result.kind !== "step") return;
    await result.apply?.(proofTx(created, accountUpdates, placements) as never);
    expect(created[0]?.data.status).toBe("posted");
    expect(created[0]?.data.qualityChecks.verified).toBe(false);
    expect(accountUpdates[0]?.data.lastPostAt).toEqual(now);
    expect(placements).toEqual([]);
  });

  it("stores a pending placement when a link reply fails the public proof", async () => {
    const body =
      "Ich kenne das aus dem Alltag und bei mir hat eine ruhige Abendroutine mehr gebracht als noch ein weiteres Mittel auszuprobieren, gerade wenn der Schlaf unruhig bleibt.";
    const created: Array<{ data: { status: string; qualityChecks: { verified?: boolean } } }> = [];
    const accountUpdates: Array<{ data: { lastPostAt?: Date } }> = [];
    const placements: Array<{ data: { status: string } }> = [];
    const result = await REAL_STEP_HANDLERS.post(
      proofContext({
        warmup: false,
        created,
        accountUpdates,
        placements,
        body,
        link: true,
      }),
    );
    expect(result).toMatchObject({ kind: "step", lastAction: "Reply not visible" });
    if (result.kind !== "step") return;
    await result.apply?.(proofTx(created, accountUpdates, placements) as never);
    expect(created[0]?.data.qualityChecks.verified).toBe(false);
    expect(placements[0]?.data.status).toBe("pending");
  });
});

function proofTx(
  created: Array<{ data: { status: string; qualityChecks: { verified?: boolean } } }>,
  accountUpdates: Array<{ data: { lastPostAt?: Date } }>,
  placements: unknown[],
) {
  return {
    lbHost: { update: async () => ({}) },
    lbCaptchaEvent: { create: async () => ({}) },
    lbThreadCandidate: {
      upsert: async () => ({ id: "thread-1" }),
    },
    lbDraft: {
      create: async (args: { data: { status: string; qualityChecks: { verified?: boolean } } }) => {
        created.push(args);
        return { id: "draft-1" };
      },
    },
    lbPlacement: {
      create: async (args: unknown) => {
        placements.push(args);
        return { id: "place-1" };
      },
    },
    lbHostAccount: {
      update: async (args: { data: { lastPostAt?: Date } }) => {
        accountUpdates.push(args);
        return {};
      },
    },
  };
}

function proofContext(input: {
  warmup: boolean;
  created: unknown[];
  accountUpdates: unknown[];
  placements: unknown[];
  body: string;
  link?: boolean;
}): StepContext {
  const recent = now.toISOString();
  return {
    now,
    stepIndex: 4,
    adapter: {},
    run: { id: "run-1", counters: { newToday: 1, liveToday: 0 } },
    secrets: [],
    storeArtifact: async () => "art-1",
    project: {
      id: "project-1",
      workspaceId: "w1",
      ownerUserId: "user-1",
      name: "Vitaminexpress",
      brandName: "Vitaminexpress",
      allowedDomains: ["vitaminexpress.org"],
      persona: {
        displayName: "Sophie Braun",
        bio: "Ich schreibe aus Erfahrung.",
        register: "du",
        language: "de",
        disclosureText: "",
      },
      markets: [{ country: "DE", language: "de", locale: "de-DE", timezoneId: "Europe/Berlin" }],
      facts: [],
      targets: [{ url: "https://vitaminexpress.org/magnesium", description: "Magnesium" }],
      content: {
        toneNotes: "",
        topics: [],
        threadActivityDays: 30,
        maxReplyChars: 1200,
        bannedClaims: [],
        excludedLaneIds: [],
      },
      disclosureMode: "undisclosed_persona",
      linkRatio: "sometimes",
      topicLanes: [
        {
          id: "lane",
          tag: "Magnesium",
          description: "Schlaf und Magnesium",
          exampleQuestions: [],
        },
      ],
      schedule: { timezone: "Europe/Berlin" },
      warmup: { minPostsBeforeLink: 4, minAccountAgeHours: 24, activityDays: 30 },
    },
    host: {
      id: "host-1",
      status: "warming",
      platform: "phpbb",
      registrableDomain: "forum.example",
      homepageUrl: "https://forum.example/",
      signatureLinks: false,
      country: "DE",
      language: "de",
    },
    account: {
      id: "acct-1",
      username: "Sophie",
      postCount: 0,
      linkPostCount: 0,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      firstPostAt: null,
      lastPostAt: null,
      siteLoginId: "login-1",
    },
    pool: () => ({
      hostId: "host-1",
      profileSet: true,
      session: {
        goto: async () => undefined,
        url: async () => "https://forum.example/viewtopic.php?t=9",
        pageText: async () => "Magnesium und Schlaf. Jemand anderes hat gestern geschrieben.",
        pageHtml: async () => "<html><body><div class='post'>Magnesium</div></body></html>",
        exists: async () => false,
        fill: async () => undefined,
        click: async () => undefined,
        screenshotPng: async () => new Uint8Array([1]),
      },
      driver: {
        login: async () => true,
        listThreads: async () => [
          { url: "https://forum.example/viewtopic.php?t=9", title: "Magnesium und Schlaf" },
        ],
        readThreadMeta: async () => ({
          lastActivityAt: recent,
          posts: [{ author: "Ratchet30", at: recent }],
          closed: false,
          section: "Gesundheit",
          firstPost: "Magnesium und Schlaf, was hilft euch?",
        }),
        openReply: async () => true,
        fillReply: async () => undefined,
        detectCaptcha: async () => ({ kind: "none" }),
        submitReply: async () => ({
          kind: "posted",
          permalink: "https://forum.example/viewtopic.php?t=9#p100",
        }),
        probeLinkRule: () => ({
          hrefForNewMembers: "unknown",
          minPosts: null,
          relDefault: "unknown",
        }),
      },
    }),
    services: {
      verifyFetch: async () => new Response("<html>empty</html>"),
      verifyDelayMs: 1_000,
      prisma: {
        lbDraft: { findMany: async () => [], findFirst: async () => null },
        lbThreadCandidate: { findMany: async () => [] },
        lbRunStep: { findMany: async () => [] },
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
      textModel: {
        complete: async (request: { schema?: unknown }) => {
          const tokens = { input: 1, output: 1 };
          if (request.schema === LbThreadRelevanceSchema) {
            return {
              ok: true,
              modelId: "m",
              tokens,
              value: {
                relevance: 0.91,
                openQuestion: input.link === true,
                reasons: ["Austausch"],
              },
            };
          }
          if (request.schema === LbFitCheckSchema) {
            return {
              ok: true,
              modelId: "m",
              tokens,
              value: { fitsThread: true, soundsLikeAd: false, factsOnly: true, issues: [] },
            };
          }
          return {
            ok: true,
            modelId: "m",
            tokens,
            value: {
              body: input.body,
              linkSlot: input.link ? "inline" : "none",
              targetUrlIndex: input.link ? 0 : null,
              anchorText: input.link ? "Magnesium" : null,
              confidence: 0.8,
            },
          };
        },
      },
    },
  } as unknown as StepContext;
}
