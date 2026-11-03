import { describe, expect, it } from "vitest";
import { campaignRecoveryActions } from "./campaign-recovery";
import type { CampaignItem, CampaignJob } from "./campaign-types";

const item = (status: CampaignItem["status"]): CampaignItem => ({
  id: "source-1",
  campaignId: "campaign-1",
  kind: "source",
  url: "https://example.com",
  title: "Example",
  body: "",
  status,
  details: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const job = (status: CampaignJob["status"]): CampaignJob => ({
  id: "job-1",
  itemId: "source-1",
  operation: "research_source",
  status,
  attemptCount: 1,
  maxAttempts: 3,
  availableAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  heartbeatAt: null,
  deadlineAt: null,
  lastError: null,
});

describe("campaign recovery controls", () => {
  it("offers only server-eligible controls for a queued research source", () => {
    expect(campaignRecoveryActions(item("queued"), job("queued"), "research")).toEqual([
      "retry",
      "defer",
      "skip",
    ]);
  });

  it("allows defer and skip while research is running, but does not advertise retry", () => {
    expect(campaignRecoveryActions(item("researching"), job("running"), "research")).toEqual([
      "defer",
      "skip",
    ]);
  });

  it("offers recovery for blocked catalog guidance without changing paid ambiguity rules", () => {
    expect(
      campaignRecoveryActions(
        item("needs_action"),
        { ...job("needs_action"), operation: "catalog_page" },
        "research",
      ),
    ).toEqual(["retry", "defer", "skip"]);
    expect(
      campaignRecoveryActions(
        item("queued"),
        { ...job("queued"), operation: "challenge_solve" },
        "research",
      ),
    ).toEqual([]);
  });

  it("keeps explicit retry available for a failed optional catalog probe", () => {
    const probe = {
      ...item("failed"),
      details: {
        catalog: {
          runId: "a".repeat(64),
          rootUrl: "https://example.com/",
          purpose: "page",
          category: "llm",
          provenance: "conventional_probe",
          depth: 0,
        },
      },
    };
    expect(
      campaignRecoveryActions(
        probe,
        { ...job("failed"), operation: "catalog_page", lastError: "page_absent" },
        "research",
      ),
    ).toEqual(["retry", "defer", "skip"]);
  });

  it("offers read recovery for discovery searches and inspection failures", () => {
    expect(
      campaignRecoveryActions(
        item("failed"),
        { ...job("failed"), operation: "discovery_search" },
        "research",
      ),
    ).toEqual(["retry", "defer", "skip"]);
    expect(
      campaignRecoveryActions(
        item("needs_action"),
        { ...job("needs_action"), operation: "discovery_inspect" },
        "research",
      ),
    ).toEqual(["retry", "defer", "skip"]);
  });

  it("hides retry for uncertain paid results, including work superseded by a website change", () => {
    expect(
      campaignRecoveryActions(
        item("needs_action"),
        {
          ...job("needs_action"),
          operation: "research_opportunity",
          lastError: "ai_result_ambiguous",
        },
        "research",
      ),
    ).toEqual(["defer", "skip"]);
    expect(
      campaignRecoveryActions(
        item("needs_action"),
        {
          ...job("needs_action"),
          operation: "research_opportunity",
          lastError: "website_changed_uncertain_model_result",
        },
        "research",
      ),
    ).toEqual(["defer", "skip"]);
  });

  it("hides recovery actions for controlled fixture campaigns and unsupported states", () => {
    expect(campaignRecoveryActions(item("queued"), job("queued"), "controlled")).toEqual([]);
    expect(campaignRecoveryActions(item("verified"), job("succeeded"), "research")).toEqual([]);
    expect(campaignRecoveryActions(item("failed"), undefined, "research")).toEqual([]);
  });
});
