import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import {
  addCampaignItem,
  CampaignCommandConflictError,
  CampaignConflictError,
  CampaignNotFoundError,
  CampaignRuleError,
  controlCampaign,
  createCampaign,
  getCampaignSnapshot,
  listCampaigns,
  type PrismaClient,
  recoverCampaignItem,
  reviewCampaignDraft,
  reviewCampaignOpportunity,
  stopAllCampaigns,
  updateCampaignConfig,
  updateCampaignDraft,
} from "@rakazo/db";

function mapCampaignError(error: unknown): never {
  if (error instanceof CampaignNotFoundError) throw new ORPCError("NOT_FOUND");
  if (error instanceof CampaignConflictError || error instanceof CampaignCommandConflictError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof CampaignRuleError)
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  if (error instanceof Error && error.name === "ZodError") {
    throw new ORPCError("BAD_REQUEST", { message: "Campaign input is invalid" });
  }
  throw error;
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapCampaignError(error);
  }
}

export function createCampaignService(prisma: PrismaClient) {
  return {
    list: (actor: Actor) => translate(() => listCampaigns(prisma, actor)),
    create: (
      actor: Actor,
      input: { config: unknown; mode: "research" | "controlled"; clientNonce: string },
    ) => translate(() => createCampaign(prisma, actor, input)),
    update: (
      actor: Actor,
      input: { campaignId: string; expectedRevision: number; config: unknown },
    ) => translate(() => updateCampaignConfig(prisma, actor, input)),
    get: (actor: Actor, input: { campaignId: string; afterSequence: number }) =>
      translate(() => getCampaignSnapshot(prisma, actor, input)),
    addItem: (
      actor: Actor,
      input: {
        campaignId: string;
        kind: "source" | "opportunity";
        url: string;
        title: string;
        clientNonce: string;
      },
    ) => translate(() => addCampaignItem(prisma, actor, input)),
    updateDraft: (
      actor: Actor,
      input: { campaignId: string; itemId: string; body: string; expectedUpdatedAt: string },
    ) => translate(() => updateCampaignDraft(prisma, actor, input)),
    review: (
      actor: Actor,
      input: {
        campaignId: string;
        itemId: string;
        decision: "approve" | "reject";
        expectedUpdatedAt: string;
      },
    ) => translate(() => reviewCampaignDraft(prisma, actor, input)),
    reviewOpportunity: (
      actor: Actor,
      input: {
        campaignId: string;
        itemId: string;
        expectedUpdatedAt: string;
        action: "select" | "dismiss";
        clientNonce: string;
      },
    ) => translate(() => reviewCampaignOpportunity(prisma, actor, input)),
    control: (
      actor: Actor,
      input: { campaignId: string; action: "start" | "pause" | "resume"; clientNonce: string },
    ) => translate(() => controlCampaign(prisma, actor, input)),
    stopAll: (actor: Actor, clientNonce: string) =>
      translate(() => stopAllCampaigns(prisma, actor, clientNonce)),
    recoverItem: (
      actor: Actor,
      input: {
        campaignId: string;
        itemId: string;
        action: "retry" | "defer" | "skip";
        clientNonce: string;
      },
    ) => translate(() => recoverCampaignItem(prisma, actor, input)),
  };
}
