import {
  claimCampaignPublicationVerification,
  completeCampaignPublicationVerification,
  listCampaignPublicationActions,
  type PrismaClient,
} from "@rakazo/db";
import type { DiscourseCampaignAdapter } from "./discourse-campaign.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_PER_TICK = 3;
const CANDIDATE_BATCH_SIZE = 30;
const MAX_ADAPTER_TIMEOUT_MS = 9_999;
const DEFAULT_ADAPTER_TIMEOUT_MS = 9_000;

type DueAction = {
  id: string;
  campaignId: string;
  status: "intent" | "submitted" | "pending";
  providerPostId: number | null;
  campaign: {
    workspaceId: string;
    userId: string;
    user: { email: string };
  };
};

export interface CampaignPublicationWorkerOptions {
  prisma: PrismaClient;
  /** Construct with a request timeout below 10 seconds; this worker never submits posts. */
  adapter?: DiscourseCampaignAdapter;
  now?: () => Date;
  intervalMs?: number;
  maxPerTick?: number;
  requestTimeoutMs?: number;
  onError?: (code: "tick_failed" | "verify_failed") => void;
}

function reportError(
  handler: CampaignPublicationWorkerOptions["onError"],
  code: "tick_failed" | "verify_failed",
) {
  if (handler) {
    handler(code);
    return;
  }
  console.error(`[campaign publication worker] ${code}`);
}

/** Reconciles known Discourse receipts and expires stale ledger entries; it never creates posts. */
export function createCampaignPublicationWorker(options: CampaignPublicationWorkerOptions) {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPerTick = options.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new Error("Campaign publication worker interval is invalid");
  }
  if (!Number.isInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > DEFAULT_MAX_PER_TICK) {
    throw new Error("Campaign publication worker concurrency is invalid");
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_ADAPTER_TIMEOUT_MS
  ) {
    throw new Error("Campaign publication worker request timeout is invalid");
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;

  function actorFor(candidate: DueAction) {
    return {
      userId: candidate.campaign.userId,
      workspaceId: candidate.campaign.workspaceId,
      email: candidate.campaign.user.email,
      // This worker only reconciles existing shared-provider ledger entries.
      isDeploymentOwner: true,
    };
  }

  async function verify(candidate: DueAction, signal: AbortSignal): Promise<void> {
    if (!options.adapter || stopped || signal.aborted) return;
    const actor = actorFor(candidate);
    const claim = await claimCampaignPublicationVerification(options.prisma, actor, {
      campaignId: candidate.campaignId,
      actionId: candidate.id,
      now: now(),
    });
    if (!claim.verify) return;

    try {
      const check = options.adapter.verifyPublication(claim.providerPostId, claim.expectedLink);
      // The adapter is configured below 10 seconds by the caller; this outer bound also prevents
      // a faulty injected provider from freezing the timer loop or shutdown indefinitely.
      void check.catch(() => undefined);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let result: Awaited<ReturnType<DiscourseCampaignAdapter["verifyPublication"]>>;
      try {
        result = await Promise.race([
          check,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("verification_timeout")), requestTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (stopped || signal.aborted) return;
      if (result.status !== "success") {
        await completeCampaignPublicationVerification(options.prisma, actor, {
          campaignId: candidate.campaignId,
          actionId: candidate.id,
          outcome: "pending",
          safeError: "provider_unavailable",
          now: now(),
        });
        return;
      }

      const evidence = result.value.evidence;
      const verified =
        result.value.verification === "verified" &&
        evidence.postId === claim.providerPostId &&
        evidence.topicId === claim.topicId &&
        evidence.audience === "public" &&
        evidence.visibility === "visible" &&
        evidence.expectedLinkMatched;
      await completeCampaignPublicationVerification(options.prisma, actor, {
        campaignId: candidate.campaignId,
        actionId: candidate.id,
        outcome: verified
          ? "verified"
          : result.value.verification === "not_verified"
            ? "not_verified"
            : "pending",
        safeError: verified ? null : "verification_pending",
        now: now(),
      });
    } catch {
      // Provider exceptions may contain credentials or response bodies; expose only a static code.
      if (!stopped && !signal.aborted) {
        try {
          await completeCampaignPublicationVerification(options.prisma, actor, {
            campaignId: candidate.campaignId,
            actionId: candidate.id,
            outcome: "pending",
            safeError: "provider_unavailable",
            now: now(),
          });
        } catch {
          // The durable action can be reclaimed on a later tick if persistence failed.
        }
        reportError(options.onError, "verify_failed");
      }
    }
  }

  async function runTick(signal: AbortSignal): Promise<void> {
    const instant = now();
    const candidates = (await options.prisma.campaignPublicationAction.findMany({
      where: {
        OR: [
          { status: "intent", deadlineAt: { lte: instant } },
          {
            status: { in: ["submitted", "pending"] },
            OR: [
              { deadlineAt: { lte: instant } },
              { nextVerifyAt: null },
              { nextVerifyAt: { lte: instant } },
            ],
          },
        ],
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
      orderBy: [
        { deadlineAt: "asc" },
        { nextVerifyAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: CANDIDATE_BATCH_SIZE,
    })) as DueAction[];
    if (stopped || signal.aborted) return;

    // Listing performs bounded ledger expiry for stale intents and exhausted submissions,
    // even when provider credentials are absent. Do it once per affected campaign.
    const byCampaign = new Map<string, DueAction>();
    for (const candidate of candidates) byCampaign.set(candidate.campaignId, candidate);
    await Promise.all(
      [...byCampaign.values()].map(async (candidate) => {
        try {
          await listCampaignPublicationActions(
            options.prisma,
            actorFor(candidate),
            candidate.campaignId,
          );
        } catch {
          reportError(options.onError, "tick_failed");
        }
      }),
    );
    if (!options.adapter || stopped || signal.aborted) return;

    const actionable = candidates.filter(
      (candidate) =>
        (candidate.status === "submitted" || candidate.status === "pending") &&
        candidate.providerPostId !== null,
    );
    let index = 0;
    const runners = Array.from({ length: Math.min(maxPerTick, actionable.length) }, async () => {
      while (!stopped && !signal.aborted) {
        const candidate = actionable[index++];
        if (!candidate) return;
        try {
          await verify(candidate, signal);
        } catch {
          reportError(options.onError, "verify_failed");
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
        throw new Error("Campaign publication worker tick failed");
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
