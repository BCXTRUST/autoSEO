import type { ChallengeTaskResult } from "@rakazo/adapter-kit/challenge";
import { type Actor, CampaignConfigInput } from "@rakazo/contracts";
import { CampaignNotFoundError, CampaignRuleError } from "./campaigns.js";
import { Prisma, type PrismaClient } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

const MAX_POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 10_000;
const POLL_LEASE_MS = 15_000;

export type CampaignChallengeSafeError =
  | "ambiguous_creation"
  | "provider_unavailable"
  | "provider_task_failed"
  | "poll_limit_reached"
  | "poll_deadline_exceeded";

export interface CampaignChallengeTaskDto {
  id: string;
  campaignId: string;
  status: "creating" | "submitted" | "ready" | "failed" | "ambiguous";
  reservationMicros: number;
  actualCostMicros: number | null;
  pollAttempts: number;
  maxPollAttempts: number;
  deadlineAt: string;
  nextPollAt: string | null;
  safeError: CampaignChallengeSafeError | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignChallengeCampaignContext {
  mode: string;
  status: string;
  dailySpendLimitMicros: number;
}

type TaskRow = {
  id: string;
  campaignId: string;
  status: string;
  providerTaskId: string | null;
  reservationMicros: bigint;
  actualCostMicros: bigint | null;
  pollAttempts: number;
  maxPollAttempts: number;
  deadlineAt: Date;
  nextPollAt: Date | null;
  pollLeaseUntil: Date | null;
  safeError: string | null;
  solutionCiphertext: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const campaignScope = (actor: Actor, campaignId: string) => ({
  id: campaignId,
  workspaceId: actor.workspaceId,
  userId: actor.userId,
});

function safeInteger(value: bigint, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CampaignRuleError(`${name} exceeds the supported safe integer range`);
  }
  return number;
}

function safeError(value: string | null): CampaignChallengeSafeError | null {
  switch (value) {
    case "ambiguous_creation":
    case "provider_unavailable":
    case "provider_task_failed":
    case "poll_limit_reached":
    case "poll_deadline_exceeded":
      return value;
    default:
      return null;
  }
}

function toDto(row: TaskRow): CampaignChallengeTaskDto {
  if (
    row.status !== "creating" &&
    row.status !== "submitted" &&
    row.status !== "ready" &&
    row.status !== "failed" &&
    row.status !== "ambiguous"
  ) {
    throw new CampaignRuleError("Challenge task has an invalid persisted status");
  }
  return {
    id: row.id,
    campaignId: row.campaignId,
    status: row.status,
    reservationMicros: safeInteger(row.reservationMicros, "Challenge reservation"),
    actualCostMicros:
      row.actualCostMicros === null ? null : safeInteger(row.actualCostMicros, "Challenge cost"),
    pollAttempts: row.pollAttempts,
    maxPollAttempts: row.maxPollAttempts,
    deadlineAt: row.deadlineAt.toISOString(),
    nextPollAt: row.nextPollAt?.toISOString() ?? null,
    safeError: safeError(row.safeError),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function lockOwnedCampaign(tx: Prisma.TransactionClient, actor: Actor, campaignId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "campaigns"
    WHERE "id" = ${campaignId}
      AND "workspaceId" = ${actor.workspaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `);
  if (locked.length === 0) throw new CampaignNotFoundError();
  const campaign = await tx.campaign.findFirst({ where: campaignScope(actor, campaignId) });
  if (!campaign) throw new CampaignNotFoundError();
  return campaign;
}

async function lockOwnedTask(
  tx: Prisma.TransactionClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t."id" FROM "campaign_challenge_tasks" t
    JOIN "campaigns" c ON c."id" = t."campaignId"
    WHERE t."id" = ${taskId}
      AND t."campaignId" = ${campaignId}
      AND c."workspaceId" = ${actor.workspaceId}
      AND c."userId" = ${actor.userId}
    FOR UPDATE OF t
  `);
  if (locked.length === 0) throw new CampaignNotFoundError();
  const task = await tx.campaignChallengeTask.findFirst({ where: { id: taskId, campaignId } });
  if (!task) throw new CampaignNotFoundError();
  return task;
}

async function inTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
}

/** Shared same-day spend total. Call inside a transaction after locking the campaign row. */
export async function getCampaignDailyReservedSpendMicros(
  tx: Prisma.TransactionClient,
  campaignId: string,
  dayStart: Date,
): Promise<bigint> {
  const dayKey = dayStart.toISOString().slice(0, 10);
  const spentRows = await tx.$queryRaw<Array<{ spent: string | bigint | null }>>(Prisma.sql`
    WITH challenge_spend AS (
      SELECT COALESCE(SUM(COALESCE("actualCostMicros", "reservationMicros")), 0)::numeric AS "amount"
      FROM "campaign_challenge_tasks"
      WHERE "campaignId" = ${campaignId}
        AND "createdAt" >= ${dayStart}
        AND "createdAt" < ${new Date(dayStart.getTime() + 86_400_000)}
    ), drafting_spend AS (
      SELECT COALESCE(SUM(
        CASE
          WHEN "checkpoint"->>'aiActualCostMicros' IS NOT NULL THEN
            CASE
              WHEN "checkpoint"->>'aiActualCostMicros' ~ '^[0-9]{1,16}$'
                THEN ("checkpoint"->>'aiActualCostMicros')::numeric
              ELSE 9007199254740991::numeric
            END
          WHEN "checkpoint"->>'aiReservationMicros' ~ '^[0-9]{1,16}$'
            THEN ("checkpoint"->>'aiReservationMicros')::numeric
          ELSE 9007199254740991::numeric
        END
      ), 0)::numeric AS "amount"
      FROM "campaign_jobs"
      WHERE "campaignId" = ${campaignId}
        AND "checkpoint"->>'aiReservedDay' = ${dayKey}
        AND "checkpoint"->>'aiState' IN ('intent', 'ready', 'ambiguous')
    )
    SELECT LEAST(challenge_spend."amount" + drafting_spend."amount", 9007199254740991::numeric)::text AS "spent"
    FROM challenge_spend CROSS JOIN drafting_spend
  `);
  const rawSpent = spentRows[0]?.spent ?? 0n;
  try {
    return BigInt(rawSpent);
  } catch {
    throw new CampaignRuleError("Campaign daily spend ledger is invalid");
  }
}

export async function getCampaignChallengeTasks(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  now = new Date(),
): Promise<CampaignChallengeTaskDto[]> {
  return inTransaction(prisma, async (tx) => {
    await lockOwnedCampaign(tx, actor, campaignId);
    await expireStaleTasks(tx, now, campaignId);
    const rows = await tx.campaignChallengeTask.findMany({
      where: { campaignId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    return rows.map((row) => toDto(row as TaskRow));
  });
}

async function expireStaleTasks(
  tx: Prisma.TransactionClient,
  now: Date,
  campaignId?: string,
): Promise<number> {
  const creating = await tx.campaignChallengeTask.updateMany({
    where: {
      ...(campaignId ? { campaignId } : {}),
      status: "creating",
      deadlineAt: { lte: now },
    },
    data: { status: "ambiguous", safeError: "ambiguous_creation", updatedAt: now },
  });
  const submitted = await tx.$executeRaw(Prisma.sql`
    UPDATE "campaign_challenge_tasks"
    SET "status" = 'failed',
        "safeError" = CASE
          WHEN "deadlineAt" <= ${now} THEN 'poll_deadline_exceeded'
          ELSE 'poll_limit_reached'
        END,
        "pollLeaseUntil" = NULL,
        "updatedAt" = ${now}
    WHERE (${campaignId ?? null}::text IS NULL OR "campaignId" = ${campaignId ?? null})
      AND "status" = 'submitted'
      AND ("deadlineAt" <= ${now} OR "pollAttempts" >= "maxPollAttempts")
      AND ("pollLeaseUntil" IS NULL OR "pollLeaseUntil" <= ${now})
  `);
  return creating.count + submitted;
}

export async function expireStaleCampaignChallengeTasks(
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> {
  return inTransaction(prisma, (tx) => expireStaleTasks(tx, now));
}

export async function getCampaignChallengeCampaignContext(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
): Promise<CampaignChallengeCampaignContext> {
  const campaign = await prisma.campaign.findFirst({
    where: campaignScope(actor, campaignId),
    select: { mode: true, status: true, config: true },
  });
  if (!campaign) throw new CampaignNotFoundError();
  const config = CampaignConfigInput.parse(campaign.config);
  return {
    mode: campaign.mode,
    status: campaign.status,
    dailySpendLimitMicros: config.dailySpendLimitMicros,
  };
}

export interface ReserveCampaignChallengeTaskInput {
  campaignId: string;
  nonce: string;
  payloadHash: string;
  reservationMicros: number;
  deadlineAt: Date;
  now?: Date;
  maxPollAttempts?: number;
}

export async function reserveCampaignChallengeTask(
  prisma: PrismaClient,
  actor: Actor,
  input: ReserveCampaignChallengeTaskInput,
): Promise<{ task: CampaignChallengeTaskDto; created: boolean }> {
  if (!Number.isSafeInteger(input.reservationMicros) || input.reservationMicros <= 0) {
    throw new CampaignRuleError("A positive safe challenge reservation is required");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.payloadHash)) {
    throw new CampaignRuleError("Challenge payload hash is invalid");
  }
  const now = input.now ?? new Date();
  const maxPollAttempts = input.maxPollAttempts ?? MAX_POLL_ATTEMPTS;
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1 || maxPollAttempts > 50) {
    throw new CampaignRuleError("Challenge poll attempt limit is invalid");
  }
  try {
    return await inTransaction(prisma, async (tx) => {
      const campaign = await lockOwnedCampaign(tx, actor, input.campaignId);
      const existing = await tx.campaignChallengeTask.findUnique({
        where: { campaignId_nonce: { campaignId: input.campaignId, nonce: input.nonce } },
      });
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          throw new CampaignRuleError(
            "This challenge nonce was already used for different image data",
          );
        }
        return { task: toDto(existing as TaskRow), created: false };
      }
      if (campaign.mode !== "research" || campaign.status !== "active") {
        throw new CampaignRuleError("Paid challenges require an active research campaign");
      }
      const config = CampaignConfigInput.parse(campaign.config);
      if (config.dailySpendLimitMicros <= 0) {
        throw new CampaignRuleError("Paid challenges are disabled by this campaign's spend limit");
      }

      const dayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const spent = await getCampaignDailyReservedSpendMicros(tx, input.campaignId, dayStart);
      const budget = BigInt(config.dailySpendLimitMicros);
      const reservation = BigInt(input.reservationMicros);
      if (spent + reservation > budget) {
        throw new CampaignRuleError("The campaign's daily challenge budget has been reserved");
      }

      const task = await tx.campaignChallengeTask.create({
        data: {
          campaignId: input.campaignId,
          nonce: input.nonce,
          payloadHash: input.payloadHash,
          status: "creating",
          reservationMicros: reservation,
          maxPollAttempts,
          deadlineAt: input.deadlineAt,
        },
      });
      return { task: toDto(task as TaskRow), created: true };
    });
  } catch (error) {
    // A serialized duplicate may only become visible after the winning transaction commits.
    if (!isUniqueViolation(error)) throw error;
    const campaign = await prisma.campaign.findFirst({
      where: campaignScope(actor, input.campaignId),
      select: { id: true },
    });
    if (!campaign) throw new CampaignNotFoundError();
    const existing = await prisma.campaignChallengeTask.findUnique({
      where: { campaignId_nonce: { campaignId: input.campaignId, nonce: input.nonce } },
    });
    if (!existing) throw error;
    if (existing.payloadHash !== input.payloadHash) {
      throw new CampaignRuleError("This challenge nonce was already used for different image data");
    }
    return { task: toDto(existing as TaskRow), created: false };
  }
}

export async function completeCampaignChallengeCreation(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
  providerTaskId: string,
  now = new Date(),
): Promise<CampaignChallengeTaskDto> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "creating") return toDto(task as TaskRow);
    const updated = await tx.campaignChallengeTask.update({
      where: { id: taskId },
      data: {
        status: task.deadlineAt <= now ? "ambiguous" : "submitted",
        providerTaskId,
        nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
        safeError: task.deadlineAt <= now ? "ambiguous_creation" : null,
        updatedAt: now,
      },
    });
    return toDto(updated as TaskRow);
  });
}

