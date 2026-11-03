import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscourseCampaignAdapter } from "./discourse-campaign.js";

const db = vi.hoisted(() => ({
  list: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    listCampaignPublicationActions: db.list,
    claimCampaignPublicationVerification: db.claim,
    completeCampaignPublicationVerification: db.complete,
  };
});

import { createCampaignPublicationWorker } from "./campaign-publication-worker.js";

function dueAction(
  id: string,
  status: "intent" | "submitted" | "pending" = "submitted",
  providerPostId: number | null = 501,
) {
  return {
    id,
    campaignId: "campaign-1",
    status,
    providerPostId,
    campaign: {
      workspaceId: "workspace-1",
      userId: "owner-1",
      user: { email: "owner@example.test" },
    },
  };
}

function fakeAdapter(
  verifyPublication: DiscourseCampaignAdapter["verifyPublication"] = async (postId) => ({
    status: "success",
    value: {
      verification: "verified",
      evidence: {
        postId,
        topicId: 77,
        audience: "public",
        visibility: "visible",
        expectedLinkMatched: true,
      },
    },
  }),
) {
  return {
    getIdentity: vi.fn(),
    getTopic: vi.fn(),
    publishReviewedContribution: vi.fn(),
    verifyPublication: vi.fn(verifyPublication),
  } satisfies DiscourseCampaignAdapter;
}

describe("campaign publication worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.list.mockResolvedValue([]);
    db.claim.mockImplementation(async (_prisma, _actor, input) => ({
      verify: true,
      action: { id: input.actionId },
      expectedLink: "https://brand.example/",
      topicId: 77,
      providerPostId: 501,
    }));
    db.complete.mockResolvedValue({ status: "verified" });
  });

  it("expires stale records without provider configuration", async () => {
    const action = dueAction("intent-1", "intent", null);
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => [action]) },
    } as never;
    const worker = createCampaignPublicationWorker({ prisma });

    await worker.tick();
    await worker.stop();

    expect(db.list).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ userId: "owner-1", workspaceId: "workspace-1" }),
      "campaign-1",
    );
    expect(db.claim).not.toHaveBeenCalled();
  });

  it("verifies a durable post receipt and completes only matching public evidence", async () => {
    const action = dueAction("action-1");
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => [action]) },
    } as never;
    const adapter = fakeAdapter();
    const worker = createCampaignPublicationWorker({ prisma, adapter });

    await worker.tick();
    await worker.stop();

    expect(adapter.verifyPublication).toHaveBeenCalledWith(501, "https://brand.example/");
    expect(db.complete).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ userId: "owner-1", isDeploymentOwner: true }),
      expect.objectContaining({
        campaignId: "campaign-1",
        actionId: "action-1",
        outcome: "verified",
        safeError: null,
      }),
    );
    expect(adapter.publishReviewedContribution).not.toHaveBeenCalled();
    expect(adapter.getIdentity).not.toHaveBeenCalled();
  });

  it("records mismatched evidence as pending and bounds verification concurrency", async () => {
    const actions = Array.from({ length: 7 }, (_, index) => dueAction(`action-${index}`));
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => actions) },
    } as never;
    let active = 0;
    let peak = 0;
    const adapter = fakeAdapter(async (postId) => {
      active += 1;
      peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return {
        status: "success",
        value: {
          verification: "verified",
          evidence: {
            postId,
            topicId: 77,
            audience: "public",
            visibility: "moderated",
            expectedLinkMatched: true,
          },
        },
      };
    });
    const worker = createCampaignPublicationWorker({ prisma, adapter });

    await worker.tick();
    await worker.stop();

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(db.complete).toHaveBeenCalledTimes(7);
    for (const call of db.complete.mock.calls) {
      expect(call[2]).toMatchObject({ outcome: "pending", safeError: "verification_pending" });
    }
  });

  it("never attempts verification for an unresolved submission without a receipt ID", async () => {
    const action = dueAction("ambiguous-1", "intent", null);
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => [action]) },
    } as never;
    const adapter = fakeAdapter();
    const worker = createCampaignPublicationWorker({ prisma, adapter });

    await worker.tick();
    await worker.stop();

    expect(adapter.verifyPublication).not.toHaveBeenCalled();
    expect(db.claim).not.toHaveBeenCalled();
    expect(adapter.publishReviewedContribution).not.toHaveBeenCalled();
  });

  it("does not overlap ticks and waits for an active check when stopping", async () => {
    const action = dueAction("action-stop");
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => [action]) },
    } as never;
    let resolveCheck: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = fakeAdapter(
      () =>
        new Promise((resolve) => {
          started?.();
          resolveCheck = () =>
            resolve({
              status: "success",
              value: {
                verification: "verified",
                evidence: {
                  postId: 501,
                  topicId: 77,
                  audience: "public",
                  visibility: "visible",
                  expectedLinkMatched: true,
                },
              },
            });
        }),
    );
    const worker = createCampaignPublicationWorker({ prisma, adapter });
    const first = worker.tick();
    expect(worker.tick()).toBe(first);
    await began;
    const stopping = worker.stop();
    expect(db.complete).not.toHaveBeenCalled();
    resolveCheck?.();
    await stopping;
    await expect(first).resolves.toBeUndefined();
    expect(adapter.verifyPublication).toHaveBeenCalledTimes(1);
    expect(db.complete).not.toHaveBeenCalled();
  });

  it("bounds a hung verification and records pending without any publication retry", async () => {
    const action = dueAction("action-hung");
    const prisma = {
      campaignPublicationAction: { findMany: vi.fn(async () => [action]) },
    } as never;
    const adapter = fakeAdapter(() => new Promise(() => undefined));
    const worker = createCampaignPublicationWorker({
      prisma,
      adapter,
      requestTimeoutMs: 5,
      onError: vi.fn(),
    });

    await worker.tick();
    await worker.stop();

    expect(db.complete).toHaveBeenCalledWith(
      prisma,
      expect.anything(),
      expect.objectContaining({ outcome: "pending", safeError: "provider_unavailable" }),
    );
    expect(adapter.publishReviewedContribution).not.toHaveBeenCalled();
    expect(adapter.getIdentity).not.toHaveBeenCalled();
  });
});
