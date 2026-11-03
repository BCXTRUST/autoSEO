import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  request: vi.fn(),
  destroyAgent: vi.fn(async () => undefined),
}));

vi.mock("node:dns/promises", () => ({ lookup: transport.dnsLookup }));
vi.mock("undici", () => ({
  Agent: class {
    destroy = transport.destroyAgent;
  },
  request: transport.request,
}));

import { type CampaignCatalogError, fetchCampaignCatalogPage } from "./campaign-catalog.js";

describe("campaign catalog request guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("does not request a same-origin redirect denied by robots", async () => {
    transport.request.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: "/private/secret" },
      body: { destroy: vi.fn() },
    });
    const allowUrl = (url: string) => new URL(url).pathname !== "/private/secret";

    await expect(
      fetchCampaignCatalogPage("https://shop.example/public", {
        allowedOrigin: "https://shop.example",
        allowedUrl: allowUrl,
      }),
    ).rejects.toMatchObject({
      name: "CampaignCatalogError",
      kind: "unsupported",
      safeCode: "robots_disallowed",
    } satisfies Partial<CampaignCatalogError>);

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(String(transport.request.mock.calls[0]![0])).toBe("https://shop.example/public");
  });

  it("rejects a cross-origin redirect before requesting its destination", async () => {
    transport.request.mockResolvedValueOnce({
      statusCode: 302,
      headers: { location: "https://other.example/public" },
      body: { destroy: vi.fn() },
    });

    await expect(
      fetchCampaignCatalogPage("https://shop.example/public", {
        allowedOrigin: "https://shop.example",
      }),
    ).rejects.toMatchObject({
      name: "CampaignCatalogError",
      kind: "invalid_input",
      safeCode: "redirect_origin_mismatch",
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
});
