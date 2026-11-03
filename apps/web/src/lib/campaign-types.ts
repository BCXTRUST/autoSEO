import type {
  Campaign,
  CampaignActivity,
  CampaignChallengeTask,
  CampaignConfigInput,
  CampaignItem,
  CampaignItemKind,
  CampaignJob,
  CampaignMode,
  CampaignPublicationAction,
  CampaignPublicationStatus,
  CampaignSnapshot,
} from "@rakazo/contracts";

export type {
  CampaignActivity,
  CampaignChallengeTask,
  CampaignItem,
  CampaignItemKind,
  CampaignJob,
  CampaignMode,
  CampaignPublicationAction,
  CampaignPublicationStatus,
};
export type CampaignConfig = CampaignConfigInput;
export type CampaignRecord = Campaign;
export type CampaignStateSnapshot = CampaignSnapshot;
export interface CampaignChallengeStatus {
  configured: boolean;
  paidTasksEnabled: boolean;
  supportedTypes: ["image-to-text"];
  balanceUsd: number | null;
  status: "not_configured" | "ready" | "disabled" | "unavailable";
  error: string | null;
  tasks: CampaignChallengeTask[];
}
export interface CampaignChallengeResult {
  taskId: string;
  solution: string;
  application: "manual_only";
}
