import { describe, expect, it, vi } from "vitest";
import { CampaignCatalogError, type CampaignCatalogPage } from "./campaign-catalog.js";
import {
  type CampaignCatalogPageFetcher,
  CampaignOpportunityInspectionError,
  inspectCampaignOpportunity,
} from "./campaign-discovery.js";

const candidate = "https://community.example/t/helpful-topic/123";
const origin = "https://community.example";

function robotsPage(url: string, robotsText: string): CampaignCatalogPage {
  return {
    url,
    title: "robots.txt",
    text: robotsText.replace(/\s+/g, " ").trim(),
    robotsText,
    contentType: "text/plain",
    fetchedAt: "2026-11-02T12:00:00.000Z",
    links: [],
    httpStatus: 200,
  };
}

function candidatePage(overrides: Partial<CampaignCatalogPage> = {}): CampaignCatalogPage {
  return {
    url: candidate,
    title: "Community support topic",
    text: "Observed public discussion about product setup.",
    contentType: "text/html",
    fetchedAt: "2026-11-02T12:00:00.000Z",
    links: [
      { url: `${origin}/guidelines`, label: "Community guidelines" },
      { url: `${origin}/terms`, label: "Terms of use" },
      { url: "https://other.example/rules", label: "Rules" },
      { url: `${origin}/ordinary`, label: "More information" },
    ],
    httpStatus: 200,
    ...overrides,
  };
}

function scriptedFetcher(
  responses: Array<CampaignCatalogPage | Error>,
): CampaignCatalogPageFetcher & { calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async (_url: string, _options: unknown) => {
    const response = responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    return response;
  });
  return Object.assign(calls, { calls }) as CampaignCatalogPageFetcher & { calls: typeof calls };
}