export async function failCampaignChallengeCreation(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
  error: { ambiguous: boolean; code: CampaignChallengeSafeError },
  now = new Date(),
): Promise<CampaignChallengeTaskDto> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "creating") return toDto(task as TaskRow);
    const updated = await tx.campaignChallengeTask.update({
      where: { id: taskId },
      data: {
        status: error.ambiguous ? "ambiguous" : "failed",
        reservationMicros: error.ambiguous ? task.reservationMicros : 0n,
        safeError: error.code,
        updatedAt: now,
      },
    });
    return toDto(updated as TaskRow);
  });
}

export async function claimCampaignChallengePoll(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
  now = new Date(),
): Promise<{ task: CampaignChallengeTaskDto; providerTaskId: string | null; claimed: boolean }> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "submitted" || !task.providerTaskId) {
      return { task: toDto(task as TaskRow), providerTaskId: null, claimed: false };
    }
    if (task.pollLeaseUntil && task.pollLeaseUntil > now) {
      return { task: toDto(task as TaskRow), providerTaskId: null, claimed: false };
    }
    if (task.deadlineAt <= now) {
      const updated = await tx.campaignChallengeTask.update({
        where: { id: taskId },
        data: { status: "failed", safeError: "poll_deadline_exceeded", updatedAt: now },
      });
      return { task: toDto(updated as TaskRow), providerTaskId: null, claimed: false };
    }
    if (task.pollAttempts >= task.maxPollAttempts) {
      const updated = await tx.campaignChallengeTask.update({
        where: { id: taskId },
        data: { status: "failed", safeError: "poll_limit_reached", updatedAt: now },
      });
      return { task: toDto(updated as TaskRow), providerTaskId: null, claimed: false };
    }
    if (
      (task.nextPollAt && task.nextPollAt > now) ||
      (task.pollLeaseUntil && task.pollLeaseUntil > now)
    ) {
      return { task: toDto(task as TaskRow), providerTaskId: null, claimed: false };
    }
    const updated = await tx.campaignChallengeTask.update({
      where: { id: taskId },
      data: {
        pollAttempts: { increment: 1 },
        pollLeaseUntil: new Date(now.getTime() + POLL_LEASE_MS),
        nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
        updatedAt: now,
      },
    });
    return { task: toDto(updated as TaskRow), providerTaskId: task.providerTaskId, claimed: true };
  });
}

