import { describe, expect, it } from "vitest";
import {
  boardTopicQueries,
  matchDeepLink,
  pageKind,
  primaryProblemQuery,
  queryOmitsShop,
  relevanceTopicFromProject,
  searchedGoogleLine,
  useCaseLanes,
} from "./problem-queries.js";

const magnesium = {
  name: "Vitaminexpress",
  brandName: "Vitaminexpress",
  topic: "Magnesium kaufen",
  keywords: ["magnesium kaufen"],
  pages: [
    { url: "https://www.vitaminexpress.org/de/magnesium", keyword: "Magnesium" },
    {
      url: "https://www.vitaminexpress.org/de/welches-magnesium-ist-das-beste",
      keyword: "Welches Magnesium",
    },
    { url: "https://www.vitaminexpress.org/de/magnesium-kaufen", keyword: "Magnesium kaufen" },
  ],
};

describe("problem queries", () => {
  it("searches the magnesium problem and leaves the shop name out", () => {
    const query = primaryProblemQuery(magnesium);
    expect(query).toBe("Magnesium Krämpfe Forum");
    expect(boardTopicQueries(magnesium)).toEqual(["Magnesium Krämpfe", "Magnesium"]);
    expect(
      relevanceTopicFromProject({
        topicLanes: [{ tag: "Magnesium kaufen", description: "Shop page" }],
      }),
    ).toEqual({
      tag: "Krämpfe",
      description:
        "Threads about Krämpfe are on topic. Magnesium is one possible answer. The thread does not have to name Magnesium.",
    });
    expect(queryOmitsShop(query ?? "", ["Vitaminexpress"])).toBe(true);
    expect(query).not.toMatch(/vitaminexpress|kaufen/i);
    const lanes = useCaseLanes(magnesium);
    expect(lanes.map((lane) => lane.query)).toEqual(
      expect.arrayContaining(["Magnesium Krämpfe Forum", "Magnesium Schlaf Forum Deutschland"]),
    );
    expect(lanes.every((lane) => lane.market === "DE")).toBe(true);
    expect(lanes.every((lane) => !/vitaminexpress|kaufen/i.test(lane.query))).toBe(true);
    expect(lanes[0]?.destinationUrl).toBe("https://www.vitaminexpress.org/de/magnesium");
    expect(lanes[0]?.destinationKind).toBe("ratgeber");
  });

  it("does not invent a query from the shop name alone", () => {
    expect(primaryProblemQuery({ brandName: "Vitaminexpress", name: "Vitaminexpress" })).toBeNull();
    expect(
      primaryProblemQuery({
        brandName: "Vitaminexpress",
        keywords: ["forum-abc.example", "https://brett.example/topic"],
      }),
    ).toBeNull();
  });

  it("turns each catalog product into German problems and leaves problem searches unlinked", () => {
    const creatin = useCaseLanes({
      brandName: "Vitaminexpress",
      keywords: ["Kreatin EEM", "folsäure kaufen", "k2 vitamin", "vitamin b"],
      pages: [
        { url: "https://www.vitaminexpress.org/at/creatin", keyword: "Kreatin EEM" },
        { url: "https://www.vitaminexpress.org/at/folsaeure-kaufen", keyword: "folsäure kaufen" },
        { url: "https://www.vitaminexpress.org/de/vitamin-k2", keyword: "k2 vitamin" },
        {
          url: "https://www.vitaminexpress.org/at/vitamin-b-complex-vitamin-b-kapseln",
          keyword: "vitamin b",
        },
      ],
    });
    const queries = creatin.map((lane) => lane.query);
    expect(queries).toEqual(
      expect.arrayContaining([
        "Kreatin Krafttraining Forum",
        "Folsäure Mangel Forum",
        "Vitamin D Mangel Forum",
        "Vitamin B Müdigkeit Forum",
      ]),
    );
    expect(queries.every((query) => !/vitaminexpress|kaufen/i.test(query))).toBe(true);
    expect(creatin.find((lane) => lane.nutrient === "Kreatin")?.destinationUrl).toBe(
      "https://www.vitaminexpress.org/at/creatin",
    );
    expect(useCaseLanes({ keywords: ["vitamin b"] }).some((lane) => /B12/.test(lane.query))).toBe(
      false,
    );
    expect(
      useCaseLanes({ keywords: ["vitamin b12"] }).some((lane) => lane.nutrient === "Vitamin B"),
    ).toBe(false);
    for (const keyword of ["Stimmungsaufheller", "Tipps zum Einschlafen"]) {
      const lanes = useCaseLanes({ keywords: [keyword] });
      expect(lanes.length).toBeGreaterThan(1);
      expect(lanes.every((lane) => lane.destinationUrl === null)).toBe(true);
      expect(lanes.every((lane) => !/vitaminexpress|kaufen/i.test(lane.query))).toBe(true);
    }
  });

  it("uses the brief templates for the other catalog lanes", () => {
    const lanes = useCaseLanes({
      keywords: ["Vitamin D Mangel", "Melatonin Schlaf", "Glucosamin Gelenke"],
    });
    expect(lanes.map((lane) => lane.query)).toEqual(
      expect.arrayContaining([
        "Vitamin D Mangel Forum",
        "Schlafprobleme Forum Melatonin",
        "Gelenkschmerzen Forum Glucosamin",
      ]),
    );
  });

  it("matches one deep URL to the thread", () => {
    const targets = magnesium.pages.map((page) => ({ url: page.url }));
    expect(pageKind(targets[0]?.url ?? "")).toBe("ratgeber");
    expect(pageKind(targets[2]?.url ?? "")).toBe("buy");
    const advice = matchDeepLink({
      threadText: "Welche Magnesiumform hilft bei nächtlichen Krämpfen?",
      targets,
    });
    const buy = matchDeepLink({
      threadText: "Wo kann ich Magnesium kaufen ohne große Dosen?",
      targets,
    });
    expect(advice).toBe("https://www.vitaminexpress.org/de/magnesium");
    expect(buy).toBe("https://www.vitaminexpress.org/de/magnesium-kaufen");
    expect(advice).not.toBe(buy);
    expect(
      matchDeepLink({
        threadText: "Vitamin D Mangel im Winter, welche Dosis?",
        targets,
      }),
    ).toBeNull();
    expect(searchedGoogleLine("Magnesium Krämpfe Forum")).toBe(
      "Searched Google.de for Magnesium Krämpfe Forum",
    );
  });
});
