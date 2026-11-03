import { describe, expect, it } from "vitest";
import { mergeCampaignSnapshots } from "./campaign-data";
import type { CampaignStateSnapshot } from "./campaign-types";

function snapshot(overrides: Partial<CampaignStateSnapshot> = {}): CampaignStateSnapshot {
  return {
    campaign: {
      id: "campaign-1",
      workspaceId: "workspace-1",
      status: "active",
      mode: "research",
      revision: 1,
      config: {
        name: "Research",
        websiteUrl: "https://example.com",
        language: "English",
        market: "US",
        objective: "Find useful sources",
        dailyRegistrationLimit: 0,
        dailyPublicationLimit: 0,
        dailySpendLimitMicros: 0,
        requirePublicationReview: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    items: [],
    jobs: [],
    activities: [],
    observedAt: "2026-01-01T00:00:00.000Z",
    nextCursor: 0,
    hasMore: false,
    ...overrides,
  };
}

describe("campaign snapshot merge", () => {
  it("preserves durable activity and entities when an incremental page is empty", () => {
    const initial = snapshot({
      activities: [
        {
          id: "event-1",
          campaignId: "campaign-1",
          sequence: 1,
          type: "campaign_created",
          summary: "Campaign created",
          occurredAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      items: [
        {
          id: "item-1",
          campaignId: "campaign-1",
          kind: "source",
          url: "https://example.com",
          title: "Home",
          body: "",
          status: "queued",
          details: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const merged = mergeCampaignSnapshots(initial, snapshot({ nextCursor: 1 }));

    expect(merged.activities.map((event) => event.id)).toEqual(["event-1"]);
    expect(merged.items.map((item) => item.id)).toEqual(["item-1"]);
  });

  it("deduplicates overlapping cursor pages and keeps events in sequence order", () => {
    const first = snapshot({
      activities: [
        {
          id: "event-1",
          campaignId: "campaign-1",
          sequence: 1,
          type: "campaign_created",
          summary: "Created",
          occurredAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "event-2-old",
          campaignId: "campaign-1",
          sequence: 2,
          type: "step_started",
          summary: "Started",
          occurredAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    const next = snapshot({
      activities: [
        {
          id: "event-2",
          campaignId: "campaign-1",
          sequence: 2,
          type: "step_started",
          summary: "Updated started event",
          occurredAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "event-3",
          campaignId: "campaign-1",
          sequence: 3,
          type: "step_completed",
          summary: "Completed",
          occurredAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      nextCursor: 3,
    });

    const merged = mergeCampaignSnapshots(first, next);

    expect(merged.activities.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(merged.activities[1]!.id).toBe("event-2");
    expect(merged.activities[1]!.summary).toBe("Updated started event");
  });
});
