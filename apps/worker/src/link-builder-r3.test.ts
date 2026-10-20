import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  relevanceTopicsFromProject,
  selectThreadCandidate,
  WARMUP_TITLE_BLOCK,
  warmupThreadEligible,
} from "@rakazo/linkbuilder-core";
import { GenericFormDriver, threadMetaFromHtml, WoltlabDriver } from "@rakazo/linkbuilder-drivers";
import { HtmlBrowserSession } from "@rakazo/linkbuilder-drivers/testing";
import { describe, expect, it } from "vitest";
import { threadDiscussionExcerpt } from "./link-builder-draft.js";
import { rejectionIsStored } from "./link-builder-warmup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../test/fixtures/forums");
const NOW = new Date("2026-10-20T10:45:00.000Z");
const project = JSON.parse(
  readFileSync(path.resolve(here, "../test/fixtures/vitaminexpress-project.json"), "utf8"),
) as {
  name: string;
  brandName: string;
  topicLanes: unknown;
  targets: unknown;
};

function html(domain: string, name: string): string {
  return readFileSync(path.join(fixtures, domain, name), "utf8");
}

function memberSince(page: string): string[] {
  return [...page.matchAll(/Mitglied seit:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/g)].map((match) => {
    const day = match[1]?.padStart(2, "0");
    const month = match[2]?.padStart(2, "0");
    const year = match[3];
    return `${year}-${month}-${day}T00:00:00.000Z`;
  });
}

