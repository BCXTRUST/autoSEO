import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  BrowserPersona,
  BrowserSession,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { HELPER_LABELS, TEST_PACING } from "@rakazo/linkbuilder-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertLocalBrowserAllowed,
  LocalBrowserRefused,
  LocalBrowserSessionFactory,
  SandboxBrowserSessionFactory,
} from "./factory.js";
import { BrowserRpcServer, RpcBrowserSession } from "./rpc.js";
import { describeCall, LAUNCH_ENV, REQUEST_ENV } from "./runner-cli.js";
import { browserTestGate, FIXTURE_PAGE_HELPER_DIR } from "./testing.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

const persona = (profileKey: string): BrowserPersona => ({
  projectId: "project-1",
  profileKey,
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
});

class StubSession implements BrowserSession {
  readonly id = "stub";
  filled: string[] = [];
  async goto() {}
  async url() {
    return "http://board.example.test/";
  }
  async fill(_selector: string, text: string) {
    this.filled.push(text);
    throw new Error(`could not type ${text} into field`);
  }
  async click() {}
  async text() {
    return "hello";
  }
  async exists() {
    return true;
  }
  async attribute() {
    return null;
  }
  async elementScreenshotPng() {
    return new Uint8Array([1, 2, 3]);
  }
  async pageText() {
    return "page";
  }
  async waitFor() {
    return true;
  }
  async screenshotPng() {
    return new Uint8Array([9, 8, 7]);
  }
  async close() {}
}

describe("browser RPC", () => {
  it("round-trips calls and binary results", async () => {
    const server = new BrowserRpcServer(new StubSession());
    const session = new RpcBrowserSession("stub", (request) => server.handle(request));
    expect(await session.text("p")).toBe("hello");
    expect(await session.url()).toBe("http://board.example.test/");
    expect([...(await session.screenshotPng())]).toEqual([9, 8, 7]);
    expect([...(await session.elementScreenshotPng("img"))]).toEqual([1, 2, 3]);
    expect(await session.loadedExtensions()).toEqual([]);
  });

  it("rejects malformed requests and never echoes secret fills", async () => {
    const server = new BrowserRpcServer(new StubSession());
    expect(await server.handle({ method: "eval", script: "1" })).toEqual({
      ok: false,
      error: "invalid request",
    });
    expect(await server.handle({ method: "goto", url: "file:///etc/passwd" })).toMatchObject({
      ok: false,
    });
    const response = await server.handle({
      method: "fill",
      selector: "#password",
      text: "Sup3r-Secret!pw",
      secret: true,
    });
    expect(response).toEqual({ ok: false, error: "could not type [redacted] into field" });
  });

  it("logs each runner call with method, target and timing but never the text", () => {
    const line = describeCall(
      { method: "fill", selector: "#password", text: "Sup3r-Secret!pw", secret: true },
      { ok: false, error: "could not type [redacted] into field" },
      42,
    );
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T.* fill #password 42ms error could not type \[redacted\] into field$/,
    );
    expect(line).not.toContain("Sup3r");
    expect(
      describeCall({ method: "goto", url: "https://board.example/" }, { ok: true }, 7),
    ).toContain("goto https://board.example/ 7ms ok");
  });
});

