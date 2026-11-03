import {
  CampaignSearchError,
  deriveCampaignSearchQueries,
} from "@rakazo/adapter-kit/campaign-search";
import { describe, expect, it, vi } from "vitest";
import type { CampaignPublicResource } from "./campaign-research.js";
import { createBingCampaignSearchProvider } from "./campaign-search.js";

function fetched(
  body: string,
  overrides: Partial<CampaignPublicResource> = {},
): CampaignPublicResource {
  return {
    url: "https://www.bing.com/search?format=rss&q=test",
    httpStatus: 200,
    contentType: "application/rss+xml",
    body,
    ...overrides,
  };
}

function rss(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Search</title>${items}</channel></rss>`;
}

function item(url: string, title = "A result", description = "A useful result summary") {
  return `<item><title>${title}</title><link>${url.replace(/&/g, "&amp;")}</link><description>${description}</description></item>`;
}

function adapter(body: string, options: { now?: () => Date } = {}) {
  const fetchResource = vi.fn(async () => fetched(body));
  const provider = createBingCampaignSearchProvider({ fetchResource, ...options });
  return { provider, fetchResource };
}

describe("Bing campaign search adapter", () => {
  it("derives queries only from nonempty exact-host catalog source evidence", () => {
    expect(
      deriveCampaignSearchQueries({ websiteUrl: "https://brand.example/", sources: [] }),
    ).toEqual([]);
    expect(
      deriveCampaignSearchQueries({
        websiteUrl: "https://brand.example/",
        sources: [
          {
            url: "https://untrusted.example/page",
            title: "Observed community guide",
            text: "A source passage",
          },
          { url: "https://brand.example/empty", title: "", text: "  " },
          {
            url: "https://brand.example/docs",
            title: "Product onboarding checklist",
            text: "Use these steps",
          },
        ],
      }),
    ).toEqual([
      '"brand.example" product (forum OR discussion)',
      "product onboarding checklist (community OR forum OR discussion) -site:brand.example",
    ]);
    const queries = deriveCampaignSearchQueries({
      websiteUrl: "https://brand.example/",
      sources: [
        {
          url: "https://brand.example/docs",
          title: "Product onboarding checklist",
          text: "Observed source text",
        },
      ],
    });
    expect(queries[0]).toContain('"brand.example"');
    expect(queries[1]).toContain("product onboarding checklist");
    expect(queries[1]).not.toMatch(/(?:^|\s)site:brand\.example/u);
  });

  it("parses inert RSS, sanitizes text, canonicalizes links, and deduplicates", async () => {
    const { provider, fetchResource } = adapter(
      rss(
        item(
          "https://public.example/path?utm_source=test&b=2&a=1#part",
          "<![CDATA[<b>Community title</b>]]>",
          "<![CDATA[Read <script>secret()</script><p>community feedback &amp; setup</p>]]>",
        ) + item("https://public.example/path?a=1&b=2", "duplicate", "duplicate snippet"),
      ),
      { now: () => new Date("2026-01-02T03:04:05.000Z") },
    );
    const result = await provider.search({ query: "site:example.com onboarding forum", limit: 5 });
    expect(result).toEqual({
      query: "site:example.com onboarding forum",
      provider: "bing-rss",
      observedAt: "2026-01-02T03:04:05.000Z",
      results: [
        {
          url: "https://public.example/path?a=1&b=2",
          title: "Community title",
          snippet: "Read community feedback & setup",
          rank: 1,
        },
      ],
    });
    expect(fetchResource).toHaveBeenCalledTimes(1);
    const [url, options] = fetchResource.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    const requested = new URL(url);
    expect(requested.origin).toBe("https://www.bing.com");
    expect(requested.pathname).toBe("/search");
    expect(requested.searchParams.get("format")).toBe("rss");
    expect(requested.searchParams.get("q")).toBe("site:example.com onboarding forum");
    expect(options).toMatchObject({
      allowedOrigin: "https://www.bing.com",
      timeoutMs: 8_000,
      readContentTypes: ["application/rss+xml", "application/xml", "text/xml"],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("enforces query and result limits before transport", async () => {
    const { provider, fetchResource } = adapter(rss(""));
    await expect(provider.search({ query: "x".repeat(301), limit: 1 })).rejects.toMatchObject({
      kind: "invalid_input",
      safeCode: "search_query_invalid",
    });
    await expect(provider.search({ query: "valid", limit: 11 })).rejects.toMatchObject({
      kind: "invalid_input",
      safeCode: "search_query_invalid",
    });
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it("rejects malformed, unsafe XML, wrong root, and unexpected endpoint responses safely", async () => {
    for (const body of [
      "<rss><item>",
      "<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss/>",
      "<html/>",
    ]) {
      const { provider } = adapter(body);
      await expect(provider.search({ query: "safe query", limit: 2 })).rejects.toBeInstanceOf(
        CampaignSearchError,
      );
    }
    const wrongEndpoint = createBingCampaignSearchProvider({
      fetchResource: async () => fetched(rss(""), { url: "https://evil.example/search" }),
    });
    await expect(wrongEndpoint.search({ query: "safe query", limit: 2 })).rejects.toMatchObject({
      kind: "unavailable",
      safeCode: "search_unavailable",
      causeCode: "endpoint_mismatch",
    });
    const wrongMime = createBingCampaignSearchProvider({
      fetchResource: async () => fetched(rss(""), { contentType: "text/html" }),
    });
    await expect(wrongMime.search({ query: "safe query", limit: 2 })).rejects.toMatchObject({
      causeCode: "content_type_invalid",
    });
  });

  it("drops private, credentialed, relative, and non-HTTP result links", async () => {
    const { provider } = adapter(
      rss(
        item("http://127.0.0.1/private") +
          item("https://user:pass@public.example/path") +
          item("/relative") +
          item("javascript:alert(1)") +
          item("https://public.example/valid"),
      ),
    );
    const result = await provider.search({ query: "safe query", limit: 10 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("https://public.example/valid");
  });

  it("rejects oversized bodies and non-success HTTP responses", async () => {
    const large = createBingCampaignSearchProvider({
      fetchResource: async () => fetched("x".repeat(512 * 1024 + 1)),
    });
    await expect(large.search({ query: "safe query", limit: 2 })).rejects.toMatchObject({
      kind: "unavailable",
      causeCode: "response_too_large",
    });
    for (const httpStatus of [403, 429, 503]) {
      const { provider, fetchResource } = adapter("", {});
      fetchResource.mockImplementation(async () => fetched("", { httpStatus }));
      await expect(provider.search({ query: "safe query", limit: 2 })).rejects.toMatchObject({
        kind: httpStatus === 403 ? "unavailable" : "transient",
        safeCode: "search_unavailable",
        causeCode: `http_${httpStatus}`,
      });
      expect(fetchResource).toHaveBeenCalledTimes(1);
    }
  });

  it("handles abort and timeout and never retries a failed transport", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const noCall = vi.fn(async () => fetched(rss("")));
    await expect(
      createBingCampaignSearchProvider({ fetchResource: noCall }).search({
        query: "safe query",
        limit: 1,
        signal: alreadyAborted.signal,
      }),
    ).rejects.toMatchObject({ safeCode: "search_aborted" });
    expect(noCall).not.toHaveBeenCalled();

    const caller = new AbortController();
    const abortedFetch = vi.fn(
      (_url: string, options?: { signal?: AbortSignal }) =>
        new Promise<CampaignPublicResource>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("secret transport detail")),
            {
              once: true,
            },
          );
          caller.abort();
        }),
    );
    await expect(
      createBingCampaignSearchProvider({ fetchResource: abortedFetch }).search({
        query: "safe query",
        limit: 1,
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ safeCode: "search_aborted", causeCode: "caller_aborted" });
    expect(abortedFetch).toHaveBeenCalledTimes(1);

    const networkFailure = vi.fn(async () => {
      throw new Error("key=do-not-leak response body");
    });
    let error: unknown;
    try {
      await createBingCampaignSearchProvider({ fetchResource: networkFailure }).search({
        query: "safe query",
        limit: 1,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ safeCode: "search_unavailable", causeCode: "network_error" });
    expect(String(error)).not.toContain("do-not-leak");
    expect(networkFailure).toHaveBeenCalledTimes(1);

    const timeoutTransport = vi.fn(async () => new Promise<CampaignPublicResource>(() => {}));
    const timeout = createBingCampaignSearchProvider({
      timeoutMs: 1,
      fetchResource: timeoutTransport,
    });
    await expect(timeout.search({ query: "safe query", limit: 1 })).rejects.toMatchObject({
      safeCode: "search_timeout",
      causeCode: "fetch_timeout",
    });
    expect(timeoutTransport).toHaveBeenCalledTimes(1);
  });
});
