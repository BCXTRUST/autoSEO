import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { ChallengeProvider, ChallengeTaskResult } from "@rakazo/adapter-kit/challenge";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { AntiCaptchaError, createAntiCaptchaAdapter } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  type CampaignChallengeTaskDto,
  CampaignNotFoundError,
  CampaignRuleError,
  claimCampaignChallengePoll,
  completeCampaignChallengeCreation,
  failCampaignChallengeCreation,
  getCampaignChallengeCampaignContext,
  getCampaignChallengeSolution,
  getCampaignChallengeTasks,
  type PrismaClient,
  recordCampaignChallengePoll,
  recordCampaignChallengePollFailure,
  reserveCampaignChallengeTask,
} from "@rakazo/db";

const BALANCE_CACHE_MS = 30_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_IMAGE_BASE64_LENGTH = 7 * 1024 * 1024;

export interface CampaignChallengeEnvironment {
  ANTI_CAPTCHA_API_KEY?: string;
  CAMPAIGN_PAID_CHALLENGES_ENABLED?: string;
  CAMPAIGN_CHALLENGE_RESERVATION_MICROS?: string;
}

export interface CampaignChallengeStatusDto {
  configured: boolean;
  paidTasksEnabled: boolean;
  supportedTypes: ["image-to-text"];
  balanceUsd: number | null;
  status: "not_configured" | "ready" | "disabled" | "unavailable";
  error: string | null;
  tasks: CampaignChallengeTaskDto[];
}

export interface CreateCampaignChallengeInput {
  campaignId: string;
  clientNonce: string;
  imageBase64: string;
  authorizedUse: true;
}

export interface PollCampaignChallengeInput {
  campaignId: string;
  taskId: string;
}

export interface CampaignChallengeServiceOptions {
  prisma: PrismaClient;
  env?: CampaignChallengeEnvironment;
  provider?: ChallengeProvider;
  secrets?: EncryptedSecretStore;
  now?: () => Date;
}

