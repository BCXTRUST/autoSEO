import { describe, expect, it } from "vitest";
import {
  type CampaignResearchError,
  createCampaignPublicAddressLookup,
  extractPageText,
  researchCampaignUrl,
  validateCampaignResearchRedirect,
} from "./campaign-research.js";

describe("campaign page research", () => {
  it("extracts a page title and readable text without scripts or navigation", () => {
    expect(
      extractPageText(
        "<html><head><title>Example page</title><script>secret()</script></head><body><nav>Menu</nav><main><p>A useful fact.</p></main></body></html>",
        "text/html",
      ),
    ).toEqual({ title: "Example page", text: "A useful fact." });
  });

  it.each([
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://localhost/",
    "http://service.local/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[2001:db8::1]/",
    "http://[2002:c000:0201::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.0.2.10/",
  ])("rejects unsafe supplied URL %s before a network request", async (url) => {
    await expect(researchCampaignUrl(url)).rejects.toMatchObject({
      name: "CampaignResearchError",
      kind: "invalid_input",
    } satisfies Partial<CampaignResearchError>);
  });

  it("blocks a redirect to a private destination before following it", () => {
    expect(() =>
      validateCampaignResearchRedirect(
        new URL("https://public.example/start"),
        "http://169.254.169.254/latest/meta-data/",
      ),
    ).toThrowError(
      expect.objectContaining({ kind: "invalid_input", safeCode: "url_address_blocked" }),
    );
  });

  it("pins the validated DNS answer to the socket lookup", async () => {
    const lookup = createCampaignPublicAddressLookup(async (hostname) => {
      expect(hostname).toBe("public.example");
      return [{ address: "93.184.216.34", family: 4 }];
    });
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("public.example", { all: false }, (error, address, family) => {
        if (error) reject(error);
        else if (family === undefined) reject(new Error("Expected a resolved address family"));
        else resolve({ address: address as string, family });
      });
    });
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects DNS answers containing any private address", async () => {
    const lookup = createCampaignPublicAddressLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      new Promise<void>((resolve, reject) => {
        lookup("public.example", { all: false }, (error) => (error ? reject(error) : resolve()));
      }),
    ).rejects.toThrow("address validation failed");
  });
});
