import { describe, expect, it } from "vitest";
import {
  desktopShowsForumSearch,
  desktopShowsProblemSearch,
  forumSearchQuery,
  forumSearchUrl,
  forumSearchUrlFromProject,
} from "./forum-search.js";

describe("forum search", () => {
  it("searches Google.de for the human problem, not the shop", () => {
    const url = forumSearchUrlFromProject({
      name: "Vitaminexpress",
      brandName: "Vitaminexpress",
      topicLanes: [{ tag: "Magnesium kaufen", description: "Questions about magnesium" }],
      targets: [
        {
          url: "https://www.vitaminexpress.org/de/magnesium",
          keywordClusters: ["magnesium kaufen"],
        },
      ],
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.google.de/search");
    expect(parsed.searchParams.get("q")).toBe("Magnesium Krämpfe Forum");
    expect(parsed.searchParams.get("hl")).toBe("de");
    expect(parsed.searchParams.get("gl")).toBe("de");
    expect(url).not.toMatch(/vitaminexpress|kaufen|\.example/i);
  });

  it("drops the shop name and example hosts", () => {
    expect(
      forumSearchQuery({
        brandName: "Vitaminexpress",
        topic: "forum-abc123.example",
        name: "fragen-abc123.example",
        keywords: ["brett-abc123.example", "https://boards.example/topic"],
      }),
    ).toBe("on-topic forums");
    expect(
      forumSearchQuery({
        brandName: "Vitaminexpress",
        name: "Vitaminexpress",
        topic: "Magnesium kaufen",
      }),
    ).toBe("Magnesium Krämpfe Forum");
  });

  it("does not invent a host when the project has no real topic", () => {
    const url = forumSearchUrl({
      brandName: "forum-1.example",
      name: "brett-1.example",
    });
    expect(new URL(url).searchParams.get("q")).toBe("on-topic forums");
    expect(url).not.toContain(".example");
    expect(url).toContain("https://www.google.de/search");
  });

  it("treats a Google search window as the working page", () => {
    expect(desktopShowsForumSearch(["Magnesium Krämpfe Forum - Google Suche"])).toBe(true);
    expect(desktopShowsForumSearch(["Magnesium Krämpfe Forum - Google Search"])).toBe(true);
    expect(desktopShowsForumSearch(["Google"])).toBe(false);
    expect(desktopShowsForumSearch(["https://www.google.com/"])).toBe(false);
    expect(desktopShowsForumSearch(["New Tab - Google Chrome"])).toBe(false);
    expect(desktopShowsForumSearch(["Unusual traffic from your computer"])).toBe(false);
    expect(desktopShowsForumSearch(["Welcome to Google Chrome"])).toBe(false);
    expect(desktopShowsForumSearch(["Can't update Chrome"])).toBe(false);
    expect(desktopShowsForumSearch(["Home", "Trash"])).toBe(false);
    expect(desktopShowsForumSearch([])).toBe(false);
  });

  it("replaces a shop search and keeps the problem query", () => {
    const query = "Magnesium Krämpfe Forum";
    expect(
      desktopShowsProblemSearch(["Vitaminexpress Magnesium kaufen forum - Google Search"], query, [
        "Vitaminexpress",
      ]),
    ).toBe(false);
    expect(
      desktopShowsProblemSearch(["Magnesium Krämpfe Forum - Google Suche"], query, [
        "Vitaminexpress",
      ]),
    ).toBe(true);
    expect(desktopShowsProblemSearch(["Can't update Chrome"], query, ["Vitaminexpress"])).toBe(
      false,
    );
  });
});
