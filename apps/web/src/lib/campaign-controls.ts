import type { CampaignItem, CampaignRecord } from "./campaign-types";

export function campaignStartBlocked(
  campaign: Pick<CampaignRecord, "mode" | "status">,
  userAddedItems: Pick<CampaignItem, "status">[],
): boolean {
  return (
    campaign.mode === "controlled" &&
    campaign.status === "draft" &&
    !userAddedItems.some((item) => ["queued", "researching"].includes(item.status))
  );
}
