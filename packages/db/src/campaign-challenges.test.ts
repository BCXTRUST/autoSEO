import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  claimCampaignChallengePoll,
  completeCampaignChallengeCreation,
  getCampaignChallengeSolution,
  getCampaignChallengeTasks,
  recordCampaignChallengePoll,
  reserveCampaignChallengeTask,
} from "./campaign-challenges.js";
import { CampaignNotFoundError, CampaignRuleError } from "./campaigns.js";
import type { PrismaClient } from "./client.js";

const now = new Date("2026-11-02T12:00:00.000Z");
const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const campaign = {
  id: "campaign-1",
  workspaceId: actor.workspaceId,
  userId: actor.userId,
  mode: "research",
  status: "active",
  config: {
    name: "Campaign",
    websiteUrl: "https://example.test",
    language: "en",
    market: "Global",
    objective: "Test",
    dailyRegistrationLimit: 0,
    dailyPublicationLimit: 0,
    dailySpendLimitMicros: 250,
    requirePublicationReview: true,
  },
};
const payloadHash = "a".repeat(64);

function fakePrisma(
  options: {
    budget?: number;
    owned?: boolean;
    aiReservations?: Array<{
      day: string;
      aiState: string;
      reservationMicros: string;
      actualCostMicros: string | null;
    }>;
  } = {},
) {
  const rows = new Map<string, Record<string, unknown>>();
  const nonceIndex = new Map<string, string>();
  let nextId = 0;
  let transactionQueue = Promise.resolve();
  let nonceReads = 0;
  let createCount = 0;
  const scopedCampaign = {
    ...campaign,
    config: { ...campaign.config, dailySpendLimitMicros: options.budget ?? 250 },
  };

  const prisma = {
    campaign: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; workspaceId?: string; userId?: string } }) => {
          if (options.owned === false) return null;
          if (where.id && where.id !== scopedCampaign.id) return null;
          if (where.workspaceId && where.workspaceId !== scopedCampaign.workspaceId) return null;
          if (where.userId && where.userId !== scopedCampaign.userId) return null;
          return scopedCampaign;
        },
      ),
    },
    $transaction: vi.fn(async <T>(operation: (tx: unknown) => Promise<T>) => {
      let unlock: (() => void) | undefined;
      const previous = transactionQueue;
      transactionQueue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      let rawQuery = 0;
      const tx = {
        $queryRaw: vi.fn(async () => {
          rawQuery += 1;
          if (rawQuery === 1) return options.owned === false ? [] : [{ id: scopedCampaign.id }];
          const dayStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
          );
          let spent = 0n;
          for (const row of rows.values()) {
            if (
              (row.campaignId as string) !== scopedCampaign.id ||
              (row.createdAt as Date) < dayStart
            )
              continue;
            const actual = row.actualCostMicros as bigint | null;
            spent += actual ?? (row.reservationMicros as bigint);
          }
          const dayKey = now.toISOString().slice(0, 10);
          for (const reservation of options.aiReservations ?? []) {
            if (
              reservation.day !== dayKey ||
              !["intent", "ready", "ambiguous"].includes(reservation.aiState)
            ) {
              continue;
            }
            spent += BigInt(reservation.actualCostMicros ?? reservation.reservationMicros);
          }
          return [{ spent }];
        }),
        $executeRaw: vi.fn(async () => {
          let count = 0;
          for (const row of rows.values()) {
            if (row.campaignId !== scopedCampaign.id || row.status !== "submitted") continue;
            const deadlineExpired = (row.deadlineAt as Date) <= now;
            const pollsExhausted = Number(row.pollAttempts) >= Number(row.maxPollAttempts);
            const leaseExpired = !row.pollLeaseUntil || (row.pollLeaseUntil as Date) <= now;
            if ((deadlineExpired || pollsExhausted) && leaseExpired) {
              row.status = "failed";
              row.safeError = deadlineExpired ? "poll_deadline_exceeded" : "poll_limit_reached";
              row.pollLeaseUntil = null;
              row.updatedAt = now;
              count += 1;
            }
          }
          return count;
        }),
        campaign: {
          findFirst: vi.fn(async () => scopedCampaign),
        },
        campaignChallengeTask: {
          findUnique: vi.fn(
            async ({
              where,
            }: {
              where: { campaignId_nonce: { campaignId: string; nonce: string } };
            }) => {
              nonceReads += 1;
              const id = nonceIndex.get(
                `${where.campaignId_nonce.campaignId}:${where.campaignId_nonce.nonce}`,
              );
              return id ? (rows.get(id) ?? null) : null;
            },
          ),
          findFirst: vi.fn(async ({ where }: { where: { id: string; campaignId?: string } }) => {
            const row = rows.get(where.id);
            return row && (!where.campaignId || row.campaignId === where.campaignId) ? row : null;
          }),
          findMany: vi.fn(async ({ where }: { where: { campaignId: string } }) =>
            [...rows.values()].filter((row) => row.campaignId === where.campaignId),
          ),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            createCount += 1;
            nextId += 1;
            const row: Record<string, unknown> = {
              id: `task-${nextId}`,
              ...data,
              providerTaskId: null,
              actualCostMicros: null,
              pollAttempts: 0,
              maxPollAttempts: data.maxPollAttempts ?? 12,
              nextPollAt: null,
              pollLeaseUntil: null,
              safeError: null,
              createdAt: now,
              updatedAt: now,
            };
            rows.set(String(row.id), row);
            nonceIndex.set(`${String(row.campaignId)}:${String(row.nonce)}`, String(row.id));
            return row;
          }),
          updateMany: vi.fn(
            async ({
              where,
              data,
            }: {
              where: { campaignId: string; status?: string; deadlineAt?: { lte: Date } };
              data: Record<string, unknown>;
            }) => {
              let count = 0;
              for (const row of rows.values()) {
                if (row.campaignId !== where.campaignId || row.status !== where.status) continue;
                if (where.deadlineAt && (row.deadlineAt as Date) > where.deadlineAt.lte) continue;
                Object.assign(row, data);
                count += 1;
              }
              return { count };
            },
          ),
          update: vi.fn(
            async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
              const row = rows.get(where.id);
              if (!row) throw new Error("missing task");
              for (const [key, value] of Object.entries(data)) {
                if (value && typeof value === "object" && "increment" in value) {
                  row[key] = Number(row[key]) + Number((value as { increment: number }).increment);
                } else {
                  row[key] = value;
                }
              }
              return row;
            },
          ),
        },
      };
      try {
        return await operation(tx);
      } finally {
        unlock?.();
      }
    }),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    rows,
    get nonceReads() {
      return nonceReads;
    },
    get createCount() {
      return createCount;
    },
  };
}

