import type { ChallengeProvider, ChallengeTaskResult } from "@rakazo/adapter-kit/challenge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  expire: vi.fn(),
  claim: vi.fn(),
  record: vi.fn(),
  recordFailure: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    expireStaleCampaignChallengeTasks: db.expire,
    claimCampaignChallengePoll: db.claim,
    recordCampaignChallengePoll: db.record,
    recordCampaignChallengePollFailure: db.recordFailure,
  };
});

import { createCampaignChallengeWorker } from "./campaign-challenge-worker.js";

function dueTask(id: string) {
  return {
    id,
    campaignId: "campaign-1",
    campaign: {
      workspaceId: "workspace-1",
      userId: "owner-1",
      user: { email: "owner@example.test" },
    },
  };
}

function fakeProvider(
  pollTask: ChallengeProvider["pollTask"] = async () => ({ status: "processing" }),
) {
  return {
    getBalance: vi.fn(async () => ({ balanceUsd: 1 })),
    createTask: vi.fn(async () => ({ taskId: "must-not-create" })),
    pollTask: vi.fn(pollTask),
  } satisfies ChallengeProvider;
}

const secretStoreStub = {
  put: vi.fn(async (text: string) => ({ id: "secret-1", ciphertext: `ciphertext:${text}` })),
  load: vi.fn(),
};
const secretStore = secretStoreStub as never;

describe("campaign challenge worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.expire.mockResolvedValue(0);
    db.claim.mockImplementation(async (_prisma, _actor, campaignId: string, taskId: string) => ({
      task: { id: taskId, campaignId, status: "submitted" },
      providerTaskId: `provider-${taskId}`,
      claimed: true,
    }));
    db.record.mockResolvedValue({ status: "submitted" });
    db.recordFailure.mockResolvedValue({ status: "submitted" });
  });

  it("expires durable records without provider configuration and makes no provider calls", async () => {
    const prismaStub = {
      campaignChallengeTask: { findMany: vi.fn() },
    };
    const prisma = prismaStub as never;
    const worker = createCampaignChallengeWorker({ prisma, secrets: secretStore });
    await worker.tick();
    await worker.stop();
    expect(db.expire).toHaveBeenCalledTimes(1);
    expect(prismaStub.campaignChallengeTask.findMany).not.toHaveBeenCalled();
  });

  it("reconciles due IDs with at most three concurrent polls and stores only encrypted answers", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => dueTask(`task-${index}`));
    const prisma = {
      campaignChallengeTask: { findMany: vi.fn(async () => tasks) },
    } as never;
    let active = 0;
    let peak = 0;
    const provider = fakeProvider(async (): Promise<ChallengeTaskResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return { status: "ready", solution: { text: "private-answer" }, costUsd: 0.0007 };
    });
    const onError = vi.fn();
    const worker = createCampaignChallengeWorker({
      prisma,
      provider,
      secrets: secretStore,
      onError,
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    await worker.tick();
    await worker.stop();

    expect(provider.pollTask).toHaveBeenCalledTimes(6);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(provider.createTask).not.toHaveBeenCalled();
    expect(provider.getBalance).not.toHaveBeenCalled();
    expect(secretStoreStub.put).toHaveBeenCalledTimes(6);
    expect(db.record).toHaveBeenCalledTimes(6);
    for (const [, , , , result, ciphertext] of db.record.mock.calls) {
      expect(result).toMatchObject({ status: "ready", solution: { text: "private-answer" } });
      expect(ciphertext).toBe("ciphertext:private-answer");
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not overlap ticks and stop aborts an active provider poll", async () => {
    const prisma = {
      campaignChallengeTask: { findMany: vi.fn(async () => [dueTask("task-abort")]) },
    } as never;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider = fakeProvider(
      (_taskId, options) =>
        new Promise((_resolve, reject) => {
          markStarted?.();
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const worker = createCampaignChallengeWorker({
      prisma,
      provider,
      secrets: secretStore,
      onError: vi.fn(),
    });
    const first = worker.tick();
    const overlapping = worker.tick();
    expect(overlapping).toBe(first);
    await started;
    await worker.stop();
    await expect(first).resolves.toBeUndefined();
    expect(provider.pollTask).toHaveBeenCalledTimes(1);
    expect(db.recordFailure).toHaveBeenCalledTimes(1);
  });
});
