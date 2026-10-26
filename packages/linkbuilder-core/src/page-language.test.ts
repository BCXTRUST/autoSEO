import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverHosts } from "./discovery.js";
import { detectLanguage } from "./page-language.js";
import { sampleForumHtml } from "./probe.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const market = {
  country: "DE" as const,
  language: "de" as const,
  locale: "de-DE" as const,
  timezoneId: "Europe/Berlin",
};

const lane = {
  id: "lane",
  tag: "Magnesium",
  description: "Schlaf und Sport",
  exampleQuestions: [],
};

describe("detectLanguage", () => {
  it("recognizes substantial English discussion text without a language tag", () => {
    const text =
      "This is our community where you can share your experience with others. What have you tried and how has that worked for you? We are here to learn from their questions about sleep and meditation, and not to offer medical advice. The discussion should include what you know about the research and how this can help our understanding.";
    expect(
      detectLanguage(`<html><body>${text}</body></html>`, "https://board.example/").language,
    ).toBe("en");
  });
  it.each([
    "Checking your browser. Please wait.",
    "Please enable JavaScript to continue.",
    "meditation frequency wellness PEMF research technology ".repeat(20),
    "Bienvenue sur notre communauté pour discuter de votre santé et partager vos expériences avec les autres membres. ".repeat(
      8,
    ),
  ])("does not infer English from insufficient or unrelated text", (text) => {
    expect(
      detectLanguage(`<html><body>${text}</body></html>`, "https://board.example/").language,
    ).not.toBe("en");
  });
  it("rejects a misleading English tag when the visible page is Chinese", () => {
    expect(
      detectLanguage(
        `<html lang="en-US"><body>${"教育學習研究醫護數位跨域專業人才 ".repeat(15)}</body></html>`,
        "https://college.example/",
      ).language,
    ).toBe("zh");
  });
  it("reads English from the fitness.com register page", () => {
    const html = readFileSync(
      path.resolve(here, "../../../apps/worker/test/fixtures/forums/fitness.com/register.html"),
      "utf8",
    );
    expect(detectLanguage(html, "https://www.fitness.com/register")).toEqual({
      language: "en",
      country: null,
    });
  });

  it("reads German stopwords and an Austrian host", () => {
    const html = `<html lang="de"><body><p>Ich bin mit der Therapie nicht zufrieden und der Arzt ist heute nicht da.</p></body></html>`;
    expect(detectLanguage(html, "https://forum.example.at/")).toEqual({
      language: "de",
      country: "AT",
    });
  });
});

describe("discoverHosts language gate", () => {
  it("marks an English board off-topic and keeps a German board", async () => {
    const english = readFileSync(
      path.resolve(here, "../../../apps/worker/test/fixtures/forums/fitness.com/register.html"),
      "utf8",
    );
    const german = sampleForumHtml({ platform: "phpbb" }).replace(
      "<html>",
      `<html lang="de"><body><p>Ich und der Sport und das Training ist nicht nur Magnesium.</p>`,
    );
    const hosts = await discoverHosts({
      lanes: [lane],
      markets: [market],
      policy: "primary_only",
      supply: {},
      need: 1,
      depth: 20,
      search: async (request) => {
        expect(request.depth).toBe(20);
        return [
          { url: "https://www.fitness.com/register", title: "Fitness", snippet: "" },
          { url: "https://magnesium-forum.de/viewtopic.php?t=1", title: "Magnesium", snippet: "" },
        ];
      },
      fetchText: async (url) => {
        if (url.includes("fitness.com")) return english;
        if (url.includes("magnesium-forum.de")) return german;
        return null;
      },
    });
    const fitness = hosts.find((host) => host.registrableDomain === "fitness.com");
    const board = hosts.find((host) => host.registrableDomain === "magnesium-forum.de");
    expect(fitness).toMatchObject({ status: "off_topic", reason: "language:en" });
    expect(fitness?.market.language).toBe("en");
    expect(board?.market.language).toBe("de");
    expect(board?.market.country).toBe("DE");
    expect(board?.status).not.toBe("off_topic");
  });

  it("marks a portal that is not a forum off-topic", async () => {
    const portal = `<html lang="de"><head><title>AOK Ratgeber</title></head><body>
<p>Ich und der Arzt und das ist nicht ein Forum. Der Rücken ist heute nicht besser.</p>
<a href="/register">Registrieren</a>
<a href="/ratgeber/ruecken">Rückenschmerzen</a>
</body></html>`;
    const hosts = await discoverHosts({
      lanes: [lane],
      markets: [market],
      policy: "primary_only",
      supply: {},
      need: 1,
      search: async () => [
        { url: "https://www.aok.de/ratgeber/ruecken", title: "AOK", snippet: "" },
      ],
      fetchText: async (url) => (url.includes("aok.de") ? portal : null),
    });
    expect(hosts.find((host) => host.registrableDomain === "aok.de")).toMatchObject({
      status: "off_topic",
      reason: "not_forum",
    });
  });
});
