import { describe, expect, it } from "vitest";
import {
  fakeDomains,
  foundForumLine,
  foundThreadLine,
  isCannedResearchLine,
  isFixtureHostDomain,
  planFakeStep,
  problemSearchAction,
  replayFakeScript,
  researchLogLines,
} from "./fake-scenario.js";

const now = new Date("2026-10-05T17:00:00.000Z");
const input = {
  seed: "project-seed",
  now,
  markets: [
    {
      country: "DE" as const,
      language: "de",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    },
  ],
  brandName: "Nordlicht",
  targetUrl: "https://nordlicht.example/schlaf",
  quotas: { livePerDay: 1, liveWeekCap: 5 },
  countNofollow: true,
};

describe("fake scenario", () => {
  it("is deterministic for a seed", () => {
    const first = replayFakeScript(input);
    const second = replayFakeScript({ ...input, now: new Date("2026-10-06T17:00:00.000Z") });
    expect(first.map((step) => step.kind)).toEqual(second.map((step) => step.kind));
    expect(fakeDomains(input.seed)).toEqual(fakeDomains(input.seed));
    expect(fakeDomains("other")).not.toEqual(fakeDomains(input.seed));
  });

  it("holds instead of replaying the three canned lines", () => {
    expect(replayFakeScript(input)).toEqual([]);
    expect(isCannedResearchLine("Checking Google for on-topic forums")).toBe(true);
    expect(isCannedResearchLine("Looking for threads")).toBe(true);
    expect(isCannedResearchLine("Continuing")).toBe(true);
    const held = planFakeStep({
      ...input,
      stepIndex: 3,
      researchBeats: 4,
      stageBeats: 4,
      previousAction: "Continuing",
    });
    expect(held).toEqual({ hold: true });
    const again = planFakeStep({
      ...input,
      stepIndex: 20,
      researchBeats: 6,
      previousAction: "Checking Google for on-topic forums",
    });
    expect(again).toEqual({ hold: true });
    expect(problemSearchAction("Vitaminexpress Magnesium kaufen forum", "Vitaminexpress")).toBe(
      null,
    );
    const searched = replayFakeScript({
      ...input,
      brandName: "Vitaminexpress",
      searchQuery: "Magnesium Krämpfe Forum",
    });
    expect(searched.map((step) => step.lastAction)).toEqual([
      "Searched Google.de for Magnesium Krämpfe Forum",
    ]);
    expect(searched.every((step) => step.host === undefined && step.placement === undefined)).toBe(
      true,
    );
  });

  it("writes a found line only when the name is real", () => {
    expect(foundForumLine(null)).toBeNull();
    expect(foundForumLine(" ")).toBeNull();
    expect(foundForumLine("forum-abc.example")).toBeNull();
    expect(foundForumLine("fragen-1ej2xe.example")).toBeNull();
    expect(foundThreadLine("brett-1ej2xe.example")).toBeNull();
    expect(foundThreadLine("thread.example")).toBeNull();
    expect(foundForumLine("gutefrage.net")).toBe("Found forum gutefrage.net");
    expect(foundThreadLine("Vitamin D im Winter?")).toBe("Found Vitamin D im Winter?");
    expect(foundThreadLine("[3.3] Fehler bei E-Mail Versand")).toBeNull();
    expect(
      researchLogLines({ forumName: "gutefrage.net", threadName: "Vitamin D im Winter?" }),
    ).toEqual(["Found forum gutefrage.net", "Found Vitamin D im Winter?"]);
    const invented = researchLogLines({
      forumName: "forum-a.example",
      threadName: "On https://brett-a.example/t/1",
    });
    expect(invented.join("\n")).not.toContain(".example");
    expect(invented.some((line) => line.startsWith("Found"))).toBe(false);
    expect(invented).not.toContain("Looking for threads");
    expect(invented).not.toContain("Continuing");
    const named = planFakeStep({
      ...input,
      stepIndex: 1,
      researchBeats: 1,
      previousAction: "Checking Google for on-topic forums",
      forumName: "gutefrage.net",
    });
    expect(named).toMatchObject({ lastAction: "Found forum gutefrage.net" });
    const foundThread = planFakeStep({
      ...input,
      stepIndex: 2,
      researchBeats: 2,
      previousAction: "Found forum gutefrage.net",
      forumName: "gutefrage.net",
      threadName: "Vitamin D im Winter?",
    });
    expect(foundThread).toMatchObject({ lastAction: "Found Vitamin D im Winter?" });
    const done = planFakeStep({
      ...input,
      stepIndex: 4,
      previousAction: "Found Vitamin D im Winter?",
      forumName: "gutefrage.net",
      threadName: "Vitamin D im Winter?",
    });
    expect(done).toEqual({ hold: true });
    const skipped = planFakeStep({
      ...input,
      stepIndex: 1,
      researchBeats: 1,
      previousAction: "Checking Google for on-topic forums",
      forumName: "forum-a.example",
      threadName: "thread.example",
    });
    expect(JSON.stringify(skipped)).not.toContain(".example");
    expect(skipped).toEqual({ hold: true });
  });

  it("treats the offline boards as fixtures and leaves real domains alone", () => {
    const [forum, fragen, brett] = Object.values(fakeDomains(input.seed));
    expect(isFixtureHostDomain(forum!)).toBe(true);
    expect(isFixtureHostDomain(fragen!)).toBe(true);
    expect(isFixtureHostDomain(brett!)).toBe(true);
    expect(isFixtureHostDomain("fragen.nordlicht.example")).toBe(false);
    expect(isFixtureHostDomain("www.vitaminexpress.org")).toBe(false);
  });

  it("plans a single step that matches the replay", () => {
    const replayed = replayFakeScript({
      ...input,
      forumName: "gutefrage.net",
      threadName: "Vitamin D im Winter?",
    });
    expect(replayed.map((step) => step.lastAction)).toEqual([
      "Found forum gutefrage.net",
      "Found Vitamin D im Winter?",
    ]);
    expect(replayed.every((step) => step.host === undefined && step.placement === undefined)).toBe(
      true,
    );
    expect(replayed.every((step) => step.kind === "research")).toBe(true);
    expect(
      planFakeStep({
        ...input,
        stepIndex: 1,
        researchBeats: 1,
        previousAction: replayed[0]?.lastAction,
        forumName: "gutefrage.net",
        threadName: "Vitamin D im Winter?",
      }),
    ).toEqual(replayed[1]);
    expect(
      planFakeStep({
        ...input,
        stepIndex: 2,
        researchBeats: 2,
        previousAction: replayed[1]?.lastAction,
        forumName: "gutefrage.net",
        threadName: "Vitamin D im Winter?",
      }),
    ).toEqual({ hold: true });
  });
});