function microsFromUsd(costUsd: number): bigint {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new CampaignRuleError("Provider task cost is invalid");
  }
  const micros = Math.round(costUsd * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new CampaignRuleError("Provider task cost is too large");
  return BigInt(micros);
}

export async function recordCampaignChallengePoll(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
  result: ChallengeTaskResult,
  encryptedSolution: string | null,
  now = new Date(),
): Promise<CampaignChallengeTaskDto> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "submitted") return toDto(task as TaskRow);
    const data: Prisma.CampaignChallengeTaskUpdateInput = {
      pollLeaseUntil: null,
      updatedAt: now,
    };
    if (result.status === "processing") {
      data.nextPollAt = new Date(now.getTime() + POLL_INTERVAL_MS);
    } else if (result.status === "ready") {
      if (!encryptedSolution) {
        throw new CampaignRuleError(
          "A completed challenge result must be encrypted before storage",
        );
      }
      data.status = "ready";
      data.nextPollAt = null;
      data.safeError = null;
      data.solutionCiphertext = encryptedSolution;
      if (result.costUsd !== undefined) data.actualCostMicros = microsFromUsd(result.costUsd);
    } else {
      data.status = "failed";
      data.nextPollAt = null;
      data.safeError = "provider_task_failed";
    }
    const updated = await tx.campaignChallengeTask.update({ where: { id: taskId }, data });
    return toDto(updated as TaskRow);
  });
}

export async function getCampaignChallengeSolution(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
): Promise<string> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "ready" || !task.solutionCiphertext) {
      throw new CampaignRuleError("Challenge result is not available");
    }
    return task.solutionCiphertext;
  });
}

export async function recordCampaignChallengePollFailure(
  prisma: PrismaClient,
  actor: Actor,
  campaignId: string,
  taskId: string,
  now = new Date(),
): Promise<CampaignChallengeTaskDto> {
  return inTransaction(prisma, async (tx) => {
    const task = await lockOwnedTask(tx, actor, campaignId, taskId);
    if (task.status !== "submitted") return toDto(task as TaskRow);
    const updated = await tx.campaignChallengeTask.update({
      where: { id: taskId },
      data: { pollLeaseUntil: null, safeError: "provider_unavailable", updatedAt: now },
    });
    return toDto(updated as TaskRow);
  });
}