async function listen(
  handler: (pathname: string) => string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(handler(url.pathname));
  });
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  return {
    origin,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("R3 thread dates", () => {
  it("reads diabetes post times instead of the author's join date", async () => {
    const driver = new GenericFormDriver();
    const read = async (name: string, pageUrl: string) => {
      const page = html("diabetes-forum.de", name);
      const meta = await driver.readThreadMeta({
        pageHtml: async () => page,
        url: async () => pageUrl,
      } as never);
      for (const post of meta.posts) {
        expect(memberSince(page)).not.toContain(post.at);
      }
      return meta;
    };
    const panisch = await read(
      "panisch.html",
      "https://www.diabetes-forum.de/forum/topic/20558/ich-werde-panisch",
    );
    const at = Date.parse(panisch.lastActivityAt ?? "");
    expect(Math.abs(at - Date.parse("2026-10-16T17:00:00.000Z"))).toBeLessThanOrEqual(
      2 * 3_600_000,
    );
    const novorapid = await read(
      "novorapid.html",
      "https://www.diabetes-forum.de/forum/topic/20557/",
    );
    expect(novorapid.lastActivityAt?.slice(0, 10)).toBe("2026-10-14");
    const glp1 = await read("glp1.html", "https://www.diabetes-forum.de/forum/topic/20533/");
    expect(glp1.lastActivityAt?.slice(0, 10)).toBe("2026-10-10");
  });
});

describe("R3 warmup gate", () => {
  function gate(domain: string, name: string, title: string, kind: "woltlab" | "markup") {
    const page = html(domain, name);
    const meta = threadMetaFromHtml(
      page,
      kind,
      NOW,
      kind === "markup" ? "Europe/Berlin" : undefined,
    );
    const posts = meta.posts.map((post) => post.text ?? "").join("\n");
    return warmupThreadEligible({
      title,
      section: meta.section,
      firstPost: [meta.firstPost, posts].filter(Boolean).join("\n"),
      meta,
      username: "NichtDabei",
      now: NOW,
      project,
    });
  }

  it("keeps the health threads and drops the lounge", () => {
    expect(
      gate(
        "med2-forum.de",
        "wer-versucht-lastpost.html",
        "Wer versucht noch schwanger zu werden?",
        "woltlab",
      ),
    ).toEqual({ ok: true });
    expect(
      gate("med2-forum.de", "hashimoto-lastpost.html", "Hashimoto - Austausch", "woltlab"),
    ).toEqual({ ok: true });
    expect(gate("med2-forum.de", "verstopfung.html", "Verstopfung?", "woltlab")).toEqual({
      ok: true,
    });
    expect(
      gate(
        "med2-forum.de",
        "unklar-lastpost.html",
        "Unklare Symptome - Körper oder Psyche?",
        "woltlab",
      ),
    ).toEqual({ ok: true });
    expect(gate("med2-forum.de", "eisen-lastpost.html", "Gutes Eisenpräparat", "woltlab")).toEqual({
      ok: true,
    });
    expect(
      gate("diabetes-forum.de", "glp1.html", "Supplements bei GLP-1 Therapien", "markup"),
    ).toEqual({ ok: true });
    expect(gate("diabetes-forum.de", "panisch.html", "ich werde panisch", "markup")).toEqual({
      ok: true,
    });
    expect(
      gate(
        "med2-forum.de",
        "knoten-lastpost.html",
        "Ich weiß es nicht. Knoten in der Brust",
        "woltlab",
      ),
    ).toEqual({
      ok: false,
      reason: "off_topic_thread",
    });
    expect(
      warmupThreadEligible({
        title: "Hallo erst mal",
        firstPost: "Hallo, ich bin neu",
        meta: {
          lastActivityAt: NOW.toISOString(),
          posts: [{ author: "Jemand", at: NOW.toISOString() }],
          closed: false,
          section: null,
        },
        username: "NichtDabei",
        now: NOW,
        project,
      }),
    ).toEqual({ ok: false, reason: "intro_or_game" });
    expect(
      warmupThreadEligible({
        title: "Ein normaler Tag",
        section: "Das Cafe",
        firstPost: "Heute war schön.",
        meta: {
          lastActivityAt: NOW.toISOString(),
          posts: [{ author: "Jemand", at: NOW.toISOString() }],
          closed: false,
          section: "Das Cafe",
        },
        username: "NichtDabei",
        now: NOW,
        project,
      }),
    ).toEqual({ ok: false, reason: "intro_or_game" });
  });

  it("matches game words as whole words", () => {
    expect(WARMUP_TITLE_BLOCK.test("Auswahl an Magnesium")).toBe(false);
    expect(WARMUP_TITLE_BLOCK.test("zum Beispiel Eisen")).toBe(false);
    expect(WARMUP_TITLE_BLOCK.test("Was hört Ihr gerade?")).toBe(true);
    expect(WARMUP_TITLE_BLOCK.test("Serienjunkies")).toBe(true);
    expect(WARMUP_TITLE_BLOCK.test("Spieleecke")).toBe(true);
  });
});

describe("R3 board discovery", () => {
  it("lists med2 health threads ahead of the lounge", async () => {
    const index = html("med2-forum.de", "forum-index.html");
    const boards: Record<string, string> = {
      "10": html("med2-forum.de", "board-10.html"),
      "5": html("med2-forum.de", "board-5.html"),
      "51": html("med2-forum.de", "board-51.html"),
      "114": html("med2-forum.de", "board-114.html"),
    };
    const served = await listen((pathname) => {
      if (pathname === "/forum" || pathname === "/forum/") return index;
      const id = /\/forum\/board\/(\d+)-/.exec(pathname)?.[1];
      return id && boards[id] ? boards[id] : "<!DOCTYPE html><html><body></body></html>";
    });
    const origin = served.origin;
    const rewrite = (page: string) =>
      page
        .replaceAll("https://www.med2-forum.de", origin)
        .replaceAll("https://med2-forum.de", origin);
    const session = new HtmlBrowserSession();
    const original = session.pageHtml.bind(session);
    session.pageHtml = async () => rewrite(await original());
    try {
      const threads = await new WoltlabDriver().listThreads(session, `${origin}/`, {
        terms: [],
        activityDays: 400,
      });
      const titles = threads.map((thread) => thread.title);
      const at = (pattern: RegExp) => titles.findIndex((title) => pattern.test(title));
      expect(at(/wer versucht/i)).toBeGreaterThanOrEqual(0);
      expect(at(/wer versucht/i)).toBeLessThan(5);
      expect(at(/hashimoto/i)).toBeGreaterThanOrEqual(0);
      expect(at(/hashimoto/i)).toBeLessThan(5);
      expect(at(/verstopfung/i)).toBeGreaterThanOrEqual(0);
      expect(at(/verstopfung/i)).toBeLessThan(5);
      expect(at(/unklare symptome/i)).toBeGreaterThanOrEqual(0);
      expect(at(/unklare symptome/i)).toBeLessThan(25);
      const lounge = titles.findIndex((title) => /das cafe|plauderecke|spieleecke/i.test(title));
      const firstHealth = Math.min(at(/wer versucht/i), at(/hashimoto/i), at(/verstopfung/i));
      expect(lounge === -1 || lounge > firstHealth).toBe(true);
      expect(titles.slice(0, 5).join("\n")).not.toMatch(/das cafe|plauderecke|spieleecke/i);
    } finally {
      await served.close();
    }
  });

  it("includes the diabetes nutrition threads", async () => {
    const pages: Record<string, string> = {
      "/forum": html("diabetes-forum.de", "forum-index.html"),
      "/forum/": html("diabetes-forum.de", "forum-index.html"),
      "/forum/topics/3/Ernaehrung": html("diabetes-forum.de", "section-3-ernaehrung.html"),
      "/forum/topics/1/Allgemein": html("diabetes-forum.de", "section-1-allgemein.html"),
    };
    const served = await listen(
      (pathname) => pages[pathname] ?? "<!DOCTYPE html><html><body></body></html>",
    );
    const session = new HtmlBrowserSession();
    try {
      const threads = await new GenericFormDriver().listThreads(session, `${served.origin}/forum`, {
        terms: ["ernährung", "sport", "kinder"],
        activityDays: 400,
      });
      const urls = threads.map((thread) => thread.url).join("\n");
      expect(urls).toContain("/forum/topic/20533");
      expect(urls).toContain("/forum/topic/20558");
    } finally {
      await served.close();
    }
  });
});

describe("R3 relevance", () => {
  it("scores every use case and quotes the opener", () => {
    const topic = relevanceTopicsFromProject(project);
    const text = `${topic.tag}\n${topic.description}`;
    expect(text).toContain("Krafttraining");
    expect(text).toContain("Müdigkeit");
    expect(text).toContain("Krämpfe");
    expect(text).toContain("Immun");
    expect(text).toContain("Mangel");
    expect(topic.description.length).toBeLessThanOrEqual(1_500);
    const page = html("diabetes-forum.de", "glp1.html");
    const meta = threadMetaFromHtml(page, "markup", NOW, "Europe/Berlin");
    const excerpt = threadDiscussionExcerpt({
      title: "Supplements bei GLP-1 Therapien",
      opener: meta.firstPost,
      posts: meta.posts,
    });
    expect(excerpt.excerpt.startsWith("Supplements bei GLP-1 Therapien")).toBe(true);
    expect(excerpt.excerpt).toContain("Hallo liebes Forum");
    expect(excerpt.excerpt.includes("Anmelden Registrieren")).toBe(false);
  });

  it("keeps a new low-relevance row stored", () => {
    expect(rejectionIsStored("low_relevance")).toBe(true);
    expect(rejectionIsStored("meta_unreadable")).toBe(false);
    expect(
      selectThreadCandidate({
        relevance: 0.65,
        openQuestion: true,
        lastActivityAt: new Date("2026-10-16T17:00:00.000Z"),
        now: NOW,
        activityDays: 30,
        pageText: "Welche Ergänzung?",
        allowedDomains: [],
        laneId: null,
        excludedLaneIds: [],
        minRelevance: 0.6,
        requireOpenQuestion: false,
      }).selected,
    ).toBe(true);
    expect(
      selectThreadCandidate({
        relevance: 0.65,
        openQuestion: true,
        lastActivityAt: new Date("2026-10-16T17:00:00.000Z"),
        now: NOW,
        activityDays: 30,
        pageText: "Welche Ergänzung?",
        allowedDomains: [],
        laneId: null,
        excludedLaneIds: [],
      }),
    ).toEqual({ selected: false, rejectReason: "low_relevance" });
  });
});
