import type { CampaignFailureKind, CampaignStatus } from "@rakazo/contracts";

export type CampaignEffectState = "not_started" | "known_submitted" | "unknown_submission";

export interface CampaignFailureDecisionInput {
  nowMs: number;
  campaignStatus: CampaignStatus;
  failureKind: CampaignFailureKind;
  effectState: CampaignEffectState;
  /** Current total attempt number, including the attempt that just failed. */
  attemptNumber: number;
  maxAttempts: number;
  stepStartedAtMs: number;
  stepTimeBudgetMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  deferMs: number;
  providerRetryAfterMs?: number | null;
}

export type CampaignFailureDecision =
  | { action: "hold"; reason: "campaign_paused" | "campaign_not_active" }
  | {
      action: "reconcile";
      reason: "submission_known" | "submission_unknown" | "submission_ambiguous";
    }
  | {
      action: "needs_action";
      reason: "authentication_required" | "budget_exhausted" | "invalid_input";
    }
  | { action: "fail"; reason: "unsupported" | "ineligible" | "permanent_failure" }
  | { action: "retry"; retryAtMs: number; reason: "transient_retry" }
  | {
      action: "defer";
      retryAtMs: number;
      reason: "attempt_limit_reached" | "step_deadline_reached";
    };

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
}

function assertPositive(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value <= 0) throw new RangeError(`${label} must be positive`);
}

function assertNonnegative(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 0) throw new RangeError(`${label} must be nonnegative`);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  assertSafeInteger(result, label);
  return result;
}

function validateFailureInput(input: CampaignFailureDecisionInput): number {
  assertNonnegative(input.nowMs, "nowMs");
  assertPositive(input.attemptNumber, "attemptNumber");
  assertPositive(input.maxAttempts, "maxAttempts");
  assertNonnegative(input.stepStartedAtMs, "stepStartedAtMs");
  assertPositive(input.stepTimeBudgetMs, "stepTimeBudgetMs");
  assertPositive(input.retryBaseMs, "retryBaseMs");
  assertPositive(input.retryMaxMs, "retryMaxMs");
  assertPositive(input.deferMs, "deferMs");
  if (input.stepStartedAtMs > input.nowMs)
    throw new RangeError("stepStartedAtMs cannot be in the future");
  if (input.retryBaseMs > input.retryMaxMs)
    throw new RangeError("retryBaseMs cannot exceed retryMaxMs");
  const deadline = safeAdd(input.stepStartedAtMs, input.stepTimeBudgetMs, "step deadline");
  if (input.providerRetryAfterMs != null) {
    assertNonnegative(input.providerRetryAfterMs, "providerRetryAfterMs");
  }
  return deadline;
}

function retryDelay(input: CampaignFailureDecisionInput): number {
  // Clamp before multiplying so a very large attempt number cannot overflow.
  let delay = input.retryBaseMs;
  for (let index = 1; index < input.attemptNumber && delay < input.retryMaxMs; index += 1) {
    delay = delay > input.retryMaxMs / 2 ? input.retryMaxMs : Math.min(delay * 2, input.retryMaxMs);
  }
  return Math.min(delay, input.retryMaxMs);
}

function deferredAt(input: CampaignFailureDecisionInput): number {
  const ordinaryRetry = safeAdd(input.nowMs, input.deferMs, "defer retry time");
  return Math.max(ordinaryRetry, input.providerRetryAfterMs ?? 0);
}

/**
 * Pure retry/defer policy. Deferring never resets the attempt count or step start time;
 * future orchestration owns those persisted changes. A paused hold blocks new dispatch,
 * while runtime reconciliation may separately inspect effects already accepted remotely.
 */
export function decideCampaignFailure(
  input: CampaignFailureDecisionInput,
): CampaignFailureDecision {
  const deadline = validateFailureInput(input);

  if (input.campaignStatus === "paused") return { action: "hold", reason: "campaign_paused" };
  if (input.campaignStatus !== "active") return { action: "hold", reason: "campaign_not_active" };

  if (input.effectState === "known_submitted") {
    return { action: "reconcile", reason: "submission_known" };
  }
  if (input.effectState === "unknown_submission") {
    return { action: "reconcile", reason: "submission_unknown" };
  }
  if (input.failureKind === "ambiguous_submission") {
    return { action: "reconcile", reason: "submission_ambiguous" };
  }

  switch (input.failureKind) {
    case "authentication":
      return { action: "needs_action", reason: "authentication_required" };
    case "budget":
      return { action: "needs_action", reason: "budget_exhausted" };
    case "invalid_input":
      return { action: "needs_action", reason: "invalid_input" };
    case "unsupported":
      return { action: "fail", reason: "unsupported" };
    case "ineligible":
      return { action: "fail", reason: "ineligible" };
    case "permanent":
      return { action: "fail", reason: "permanent_failure" };
    case "transient":
      break;
  }

  if (input.attemptNumber >= input.maxAttempts) {
    return { action: "defer", retryAtMs: deferredAt(input), reason: "attempt_limit_reached" };
  }

  const delay = retryDelay(input);
  const retryAtMs = Math.max(
    safeAdd(input.nowMs, delay, "retry time"),
    input.providerRetryAfterMs ?? 0,
  );
  if (retryAtMs < deadline) return { action: "retry", retryAtMs, reason: "transient_retry" };
  return { action: "defer", retryAtMs: deferredAt(input), reason: "step_deadline_reached" };
}

