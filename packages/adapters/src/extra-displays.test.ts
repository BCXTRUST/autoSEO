import { describe, expect, it } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import {
  allocateExtraDisplayCommand,
  ensurePrimaryViewCommand,
  extraDisplayActionCommand,
  extraDisplayLayout,
  parseAllocatedExtraDisplay,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
} from "./extra-displays.js";

describe("extra display ports", () => {
  it("keeps the vendor primary on index 0 and shifts extra screens by two", () => {
    expect(extraDisplayLayout(0, ":0")).toMatchObject({
      display: ":0",
      viewPort: 6080,
      controlPort: 6081,
      isPrimary: true,
    });
    expect(extraDisplayLayout(1, ":0")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
      isPrimary: false,
    });
    expect(extraDisplayLayout(1, ":99")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
    });
  });

  it("uses a locked sandbox registry for cross-process screen assignment", () => {
    const allocate = allocateExtraDisplayCommand("writer", "run-2:2");
    const release = releaseExtraDisplayCommand("writer", "run-2:2");
    expect(allocate).toContain("flock -w 5 9");
    expect(allocate).not.toContain("writer");
    expect(release).toContain("RAKAZO_SCREEN_RELEASE=stale");
    expect(release.indexOf("pkill -f")).toBeLessThan(release.indexOf('rm -f "$slot"'));
    expect(parseAllocatedExtraDisplay("RAKAZO_SCREEN_INDEX=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=stale\n")).toBeUndefined();
  });

  it("requires an authenticated password for view-only VNC", () => {
    expect(parseExtraDisplayViewPassword("RAKAZO_SCREEN_PASSWORD=sandbox_secret-1\n")).toBe(
      "sandbox_secret-1",
    );
    expect(() => parseExtraDisplayViewPassword("no password\n")).toThrow(
      ComputerScreenUnavailableError,
    );
  });

  it("opens extra-display URLs in a browser and raises it over Files", () => {
    const layout = extraDisplayLayout(1, ":0");
    const openUrl = extraDisplayActionCommand(layout, {
      kind: "open",
      path: "https://example.test/register",
    });
    expect(openUrl).toContain("google-chrome");
    expect(openUrl).toContain("windowquit");
    expect(openUrl).toContain("ctrl+l");
    expect(openUrl).not.toMatch(/^DISPLAY=:2 xdg-open /);
    const openFile = extraDisplayActionCommand(layout, { kind: "open", path: "notes/forums.csv" });
    expect(openFile).toContain("xdg-open");
    expect(openFile).not.toContain("windowquit");
  });

  it("starts view-only noVNC on the primary display ports", () => {
    const command = ensurePrimaryViewCommand(extraDisplayLayout(0, ":0"), "secret");
    expect(command).toContain("s.settimeout(0.2)");
    expect(command).toContain("flock -w 20 8");
    expect(command).toContain("rfbport 5910");
    expect(command).toContain("--listen 6090");
    expect(command).toContain("fuser -k 6090/tcp");
    expect(command).toContain(
      "( cd /opt/noVNC/utils && exec ./novnc_proxy --vnc localhost:5910 --listen 6090 --web /opt/noVNC ) </dev/null >/tmp/rakazo/screen-primary-novnc.log 2>&1 &",
    );
    expect(command).not.toContain("rfbport 5900");
    expect(command).not.toContain("pkill -f 'novnc_proxy");
    expect(() => ensurePrimaryViewCommand(extraDisplayLayout(1, ":0"), "secret")).toThrow(
      /primary display/,
    );
  });
});
