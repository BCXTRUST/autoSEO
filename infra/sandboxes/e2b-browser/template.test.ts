import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "e2b";
import { describe, expect, it } from "vitest";
import { autoseoBrowserTemplate } from "./template.js";

const directory = dirname(fileURLToPath(import.meta.url));

describe("autoseo browser template", () => {
  it("lists the desktop, locale, node, playwright, and start steps", async () => {
    const serialized = await Template.toJSON(autoseoBrowserTemplate());
    expect(serialized).toContain("desktop");
    expect(serialized).toContain("locales");
    expect(serialized).toContain("fonts-dejavu");
    expect(serialized).toContain("fonts-liberation");
    expect(serialized).toContain("x11-xserver-utils");
    expect(serialized).toContain("netcat-openbsd");
    expect(serialized).toContain("de_DE.UTF-8");
    expect(serialized).toContain("setup_22.x");
    expect(serialized).toContain(
      "mkdir -p /home/user/.autoseo && cd /home/user/.autoseo && npm install --no-save --no-package-lock playwright@1.62.1 && chown -R user:user /home/user/.autoseo",
    );
    expect(serialized).toContain(
      "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright /home/user/.autoseo/node_modules/.bin/playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
    );
    expect(serialized).not.toContain("npmInstall");
    expect(serialized).toContain("/opt/autoseo/start.sh");
    expect(serialized).toContain("/tmp/autoseo-display-ready");
  });

  it("start.sh is valid POSIX sh", () => {
    execFileSync("sh", ["-n", join(directory, "start.sh")], { stdio: "pipe" });
  });

  it("start.sh does not start a desktop environment", () => {
    const script = readFileSync(join(directory, "start.sh"), "utf8");
    expect(script).not.toMatch(/startxfce4|xfwm4|xfdesktop/);
  });
});
