import { describe, expect, it } from "vitest";
import {
  canDismissDiscoveryRecord,
  canSelectDiscoveryRecord,
  countCandidatesForSearch,
  readDiscoveryRecord,
  summarizeDiscovery,
} from "./campaign-discovery";
import type { CampaignItem, CampaignJob } from "./campaign-types";

const runId = "d".repeat(64);

function item(
  purpose: "search" | "candidate",
  overrides: Partial<CampaignItem> = {},
): CampaignItem {
  const id = purpose === "search" ? "search-1" : "candidate-1";
  return {
    id,
    campaignId: "campaign-1",
    kind: purpose === "search" ? "source" : "opportunity",
    url:
      purpose === "search"
        ? "https://community.example.test/"
        : "https://community.example.test/topic",
    title: purpose === "search" ? "Community search" : "Topic candidate",
    body: "Observed factual excerpt.",
    status: purpose === "search" ? "verified" : "needs_action",
    details: {
      excerpt: "Observed factual excerpt.",
      discovery: {
        runId,
        rootUrl: "https://example.test/",
        purpose,
        provider: "bing",
        query: 'example.test "mesh router" forum',
        sourceItemIds: ["search-1"],
        ...(purpose === "candidate" ? { rank: 1, observedAt: "2026-11-02T00:00:00.000Z" } : {}),
        inspection: purpose === "candidate" ? "observed" : "pending",
        eligibility: "needs_review",
        disposition: "unreviewed",
        rulesLinks: [{ url: "https://community.example.test/robots.txt", label: "Robots rules" }],
        platformHint: "discourse",
      },
    },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...overrides,
  };
}

function job(itemId: string, operation: string, status: CampaignJob["status"]): CampaignJob {
  return {
    id: `${itemId}-job`,
    itemId,
    operation,
    status,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: "2026-11-02T00:00:00.000Z",
    startedAt: null,
    heartbeatAt: null,
    deadlineAt: null,
    lastError: null,
  };
}

describe("campaign discovery projection", () => {
  it("separates search source tasks and factual observed candidates", () => {
    const search = item("search");
    const candidate = item("candidate");
    const summary = summarizeDiscovery(
      [search, candidate],
      [
        job(search.id, "discovery_search", "succeeded"),
        job(candidate.id, "discovery_inspect", "succeeded"),
      ],
    );
    expect(summary.searches).toHaveLength(1);
    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]).toMatchObject({
      excerpt: "Observed factual excerpt.",
      metadata: {
        query: 'example.test "mesh router" forum',
        rank: 1,
        inspection: "observed",
        eligibility: "needs_review",
        disposition: "unreviewed",
        platformHint: "discourse",
      },
      job: { operation: "discovery_inspect", status: "succeeded" },
    });
  });

  it("counts candidates by the exact persisted run, provider, and query", () => {
    const searchItem = item("search");
    const search = readDiscoveryRecord(searchItem, [
      job(searchItem.id, "discovery_search", "succeeded"),
    ]);
    const first = readDiscoveryRecord(item("candidate", { id: "candidate-a" }), [
      job("candidate-a", "discovery_inspect", "succeeded"),
    ]);
    const second = readDiscoveryRecord(item("candidate", { id: "candidate-b" }), [
      job("candidate-b", "discovery_inspect", "succeeded"),
    ]);
    const laterQuery = readDiscoveryRecord(
      item("candidate", {
        id: "candidate-later-query",
        details: {
          discovery: {
            ...(item("candidate").details.discovery as Record<string, unknown>),
            query: "a different query",
          },
        },
      }),
      [job("candidate-later-query", "discovery_inspect", "succeeded")],
    );
    const anotherRun = readDiscoveryRecord(
      item("candidate", {
        id: "candidate-other-run",
        details: {
          discovery: {
            ...(item("candidate").details.discovery as Record<string, unknown>),
            runId: "e".repeat(64),
          },
        },
      }),
      [job("candidate-other-run", "discovery_inspect", "succeeded")],
    );
    expect(search && first && second && laterQuery && anotherRun).toBeTruthy();
    if (!search || !first || !second || !laterQuery || !anotherRun)
      throw new Error("Missing fixture data");
    expect(countCandidatesForSearch(search, [first, second, laterQuery, anotherRun])).toBe(2);
    expect(
      countCandidatesForSearch(
        { ...search, metadata: { ...search.metadata, query: "no matching query" } },
        [first, second, laterQuery, anotherRun],
      ),
    ).toBe(0);
  });

  it("selects only inspected unreviewed candidates and allows dismissing pending ones", () => {
    const succeeded = readDiscoveryRecord(item("candidate"), [
      job("candidate-1", "discovery_inspect", "succeeded"),
    ]);
    expect(succeeded && canSelectDiscoveryRecord(succeeded, "https://example.test/")).toBe(true);
    expect(succeeded && canDismissDiscoveryRecord(succeeded)).toBe(true);

    const pendingItem = item("candidate", {
      details: {
        discovery: {
          ...(item("candidate").details.discovery as Record<string, unknown>),
          inspection: "pending",
        },
      },
    });
    const pending = readDiscoveryRecord(pendingItem, [
      job("candidate-1", "discovery_inspect", "queued"),
    ]);
    expect(pending && canSelectDiscoveryRecord(pending, "https://example.test/")).toBe(false);
    expect(pending && canDismissDiscoveryRecord(pending)).toBe(true);
  });

  it("does not offer selection for an observed candidate from a prior configured root", () => {
    const previousRootCandidate = item("candidate", {
      details: {
        ...item("candidate").details,
        discovery: {
          ...(item("candidate").details.discovery as Record<string, unknown>),
          rootUrl: "https://old.example.test/",
        },
      },
    });
    const prior = readDiscoveryRecord(previousRootCandidate, [
      job("candidate-1", "discovery_inspect", "succeeded"),
    ]);
    expect(prior && canSelectDiscoveryRecord(prior, "https://new.example.test/")).toBe(false);
    expect(prior && canSelectDiscoveryRecord(prior, "https://old.example.test")).toBe(true);
    expect(prior && canDismissDiscoveryRecord(prior)).toBe(true);
  });

  it("rejects unsafe candidate URLs and invalid rule links", () => {
    const unsafe = item("candidate", {
      url: "https://user:secret@community.example.test/topic",
    });
    expect(readDiscoveryRecord(unsafe)).toBeNull();
    const badRules = item("candidate", {
      details: {
        discovery: {
          ...(item("candidate").details.discovery as Record<string, unknown>),
          rulesLinks: [{ url: "javascript:alert(1)", label: "bad" }],
        },
      },
    });
    expect(readDiscoveryRecord(badRules)).toBeNull();
  });
});
