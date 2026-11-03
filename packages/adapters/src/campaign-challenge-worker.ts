import type { ChallengeProvider, ChallengeTaskResult } from "@rakazo/adapter-kit/challenge";
import {
  claimCampaignChallengePoll,
  expireStaleCampaignChallengeTasks,
  type PrismaClient,
  recordCampaignChallengePoll,
  recordCampaignChallengePollFailure,
} from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PER_TICK = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TASK_BATCH_SIZE = 30;

type DueTask = {
  id: string;
  campaignId: string;
  campaign: {
    workspaceId: string;
    userId: string;
    user: { email: string };
  };
};

export interface CampaignChallengeWorkerOptions {
  prisma: PrismaClient;
  provider?: ChallengeProvider;
  secrets: EncryptedSecretStore;
  now?: () => Date;
  intervalMs?: number;
  maxPerTick?: number;
  requestTimeoutMs?: number;
  onError?: (code: "tick_failed" | "poll_failed") => void;
}

function reportError(
  handler: CampaignChallengeWorkerOptions["onError"],
  code: "tick_failed" | "poll_failed",
) {
  if (handler) {
    handler(code);
    return;
  }
  console.error(`[campaign challenge worker] ${code}`);
}

/** Reconciles durable challenge IDs only; it never creates or retries a paid task. */
export function createCampaignChallengeWorker(options: CampaignChallengeWorkerOptions) {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new Error("Campaign challenge worker interval is invalid");
  }
  if (!Number.isInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > DEFAULT_MAX_PER_TICK) {
    throw new Error("Campaign challenge worker concurrency is invalid");
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS
  ) {
    throw new Error("Campaign challenge worker request timeout is invalid");
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;

  async function reconcile(task: DueTask, signal: AbortSignal): Promise<void> {
    if (!options.provider || stopped || signal.aborted) return;
    const actor = {
      userId: task.campaign.userId,
      workspaceId: task.campaign.workspaceId,
      email: task.campaign.user.email,
      // Only the deployment owner can create a task using the shared operator key.
      isDeploymentOwner: true,
    };
    const claim = await claimCampaignChallengePoll(
      options.prisma,
      actor,
      task.campaignId,
      task.id,
      now(),
    );
    if (!claim.claimed || !claim.providerTaskId) return;

    let result: ChallengeTaskResult;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
      result = await options.provider.pollTask(claim.providerTaskId, { signal: requestSignal });
      if (result.status === "ready") {
        const encrypted = await options.secrets.put(result.solution.text, {
          operationId: `campaign-challenge:${task.id}`,
          traceId: `campaign-challenge:${task.id}`,
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          signal,
        });
        await recordCampaignChallengePoll(
          options.prisma,
          actor,
          task.campaignId,
          task.id,
          result,
          encrypted.ciphertext,
          now(),
        );
      } else {
        await recordCampaignChallengePoll(
          options.prisma,
          actor,
          task.campaignId,
          task.id,
          result,
          null,
          now(),
        );
      }
    } catch {
      // Provider payloads and exceptions can contain credentials or solve data; only a static
      // status code is reported. Clearing the lease lets a later bounded attempt reconcile it.
      await recordCampaignChallengePollFailure(
        options.prisma,
        actor,
        task.campaignId,
        task.id,
        now(),
      );
      reportError(options.onError, "poll_failed");
    }
  }

  async function runTick(signal: AbortSignal): Promise<void> {
    const instant = now();
    await expireStaleCampaignChallengeTasks(options.prisma, instant);
    if (!options.provider || stopped || signal.aborted) return;

    const candidates = (await options.prisma.campaignChallengeTask.findMany({
      where: {
        status: "submitted",
        deadlineAt: { gt: instant },
        nextPollAt: { lte: instant },
      },
      include: {
        campaign: {
          select: {
            workspaceId: true,
            userId: true,
            user: { select: { email: true } },
          },
        },
      },
      orderBy: [{ nextPollAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: TASK_BATCH_SIZE,
    })) as DueTask[];

    let index = 0;
    const runners = Array.from({ length: Math.min(maxPerTick, candidates.length) }, async () => {
      while (!stopped && !signal.aborted) {
        const task = candidates[index++];
        if (!task) return;
        try {
          await reconcile(task, signal);
        } catch {
          reportError(options.onError, "poll_failed");
        }
      }
    });
    await Promise.all(runners);
  }

  function tick(signal?: AbortSignal): Promise<void> {
    if (stopped) return Promise.resolve();
    if (ticking) return ticking;
    controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    ticking = runTick(combinedSignal)
      .catch(() => {
        reportError(options.onError, "tick_failed");
        throw new Error("Campaign challenge worker tick failed");
      })
      .finally(() => {
        ticking = undefined;
        controller = undefined;
      });
    return ticking;
  }

  function start(): void {
    if (stopped || timer) return;
    timer = setInterval(() => {
      void tick().catch(() => undefined);
    }, intervalMs);
    void tick().catch(() => undefined);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    controller?.abort();
    await ticking;
  }

  return { start, tick, stop };
}
