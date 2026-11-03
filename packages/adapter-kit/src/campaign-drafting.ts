export interface CampaignDraftCampaign {
  objective: string;
  websiteUrl: string;
  language: string;
  market: string;
}

export interface CampaignDraftSource {
  url: string;
  title: string;
  text: string;
}

export interface CampaignDraftInput {
  campaign: CampaignDraftCampaign;
  source: CampaignDraftSource;
  /** Optional, caller-observed same-origin project pages. Each source remains untrusted text. */
  projectSources?: CampaignDraftSource[];
  /** Required caller-owned spend reservation in micros. */
  maxCostMicros: number;
  /** Must be at most 2048 tokens; larger requests are rejected. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface CampaignDraftUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost calculated from observed usage and configured model prices, or null. */
  costMicros: number | null;
}

export interface CampaignDraftOutput {
  body: string;
  rationale: string;
  sourceUrls: string[];
  usage: CampaignDraftUsage;
}

export interface CampaignDraftEstimateInput {
  campaign: CampaignDraftCampaign;
  source: CampaignDraftSource;
  /** Must match the optional bounded project context supplied to generate. */
  projectSources?: CampaignDraftSource[];
  maxOutputTokens?: number;
}

export interface CampaignDraftReservationEstimate {
  estimatedCostMicros: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  isEstimate: true;
}

export interface CampaignDraftModelMetadata {
  providerId: string | null;
  modelId: string | null;
  modelName: string | null;
  configured: boolean;
  pricingAvailable: boolean;
}

export type CampaignDraftErrorCode =
  | "disabled"
  | "configuration"
  | "invalid_input"
  | "budget_exceeded"
  | "aborted"
  | "timeout"
  | "provider_error"
  | "needs_review";

const CAMPAIGN_DRAFT_ERROR_MESSAGES: Record<CampaignDraftErrorCode, string> = {
  disabled: "Campaign drafting is disabled.",
  configuration: "Campaign drafting is not configured with a priced model and credential.",
  invalid_input: "Campaign draft input is invalid.",
  budget_exceeded: "The campaign draft estimate exceeds the available reservation.",
  aborted: "Campaign drafting was cancelled.",
  timeout: "Campaign drafting timed out; its provider result may be uncertain.",
  provider_error: "The configured model could not complete this draft.",
  needs_review: "The model response needs human review before it can be used.",
};

/** Fixed public messages keep raw provider errors and credentials out of results. */
export class CampaignDraftError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: CampaignDraftErrorCode,
    /** Usage observed before an invalid response, for budget reconciliation. */
    readonly usage: CampaignDraftUsage | null = null,
  ) {
    super(CAMPAIGN_DRAFT_ERROR_MESSAGES[code]);
    this.name = "CampaignDraftError";
  }
}

export interface CampaignDraftProvider {
  describe(): CampaignDraftModelMetadata;
  /** A conservative quote for reservation, never a guaranteed charge. */
  estimateReservationMicros(input: CampaignDraftEstimateInput): CampaignDraftReservationEstimate;
  /** Returns an editable proposal. Calling this never approves or publishes it. */
  generate(input: CampaignDraftInput): Promise<CampaignDraftOutput>;
}
