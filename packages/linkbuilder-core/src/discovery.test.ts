import { describe, expect, it } from "vitest";
import {
  discoverHosts,
  footprintQuery,
  planDiscoveryQueries,
  planFootprintQueries,
  prioritizeResearchUrls,
} from "./discovery.js";

const de = {
  country: "DE" as const,
  language: "de" as const,
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
};

describe("footprint planning", () => {
  it("searches the human problem instead of the product keyword", () => {
    const planned = planFootprintQueries({
      lanes: [
        {
          id: "lane-mg",
          tag: "Magnesium kaufen",
          description: "Shop page",
          exampleQuestions: [],
        },
      ],
      markets: [de],
      policy: "primary_only",
      supply: {},
      need: 1,
    });
    const queries = planned.map((item) => item.query);
    expect(queries.some((query) => query.includes("Magnesium Krämpfe Forum"))).toBe(true);
    expect(queries.join("\n")).not.toMatch(/kaufen|vitaminexpress/i);
  });

  it("keeps the lane tag when the catalog has no mapped problem", () => {
    const planned = planFootprintQueries({
      lanes: [
        {
          id: "lane-ruecken",
          tag: "Rückenschmerzen",
          description: "Erfahrungen",
          exampleQuestions: [],
        },
      ],
      markets: [de],
      policy: "primary_only",
      supply: {},
      need: 1,
    });
    expect(planned.map((item) => item.query)).toEqual([footprintQuery("Rückenschmerzen")]);
  });

  it("sends at most eight problem queries and never a ninth", () => {
    const queries = planDiscoveryQueries(["Magnesium Schlaf", "Vitamin D", "Gelenkschmerzen"], 8);
    expect(queries).toHaveLength(8);
    expect(queries[0]).toBe("Magnesium Schlaf Forum");
    expect(queries.some((query) => query.includes("Registrieren"))).toBe(true);
    expect(queries.some((query) => /vitaminexpress/i.test(query))).toBe(false);
  });
});

describe("project language gate", () => {
  it("checks XenForo terms before qualifying a matching English forum", async () => {
    const hosts = await discoverHosts({
      lanes: [{ id: "meditation", tag: "Meditation", description: "", exampleQuestions: [] }],
      markets: [{ country: "US", language: "en", locale: "en-US", timezoneId: "America/New_York" }],
      policy: "primary_only",
      supply: {},
      need: 1,
      search: async () => [
        { url: "https://board.example/threads/meditation.123/", title: "Meditation", snippet: "" },
      ],
      fetchText: async (url) =>
        url.endsWith("/help/terms/")
          ? '<html lang="en"><p>You may not automate access to the forum.</p></html>'
          : '<html lang="en"><body data-xf-init=""><a href="/register/">Register</a><p>Meditation discussion</p></body></html>',
    });
    expect(hosts[0]).toMatchObject({ status: "denied", reason: "automation_forbidden" });
  });
  it("keeps the forum subdomain instead of visiting the marketing homepage", async () => {
    const visited: string[] = [];
    const hosts = await discoverHosts({
      lanes: [
        { id: "wellness", tag: "Meditation", description: "Relaxation", exampleQuestions: [] },
      ],
      markets: [{ country: "US", language: "en", locale: "en-US", timezoneId: "America/New_York" }],
      policy: "primary_only",
      supply: {},
      need: 1,
      search: async () => [
        {
          url: "https://forum.community.example/viewtopic.php?t=1",
          title: "Meditation",
          snippet: "",
        },
      ],
      fetchText: async (url) => {
        visited.push(url);
        return '<html lang="en"><body>phpBB <a href="/ucp.php?mode=register">Register</a></body></html>';
      },
    });
    expect(visited[0]).toBe("https://forum.community.example/");
    expect(hosts[0]?.homepageUrl).toBe("https://forum.community.example/");
    expect(hosts[0]?.facts.registerUrl).toContain("https://forum.community.example/");
  });
  it.each(["en", "de", "fr", null])(
    "checks a %s page against the English market",
    async (language) => {
      const hosts = await discoverHosts({
        lanes: [
          { id: "wellness", tag: "Meditation", description: "Relaxation", exampleQuestions: [] },
        ],
        markets: [
          { country: "US", language: "en", locale: "en-US", timezoneId: "America/New_York" },
        ],
        policy: "primary_only",
        supply: {},
        need: 1,
        search: async () => [
          { url: "https://forum.example/viewtopic.php?t=1", title: "Meditation", snippet: "" },
        ],
        fetchText: async () =>
          `<html ${language ? `lang="${language}"` : ""}><body>phpBB <a href="/ucp.php?mode=register">Register</a><a href="/viewtopic.php?t=1">Meditation questions</a></body></html>`,
      });
      expect(hosts[0]?.reason).toBe(language === "en" ? null : `language:${language ?? "unknown"}`);
      expect(hosts[0]?.status).toBe(language === "en" ? "qualified" : "off_topic");
    },
  );
  it("does not use German registration terms for English searches", () => {
    const queries = planDiscoveryQueries(["Meditation"], 8, "en");
    expect(queries.join(" ")).not.toContain("Registrieren");
    expect(queries.join(" ")).toContain("register");
  });
  it("spreads English searches across topics, rotates later batches, and excludes broad platforms", () => {
    const first = planDiscoveryQueries(
      ["frequency wellness forum", "PEMF forum", "meditation forum"],
      3,
      "en",
    );
    expect(first.map((query) => query.split(" (")[0])).toEqual([
      "frequency wellness",
      "PEMF",
      "meditation",
    ]);
    expect(
      first.every((query) => query.includes("inurl:") && query.includes("-site:youtube.com")),
    ).toBe(true);
    expect(first.join(" ")).not.toMatch(/forum Forum/i);
    expect(
      planDiscoveryQueries(
        ["frequency wellness forum", "PEMF forum", "meditation forum"],
        3,
        "en",
        3,
      ),
    ).not.toEqual(first);
  });
});

describe("bounded research shortlist", () => {
  it("prefers discussion URLs and deduplicates their marketing domains before applying the cap", () => {
    expect(
      prioritizeResearchUrls(
        [
          "https://shop.example/",
          "https://brand.example/",
          "https://forum.brand.example/viewtopic.php?t=1",
          "https://community.other.example/questions",
        ],
        [],
        2,
      ),
    ).toEqual([
      "https://forum.brand.example/viewtopic.php?t=1",
      "https://community.other.example/questions",
    ]);
  });
  it("does not spend the batch on excluded or previously reviewed sites", () => {
    expect(
      prioritizeResearchUrls(
        [
          "https://forum.brand.example/viewtopic.php?t=1",
          "https://forum.other.example/viewtopic.php?t=2",
          "javascript:alert(1)",
        ],
        ["brand.example"],
        20,
      ),
    ).toEqual(["https://forum.other.example/viewtopic.php?t=2"]);
  });
});
