import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  createDiscourseCampaignAdapter,
  type DiscourseCampaignAdapter,
  type DiscourseCampaignOptions,
  hashReviewedContribution,
} from "@rakazo/adapters";
import type { Actor, CampaignPublicationStatus } from "@rakazo/contracts";
import {
  CampaignConflictError,
  CampaignNotFoundError,
  CampaignRuleError,
  claimCampaignPublicationVerification,
  completeCampaignPublicationVerification,
  dispatchCampaignPublication,
  getCampaignPublicationContext,
  getCampaignPublicationDraft,
  listCampaignPublicationActions,
  markCampaignPublicationBlocked,
  type PrismaClient,
  reserveCampaignPublication,
} from "@rakazo/db";

export interface CampaignPublicationEnv {
  discourseBaseUrl?: string;
  discourseApiKey?: string;
  discourseApiUsername?: string;
  discoursePublishingEnabled?: boolean;
}

type AdapterFactory = (options: DiscourseCampaignOptions) => DiscourseCampaignAdapter;

function mapError(error: unknown): never {
  if (error instanceof CampaignNotFoundError) throw new ORPCError("NOT_FOUND");
  if (error instanceof CampaignConflictError)
    throw new ORPCError("CONFLICT", { message: error.message });
  if (error instanceof CampaignRuleError)
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  throw error;
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapError(error);
  }
}

