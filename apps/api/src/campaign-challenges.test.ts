import type { ChallengeTaskResult } from "@rakazo/adapter-kit/challenge";
import { AntiCaptchaError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  campaignContext: vi.fn(),
  getSolution: vi.fn(),
  tasks: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  claimPoll: vi.fn(),
  recordPoll: vi.fn(),
  recordPollFailure: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    getCampaignChallengeCampaignContext: db.campaignContext,
    getCampaignChallengeSolution: db.getSolution,
    getCampaignChallengeTasks: db.tasks,
    reserveCampaignChallengeTask: db.reserve,
    completeCampaignChallengeCreation: db.complete,
    failCampaignChallengeCreation: db.fail,
    claimCampaignChallengePoll: db.claimPoll,
    recordCampaignChallengePoll: db.recordPoll,
    recordCampaignChallengePollFailure: db.recordPollFailure,
  };
});

import { createCampaignChallengeService } from "./campaign-challenges.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const member: Actor = { ...owner, userId: "user-2", isDeploymentOwner: false };
const campaign = { mode: "research", status: "active", dailySpendLimitMicros: 10_000 };
const task = {
  id: "task-1",
  campaignId: "campaign-1",
  status: "creating" as const,
  reservationMicros: 1000,
  actualCostMicros: null,
  pollAttempts: 0,
  maxPollAttempts: 12,
  deadlineAt: "2026-11-02T12:05:00.000Z",
  nextPollAt: null,
  safeError: null,
  createdAt: "2026-11-02T12:00:00.000Z",
  updatedAt: "2026-11-02T12:00:00.000Z",
};
const createInput = {
  campaignId: "campaign-1",
  clientNonce: "nonce-1",
  imageBase64: "c2VjcmV0LWltYWdl",
  authorizedUse: true as const,
};

function provider() {
  return {
    getBalance: vi.fn(async () => ({ balanceUsd: 12.5 })),
    createTask: vi.fn(async () => ({ taskId: "provider-task-9" })),
    pollTask: vi.fn(async (): Promise<ChallengeTaskResult> => ({ status: "processing" })),
  };
}

const secrets = {
  put: vi.fn(async (plaintext: string) => ({ id: "secret-1", ciphertext: `cipher:${plaintext}` })),
  load: vi.fn((ciphertext: string) => ciphertext.slice("cipher:".length)),
} as never;

