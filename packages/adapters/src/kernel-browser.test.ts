import type { AdapterContext, BrowserPersona } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { KernelBrowserSessionFactory } from "./kernel-browser.js";

const context: AdapterContext = {
  operationId: "kernel",
  traceId: "kernel",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const persona: BrowserPersona = {
  projectId: "project-1",
  profileKey: "project-1",
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
  proxy: {
    id: "lease-1",
    country: "DE",
    stickyKey: "persona:DE",
    server: "proxy.example:8080",
    username: { secretId: "user-secret" },
    password: { secretId: "pass-secret" },
    kind: "static_isp",
  },
};

/** Recorded Kernel JSON. Not from a live call. */
const RECORDED_PROXY = { id: "proxy_recorded", type: "custom", name: "lb-project-1" };
const RECORDED_BROWSER = {
  session_id: "sess_recorded",
  browser_live_view_url: "https://live.example/sess_recorded",
  cdp_ws_url: "wss://cdp.example/sess_recorded",
};
const RECORDED_TEXT = { success: true, result: { text: "hello" } };

const TOKEN = "kernel_test_token";
const PROXY_PASSWORD = "proxy-test-secret";

function recordedFetch(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    if (next.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, requests };
}

describe("Kernel browser", () => {
  it("requires https and is idle until open", () => {
    expect(
      () =>
        new KernelBrowserSessionFactory(
          { apiKey: { secretId: "kernel" }, baseUrl: "http://api.onkernel.com" },
          { loadSecret: async () => TOKEN, fetch: async () => new Response("no") },
        ),
    ).toThrow(/https/);
  });

  it("creates a profile over https with recorded fixtures and keeps secrets out of the script", async () => {
    const { fetchImpl, requests } = recordedFetch([
      { status: 201, body: RECORDED_PROXY },
      { status: 201, body: RECORDED_BROWSER },
      { body: RECORDED_TEXT },
      { status: 204, body: {} },
    ]);
    const seen: string[] = [];
    const factory = new KernelBrowserSessionFactory(
      {
        apiKey: { secretId: "kernel" },
        extensionNames: ["page-helper"],
      },
      {
        fetch: fetchImpl,
        onSecret: (secret) => seen.push(secret),
        loadSecret: async (ref) => {
          if (ref.secretId === "kernel") return TOKEN;
          if (ref.secretId === "user-secret") return "proxy-user";
          return PROXY_PASSWORD;
        },
      },
    );
    expect(factory.mode).toBe("kernel");
    expect(factory.describe().capabilities).toMatchObject({
      persistentProfile: true,
      extensions: true,
      liveScreen: false,
    });
    const session = await factory.open(persona, context);
    expect(session.id).toBe("sess_recorded");
    expect(await session.text("p")).toBe("hello");
    await session.close();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://api.onkernel.com/proxies",
      "POST https://api.onkernel.com/browsers",
      "POST https://api.onkernel.com/browsers/sess_recorded/playwright/execute",
      "DELETE https://api.onkernel.com/browsers/sess_recorded",
    ]);
    for (const request of requests) {
      expect(request.url.startsWith("https://")).toBe(true);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    const proxy = JSON.parse(requests[0]?.body ?? "{}") as {
      config: { host: string; password: string };
    };
    expect(proxy.config).toMatchObject({
      host: "proxy.example",
      port: 8080,
      password: PROXY_PASSWORD,
    });
    const browser = JSON.parse(requests[1]?.body ?? "{}") as {
      profile: { name: string };
      extensions: Array<{ name: string }>;
      proxy: { id: string };
    };
    expect(browser.profile.name).toBe("project-1");
    expect(browser.extensions).toEqual([{ name: "page-helper" }]);
    expect(browser.proxy.id).toBe("proxy_recorded");
    const code = JSON.parse(requests[2]?.body ?? "{}").code as string;
    expect(code).toContain("page.locator");
    expect(code).not.toContain(TOKEN);
    expect(code).not.toContain(PROXY_PASSWORD);
    expect(seen).toEqual([TOKEN, "proxy-user", PROXY_PASSWORD]);
  });

  it("refuses a redirect and does not follow it", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    };
    const factory = new KernelBrowserSessionFactory(
      { apiKey: { secretId: "kernel" } },
      { fetch: fetchImpl, loadSecret: async () => TOKEN },
    );
    await expect(factory.open({ ...persona, proxy: undefined }, context)).rejects.toThrow(
      /redirect refused/,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe("https://api.onkernel.com/browsers");
  });

  it("drops a failure body that echoes the token", async () => {
    const { fetchImpl } = recordedFetch([
      { status: 201, body: RECORDED_BROWSER },
      { status: 500, body: { error: `leaked ${TOKEN}` } },
    ]);
    const factory = new KernelBrowserSessionFactory(
      { apiKey: { secretId: "kernel" } },
      { fetch: fetchImpl, loadSecret: async () => TOKEN },
    );
    const session = await factory.open({ ...persona, proxy: undefined }, context);
    let message = "";
    try {
      await session.text("p");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Kernel request failed \(500\)/);
    expect(message).not.toContain(TOKEN);
  });
});
