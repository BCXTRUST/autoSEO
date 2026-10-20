import { describe, expect, it } from "vitest";
import { footprintQuery, planDiscoveryQueries, planFootprintQueries } from "./discovery.js";

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