describe("campaign challenge service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.campaignContext.mockResolvedValue(campaign);
    db.getSolution.mockResolvedValue("cipher:answer");
    db.tasks.mockResolvedValue([]);
    db.reserve.mockResolvedValue({ task, created: true });
    db.complete.mockResolvedValue({ ...task, status: "submitted" });
    db.fail.mockResolvedValue({ ...task, status: "ambiguous", safeError: "ambiguous_creation" });
    db.claimPoll.mockResolvedValue({
      task: { ...task, status: "submitted" },
      providerTaskId: "provider-task-9",
      claimed: true,
    });
    db.recordPoll.mockResolvedValue({ ...task, status: "submitted" });
    db.recordPollFailure.mockResolvedValue({
      ...task,
      status: "submitted",
      safeError: "provider_unavailable",
    });
  });

  it("makes no provider calls and prevents task creation while paid challenges are disabled", async () => {
    const fakeProvider = provider();
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: { ANTI_CAPTCHA_API_KEY: "operator-key", CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000" },
    });
    const status = await service.status(owner, { campaignId: "campaign-1" });
    expect(status).toMatchObject({
      configured: true,
      paidTasksEnabled: false,
      status: "disabled",
      balanceUsd: null,
    });
    expect(fakeProvider.getBalance).not.toHaveBeenCalled();
    await expect(service.create(owner, createInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fakeProvider.createTask).not.toHaveBeenCalled();
    expect(db.reserve).not.toHaveBeenCalled();
  });

  it("does not expose shared account balance or spend through a non-owner campaign", async () => {
    const fakeProvider = provider();
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    await expect(service.status(member, { campaignId: "campaign-1" })).resolves.toMatchObject({
      status: "disabled",
      balanceUsd: null,
    });
    await expect(service.create(member, createInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fakeProvider.getBalance).not.toHaveBeenCalled();
    expect(fakeProvider.createTask).not.toHaveBeenCalled();
    expect(db.reserve).not.toHaveBeenCalled();
  });

  it("posts only after durable reservation and duplicate nonce replays never post twice", async () => {
    const fakeProvider = provider();
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    db.reserve
      .mockResolvedValueOnce({ task, created: true })
      .mockResolvedValueOnce({ task: { ...task, status: "submitted" }, created: false });
    await expect(service.create(owner, createInput)).resolves.toMatchObject({
      status: "submitted",
    });
    await expect(service.create(owner, createInput)).resolves.toMatchObject({
      status: "submitted",
    });
    expect(db.reserve).toHaveBeenCalledTimes(2);
    expect(db.reserve.mock.calls[0]?.[2]).not.toHaveProperty("imageBase64");
    expect(fakeProvider.createTask).toHaveBeenCalledTimes(1);
    expect(db.complete).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      "campaign-1",
      "task-1",
      "provider-task-9",
      expect.any(Date),
    );
  });

  it("retains an ambiguous reservation and never retries task creation on nonce replay", async () => {
    const fakeProvider = provider();
    fakeProvider.createTask.mockRejectedValue(
      new AntiCaptchaError("ambiguous_creation", "safe ambiguity"),
    );
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    db.reserve.mockResolvedValueOnce({ task, created: true }).mockResolvedValueOnce({
      task: { ...task, status: "ambiguous", safeError: "ambiguous_creation" },
      created: false,
    });
    await expect(service.create(owner, createInput)).resolves.toMatchObject({
      status: "ambiguous",
    });
    await expect(service.create(owner, createInput)).resolves.toMatchObject({
      status: "ambiguous",
    });
    expect(db.fail).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      "campaign-1",
      "task-1",
      { ambiguous: true, code: "ambiguous_creation" },
      expect.any(Date),
    );
    expect(fakeProvider.createTask).toHaveBeenCalledTimes(1);
  });

  it("treats an unknown create failure as ambiguous rather than releasing the reservation", async () => {
    const fakeProvider = provider();
    fakeProvider.createTask.mockRejectedValue(new Error("transport detail that must not escape"));
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    const result = await service.create(owner, createInput);
    expect(result).toMatchObject({ status: "ambiguous", reservationMicros: 1000 });
    expect(result.safeError).toBe("ambiguous_creation");
    expect(JSON.stringify(result)).not.toContain("transport detail");
    expect(db.fail).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      "campaign-1",
      "task-1",
      { ambiguous: true, code: "ambiguous_creation" },
      expect.any(Date),
    );
  });

  it("performs at most one provider poll for a persisted claim and omits solve text", async () => {
    const fakeProvider = provider();
    fakeProvider.pollTask.mockResolvedValue({
      status: "ready",
      solution: { text: "private solve" },
      costUsd: 0.0007,
    });
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    db.claimPoll
      .mockResolvedValueOnce({
        task: { ...task, status: "submitted" },
        providerTaskId: null,
        claimed: false,
      })
      .mockResolvedValueOnce({
        task: { ...task, status: "submitted" },
        providerTaskId: "provider-task-9",
        claimed: true,
      });
    await expect(
      service.poll(owner, { campaignId: "campaign-1", taskId: "task-1" }),
    ).resolves.toMatchObject({ status: "submitted" });
    const result = await service.poll(owner, { campaignId: "campaign-1", taskId: "task-1" });
    expect(fakeProvider.pollTask).toHaveBeenCalledTimes(1);
    expect(db.recordPoll).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      "campaign-1",
      "task-1",
      {
        status: "ready",
        solution: { text: "private solve" },
        costUsd: 0.0007,
      },
      "cipher:private solve",
      expect.any(Date),
    );
    expect(JSON.stringify(result)).not.toContain("private solve");
  });

  it("caches account balance for the short status interval", async () => {
    const fakeProvider = provider();
    let epoch = Date.parse("2026-11-02T12:00:00.000Z");
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: fakeProvider,
      secrets,
      now: () => new Date(epoch),
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    await expect(service.status(owner, { campaignId: "campaign-1" })).resolves.toMatchObject({
      status: "ready",
      balanceUsd: 12.5,
    });
    epoch += 10_000;
    await service.status(owner, { campaignId: "campaign-1" });
    expect(fakeProvider.getBalance).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer behind deployment-owner retrieval and labels it manual only", async () => {
    const service = createCampaignChallengeService({
      prisma: {} as never,
      provider: provider(),
      secrets,
      env: {
        ANTI_CAPTCHA_API_KEY: "operator-key",
        CAMPAIGN_PAID_CHALLENGES_ENABLED: "true",
        CAMPAIGN_CHALLENGE_RESERVATION_MICROS: "1000",
      },
    });
    await expect(
      service.result(owner, { campaignId: "campaign-1", taskId: "task-1" }),
    ).resolves.toEqual({ taskId: "task-1", solution: "answer", application: "manual_only" });
    await expect(
      service.result(member, { campaignId: "campaign-1", taskId: "task-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.getSolution).toHaveBeenCalledTimes(1);
  });
});
