import { describe, expect, it } from "vitest";
import { keywordFromUrl, suggestFromPublicPage, suggestPageCopy } from "./page-suggestion.js";

const html = `<!doctype html><html><head>
<title>Magnesium kaufen | Vitaminexpress</title>
<meta name="description" content="Magnesium hilft bei M&uuml;digkeit. Die Seite nennt die Formen.">
</head><body>
<h1>Magnesium kaufen</h1>
<p>Magnesium ist ein Mineralstoff, den viele Menschen zu wenig aufnehmen.</p>
</body></html>`;

describe("page suggestion", () => {
  it("reads a keyword and a short rule from the page", () => {
    expect(suggestPageCopy("https://www.vitaminexpress.org/de/magnesium-kaufen", html)).toEqual({
      keyword: "Magnesium kaufen",
      rule: "Magnesium hilft bei Müdigkeit. Die Seite nennt die Formen.",
    });
  });

  it("uses the last path word when the page has no title", () => {
    expect(keywordFromUrl("https://www.vitaminexpress.org/de/magnesium-kaufen")).toBe(
      "Magnesium kaufen",
    );
    expect(keywordFromUrl("https://www.vitaminexpress.org/de")).toBe("");
    expect(suggestPageCopy("https://www.vitaminexpress.org/de/magnesium-kaufen", "")).toEqual({
      keyword: "Magnesium kaufen",
      rule: "",
    });
  });

  it("follows a same-site redirect and refuses a private host", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/de")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.vitaminexpress.org/de/magnesium-kaufen" },
        });
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const resolve = async () => [{ address: "93.184.216.34" }];
    await expect(
      suggestFromPublicPage("https://www.vitaminexpress.org/de", { fetchImpl, resolve }),
    ).resolves.toMatchObject({ keyword: "Magnesium kaufen" });
    await expect(
      suggestFromPublicPage("http://127.0.0.1/secret", { fetchImpl, resolve }),
    ).resolves.toEqual({ keyword: "", rule: "" });
    await expect(
      suggestFromPublicPage("https://www.vitaminexpress.org/de", {
        fetchImpl,
        resolve: async () => [{ address: "10.0.0.8" }],
      }),
    ).resolves.toEqual({ keyword: "", rule: "" });
  });
});
