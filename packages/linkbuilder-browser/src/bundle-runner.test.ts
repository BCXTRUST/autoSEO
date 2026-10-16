import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
