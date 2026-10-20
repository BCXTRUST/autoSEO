import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { encodeEnvJson, REQUEST_ENV } from "./runner-cli.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("runner bundle", () => {
  it("builds and prints usage when started with no args", () => {
    execFileSync("node", ["scripts/bundle-runner.mjs"], { cwd: packageRoot, stdio: "pipe" });
    let stderr = "";
    let code = 0;
    try {
      execFileSync("node", ["dist/rakazo-lb-browser.cjs"], {
        cwd: packageRoot,
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      code = failed.status ?? 0;
      stderr = failed.stderr ?? "";
    }
    expect(code).toBe(2);
    expect(stderr).toContain("usage: rakazo-lb-browser serve|call --state <file>");
  });

  it("returns a 300,000-character pageHtml intact", async () => {
    execFileSync("node", ["scripts/bundle-runner.mjs"], { cwd: packageRoot, stdio: "pipe" });
    const value = "p".repeat(300_000);
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/rpc") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, value }));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const dir = await mkdtemp(join(tmpdir(), "lb-runner-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        port,
        token: "t".repeat(32),
        pid: process.pid,
        sessionId: "session-1",
      }),
    );
    try {
      const { stdout } = await execFileAsync(
        "node",
        ["dist/rakazo-lb-browser.cjs", "call", "--state", statePath],
        {
          cwd: packageRoot,
          env: { ...process.env, [REQUEST_ENV]: encodeEnvJson({ method: "pageHtml" }) },
          maxBuffer: 2_000_000,
        },
      );
      const line = stdout.trim().split("\n").at(-1) ?? "";
      const parsed = JSON.parse(line) as { value?: string };
      expect(parsed.value?.length).toBe(300_000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
