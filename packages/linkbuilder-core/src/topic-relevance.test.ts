import { describe, expect, it } from "vitest";
import { hasTerm, pageMatchesTopics, topicStatusForPage, topicTerms } from "./topic-relevance.js";

const project = {
  name: "Vitaminexpress",
  brandName: "Vitaminexpress",
  topicLanes: [
    {
      id: "lane",
      tag: "Magnesium",
      description:
        "A relevant forum is sleep, pain, cramps, sport and training, children, mood, pregnancy, deficiency, energy.",
      exampleQuestions: [],
    },
  ],
  targets: [
    {
      url: "https://example.com/magnesium",
      description: "",
      keywordClusters: ["Magnesium", "melatonin"],
    },
  ],
};

describe("topic relevance", () => {
  it("rejects a car title and a shop-only page, and keeps a health page", () => {
    const car = {
      title: "Community und Forum für BMW und Tuning",
      pageText:
        "Sportwagen und Motorsport. Eine flache Dachlinie macht noch keinen sportlichen BMW.",
    };
    const health = {
      title: "Schlaf und Sport",
      pageText: "Magnesium, Training und Kinder.",
    };
    const shop = { title: "Vitaminexpress", pageText: "Vitaminexpress" };
    expect(pageMatchesTopics(car, project)).toBe(false);
    expect(topicStatusForPage("qualified", car, project)).toBe("off_topic");
    expect(pageMatchesTopics(shop, project)).toBe(false);
    expect(pageMatchesTopics(health, project)).toBe(true);
    expect(topicStatusForPage("qualified", health, project)).toBe("qualified");
  });

  it("ignores topic tags that only repeat the search query", () => {
    expect(
      pageMatchesTopics(
        {
          title: "Gartenforum",
          pageText: "Tomaten und Beete.",
          topicTags: ["Kreatin Krafttraining Forum"],
        },
        project,
      ),
    ).toBe(false);
  });

  it("folds Nahrungsergänzung the same way on both sides", () => {
    const terms = topicTerms({
      topicLanes: [{ id: "sup", tag: "supplements", description: "", exampleQuestions: [] }],
    });
    const supplement = terms.find((term) => term.includes("nahrung"));
    expect(supplement).toBeTruthy();
    expect(hasTerm("Nahrungsergänzungsmittel", supplement ?? "")).toBe(true);
  });

  it("rejects a pickup title even when the body has a fitness section", () => {
    expect(
      pageMatchesTopics(
        {
          title: "Pickup Forum - The Pickup Artist Community",
          pageText: "Sport & Fitness. Supplements und Ernährung.",
        },
        project,
      ),
    ).toBe(false);
  });
});
