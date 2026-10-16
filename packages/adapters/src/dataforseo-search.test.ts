import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { DataForSeoSearchProvider } from "./dataforseo-search.js";

const context: AdapterContext = {
  operationId: "search",
  traceId: "search",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("DataForSeoSearchProvider", () => {
  it("posts organic live advanced and never echoes the password", async () => {
    let authorization = "";
    let body = "";
    const provider = new DataForSeoSearchProvider({
      credentials: async () => ({ login: "dfs-user", password: "dfs-secret-value" }),
      fetch: async (url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        body = String(init?.body ?? "");
        expect(String(url)).toContain("/v3/serp/google/organic/live/advanced");
        return new Response(
          JSON.stringify({
            status_code: 20000,
            tasks: [
              {
                status_code: 20000,
                result: [
                  {
                    items: [
                      {
                        type: "organic",
                        url: "https://rueckenforum.example/viewtopic.php?t=1",
                        title: "Rücken",
                        description: "Forum",
                        domain: "rueckenforum.example",
                      },
                      { type: "paid", url: "https://ads.example/" },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    const rows = await provider.search(
      { query: "Rückenschmerzen", country: "DE", language: "de", depth: 10 },
      context,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.domain).toBe("rueckenforum.example");
    expect(authorization.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(authorization.slice(6), "base64").toString();
    expect(decoded).toBe("dfs-user:dfs-secret-value");
    expect(body).toContain('"location_code":2276');
    expect(body).toContain('"language_code":"de"');
    const failing = new DataForSeoSearchProvider({
      credentials: async () => ({ login: "dfs-user", password: "dfs-secret-value" }),
      fetch: async () => {
        throw new Error("network dfs-secret-value");
      },
    });
    await expect(
      failing.search({ query: "x", country: "DE", language: "de", depth: 1 }, context),
    ).rejects.toThrow(/redacted/);
    await expect(
      provider.search({ query: "x", country: "ZZ", language: "en", depth: 1 }, context),
    ).rejects.toMatchObject({ code: "unsupported_market" });
  });

  it("keeps organic rows when other items send null fields", async () => {
    const provider = new DataForSeoSearchProvider({
      credentials: async () => ({ login: "test-login", password: "test-pass" }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            status_code: 20000,
            status_message: "Ok.",
            tasks: [
              {
                status_code: 20000,
                status_message: "Ok.",
                result: [
                  {
                    items: [
                      {
                        type: "organic",
                        url: "https://rueckenforum.example/viewtopic.php?t=1",
                        title: "Rücken",
                        description: null,
                        domain: null,
                      },
                      { type: "people_also_ask", url: null, title: null, description: null },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
    });
    const rows = await provider.search(
      { query: "Rückenschmerzen", country: "DE", language: "de", depth: 10 },
      context,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.domain).toBe("rueckenforum.example");
    expect(rows[0]?.snippet).toBe("");
  });

  it("puts the provider status on an invalid task", async () => {
    const provider = new DataForSeoSearchProvider({
      credentials: async () => ({ login: "test-login", password: "test-pass" }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            status_code: 20000,
            status_message: "Ok.",
            tasks: [{ status_code: 40501, status_message: "Invalid Field" }],
          }),
        ),
    });
    await expect(
      provider.search({ query: "x", country: "DE", language: "de", depth: 1 }, context),
    ).rejects.toThrow("status 20000/40501 Invalid Field");
  });
});