const reservationInput = (nonce: string, reservationMicros = 150) => ({
  campaignId: campaign.id,
  nonce,
  payloadHash,
  reservationMicros,
  deadlineAt: new Date(now.getTime() + 60_000),
  now,
});

describe("campaign challenge reservations", () => {
  it("checks campaign ownership before consulting the nonce index", async () => {
    const db = fakePrisma({ owned: false });
    await expect(
      reserveCampaignChallengeTask(db.prisma, actor, reservationInput("nonce-1")),
    ).rejects.toBeInstanceOf(CampaignNotFoundError);
    expect(db.nonceReads).toBe(0);
    expect(db.createCount).toBe(0);
  });

  it("serializes concurrent reservations against the exact daily budget", async () => {
    const db = fakePrisma({ budget: 250 });
    const results = await Promise.allSettled([
      reserveCampaignChallengeTask(db.prisma, actor, reservationInput("nonce-a", 150)),
      reserveCampaignChallengeTask(db.prisma, actor, reservationInput("nonce-b", 150)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(db.createCount).toBe(1);
    expect(
      [...db.rows.values()].reduce((total, row) => total + Number(row.reservationMicros), 0),
    ).toBe(150);
  });

  it("counts the optional drafting reservation in the shared campaign daily budget", async () => {
    const db = fakePrisma({
      budget: 250,
      aiReservations: [
        {
          day: "2026-11-02",
          aiState: "intent",
          reservationMicros: "250",
          actualCostMicros: null,
        },
      ],
    });
    await expect(
      reserveCampaignChallengeTask(db.prisma, actor, reservationInput("challenge-after-ai", 1)),
    ).rejects.toBeInstanceOf(CampaignRuleError);
    expect(db.createCount).toBe(0);
  });

  it("replays a matching nonce without creating another task and conflicts on different payload", async () => {
    const db = fakePrisma({ budget: 500 });
    const first = await reserveCampaignChallengeTask(db.prisma, actor, reservationInput("nonce-1"));
    const replay = await reserveCampaignChallengeTask(
      db.prisma,
      actor,
      reservationInput("nonce-1"),
    );
    expect(first).toMatchObject({ created: true });
    expect(replay).toMatchObject({ created: false, task: { id: first.task.id } });
    expect(db.createCount).toBe(1);
    await expect(
      reserveCampaignChallengeTask(db.prisma, actor, {
        ...reservationInput("nonce-1"),
        payloadHash: "b".repeat(64),
      }),
    ).rejects.toBeInstanceOf(CampaignRuleError);
    expect(db.createCount).toBe(1);
  });

  it("keeps provider IDs private and bounds polling with one persisted claim at a time", async () => {
    const db = fakePrisma();
    const reserved = await reserveCampaignChallengeTask(db.prisma, actor, {
      ...reservationInput("nonce-1"),
      maxPollAttempts: 2,
    });
    const submitted = await completeCampaignChallengeCreation(
      db.prisma,
      actor,
      campaign.id,
      reserved.task.id,
      "provider-123",
      now,
    );
    expect(JSON.stringify(submitted)).not.toContain("provider-123");

    const early = await claimCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      now,
    );
    expect(early.claimed).toBe(false);
    const firstPollTime = new Date(now.getTime() + 10_000);
    const firstClaim = await claimCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      firstPollTime,
    );
    expect(firstClaim).toMatchObject({
      claimed: true,
      providerTaskId: "provider-123",
      task: { pollAttempts: 1 },
    });
    const duplicateClaim = await claimCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      firstPollTime,
    );
    expect(duplicateClaim.claimed).toBe(false);
    await recordCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      { status: "processing" },
      null,
      firstPollTime,
    );

    const secondPollTime = new Date(firstPollTime.getTime() + 10_000);
    const secondClaim = await claimCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      secondPollTime,
    );
    expect(secondClaim.task.pollAttempts).toBe(2);
    await recordCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      { status: "processing" },
      null,
      secondPollTime,
    );
    const exhausted = await claimCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      new Date(secondPollTime.getTime() + 10_000),
    );
    expect(exhausted).toMatchObject({
      claimed: false,
      task: { status: "failed", safeError: "poll_limit_reached" },
    });
  });

  it("records validated actual costs in micros", async () => {
    const db = fakePrisma();
    const reserved = await reserveCampaignChallengeTask(
      db.prisma,
      actor,
      reservationInput("nonce-cost"),
    );
    const submitted = await completeCampaignChallengeCreation(
      db.prisma,
      actor,
      campaign.id,
      reserved.task.id,
      "provider-cost",
      now,
    );
    const row = db.rows.get(submitted.id)!;
    row.nextPollAt = new Date(now.getTime() - 1);
    await claimCampaignChallengePoll(db.prisma, actor, campaign.id, submitted.id, now);
    const ready = await recordCampaignChallengePoll(
      db.prisma,
      actor,
      campaign.id,
      submitted.id,
      { status: "ready", solution: { text: "private answer" }, costUsd: 0.0007 },
      "encrypted-solution",
      now,
    );
    expect(ready.actualCostMicros).toBe(700);
    expect(JSON.stringify(ready)).not.toContain("private answer");
    expect(JSON.stringify(ready)).not.toContain("encrypted-solution");
    await expect(
      getCampaignChallengeSolution(db.prisma, actor, campaign.id, submitted.id),
    ).resolves.toBe("encrypted-solution");
  });

  it("expires abandoned creating and submitted work during status reads", async () => {
    const db = fakePrisma({ budget: 500 });
    const creating = await reserveCampaignChallengeTask(
      db.prisma,
      actor,
      reservationInput("nonce-stale"),
    );
    const submittedReservation = await reserveCampaignChallengeTask(
      db.prisma,
      actor,
      reservationInput("nonce-submitted"),
    );
    const submitted = await completeCampaignChallengeCreation(
      db.prisma,
      actor,
      campaign.id,
      submittedReservation.task.id,
      "provider-stale",
      new Date(now.getTime() - 20_000),
    );
    const creatingRow = db.rows.get(creating.task.id)!;
    creatingRow.deadlineAt = new Date(now.getTime() - 1);
    const submittedRow = db.rows.get(submitted.id)!;
    submittedRow.deadlineAt = new Date(now.getTime() - 1);
    submittedRow.nextPollAt = new Date(now.getTime() - 1);
    submittedRow.pollLeaseUntil = null;

    const tasks = await getCampaignChallengeTasks(db.prisma, actor, campaign.id, now);
    expect(tasks.find((task) => task.id === creating.task.id)).toMatchObject({
      status: "ambiguous",
      safeError: "ambiguous_creation",
    });
    expect(tasks.find((task) => task.id === submitted.id)).toMatchObject({
      status: "failed",
      safeError: "poll_deadline_exceeded",
    });
  });
});