describe("local browser opt-in", () => {
  it("requires an explicit opt-in and refuses production", () => {
    expect(() => assertLocalBrowserAllowed({})).toThrow(LocalBrowserRefused);
    expect(() => assertLocalBrowserAllowed({ LINK_BUILDER_BROWSER: "local" })).not.toThrow();
    expect(() =>
      assertLocalBrowserAllowed({ LINK_BUILDER_BROWSER: "local", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);
    expect(() =>
      assertLocalBrowserAllowed({
        LINK_BUILDER_BROWSER: "local",
        NODE_ENV: "production",
        LINK_BUILDER_ALLOW_LOCAL_BROWSER: "true",
      }),
    ).not.toThrow();
    expect(() => new LocalBrowserSessionFactory({ profileRoot: "/tmp/x", env: {} })).toThrow(
      LocalBrowserRefused,
    );
  });
});

describe("sandbox browser protocol", () => {
  class RoutingSandbox extends FakeSandboxProvider {
    readonly requests: CommandRequest[] = [];
    private rpc: BrowserRpcServer | null = null;

    override async *execute(
      _computer: ComputerRef,
      request: CommandRequest,
      _context: AdapterContext,
    ): AsyncIterable<ProcessEvent> {
      this.requests.push(request);
      if (request.argv[0] === "sh") {
        this.rpc = new BrowserRpcServer(new StubSession());
        yield { type: "exit", code: 0 };
        return;
      }
      const raw = Buffer.from(request.env?.[REQUEST_ENV] ?? "", "base64").toString("utf8");
      const response = this.rpc
        ? await this.rpc.handle(JSON.parse(raw))
        : { ok: false, error: "runner not running" };
      yield { type: "stdout", data: `${JSON.stringify(response)}\n` };
      yield { type: "exit", code: 0 };
    }
  }

  it("starts one runner per profile and keeps secrets out of argv", async () => {
    const sandbox = new RoutingSandbox();
    const factory = new SandboxBrowserSessionFactory({
      sandbox,
      resolveComputer: async () => ({ id: "c1", botId: "b1", kind: "docker", providerRef: "x" }),
      proxyResolver: async () => ({
        server: "proxy.example.test:8000",
        username: "user-de",
        password: "proxy-Secret-123",
      }),
      sleep: async () => undefined,
    });
    expect(factory.mode).toBe("sandbox");
    const session = await factory.open(
      {
        ...persona("project-1"),
        proxy: {
          id: "lease-1",
          country: "DE",
          stickyKey: "persona:DE",
          server: "proxy.example.test:8000",
          password: { secretId: "secret-1" },
          kind: "static_isp",
        },
      },
      context,
    );
    expect(await session.text("p")).toBe("hello");

    const start = sandbox.requests.find((request) => request.argv[0] === "sh")!;
    expect(start.argv).toEqual(
      expect.arrayContaining(["rakazo-lb-browser", "/tmp/rakazo-lb/project-1.json"]),
    );
    const launch = JSON.parse(Buffer.from(start.env![LAUNCH_ENV]!, "base64").toString("utf8"));
    expect(launch).toMatchObject({
      profileDir: "/home/rakazo/.browser-profiles/project-1",
      executablePath: "/usr/bin/chromium",
      proxy: { password: "proxy-Secret-123" },
    });
    for (const request of sandbox.requests) {
      expect(request.argv.join(" ")).not.toContain("proxy-Secret-123");
    }
    await expect(session.fill("#pw", "Forum-Pass-987", { secret: true })).rejects.toThrow(
      "could not type [redacted] into field",
    );
  });
});

const gate = browserTestGate();

describe("Chromium sessions", () => {
  it.skipIf(gate.available || !gate.required)("has Chromium installed in CI", () => {
    throw new Error(gate.reason);
  });
});

describe.skipIf(!gate.available)(
  `Chromium sessions${gate.reason ? ` (${gate.reason})` : ""}`,
  () => {
    let server: Server;
    let origin = "";
    let root = "";

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "rakazo-lb-browser-"));
      server = createServer((request, response) => {
        if (request.url?.startsWith("/slow-submit")) {
          // A board that sends its activation mail before answering the registration POST.
          setTimeout(() => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(`<!doctype html><div id="message">Konto angelegt</div>`);
          }, 3_000);
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (request.url?.startsWith("/register")) {
          response.end(
            `<!doctype html><form id="register" method="post" action="/slow-submit"><input id="name" name="name"><input type="submit" name="submit" value="Absenden"></form>`,
          );
          return;
        }
        if (request.url?.startsWith("/covered")) {
          response.end(
            `<!doctype html><form><div style="position:fixed;inset:0;z-index:5"></div><input id="name" name="name" oninput="document.getElementById('out').textContent=this.value"><p id="out"></p></form>`,
          );
          return;
        }
        if (request.url?.startsWith("/widget")) {
          response.end(
            `<!doctype html><form><div class="g-recaptcha" data-sitekey="fixture-key"><textarea name="g-recaptcha-response"></textarea></div><input id="name"></form>`,
          );
          return;
        }
        response.end(
          `<!doctype html><title>Board</title><p id="hello">Hallo</p><p id="visits"></p><span id="hidden-count" style="display:none">12</span><script>localStorage.visits = String(Number(localStorage.visits || 0) + 1); document.getElementById("visits").textContent = localStorage.visits;</script>`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    it("loads the helper extension, types with pacing and keeps the profile", async () => {
      const factory = new LocalBrowserSessionFactory({
        profileRoot: root,
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        headless: true,
        pacing: TEST_PACING,
        env: { LINK_BUILDER_BROWSER: "local" },
      });
      const session = await factory.open(persona("profile-a"), context);
      try {
        const extensions = await session.loadedExtensions!();
        expect(extensions).toHaveLength(1);
        expect(extensions[0]).toMatch(/^[a-p]{32}$/);

        await session.goto(`${origin}/widget`);
        expect(await session.waitFor("[data-page-helper]", { timeoutMs: 10_000 })).toBe(true);
        expect(await session.text("[data-page-helper]")).toBe(HELPER_LABELS.place);
        await session.click("[data-page-helper]");
        await expect
          .poll(() => session.text("[data-page-helper]"), { timeout: 5_000 })
          .toBe(HELPER_LABELS.placed);

        await session.fill("#name", "mira_sol42");
        expect(await session.attribute("#name", "id")).toBe("name");
        const png = await session.screenshotPng();
        expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(await session.waitFor("#missing", { timeoutMs: 50 })).toBe(false);

        await session.goto(origin);
        expect(await session.text("#hello")).toBe("Hallo");
        expect(await session.text("#visits")).toBe("1");
        const started = Date.now();
        expect(await session.text("#hidden-count")).toBe("12");
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await session.close();
      }
      expect(existsSync(join(root, "profile-a"))).toBe(true);
      const again = await factory.open(persona("profile-a"), context);
      try {
        await again.goto(origin);
        expect(await again.pageText()).toContain("Hallo");
        expect(await again.text("#visits")).toBe("2");
      } finally {
        await again.close();
      }
    });

    it("fills a field that a banner covers", async () => {
      const factory = new LocalBrowserSessionFactory({
        profileRoot: root,
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        headless: true,
        pacing: TEST_PACING,
        env: { LINK_BUILDER_BROWSER: "local" },
      });
      const session = await factory.open(persona("profile-covered"), context);
      try {
        await session.goto(`${origin}/covered`);
        await session.fill("#name", "sophie_braun68");
        expect(await session.text("#out")).toBe("sophie_braun68");
      } finally {
        await session.close();
      }
    });

    it("waits for a slow board to answer a submit before the next read", async () => {
      const factory = new LocalBrowserSessionFactory({
        profileRoot: root,
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        headless: true,
        pacing: TEST_PACING,
        env: { LINK_BUILDER_BROWSER: "local" },
      });
      const session = await factory.open(persona("profile-slow"), context);
      try {
        await session.goto(`${origin}/register`);
        await session.fill("#name", "mira_sol42");
        const started = Date.now();
        await session.click("form#register input[name='submit']");
        expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
        expect(await session.text("#message")).toBe("Konto angelegt");
        expect(await session.exists("form#register")).toBe(false);
      } finally {
        await session.close();
      }
    });

    it("loads the helper with the plain Playwright engine too", async () => {
      const factory = new LocalBrowserSessionFactory({
        profileRoot: root,
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        headless: true,
        pacing: TEST_PACING,
        engine: "playwright",
        env: { LINK_BUILDER_BROWSER: "local" },
      });
      const session = await factory.open(persona("profile-playwright"), context);
      try {
        expect(await session.loadedExtensions!()).toHaveLength(1);
        await session.goto(`${origin}/widget`);
        expect(await session.waitFor("[data-page-helper]", { timeoutMs: 10_000 })).toBe(true);
      } finally {
        await session.close();
      }
    });

    it("drives a real runner process through the sandbox exec API", async () => {
      const runnerPath = fileURLToPath(new URL("./runner-cli.ts", import.meta.url));
      const sandbox = new (class extends FakeSandboxProvider {
        override async *execute(
          _computer: ComputerRef,
          request: CommandRequest,
        ): AsyncIterable<ProcessEvent> {
          const [command, ...args] = request.argv;
          const child = spawn(command!, args, {
            env: { ...process.env, ...request.env },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          const code = await new Promise<number>((resolve) =>
            child.on("close", (c) => resolve(c ?? 1)),
          );
          yield { type: "stdout", data: stdout };
          yield { type: "exit", code };
        }
      })();
      const factory = new SandboxBrowserSessionFactory({
        sandbox,
        resolveComputer: async () => ({ id: "c1", botId: "b1", kind: "docker", providerRef: "x" }),
        runnerArgv: [process.execPath, "--import", "tsx", runnerPath],
        profileRoot: join(root, "sandbox-profiles"),
        stateRoot: join(root, "state"),
        helperDirs: [FIXTURE_PAGE_HELPER_DIR],
        executablePath: (await import("playwright")).chromium.executablePath(),
        headless: true,
        pacing: TEST_PACING,
        pollIntervalMs: 200,
      });
      const session = await factory.open(persona("profile-sandbox"), context);
      const reopened = await factory.open(persona("profile-sandbox"), context);
      expect(reopened.id).toBe(session.id);
      try {
        expect(await session.loadedExtensions!()).toHaveLength(1);
        await session.goto(origin);
        expect(await session.text("#hello")).toBe("Hallo");
        const png = await session.screenshotPng();
        expect(png.byteLength).toBeGreaterThan(100);
      } finally {
        await session.close();
      }
      await expect.poll(() => existsSync(join(root, "state", "profile-sandbox.json"))).toBe(false);
    }, 90_000);
  },
);

describe("form field rpc", () => {
  it("round-trips labelled controls without a screenshot", async () => {
    const field = {
      selector: "#handle",
      tag: "input",
      type: "text",
      name: "handle",
      id: "handle",
      autocomplete: "username",
      label: "Username",
      role: null,
      required: true,
    };
    const session = {
      id: "fields",
      formFields: async () => [field],
    } as unknown as BrowserSession;
    const rpc = new BrowserRpcServer(session);
    const client = new RpcBrowserSession("fields", (request) => rpc.handle(request));
    expect(await client.formFields("form")).toEqual([field]);
  });
});
