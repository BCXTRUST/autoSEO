import { describe, expect, it } from "vitest";
import { selectThreadCandidate } from "./drafting.js";

const now = new Date("2026-10-10T19:00:00.000Z");

function select(lastActivityAt: Date | null, activityDays = 30) {
  return selectThreadCandidate({
    relevance: 0.9,
    openQuestion: true,
    lastActivityAt,
    now,
    activityDays,
    pageText: "Welche Ergänzung im Winter?",
    allowedDomains: ["vitaminexpress.org"],
    laneId: null,
    excludedLaneIds: [],
  });
}

describe("selectThreadCandidate activity", () => {
  it("keeps a thread whose newest post is inside the month", () => {
    expect(select(new Date("2026-09-20T12:00:00.000Z"))).toEqual({ selected: true });
  });

  it("skips a thread whose newest post is from a previous year", () => {
    expect(select(new Date("2024-10-02T12:15:00.000Z"))).toEqual({
      selected: false,
      rejectReason: "inactive",
    });
  });

  it("skips a thread with no visible date", () => {
    expect(select(null)).toEqual({ selected: false, rejectReason: "inactive" });
  });

  it("lets a warmup reply join a thread that is not a question", () => {
    expect(
      selectThreadCandidate({
        relevance: 0.9,
        openQuestion: false,
        lastActivityAt: new Date("2026-09-20T12:00:00.000Z"),
        now,
        activityDays: 30,
        pageText: "Austausch zum Schlaf",
        allowedDomains: [],
        laneId: null,
        excludedLaneIds: [],
        requireOpenQuestion: false,
      }),
    ).toEqual({ selected: true });
  });
});
