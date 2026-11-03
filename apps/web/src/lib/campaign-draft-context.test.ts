import { describe, expect, it } from "vitest";
import { readDraftProjectContext } from "./campaign-draft-context";
import type { CampaignItem } from "./campaign-types";

const runId = "f".repeat(64);

function draft(details: Record<string, unknown>): CampaignItem {
  return {
    id: "draft-1",
    campaignId: "campaign-1",
    kind: "draft",
    url: "https://community.example.test/topic",
    title: "Draft suggestion",
    body: "Source notes for review.",
    status: "needs_action",
    details,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  };
}

describe("draft official project context", () => {
  it("projects available official references without implying model usage", () => {
    const result = readDraftProjectContext(
      draft({
        projectContext: {
          rootUrl: "https://official.example.test/",
          runId,
          sourceIds: ["official-home"],
          state: "available",
        },
        evidence: [
          {
            id: "target-page",
            url: "https://community.example.test/topic",
            title: "Community discussion",
            excerpt: "Target evidence must not be mistaken for official evidence.",
            fetchedAt: "2026-11-02T00:00:00.000Z",
          },
          {
            id: "official-home",
            url: "https://official.example.test/",
            title: "Official home",
            excerpt: "Verified official product facts.",
            fetchedAt: "2026-11-02T00:00:00.000Z",
          },
        ],
      }),
      "https://official.example.test",
    );
    expect(result).toMatchObject({ state: "available", isHistorical: false });
    expect(result?.references).toHaveLength(1);
    expect(result?.references[0]?.title).toBe("Official home");
  });

  it("retains older-root evidence as historical context and represents missing sources", () => {
    const historical = readDraftProjectContext(
      draft({
        projectContext: {
          rootUrl: "https://old.example.test/",
          runId,
          sourceIds: ["old-source"],
          state: "supplied",
        },
        evidence: [
          {
            id: "old-source",
            url: "https://old.example.test/guide",
            title: "Prior official guide",
            excerpt: "Preserved evidence from the prior root.",
            fetchedAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
      "https://new.example.test/",
    );
    expect(historical).toMatchObject({ state: "supplied", isHistorical: true });
    expect(historical?.references[0]?.excerpt).toBe("Preserved evidence from the prior root.");

    const missing = readDraftProjectContext(
      draft({
        projectContext: {
          rootUrl: "https://new.example.test/",
          runId: null,
          sourceIds: [],
          state: "missing",
        },
        evidence: [],
      }),
      "https://new.example.test/",
    );
    expect(missing).toMatchObject({ state: "missing", references: [], isHistorical: false });
  });

  it("rejects unsafe references and malformed project metadata", () => {
    const unsafe = readDraftProjectContext(
      draft({
        projectContext: {
          rootUrl: "https://official.example.test/",
          runId,
          sourceIds: ["source-1"],
          state: "available",
        },
        evidence: [
          {
            id: "source-1",
            url: "javascript:alert(1)",
            title: "Unsafe",
            excerpt: "Do not render.",
            fetchedAt: "2026-11-02T00:00:00.000Z",
          },
        ],
      }),
      "https://official.example.test/",
    );
    expect(unsafe?.references).toHaveLength(0);
    expect(
      readDraftProjectContext(
        draft({
          projectContext: { rootUrl: "https://official.example.test/", state: "available" },
        }),
        "https://official.example.test/",
      ),
    ).toBeNull();
  });
});
