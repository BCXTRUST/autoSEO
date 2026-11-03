import { describe, expect, it } from "vitest";
import {
  type CampaignFailureDecisionInput,
  decideCampaignFailure,
  type SelectCampaignOpportunityInput,
  selectNextCampaignOpportunity,
} from "./campaign-scheduling.js";

const failureInput = (
  overrides: Partial<CampaignFailureDecisionInput> = {},
): CampaignFailureDecisionInput => ({
  nowMs: 1_000,
  campaignStatus: "active",
  failureKind: "transient",
  effectState: "not_started",
  attemptNumber: 1,
  maxAttempts: 3,
  stepStartedAtMs: 900,
  stepTimeBudgetMs: 10_000,
  retryBaseMs: 100,
  retryMaxMs: 2_000,
  deferMs: 5_000,
  ...overrides,
});

const selectionInput = (
  overrides: Partial<SelectCampaignOpportunityInput> = {},
): SelectCampaignOpportunityInput => ({
  campaignStatus: "active",
  nowMs: 1_000,
  candidates: [],
  siteAvailability: [],
  ...overrides,
});

describe("campaign failure scheduling policy", () => {
  it("retries transient failure with capped exponential backoff", () => {
    expect(decideCampaignFailure(failureInput())).toEqual({
      action: "retry",
      retryAtMs: 1_100,
      reason: "transient_retry",
    });
    expect(decideCampaignFailure(failureInput({ attemptNumber: 3, maxAttempts: 4 }))).toEqual({
      action: "retry",
      retryAtMs: 1_400,
      reason: "transient_retry",
    });
    expect(decideCampaignFailure(failureInput({ attemptNumber: 8, maxAttempts: 9 }))).toMatchObject(
      {
        action: "retry",
        retryAtMs: 3_000,
      },
    );
  });

  it("defers after the retry budget and does not reset the step clock", () => {
    const decision = decideCampaignFailure(failureInput({ attemptNumber: 3, maxAttempts: 3 }));
    expect(decision).toEqual({
      action: "defer",
      retryAtMs: 6_000,
      reason: "attempt_limit_reached",
    });
    expect(decideCampaignFailure(failureInput({ attemptNumber: 4, maxAttempts: 3 }))).toMatchObject(
      {
        action: "defer",
        reason: "attempt_limit_reached",
      },
    );
    expect(decideCampaignFailure(failureInput({ attemptNumber: 1, maxAttempts: 1 }))).toMatchObject(
      {
        action: "defer",
        reason: "attempt_limit_reached",
      },
    );
  });

  it("defers a retry that would reach or pass the original deadline", () => {
    expect(
      decideCampaignFailure(
        failureInput({ nowMs: 1_000, stepStartedAtMs: 900, stepTimeBudgetMs: 200 }),
      ),
    ).toEqual({ action: "defer", retryAtMs: 6_000, reason: "step_deadline_reached" });
  });

  it("honors a provider retry timestamp even beyond the step deadline", () => {
    expect(
      decideCampaignFailure(failureInput({ providerRetryAfterMs: 50_000, stepTimeBudgetMs: 200 })),
    ).toEqual({ action: "defer", retryAtMs: 50_000, reason: "step_deadline_reached" });
    expect(decideCampaignFailure(failureInput({ providerRetryAfterMs: 1_500 }))).toMatchObject({
      action: "retry",
      retryAtMs: 1_500,
    });
  });

  it.each([
    ["authentication", "needs_action", "authentication_required"],
    ["budget", "needs_action", "budget_exhausted"],
    ["invalid_input", "needs_action", "invalid_input"],
    ["unsupported", "fail", "unsupported"],
    ["ineligible", "fail", "ineligible"],
    ["permanent", "fail", "permanent_failure"],
  ] as const)("routes %s without retry", (failureKind, action, reason) => {
    expect(decideCampaignFailure(failureInput({ failureKind }))).toMatchObject({ action, reason });
  });

  it.each([
    ["known_submitted", "submission_known"],
    ["unknown_submission", "submission_unknown"],
  ] as const)("reconciles %s before retry", (effectState, reason) => {
    expect(decideCampaignFailure(failureInput({ effectState }))).toEqual({
      action: "reconcile",
      reason,
    });
  });

  it("reconciles ambiguous submissions and holds paused or inactive campaigns", () => {
    expect(decideCampaignFailure(failureInput({ failureKind: "ambiguous_submission" }))).toEqual({
      action: "reconcile",
      reason: "submission_ambiguous",
    });
    expect(decideCampaignFailure(failureInput({ campaignStatus: "paused" }))).toEqual({
      action: "hold",
      reason: "campaign_paused",
    });
    expect(
      decideCampaignFailure(
        failureInput({ campaignStatus: "paused", effectState: "known_submitted" }),
      ),
    ).toEqual({ action: "hold", reason: "campaign_paused" });
    expect(decideCampaignFailure(failureInput({ campaignStatus: "draft" }))).toEqual({
      action: "hold",
      reason: "campaign_not_active",
    });
  });

  it("rejects negative, unsafe, inconsistent, and overflowing timing inputs", () => {
    expect(() => decideCampaignFailure(failureInput({ nowMs: -1 }))).toThrow(/nonnegative/i);
    expect(() => decideCampaignFailure(failureInput({ attemptNumber: 0 }))).toThrow(/positive/i);
    expect(() => decideCampaignFailure(failureInput({ stepStartedAtMs: 1_001 }))).toThrow(
      /future/i,
    );
    expect(() => decideCampaignFailure(failureInput({ retryBaseMs: 3_000 }))).toThrow(
      /cannot exceed/i,
    );
    expect(() =>
      decideCampaignFailure(failureInput({ nowMs: Number.MAX_SAFE_INTEGER, deferMs: 1 })),
    ).toThrow(/safe integer/i);
    expect(() =>
      decideCampaignFailure(
        failureInput({
          nowMs: Number.MAX_SAFE_INTEGER - 1,
          stepStartedAtMs: 0,
          stepTimeBudgetMs: Number.MAX_SAFE_INTEGER,
          retryBaseMs: 2,
        }),
      ),
    ).toThrow(/safe integer/i);
    expect(() =>
      decideCampaignFailure(
        failureInput({
          nowMs: Number.MAX_SAFE_INTEGER,
          attemptNumber: 1,
          maxAttempts: 1,
          deferMs: 1,
        }),
      ),
    ).toThrow(/safe integer/i);
  });
});