describe("campaign opportunity inspection", () => {
  it("returns observed-page evidence and only observed same-origin policy links", async () => {
    const fetchCatalogPage = scriptedFetcher([
      robotsPage(`${origin}/robots.txt`, "User-agent: *\nDisallow: /private\n"),
      candidatePage(),
    ]);
    const result = await inspectCampaignOpportunity({
      url: candidate,
      now: () => new Date("2026-11-02T12:30:00Z"),
      fetchCatalogPage,
    });

    expect(result).toEqual({
      url: candidate,
      title: "Community support topic",
      excerpt: "Observed public discussion about product setup.",
      observedAt: "2026-11-02T12:30:00.000Z",
      rulesLinks: [
        { url: `${origin}/guidelines`, label: "Community guidelines" },
        { url: `${origin}/terms`, label: "Terms of use" },
      ],
      platformHint: "discourse",
      eligibility: "needs_review",
      evidenceKind: "observed_page",
    });
    expect(fetchCatalogPage.calls).toHaveBeenCalledTimes(2);
    expect(fetchCatalogPage.calls.mock.calls[0]![0]).toBe(`${origin}/robots.txt`);
    expect(fetchCatalogPage.calls.mock.calls[0]![1]).toMatchObject({ allowedOrigin: origin });
    expect(fetchCatalogPage.calls.mock.calls[1]![1]).toMatchObject({ allowedOrigin: origin });
    expect(fetchCatalogPage.calls.mock.calls[1]![1]).toHaveProperty("allowedUrl");
  });

  it("allows a missing robots file but still fetches only the explicit candidate", async () => {
    const fetchCatalogPage = scriptedFetcher([
      new CampaignCatalogError("unsupported", "page_absent"),
      candidatePage({ url: `${origin}/support`, links: [] }),
    ]);
    const result = await inspectCampaignOpportunity({ url: `${origin}/support`, fetchCatalogPage });
    expect(result.eligibility).toBe("needs_review");
    expect(result.platformHint).toBe("unknown");
    expect(fetchCatalogPage.calls).toHaveBeenCalledTimes(2);
  });

  it("does not fetch candidate content when robots disallows its path", async () => {
    const fetchCatalogPage = scriptedFetcher([
      robotsPage(`${origin}/robots.txt`, "User-agent: AutoSEO\nDisallow: /t/\n"),
      candidatePage(),
    ]);
    await expect(
      inspectCampaignOpportunity({ url: candidate, fetchCatalogPage }),
    ).rejects.toMatchObject({ kind: "unavailable", safeCode: "robots_disallowed" });
    expect(fetchCatalogPage.calls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["transient", "rate_limited"],
    ["unavailable", "page_forbidden"],
    ["unavailable", "robots_directive_unsupported"],
  ] as const)("returns safe guidance error for robots failure %s/%s", async (kind, safeCode) => {
    const fetchCatalogPage = scriptedFetcher([
      new CampaignCatalogError(kind === "transient" ? "transient" : "unsupported", safeCode),
      candidatePage(),
    ]);
    await expect(
      inspectCampaignOpportunity({ url: candidate, fetchCatalogPage }),
    ).rejects.toMatchObject({ name: "CampaignOpportunityInspectionError", kind, safeCode });
    expect(fetchCatalogPage.calls).toHaveBeenCalledTimes(1);
  });

  it("uses only observed page text and rejects empty, cross-origin, or unsupported pages", async () => {
    const noTextFetcher = scriptedFetcher([
      robotsPage(`${origin}/robots.txt`, ""),
      candidatePage({ text: "   ", links: [{ url: `${origin}/rules`, label: "Rules" }] }),
    ]);
    await expect(
      inspectCampaignOpportunity({ url: candidate, fetchCatalogPage: noTextFetcher }),
    ).rejects.toMatchObject({ kind: "unavailable", safeCode: "page_has_no_text" });

    const crossOriginFetcher = scriptedFetcher([
      robotsPage(`${origin}/robots.txt`, ""),
      candidatePage({ url: "https://other.example/page" }),
    ]);
    await expect(
      inspectCampaignOpportunity({ url: candidate, fetchCatalogPage: crossOriginFetcher }),
    ).rejects.toMatchObject({ kind: "unavailable", safeCode: "page_origin_invalid" });

    const nonSuccessFetcher = scriptedFetcher([
      robotsPage(`${origin}/robots.txt`, ""),
      candidatePage({ httpStatus: 403 }),
    ]);
    await expect(
      inspectCampaignOpportunity({ url: candidate, fetchCatalogPage: nonSuccessFetcher }),
    ).rejects.toMatchObject({ kind: "unavailable", safeCode: "page_status" });
  });

  it("rejects private and unsuitable candidates before any page fetch", async () => {
    const fetchCatalogPage = scriptedFetcher([]);
    await expect(
      inspectCampaignOpportunity({ url: "http://127.0.0.1/private", fetchCatalogPage }),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(
      inspectCampaignOpportunity({
        url: "https://community.example/download.pdf",
        fetchCatalogPage,
      }),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(fetchCatalogPage.calls).not.toHaveBeenCalled();
  });

  it("stops an injected fetcher promptly when the caller aborts", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchCatalogPage: CampaignCatalogPageFetcher = (_url, options) =>
      new Promise((_resolve, reject) => {
        started?.();
        options.signal?.addEventListener("abort", () => reject(new Error("secret response")), {
          once: true,
        });
      });
    const request = inspectCampaignOpportunity({
      url: candidate,
      signal: controller.signal,
      fetchCatalogPage,
    });
    await requestStarted;
    controller.abort();
    await expect(request).rejects.toMatchObject({
      name: "CampaignOpportunityInspectionError",
      kind: "transient",
      safeCode: "fetch_aborted",
      message: "fetch_aborted",
    });
  });

  it("enforces one 20-second invocation deadline across both reads", async () => {
    let clock = 10_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchCatalogPage = vi.fn(async (url: string) => {
      if (url.endsWith("robots.txt")) {
        clock += 20_001;
        return robotsPage(url, "");
      }
      return candidatePage();
    });
    try {
      await expect(
        inspectCampaignOpportunity({ url: candidate, fetchCatalogPage }),
      ).rejects.toMatchObject({ kind: "transient", safeCode: "fetch_timeout" });
      expect(fetchCatalogPage).toHaveBeenCalledTimes(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not expose provider exception contents", async () => {
    const fetchCatalogPage = scriptedFetcher([new Error("private URL and response body")]);
    const error = await inspectCampaignOpportunity({ url: candidate, fetchCatalogPage }).catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(CampaignOpportunityInspectionError);
    expect(error.message).toBe("fetch_failed");
    expect(error.message).not.toContain("private URL");
  });
});