function reservationBound(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const micros = Number(value);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

function mapError(error: unknown): never {
  if (error instanceof CampaignNotFoundError) throw new ORPCError("NOT_FOUND");
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

function safeTaskFailure(error: unknown): {
  ambiguous: boolean;
  code: "ambiguous_creation" | "provider_unavailable";
} {
  if (error instanceof AntiCaptchaError && error.code === "ambiguous_creation") {
    return { ambiguous: true, code: "ambiguous_creation" };
  }
  if (
    error instanceof AntiCaptchaError &&
    [
      "authentication",
      "low_balance",
      "provider_error",
      "unsupported_task",
      "invalid_input",
    ].includes(error.code)
  ) {
    return { ambiguous: false, code: "provider_unavailable" };
  }
  return { ambiguous: true, code: "ambiguous_creation" };
}

function validateImageInput(input: CreateCampaignChallengeInput): void {
  if (input.authorizedUse !== true) {
    throw new ORPCError("BAD_REQUEST", { message: "Authorized use must be confirmed." });
  }
  if (
    typeof input.imageBase64 !== "string" ||
    input.imageBase64.length === 0 ||
    input.imageBase64.length > MAX_IMAGE_BASE64_LENGTH ||
    input.imageBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.imageBase64)
  ) {
    throw new ORPCError("BAD_REQUEST", { message: "Challenge image is invalid or too large." });
  }
  const bytes =
    Math.floor((input.imageBase64.length * 3) / 4) -
    (input.imageBase64.endsWith("==") ? 2 : input.imageBase64.endsWith("=") ? 1 : 0);
  if (bytes < 1 || bytes > 5 * 1024 * 1024) {
    throw new ORPCError("BAD_REQUEST", { message: "Challenge image is invalid or too large." });
  }
}

export function createCampaignChallengeService(options: CampaignChallengeServiceOptions) {
  const env = options.env ?? process.env;
  const clientKey = env.ANTI_CAPTCHA_API_KEY?.trim() ?? "";
  const boundMicros = reservationBound(env.CAMPAIGN_CHALLENGE_RESERVATION_MICROS);
  const configured = clientKey.length > 0 && boundMicros !== null && options.secrets !== undefined;
  const paidTasksEnabled = configured && env.CAMPAIGN_PAID_CHALLENGES_ENABLED === "true";
  const provider =
    options.provider ?? (clientKey ? createAntiCaptchaAdapter({ clientKey }) : undefined);
  const now = options.now ?? (() => new Date());
  let cachedBalance: { value: number; fetchedAt: number } | null = null;

  async function status(
    actor: Actor,
    input: { campaignId: string },
  ): Promise<CampaignChallengeStatusDto> {
    return translate(async () => {
      const campaign = await getCampaignChallengeCampaignContext(
        options.prisma,
        actor,
        input.campaignId,
      );
      const tasks = await getCampaignChallengeTasks(options.prisma, actor, input.campaignId, now());
      if (!configured || !provider || !options.secrets) {
        return {
          configured: false,
          paidTasksEnabled: false,
          supportedTypes: ["image-to-text"],
          balanceUsd: null,
          status: "not_configured",
          error: null,
          tasks,
        };
      }
      if (!actor.isDeploymentOwner) {
        return {
          configured: true,
          paidTasksEnabled: false,
          supportedTypes: ["image-to-text"],
          balanceUsd: null,
          status: "disabled",
          error: "Paid challenge tasks are restricted to the deployment owner.",
          tasks,
        };
      }
      if (
        !paidTasksEnabled ||
        campaign.mode !== "research" ||
        campaign.status !== "active" ||
        campaign.dailySpendLimitMicros <= 0
      ) {
        return {
          configured: true,
          paidTasksEnabled: false,
          supportedTypes: ["image-to-text"],
          balanceUsd: null,
          status: "disabled",
          error: "Paid challenge tasks are disabled for this campaign.",
          tasks,
        };
      }
      const epoch = now().getTime();
      if (cachedBalance && epoch - cachedBalance.fetchedAt < BALANCE_CACHE_MS) {
        return {
          configured: true,
          paidTasksEnabled: true,
          supportedTypes: ["image-to-text"],
          balanceUsd: cachedBalance.value,
          status: "ready",
          error: null,
          tasks,
        };
      }
      try {
        const { balanceUsd } = await provider.getBalance();
        if (!Number.isFinite(balanceUsd) || balanceUsd < 0) throw new Error("invalid balance");
        cachedBalance = { value: balanceUsd, fetchedAt: epoch };
        return {
          configured: true,
          paidTasksEnabled: true,
          supportedTypes: ["image-to-text"],
          balanceUsd,
          status: "ready",
          error: null,
          tasks,
        };
      } catch {
        return {
          configured: true,
          paidTasksEnabled: true,
          supportedTypes: ["image-to-text"],
          balanceUsd: null,
          status: "unavailable",
          error: "Provider balance is unavailable.",
          tasks,
        };
      }
    });
  }

  async function create(
    actor: Actor,
    input: CreateCampaignChallengeInput,
    signal?: AbortSignal,
  ): Promise<CampaignChallengeTaskDto> {
    return translate(async () => {
      validateImageInput(input);
      const campaign = await getCampaignChallengeCampaignContext(
        options.prisma,
        actor,
        input.campaignId,
      );
      if (!actor.isDeploymentOwner) {
        throw new ORPCError("FORBIDDEN", {
          message: "Paid challenge tasks are restricted to the deployment owner.",
        });
      }
      if (
        !provider ||
        !paidTasksEnabled ||
        campaign.mode !== "research" ||
        campaign.status !== "active" ||
        campaign.dailySpendLimitMicros <= 0
      ) {
        throw new ORPCError("FORBIDDEN", { message: "Paid challenge tasks are not enabled." });
      }
      const instant = now();
      const payloadHash = createHash("sha256").update(input.imageBase64, "utf8").digest("hex");
      const reservation = await reserveCampaignChallengeTask(options.prisma, actor, {
        campaignId: input.campaignId,
        nonce: input.clientNonce,
        payloadHash,
        reservationMicros: boundMicros!,
        deadlineAt: new Date(instant.getTime() + CHALLENGE_TTL_MS),
        now: instant,
      });
      if (!reservation.created) return reservation.task;

      let result: { taskId: string };
      try {
        result = await provider.createTask(
          { type: "image-to-text", authorizedUse: true, imageBase64: input.imageBase64 },
          { signal },
        );
      } catch (error) {
        const failure = safeTaskFailure(error);
        return failCampaignChallengeCreation(
          options.prisma,
          actor,
          input.campaignId,
          reservation.task.id,
          failure,
          now(),
        );
      }
      // If persisting the provider task ID fails after the remote create succeeded, leave
      // the durable reservation in `creating`; its deadline will transition it to ambiguous.
      return completeCampaignChallengeCreation(
        options.prisma,
        actor,
        input.campaignId,
        reservation.task.id,
        result.taskId,
        now(),
      );
    });
  }

  async function poll(
    actor: Actor,
    input: PollCampaignChallengeInput,
    signal?: AbortSignal,
  ): Promise<CampaignChallengeTaskDto> {
    return translate(async () => {
      const claimed = await claimCampaignChallengePoll(
        options.prisma,
        actor,
        input.campaignId,
        input.taskId,
        now(),
      );
      if (!claimed.claimed || !claimed.providerTaskId || !provider) return claimed.task;
      let result: ChallengeTaskResult;
      try {
        result = await provider.pollTask(claimed.providerTaskId, { signal });
      } catch {
        return recordCampaignChallengePollFailure(
          options.prisma,
          actor,
          input.campaignId,
          input.taskId,
          now(),
        );
      }
      let encryptedSolution: string | null = null;
      if (result.status === "ready") {
        if (!options.secrets) {
          return recordCampaignChallengePollFailure(
            options.prisma,
            actor,
            input.campaignId,
            input.taskId,
            now(),
          );
        }
        const encrypted = await options.secrets.put(result.solution.text, {
          operationId: `campaign-challenge:${input.taskId}`,
          traceId: `campaign-challenge:${input.taskId}`,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          signal: signal ?? new AbortController().signal,
        });
        encryptedSolution = encrypted.ciphertext;
      }
      return recordCampaignChallengePoll(
        options.prisma,
        actor,
        input.campaignId,
        input.taskId,
        result,
        encryptedSolution,
        now(),
      );
    });
  }

  async function result(
    actor: Actor,
    input: PollCampaignChallengeInput,
  ): Promise<{ taskId: string; solution: string; application: "manual_only" }> {
    if (!actor.isDeploymentOwner) {
      throw new ORPCError("FORBIDDEN", {
        message: "Challenge results are restricted to the deployment owner.",
      });
    }
    if (!options.secrets) {
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Challenge result storage is unavailable.",
      });
    }
    return translate(async () => {
      const ciphertext = await getCampaignChallengeSolution(
        options.prisma,
        actor,
        input.campaignId,
        input.taskId,
      );
      return {
        taskId: input.taskId,
        solution: options.secrets!.load(ciphertext),
        application: "manual_only" as const,
      };
    });
  }

  return { status, create, poll, result };
}
