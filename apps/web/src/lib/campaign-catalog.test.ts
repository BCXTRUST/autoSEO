import { describe, expect, it } from "vitest";
import {
  hasCatalogJobsForWebsite,
  isExpectedCatalogAbsence,
  readCatalogPage,
  summarizeCatalog,
} from "./campaign-catalog";
import type { CampaignItem, CampaignJob } from "./campaign-types";

const runId = "a".repeat(64);

function item(overrides: Partial<CampaignItem> = {}): CampaignItem {
  return {
    id: "catalog-page-1",
    campaignId: "campaign-1",
    kind: "source",
    url: "https://example.com/robots.txt",
    title: "Website crawl guidance",
    body: "User-agent: *\nAllow: /",
    status: "verified",
    details: {
      catalog: {
        runId,
        rootUrl: "https://example.com/",
        purpose: "guidance",
        category: "guidance",
        provenance: "conventional_probe",
        depth: 0,
      },
      evidence: [
        {
          id: "evidence-1",
          url: "https://example.com/robots.txt",
          title: "Website crawl guidance",
          excerpt: "User-agent: * Allow: /",
        },
      ],
      observedLinks: [
        {
          url: "https://example.com/docs",
          label: "Documentation",
          category: "guidance",
          status: "candidate",
        },
      ],
    },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<CampaignJob> = {}): CampaignJob {
  return {
    id: "catalog-job-1",
    itemId: "catalog-page-1",
    operation: "catalog_page",
    status: "succeeded",
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: "2026-11-01T00:00:00.000Z",
    startedAt: "2026-11-01T00:00:00.000Z",
    heartbeatAt: "2026-11-01T00:00:01.000Z",
    deadlineAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("official website catalog projection", () => {
  it("separates real catalog evidence and unverified observed link candidates from manual sources", () => {
    const page = readCatalogPage(item());
    expect(page?.metadata).toMatchObject({
      runId,
      purpose: "guidance",
      provenance: "conventional_probe",
      depth: 0,
    });
    expect(page?.evidence[0]?.excerpt).toBe("User-agent: * Allow: /");
    expect(page?.candidates).toEqual([
      {
        url: "https://example.com/docs",
        label: "Documentation",
        category: "guidance",
        status: "candidate",
      },
    ]);
    expect(readCatalogPage(item({ details: { label: "User added" } }))).toBeNull();
  });

  it("reports persisted queue outcomes and marks blocked guidance without claiming coverage", () => {
    const guidance = item({ status: "needs_action" });
    const counts = summarizeCatalog(
      [guidance],
      [
        job({ status: "needs_action", lastError: "robots_unavailable" }),
        job({ id: "catalog-job-2", status: "queued" }),
        job({ id: "source-job", operation: "research_source", status: "running" }),
      ],
    );

    expect(counts).toMatchObject({
      queued: 1,
      running: 0,
      needsAction: 1,
      succeeded: 0,
      guidanceBlocked: true,
    });
    expect(counts.jobs).toHaveLength(2);
  });

  it("distinguishes skipped guidance from a successful catalog run", () => {
    const skipped = item({
      status: "failed",
      details: {
        catalog: {
          runId,
          rootUrl: "https://example.com/",
          purpose: "guidance",
          category: "guidance",
          provenance: "conventional_probe",
          depth: 0,
        },
        recoveryReason: "Website catalog crawling is blocked because guidance was skipped.",
      },
    });
    const summary = summarizeCatalog([skipped], [job({ status: "cancelled" })]);
    expect(summary.guidanceSkipped).toBe(true);
    expect(summary.guidanceBlocked).toBe(false);
    expect(summary.succeeded).toBe(0);
  });

  it("keeps canceled old-site guidance in history without making the new run look blocked", () => {
    const oldGuidance = item({
      id: "old-guidance",
      url: "https://old.example.com/robots.txt",
      status: "failed",
      details: {
        catalog: {
          runId,
          rootUrl: "https://old.example.com/",
          purpose: "guidance",
          category: "guidance",
          provenance: "conventional_probe",
          depth: 0,
        },
        recoveryReason: "This catalog page was canceled because the campaign website changed.",
      },
    });
    const newGuidance = item({
      id: "new-guidance",
      url: "https://new.example.com/robots.txt",
      status: "researching",
      details: {
        catalog: {
          runId: "b".repeat(64),
          rootUrl: "https://new.example.com/",
          purpose: "guidance",
          category: "guidance",
          provenance: "conventional_probe",
          depth: 0,
        },
      },
    });
    const oldSkippedGuidance = item({
      id: "old-skipped-guidance",
      url: "https://old.example.com/robots.txt",
      status: "failed",
      details: {
        catalog: {
          runId: "c".repeat(64),
          rootUrl: "https://old.example.com/",
          purpose: "guidance",
          category: "guidance",
          provenance: "conventional_probe",
          depth: 0,
        },
        recoveryReason: "Website catalog crawling is blocked because guidance was skipped.",
      },
    });
    const summary = summarizeCatalog(
      [oldGuidance, oldSkippedGuidance, newGuidance],
      [
        job({
          id: "old-guidance-job",
          itemId: oldGuidance.id,
          status: "cancelled",
          lastError: "website_changed",
        }),
        job({
          id: "new-guidance-job",
          itemId: newGuidance.id,
          status: "queued",
          lastError: null,
        }),
        job({
          id: "old-skipped-guidance-job",
          itemId: oldSkippedGuidance.id,
          status: "cancelled",
          lastError: "guidance_skipped",
        }),
      ],
      "https://new.example.com/",
    );
    expect(summary.pages).toHaveLength(3);
    expect(summary.guidanceBlocked).toBe(false);
    expect(summary.guidanceSkipped).toBe(false);
    expect(summary.queued).toBe(1);
  });

  it("does not call a new website finished based only on completed prior-root jobs", () => {
    const priorPage = item({
      id: "prior-root-page",
      url: "https://old.example.com/",
      details: {
        catalog: {
          runId,
          rootUrl: "https://old.example.com/",
          purpose: "page",
          category: "homepage",
          provenance: "configured_website",
          depth: 0,
        },
      },
    });
    const oldJob = job({ itemId: priorPage.id, status: "succeeded" });
    expect(hasCatalogJobsForWebsite([priorPage], [oldJob], "https://new.example.com/")).toBe(false);
    expect(hasCatalogJobsForWebsite([priorPage], [oldJob], "https://old.example.com")).toBe(true);
  });

  it("treats only missing conventional page probes as non-blocking", () => {
    const probe = item({
      id: "llms-probe",
      url: "https://example.com/llms.txt",
      title: "LLMs guidance",
      status: "failed",
      details: {
        catalog: {
          runId,
          rootUrl: "https://example.com/",
          purpose: "page",
          category: "llm",
          provenance: "conventional_probe",
          depth: 0,
        },
      },
    });
    const optionalAbsentJob = job({ itemId: probe.id, status: "failed", lastError: "page_absent" });
    expect(isExpectedCatalogAbsence(probe, optionalAbsentJob)).toBe(true);

    const guidance403 = item({
      status: "failed",
      details: {
        catalog: {
          runId,
          rootUrl: "https://example.com/",
          purpose: "guidance",
          category: "guidance",
          provenance: "conventional_probe",
          depth: 0,
        },
      },
    });
    expect(
      isExpectedCatalogAbsence(guidance403, {
        ...job({ itemId: guidance403.id, status: "failed", lastError: "page_forbidden" }),
      }),
    ).toBe(false);

    const observedPage403 = item({
      status: "failed",
      details: {
        catalog: {
          runId,
          rootUrl: "https://example.com/",
          purpose: "page",
          category: "article",
          provenance: "observed_link",
          depth: 1,
        },
      },
    });
    expect(
      isExpectedCatalogAbsence(observedPage403, {
        ...job({ itemId: observedPage403.id, status: "failed", lastError: "page_forbidden" }),
      }),
    ).toBe(false);

    const counts = summarizeCatalog(
      [probe, guidance403, observedPage403],
      [
        optionalAbsentJob,
        job({
          id: "guidance-403",
          itemId: guidance403.id,
          status: "failed",
          lastError: "page_forbidden",
        }),
        job({
          id: "observed-403",
          itemId: observedPage403.id,
          status: "failed",
          lastError: "page_forbidden",
        }),
      ],
    );
    expect(counts).toMatchObject({ notFound: 1, needsAction: 2 });
  });

  it("rejects unsafe catalog URLs and non-candidate external links", () => {
    const unsafe = item({
      details: {
        catalog: {
          runId,
          rootUrl: "https://user:secret@example.com/",
          purpose: "page",
          category: "homepage",
          provenance: "observed_link",
          depth: 1,
        },
        observedLinks: [
          {
            url: "https://example.com/seen",
            label: "Seen",
            category: "other",
            status: "verified",
          },
        ],
      },
    });
    expect(readCatalogPage(unsafe)).toBeNull();
    expect(
      readCatalogPage(
        item({
          details: {
            catalog: {
              runId,
              rootUrl: "https://example.com/",
              purpose: "page",
              category: "homepage",
              provenance: "observed_link",
              depth: 3,
            },
          },
        }),
      ),
    ).toBeNull();
  });
});