describe("campaign opportunity selection", () => {
  it("selects the next site after one opportunity is deferred", () => {
    const selection = selectNextCampaignOpportunity(
      selectionInput({
        lastSiteKey: "a.test",
        candidates: [
          { id: "a1", siteKey: "a.test", status: "deferred", retryAtMs: 2_000, createdAtMs: 100 },
          { id: "b1", siteKey: "b.test", status: "queued", retryAtMs: null, createdAtMs: 200 },
        ],
      }),
    );
    expect(selection).toEqual({ action: "select", opportunityId: "b1", siteKey: "b.test" });
  });

  it("selects only due queued or deferred work and honors future queued retry times", () => {
    const selection = selectNextCampaignOpportunity(
      selectionInput({
        candidates: [
          { id: "future", siteKey: "a.test", status: "queued", retryAtMs: 1_500, createdAtMs: 100 },
          { id: "due", siteKey: "b.test", status: "deferred", retryAtMs: 900, createdAtMs: 200 },
        ],
      }),
    );
    expect(selection).toEqual({ action: "select", opportunityId: "due", siteKey: "b.test" });
  });

  it("does not mutate candidate or site availability inputs", () => {
    const input = selectionInput({
      candidates: [
        { id: "later", siteKey: "a.test", status: "queued", retryAtMs: 1_200, createdAtMs: 100 },
        { id: "now", siteKey: "b.test", status: "queued", retryAtMs: null, createdAtMs: 200 },
      ],
      siteAvailability: [{ siteKey: "a.test", blockedUntilMs: 1_300 }],
    });
    const before = structuredClone(input);
    selectNextCampaignOpportunity(input);
    expect(input).toEqual(before);
  });

  it("respects site breakers and returns the earliest durable wakeup", () => {
    const selection = selectNextCampaignOpportunity(
      selectionInput({
        candidates: [
          { id: "later", siteKey: "a.test", status: "queued", retryAtMs: null, createdAtMs: 100 },
          {
            id: "earlier",
            siteKey: "b.test",
            status: "deferred",
            retryAtMs: 1_200,
            createdAtMs: 200,
          },
        ],
        siteAvailability: [
          { siteKey: "a.test", blockedUntilMs: 1_500 },
          { siteKey: "b.test", blockedUntilMs: 1_300 },
        ],
      }),
    );
    expect(selection).toEqual({
      action: "waiting",
      reason: "no_eligible_work",
      nextWakeAtMs: 1_300,
    });
  });

  it("prefers another eligible site, then oldest creation and stable id", () => {
    const selection = selectNextCampaignOpportunity(
      selectionInput({
        lastSiteKey: "site-a",
        candidates: [
          { id: "same", siteKey: "site-a", status: "queued", retryAtMs: null, createdAtMs: 10 },
          { id: "z", siteKey: "site-b", status: "queued", retryAtMs: null, createdAtMs: 20 },
          { id: "b", siteKey: "site-b", status: "queued", retryAtMs: null, createdAtMs: 20 },
          { id: "old", siteKey: "site-c", status: "queued", retryAtMs: null, createdAtMs: 30 },
        ],
      }),
    );
    expect(selection).toEqual({ action: "select", opportunityId: "b", siteKey: "site-b" });
  });

  it("returns explicit no-wakeup when all work needs action or is terminal", () => {
    const selection = selectNextCampaignOpportunity(
      selectionInput({
        candidates: [
          {
            id: "action",
            siteKey: "a.test",
            status: "needs_action",
            retryAtMs: null,
            createdAtMs: 100,
          },
          { id: "done", siteKey: "b.test", status: "succeeded", retryAtMs: null, createdAtMs: 200 },
          { id: "failed", siteKey: "c.test", status: "failed", retryAtMs: null, createdAtMs: 300 },
        ],
      }),
    );
    expect(selection).toEqual({
      action: "waiting",
      reason: "no_eligible_work",
      nextWakeAtMs: null,
    });
  });

  it("does not schedule new work while paused and validates deferred timestamps", () => {
    expect(selectNextCampaignOpportunity(selectionInput({ campaignStatus: "paused" }))).toEqual({
      action: "hold",
      reason: "campaign_paused",
    });
    expect(() =>
      selectNextCampaignOpportunity(
        selectionInput({
          candidates: [
            { id: "bad", siteKey: "a.test", status: "deferred", retryAtMs: null, createdAtMs: 100 },
          ],
        }),
      ),
    ).toThrow(/must have retryAtMs/i);
  });
});
