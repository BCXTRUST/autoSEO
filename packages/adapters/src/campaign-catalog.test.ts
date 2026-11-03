import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("./campaign-research.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./campaign-research.js")>();
  return { ...actual, fetchCampaignPublicResource: network.fetch };
});

import {
  CAMPAIGN_CATALOG_USER_AGENT,
  canonicalCatalogUrl,
  classifyCatalogPage,
  fetchCampaignCatalogPage,
  isCatalogUrlAllowed,
  parseCatalogRobots,
} from "./campaign-catalog.js";
import { CampaignResearchError, validateCampaignResearchUrl } from "./campaign-research.js";

const root = "https://shop.example/";

function resource(body: string, contentType = "text/html", httpStatus = 200) {
  network.fetch.mockResolvedValue({
    url: "https://shop.example/catalog",
    httpStatus,
    contentType,
    body,
  });
}

describe("campaign catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    network.fetch.mockReset();
  });

  it("parses bounded HTML text and observes anchors before removing navigation", async () => {
    resource(
      '<html><head><title>Catalog</title><script>secret()</script></head><body><nav><a href="/shop/item?utm_source=nav">Hardware item</a></nav><main>Useful details</main></body></html>',
    );
    const page = await fetchCampaignCatalogPage("https://shop.example/catalog", {
      allowedOrigin: "https://shop.example",
      now: () => new Date("2026-11-02T12:00:00Z"),
    });

    expect(page).toMatchObject({
      title: "Catalog",
      text: "Useful details",
      contentType: "text/html",
      httpStatus: 200,
      fetchedAt: "2026-11-02T12:00:00.000Z",
      links: [{ url: "https://shop.example/shop/item?utm_source=nav", label: "Hardware item" }],
    });
    expect(network.fetch).toHaveBeenCalledWith(
      "https://shop.example/catalog",
      expect.objectContaining({
        allowedOrigin: "https://shop.example",
        userAgent: CAMPAIGN_CATALOG_USER_AGENT,
      }),
    );
  });

  it("extracts sitemap url and sitemap-index loc entries without treating them as claims", async () => {
    resource(
      "<urlset><url><loc>https://shop.example/shop/item</loc></url><url><loc>https://shop.example/blog/post</loc></url></urlset>",
      "application/xml",
    );
    const page = await fetchCampaignCatalogPage("https://shop.example/sitemap.xml", {
      allowedOrigin: "https://shop.example",
    });
    expect(page.contentType).toBe("application/xml");
    expect(page.links).toEqual([
      { url: "https://shop.example/shop/item", label: "Sitemap URL" },
      { url: "https://shop.example/blog/post", label: "Sitemap URL" },
    ]);
  });

  it("rejects XML DTD and entity declarations without resolving them", async () => {
    resource(
      '<!DOCTYPE urlset [<!ENTITY x "expanded">]><urlset><url><loc>https://shop.example/&x;</loc></url></urlset>',
      "application/xml",
    );
    await expect(
      fetchCampaignCatalogPage("https://shop.example/sitemap.xml", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({ kind: "unsupported", safeCode: "xml_declaration_unsupported" });
  });

  it("extracts Markdown links from plain text and allows an empty robots file", async () => {
    resource("[App](https://shop.example/app) and [help](https://docs.example/help)", "text/plain");
    const markdown = await fetchCampaignCatalogPage("https://shop.example/llms.txt", {
      allowedOrigin: "https://shop.example",
    });
    expect(markdown.links).toEqual([
      { url: "https://shop.example/app", label: "App" },
      { url: "https://docs.example/help", label: "help" },
    ]);

    resource("", "text/plain");
    network.fetch.mockResolvedValueOnce({
      url: "https://shop.example/robots.txt",
      httpStatus: 200,
      contentType: "text/plain",
      body: "",
    });
    const robots = await fetchCampaignCatalogPage("https://shop.example/robots.txt", {
      allowedOrigin: "https://shop.example",
    });
    expect(robots).toMatchObject({ title: "robots.txt", text: "", links: [], httpStatus: 200 });
  });

  it("preserves raw multiline robots policy through fetch and bounded text projection", async () => {
    const rawRobots = "User-agent: *\nDisallow: /secret\nAllow: /secret/public\n";
    network.fetch.mockResolvedValue({
      url: "https://shop.example/robots.txt",
      httpStatus: 200,
      contentType: "text/plain",
      body: rawRobots,
    });
    const page = await fetchCampaignCatalogPage("https://shop.example/robots.txt", {
      allowedOrigin: "https://shop.example",
    });
    expect(page.robotsText).toBe(rawRobots);
    expect(page.text).toBe("User-agent: * Disallow: /secret Allow: /secret/public");
    const rules = parseCatalogRobots(page.robotsText!, root);
    expect(isCatalogUrlAllowed("https://shop.example/secret/no", rules)).toBe(false);
    expect(isCatalogUrlAllowed("https://shop.example/secret/public", rules)).toBe(true);
  });

  it("rejects a non-text robots response instead of interpreting it as empty policy", async () => {
    network.fetch.mockResolvedValue({
      url: "https://shop.example/robots.txt",
      httpStatus: 200,
      contentType: "text/html",
      body: "<html><body>Sign in</body></html>",
    });
    await expect(
      fetchCampaignCatalogPage("https://shop.example/robots.txt", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({ kind: "unsupported", safeCode: "robots_content_type" });
  });

  it.each([
    [404, "unsupported", "page_absent"],
    [410, "unsupported", "page_absent"],
    [401, "unsupported", "page_forbidden"],
    [403, "unsupported", "page_forbidden"],
    [429, "transient", "rate_limited"],
    [503, "transient", "server_error"],
  ] as const)("classifies HTTP %i as a typed safe result", async (httpStatus, kind, safeCode) => {
    resource("", "text/html", httpStatus);
    await expect(
      fetchCampaignCatalogPage("https://shop.example/catalog", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({ name: "CampaignCatalogError", kind, safeCode });
  });

  it("retains bounded text and link projections and maps bounded response errors", async () => {
    const anchors = Array.from(
      { length: 105 },
      (_, index) => `<a href="/item/${index}">Item ${index}</a>`,
    ).join("");
    resource(
      `<html><head><title>${"x".repeat(300)}</title></head><body>${anchors}${" copied".repeat(5_000)}</body></html>`,
    );
    const page = await fetchCampaignCatalogPage("https://shop.example/catalog", {
      allowedOrigin: "https://shop.example",
    });
    expect(page.title).toHaveLength(200);
    expect(page.text.length).toBeLessThanOrEqual(18_000);
    expect(page.links).toHaveLength(100);

    network.fetch.mockRejectedValue(new CampaignResearchError("unsupported", "page_too_large"));
    await expect(
      fetchCampaignCatalogPage("https://shop.example/catalog", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({ kind: "unsupported", safeCode: "page_too_large" });

    network.fetch.mockResolvedValue({
      url: "https://shop.example/robots.txt",
      httpStatus: 200,
      contentType: "text/plain",
      body: `User-agent: *\nDisallow: /secret\n${"x".repeat(64 * 1024)}`,
    });
    await expect(
      fetchCampaignCatalogPage("https://shop.example/robots.txt", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({ kind: "unsupported", safeCode: "robots_too_large" });
  });

  it("rejects a private target under the shared research URL policy", () => {
    expect(() => validateCampaignResearchUrl("http://127.0.0.1/robots.txt")).toThrowError(
      expect.objectContaining({ name: "CampaignResearchError", kind: "invalid_input" }),
    );
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("rejects an initially disallowed catalog URL before calling the transport", async () => {
    await expect(
      fetchCampaignCatalogPage("https://shop.example/private", {
        allowedOrigin: "https://shop.example",
        allowedUrl: () => false,
      }),
    ).rejects.toMatchObject({ kind: "unsupported", safeCode: "robots_disallowed" });
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("canonicalizes only same-origin, non-auth, non-media pages and removes trackers", () => {
    expect(canonicalCatalogUrl("/shop/item?utm_source=campaign&color=blue#details", root)).toBe(
      "https://shop.example/shop/item?color=blue",
    );
    expect(canonicalCatalogUrl("/shop/item?utm_source=campaign&color=blue", root)).toBe(
      "https://shop.example/shop/item?color=blue",
    );
    for (const input of [
      "https://elsewhere.example/item",
      "https://user:pass@shop.example/item",
      "/login",
      "/cart",
      "/search?q=device",
      "/manual.pdf",
      "/image.webp",
    ]) {
      expect(canonicalCatalogUrl(input, root)).toBeNull();
    }
  });

  it("classifies routes as navigation hints rather than facts", () => {
    expect(classifyCatalogPage("https://shop.example/")).toBe("homepage");
    expect(classifyCatalogPage("https://shop.example/app/overview")).toBe("app");
    expect(classifyCatalogPage("https://shop.example/shop/device-a")).toBe("device");
    expect(classifyCatalogPage("https://shop.example/blog/guide")).toBe("article");
    expect(classifyCatalogPage("https://shop.example/llms.txt")).toBe("llm");
    expect(classifyCatalogPage("not a url")).toBe("other");
  });

  it("uses named AutoSEO rules when present and longest-match allow precedence", () => {
    const named = parseCatalogRobots(
      "User-agent: *\nDisallow: /private\nUser-agent: AutoSEO\nDisallow: /private\nDisallow: /private/*/secret$\nAllow: /private/public",
      root,
    );
    expect(named.disallow).toEqual(["/private", "/private/*/secret$"]);
    expect(isCatalogUrlAllowed("https://shop.example/private/secret", named)).toBe(false);
    expect(isCatalogUrlAllowed("https://shop.example/private/public", named)).toBe(true);
    expect(isCatalogUrlAllowed("https://shop.example/open", named)).toBe(true);

    const wildcard = parseCatalogRobots(
      "User-agent: *\nDisallow: /admin\nAllow: /admin/public",
      root,
    );
    expect(isCatalogUrlAllowed("https://shop.example/admin/secret", wildcard)).toBe(false);
    expect(isCatalogUrlAllowed("https://shop.example/admin/public", wildcard)).toBe(true);
  });

  it("keeps only safe same-origin sitemap links and fails closed on unsupported active directives", () => {
    const rules = parseCatalogRobots(
      "User-agent: *\nDisallow: /private\nSitemap: https://shop.example/sitemap.xml\nSitemap: https://other.example/sitemap.xml",
      root,
    );
    expect(rules.sitemaps).toEqual(["https://shop.example/sitemap.xml"]);
    expect(() => parseCatalogRobots("User-agent: AutoSEO\nClean-param: ref /", root)).toThrowError(
      expect.objectContaining({ kind: "unsupported", safeCode: "robots_directive_unsupported" }),
    );
  });

  it("rejects oversized robots content", () => {
    expect(() => parseCatalogRobots("x".repeat(64 * 1024 + 1), root)).toThrowError(
      expect.objectContaining({ kind: "unsupported", safeCode: "robots_too_large" }),
    );
  });

  it("rejects policies whose accepted-rule projection would exceed safe bounds", () => {
    const tooManyAllow = [
      "User-agent: AutoSEO",
      ...Array.from({ length: 101 }, (_, index) => `Allow: /p${index}`),
    ].join("\n");
    expect(() => parseCatalogRobots(tooManyAllow, root)).toThrowError(
      expect.objectContaining({ kind: "unsupported", safeCode: "robots_rule_limit" }),
    );
    expect(() =>
      parseCatalogRobots(`User-agent: AutoSEO\nDisallow: /${"*".repeat(17)}`, root),
    ).toThrowError(expect.objectContaining({ kind: "unsupported", safeCode: "robots_rule_limit" }));
  });
});
