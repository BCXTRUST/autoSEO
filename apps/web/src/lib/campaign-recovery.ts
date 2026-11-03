import type { CampaignItem, CampaignJob, CampaignMode } from "./campaign-types";

export type CampaignRecoveryAction = "retry" | "defer" | "skip";

export function campaignRecoveryActions(
  item: CampaignItem,
  job: CampaignJob | undefined,
  mode: CampaignMode,
): CampaignRecoveryAction[] {
  if (mode !== "research" || (item.kind !== "source" && item.kind !== "opportunity") || !job)
    return [];
  // Catalog jobs are read-only page fetches. Keep them behind the same
  // persisted state gates as source reads, while never exposing catalog
  // recovery controls for unrelated operations.
  if (
    job.operation !== "research_source" &&
    job.operation !== "research_opportunity" &&
    job.operation !== "catalog_page" &&
    job.operation !== "discovery_search" &&
    job.operation !== "discovery_inspect"
  )
    return [];
  const retryableJob = ["queued", "deferred", "needs_action", "failed"].includes(job.status);
  const retryableItem = ["queued", "deferred", "needs_action", "failed"].includes(item.status);
  const paidResultAmbiguous = [
    "ai_result_ambiguous",
    "website_changed_uncertain_model_result",
  ].includes(job.lastError ?? "");
  const deferrableJob = ["queued", "deferred", "needs_action", "failed", "running"].includes(
    job.status,
  );
  const deferrableItem = ["queued", "deferred", "needs_action", "failed", "researching"].includes(
    item.status,
  );
  return [
    ...(retryableJob && retryableItem && !paidResultAmbiguous ? ["retry" as const] : []),
    ...(deferrableJob && deferrableItem ? ["defer" as const, "skip" as const] : []),
  ];
}