export type CampaignOpportunityStatus =
  | "queued"
  | "deferred"
  | "needs_action"
  | "succeeded"
  | "failed";

export interface CampaignOpportunityCandidate {
  id: string;
  siteKey: string;
  status: CampaignOpportunityStatus;
  retryAtMs: number | null;
  createdAtMs: number;
}

export interface CampaignSiteAvailability {
  siteKey: string;
  blockedUntilMs: number | null;
}

export type CampaignOpportunitySelection =
  | { action: "select"; opportunityId: string; siteKey: string }
  | { action: "waiting"; reason: "no_eligible_work"; nextWakeAtMs: number | null }
  | { action: "hold"; reason: "campaign_paused" | "campaign_not_active" };

export interface SelectCampaignOpportunityInput {
  campaignStatus: CampaignStatus;
  nowMs: number;
  candidates: readonly CampaignOpportunityCandidate[];
  siteAvailability: readonly CampaignSiteAvailability[];
  lastSiteKey?: string | null;
}

function validateSelectionInput(input: SelectCampaignOpportunityInput): void {
  assertNonnegative(input.nowMs, "nowMs");
  const siteKeys = new Set<string>();
  for (const site of input.siteAvailability) {
    if (!site.siteKey) throw new RangeError("siteKey must not be empty");
    if (siteKeys.has(site.siteKey))
      throw new RangeError(`duplicate site availability: ${site.siteKey}`);
    siteKeys.add(site.siteKey);
    if (site.blockedUntilMs != null) assertNonnegative(site.blockedUntilMs, "blockedUntilMs");
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.id || !candidate.siteKey)
      throw new RangeError("candidate id and siteKey must not be empty");
    if (ids.has(candidate.id)) throw new RangeError(`duplicate opportunity id: ${candidate.id}`);
    ids.add(candidate.id);
    assertNonnegative(candidate.createdAtMs, "createdAtMs");
    if (candidate.createdAtMs > input.nowMs)
      throw new RangeError("createdAtMs cannot be in the future");
    if (candidate.retryAtMs != null) {
      assertNonnegative(candidate.retryAtMs, "retryAtMs");
      if (candidate.retryAtMs < candidate.createdAtMs) {
        throw new RangeError("retryAtMs cannot precede createdAtMs");
      }
    }
    if (candidate.status === "deferred" && candidate.retryAtMs == null) {
      throw new RangeError("deferred candidate must have retryAtMs");
    }
  }
}

/** Selects due work fairly across sites, with stable age/code-unit-id tie-breaking. */
export function selectNextCampaignOpportunity(
  input: SelectCampaignOpportunityInput,
): CampaignOpportunitySelection {
  validateSelectionInput(input);
  if (input.campaignStatus === "paused") return { action: "hold", reason: "campaign_paused" };
  if (input.campaignStatus !== "active") return { action: "hold", reason: "campaign_not_active" };

  const availability = new Map(
    input.siteAvailability.map((site) => [site.siteKey, site.blockedUntilMs]),
  );
  const eligibleStatuses = new Set<CampaignOpportunityStatus>(["queued", "deferred"]);
  const work = input.candidates
    .filter((candidate) => eligibleStatuses.has(candidate.status))
    .map((candidate) => {
      // A queued item may also carry a future retry time after a prerequisite change.
      const retryAtMs = candidate.retryAtMs ?? 0;
      const siteBlockedUntilMs = availability.get(candidate.siteKey) ?? 0;
      return {
        candidate,
        readyAtMs: Math.max(retryAtMs, siteBlockedUntilMs),
      };
    });
  const due = work.filter(({ readyAtMs }) => readyAtMs <= input.nowMs);
  if (due.length > 0) {
    due.sort((left, right) => {
      const leftSameSite = left.candidate.siteKey === input.lastSiteKey;
      const rightSameSite = right.candidate.siteKey === input.lastSiteKey;
      if (leftSameSite !== rightSameSite) return leftSameSite ? 1 : -1;
      if (left.candidate.createdAtMs !== right.candidate.createdAtMs) {
        return left.candidate.createdAtMs - right.candidate.createdAtMs;
      }
      return left.candidate.id < right.candidate.id
        ? -1
        : left.candidate.id > right.candidate.id
          ? 1
          : 0;
    });
    const selected = due[0]!.candidate;
    return { action: "select", opportunityId: selected.id, siteKey: selected.siteKey };
  }

  let nextWakeAtMs: number | null = null;
  for (const { readyAtMs } of work) {
    if (readyAtMs > input.nowMs && (nextWakeAtMs == null || readyAtMs < nextWakeAtMs)) {
      nextWakeAtMs = readyAtMs;
    }
  }
  return {
    action: "waiting",
    reason: "no_eligible_work",
    nextWakeAtMs,
  };
}