function completeCredentials(env: CampaignPublicationEnv): boolean {
  if (!env.discourseBaseUrl || !env.discourseApiKey || !env.discourseApiUsername) return false;
  try {
    const url = new URL(env.discourseBaseUrl);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function safeBaseUrl(env: CampaignPublicationEnv): string | null {
  if (!env.discourseBaseUrl) return null;
  try {
    const url = new URL(env.discourseBaseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function makeAdapter(
  env: CampaignPublicationEnv,
  factory: AdapterFactory,
): DiscourseCampaignAdapter | null {
  if (!completeCredentials(env)) return null;
  try {
    return factory({
      baseUrl: env.discourseBaseUrl!,
      apiKey: env.discourseApiKey!,
      apiUsername: env.discourseApiUsername!,
      authorizedSite: true,
    });
  } catch {
    return null;
  }
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function adapterErrorCode(code: string): string {
  if (code === "network_error" || code === "provider_unavailable" || code === "timeout") {
    return "provider_unavailable";
  }
  return "provider_rejected";
}

export function createCampaignPublicationService(
  prisma: PrismaClient,
  env: CampaignPublicationEnv,
  adapterFactory: AdapterFactory = createDiscourseCampaignAdapter,
) {
  return {
    actions: (actor: Actor, campaignId: string) =>
      translate(() => listCampaignPublicationActions(prisma, actor, campaignId)),
    status: (actor: Actor, campaignId: string) =>
      translate(async (): Promise<CampaignPublicationStatus> => {
        const [campaign, actions] = await Promise.all([
          getCampaignPublicationContext(prisma, actor, campaignId),
          listCampaignPublicationActions(prisma, actor, campaignId),
        ]);
        const configured = completeCredentials(env);
        const flagEnabled = env.discoursePublishingEnabled === true;
        const eligibleMode = campaign.mode === "research";
        const eligibleStatus = campaign.status === "active";
        const hasBudget = campaign.config.dailyPublicationLimit > 0;
        const publicBaseUrl = safeBaseUrl(env);

        if (!configured) {
          return {
            configured: false,
            enabled: false,
            status: "not_configured",
            baseUrl: null,
            account: null,
            error: "Discourse credentials are not configured.",
            actions,
          };
        }
        if (!actor.isDeploymentOwner) {
          return {
            configured: true,
            enabled: false,
            status: "disabled",
            baseUrl: publicBaseUrl,
            account: null,
            error: "Only the deployment owner can use the shared Discourse account.",
            actions,
          };
        }
        if (!flagEnabled) {
          return {
            configured: true,
            enabled: false,
            status: "disabled",
            baseUrl: publicBaseUrl,
            account: null,
            error: "Discourse publication is disabled by configuration.",
            actions,
          };
        }
        if (!eligibleMode || !eligibleStatus || !hasBudget) {
          return {
            configured: true,
            enabled: false,
            status: "disabled",
            baseUrl: publicBaseUrl,
            account: null,
            error: !hasBudget
              ? "The campaign daily publication limit is zero."
              : !eligibleMode
                ? "Controlled fixture campaigns cannot publish to Discourse."
                : "Start the campaign before publishing.",
            actions,
          };
        }
        const adapter = makeAdapter(env, adapterFactory);
        if (!adapter) {
          return {
            configured: true,
            enabled: false,
            status: "unavailable",
            baseUrl: publicBaseUrl,
            account: null,
            error: "Discourse configuration is invalid.",
            actions,
          };
        }
        const identity = await adapter.getIdentity();
        if (identity.status !== "success") {
          return {
            configured: true,
            enabled: false,
            status: "unavailable",
            baseUrl: publicBaseUrl,
            account: null,
            error: identity.message,
            actions,
          };
        }
        if (identity.value.username.toLowerCase() !== env.discourseApiUsername!.toLowerCase()) {
          return {
            configured: true,
            enabled: false,
            status: "unavailable",
            baseUrl: publicBaseUrl,
            account: identity.value.username,
            error: "The configured Discourse account did not match the authenticated account.",
            actions,
          };
        }
        return {
          configured: true,
          enabled: true,
          status: "ready",
          baseUrl: publicBaseUrl,
          account: identity.value.username,
          error: null,
          actions,
        };
      }),

    publishDraft: (
      actor: Actor,
      input: {
        campaignId: string;
        draftId: string;
        expectedUpdatedAt: string;
        topicId: number;
        clientNonce: string;
        confirmReviewed: true;
      },
    ) =>
      translate(async () => {
        const campaign = await getCampaignPublicationContext(prisma, actor, input.campaignId);
        const draft = await getCampaignPublicationDraft(
          prisma,
          actor,
          input.campaignId,
          input.draftId,
        );
        const adapter = makeAdapter(env, adapterFactory);
        const contentHash = hashReviewedContribution(input.topicId, draft.body);
        const siteOrigin = adapter
          ? new URL(env.discourseBaseUrl!).origin
          : (env.discourseBaseUrl ?? "");
        const payload = {
          draftId: draft.id,
          body: draft.body,
          approvedDraftUpdatedAt: draft.updatedAt.toISOString(),
          topicId: input.topicId,
          siteOrigin,
          account: env.discourseApiUsername,
          expectedLink: campaign.config.websiteUrl,
          contentHash,
        };
        const reservation = await reserveCampaignPublication(prisma, actor, {
          campaignId: input.campaignId,
          draftId: input.draftId,
          topicId: input.topicId,
          nonce: input.clientNonce,
          payloadHash: payloadHash(payload),
          bodySnapshot: draft.body,
          approvedDraftUpdatedAt: draft.updatedAt.toISOString(),
          contentHash,
          expectedLink: campaign.config.websiteUrl,
          allowNew:
            actor.isDeploymentOwner &&
            env.discoursePublishingEnabled === true &&
            adapter !== null &&
            campaign.status === "active" &&
            campaign.mode === "research" &&
            campaign.config.dailyPublicationLimit > 0 &&
            draft.status === "approved" &&
            draft.updatedAt.toISOString() === input.expectedUpdatedAt,
        });
        if (!reservation.dispatch) return reservation.action;

        if (!adapter) {
          return markCampaignPublicationBlocked(prisma, actor, {
            campaignId: input.campaignId,
            actionId: reservation.action.id,
            safeError: "provider_not_ready",
            summary: "Discourse configuration is unavailable; no post was sent.",
          });
        }

        const identity = await adapter.getIdentity();
        if (
          identity.status !== "success" ||
          identity.value.username.toLowerCase() !== env.discourseApiUsername!.toLowerCase()
        ) {
          return markCampaignPublicationBlocked(prisma, actor, {
            campaignId: input.campaignId,
            actionId: reservation.action.id,
            safeError: "provider_not_ready",
            summary: "The configured Discourse account could not be confirmed; no post was sent.",
          });
        }
        const topic = await adapter.getTopic(input.topicId);
        if (topic.status !== "success" || topic.value.topicId !== input.topicId) {
          return markCampaignPublicationBlocked(prisma, actor, {
            campaignId: input.campaignId,
            actionId: reservation.action.id,
            safeError: "topic_unavailable",
            summary: "The selected Discourse topic could not be confirmed; no post was sent.",
          });
        }
        return dispatchCampaignPublication(prisma, actor, {
          campaignId: input.campaignId,
          actionId: reservation.action.id,
          expectedDraftUpdatedAt: input.expectedUpdatedAt,
          enabled: env.discoursePublishingEnabled === true,
          deploymentOwner: actor.isDeploymentOwner,
          publish: async () => {
            const result = await adapter.publishReviewedContribution({
              topicId: input.topicId,
              raw: draft.body,
              approval: { approved: true, approvedContentHash: contentHash },
              operationKey: `campaignpub_${reservation.action.id}`,
            });
            if (result.status === "success") {
              return { status: "success" as const, value: result.value };
            }
            if (result.status === "ambiguous_submission") {
              return { status: "ambiguous_submission" as const, code: result.code };
            }
            return { status: "blocked" as const, code: result.code };
          },
        });
      }),

    verifyPublication: (actor: Actor, input: { campaignId: string; actionId: string }) =>
      translate(async () => {
        await getCampaignPublicationContext(prisma, actor, input.campaignId);
        const claim = await claimCampaignPublicationVerification(prisma, actor, input);
        if (!claim.verify) return claim.action;
        const adapter = makeAdapter(env, adapterFactory);
        if (!adapter || claim.action.providerPostId === null) {
          return completeCampaignPublicationVerification(prisma, actor, {
            campaignId: input.campaignId,
            actionId: input.actionId,
            outcome: "pending",
            safeError: "provider_unavailable",
          });
        }
        const result = await adapter.verifyPublication(claim.providerPostId, claim.expectedLink);
        if (result.status !== "success") {
          return completeCampaignPublicationVerification(prisma, actor, {
            campaignId: input.campaignId,
            actionId: input.actionId,
            outcome: "pending",
            safeError: adapterErrorCode(result.code),
          });
        }
        const evidence = result.value.evidence;
        const verified =
          result.value.verification === "verified" &&
          evidence.postId === claim.providerPostId &&
          evidence.topicId === claim.topicId &&
          evidence.audience === "public" &&
          evidence.visibility === "visible" &&
          evidence.expectedLinkMatched;
        return completeCampaignPublicationVerification(prisma, actor, {
          campaignId: input.campaignId,
          actionId: input.actionId,
          outcome: verified
            ? "verified"
            : result.value.verification === "not_verified"
              ? "not_verified"
              : "pending",
          safeError: verified ? null : "verification_pending",
        });
      }),
  };
}
