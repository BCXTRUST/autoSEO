import { describe, expect, it } from "vitest";
import { Campaign, CampaignActivity, CampaignConfigInput } from "./index.js";

const config = {
  name: "  Link campaign  ",
  websiteUrl: "https://example.test/products",
  language: " en ",
  market: " US ",
  objective: "Share useful resources with relevant communities.",
  dailyRegistrationLimit: 0,
  dailyPublicationLimit: 3,
  dailySpendLimitMicros: 0,
  requirePublicationReview: true,
};

describe("campaign contracts", () => {
  it("accepts and normalizes a safe campaign configuration", () => {
    expect(CampaignConfigInput.parse(config)).toMatchObject({
      name: "Link campaign",
      language: "en",
      market: "US",
      dailyRegistrationLimit: 0,
    });
  });

  it.each([
    "ftp://example.test/",
    "javascript:alert(1)",
    "https://user:password@example.test/",
    "https://example.test/",
  ])("validates website URLs and rejects unsafe or credential-bearing values: %s", (websiteUrl) => {
    const result = CampaignConfigInput.safeParse({ ...config, websiteUrl });
    expect(result.success).toBe(websiteUrl === "https://example.test/");
  });

  it.each([
    { dailyRegistrationLimit: -1 },
    { dailyPublicationLimit: 1001 },
    { dailySpendLimitMicros: -1 },
    { dailySpendLimitMicros: Number.MAX_SAFE_INTEGER + 1 },
    { requirePublicationReview: false },
  ])("rejects invalid execution limits or review policy: %o", (override) => {
    expect(CampaignConfigInput.safeParse({ ...config, ...override }).success).toBe(false);
  });

  it("parses campaign and safe activity DTOs", () => {
    const parsed = Campaign.parse({
      id: "camp_1",
      workspaceId: "ws_1",
      config,
      status: "active",
      mode: "research",
      revision: 1,
      createdAt: "2026-11-02T12:00:00.000Z",
      updatedAt: "2026-11-02T12:00:00.000Z",
    });
    expect(parsed.config.name).toBe("Link campaign");

    expect(
      CampaignActivity.parse({
        id: "event_1",
        campaignId: "camp_1",
        sequence: 1,
        type: "step_deferred",
        summary: "The page timed out; another opportunity can proceed.",
        occurredAt: "2026-11-02T12:01:00.000Z",
        stepId: "step_1",
      }),
    ).toMatchObject({ type: "step_deferred", sequence: 1 });
  });

  it("rejects raw activity payloads and invalid revisions", () => {
    const activity = {
      id: "event_1",
      campaignId: "camp_1",
      sequence: 1,
      type: "step_started",
      summary: "A step has started.",
      occurredAt: "2026-11-02T12:01:00.000Z",
      payload: { token: "secret-value" },
    };
    expect(CampaignActivity.safeParse(activity).success).toBe(false);
    expect(
      Campaign.safeParse({
        id: "camp_1",
        workspaceId: "ws_1",
        config,
        status: "active",
        mode: "research",
        revision: 0,
        createdAt: "2026-11-02T12:00:00.000Z",
        updatedAt: "2026-11-02T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
