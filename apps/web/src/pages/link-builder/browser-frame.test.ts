import { describe, expect, it } from "vitest";
import {
  browserCrop,
  browserOnlyCss,
  canvasCropCss,
  connectionStatusText,
  LIVE_PANE_BG,
  livePaneStatus,
  livePaneView,
} from "./browser-frame.js";

function paint(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = fill(x, y);
      const index = (y * width + x) * 4;
      pixels[index] = red;
      pixels[index + 1] = green;
      pixels[index + 2] = blue;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

const checker = (x: number, y: number): [number, number, number] =>
  (x + y) % 2 === 0 ? [250, 250, 250] : [20, 20, 20];

describe("live pane status", () => {
  it("turns the dead sandbox sentence into a short status", () => {
    expect(livePaneStatus("Sandbox is probably not running anymore")).toBe("Computer is off");
    expect(connectionStatusText("", "Sandbox is probably not running anymore")).toContain(
      "not running",
    );
  });

  it("treats reconnecting as a short status and leaves a connected browser alone", () => {
    expect(livePaneStatus("Reconnecting…")).toBe("Reconnecting");
    expect(livePaneStatus("Connecting...")).toBe("Reconnecting");
    expect(livePaneStatus("Failed to connect to server")).toBe("Reconnecting");
    expect(livePaneStatus("Connected")).toBeNull();
    expect(livePaneStatus("Connected (unencrypted)")).toBeNull();
  });

  it("covers a dead pane and shows a live browser, including a black frame", () => {
    expect(livePaneView("Computer is off", null)).toEqual({
      cover: true,
      showingBrowser: false,
      status: "Computer is off",
    });
    expect(
      livePaneView("Reconnecting", { kind: "browser", rect: { x: 0, y: 0, width: 8, height: 8 } }),
    ).toMatchObject({ cover: true, showingBrowser: false, status: "Reconnecting" });
    expect(livePaneView(null, { kind: "desktop" })).toEqual({
      cover: true,
      showingBrowser: false,
      status: null,
    });
    expect(livePaneView(null, { kind: "blank" })).toEqual({
      cover: true,
      showingBrowser: false,
      status: null,
    });
    expect(
      livePaneView(null, { kind: "browser", rect: { x: 0, y: 0, width: 80, height: 50 } }),
    ).toEqual({ cover: false, showingBrowser: true, status: null });
  });
});

describe("browserCrop", () => {
  it("shows a white kiosk page and treats a black frame as a stream, not the desktop", () => {
    const white = paint(80, 50, () => [250, 250, 250]);
    expect(browserCrop(white, 80, 50)).toEqual({
      kind: "browser",
      rect: { x: 0, y: 0, width: 80, height: 50 },
    });
    const black = paint(80, 50, () => [0, 0, 0]);
    expect(browserCrop(black, 80, 50).kind).toBe("blank");
    const wallpaper = paint(80, 50, () => [30, 90, 160]);
    expect(browserCrop(wallpaper, 80, 50).kind).toBe("desktop");
  });

  it("crops a white page out from under a taskbar", () => {
    const page = paint(80, 50, (_x, y) => (y >= 46 ? [28, 28, 32] : [248, 248, 248]));
    const shown = browserCrop(page, 80, 50);
    expect(shown.kind).toBe("browser");
    if (shown.kind !== "browser") return;
    expect(shown.rect.y).toBe(0);
    expect(shown.rect.y + shown.rect.height).toBeLessThan(48);
  });

  it("shows a fullscreen browser and hides wallpaper, icons, and the taskbar", () => {
    const full = paint(80, 50, checker);
    const shown = browserCrop(full, 80, 50);
    expect(shown.kind).toBe("browser");
    if (shown.kind !== "browser") return;
    expect(shown.rect).toEqual({ x: 0, y: 0, width: 80, height: 50 });

    const desktop = paint(80, 50, (x, y) => {
      if (y >= 46) return [32, 32, 36];
      if (x < 8 && y > 2 && y < 14 && (x + y) % 2 === 0) return [240, 240, 240];
      if (x < 8 && y > 2 && y < 14) return [20, 20, 20];
      if (x >= 16 && x < 64 && y >= 8 && y < 40) return checker(x, y);
      return [30, 90, 160];
    });
    const cropped = browserCrop(desktop, 80, 50);
    expect(cropped.kind).toBe("browser");
    if (cropped.kind !== "browser") return;
    expect(cropped.rect.x).toBeGreaterThan(8);
    expect(cropped.rect.y).toBeGreaterThan(2);
    expect(cropped.rect.x + cropped.rect.width).toBeLessThan(76);
    expect(cropped.rect.y + cropped.rect.height).toBeLessThan(46);
  });

  it("shows a page of text when the desktop bar is gone", () => {
    const page = paint(80, 50, (x, y) => {
      if (y % 4 === 0 && x > 6 && x < 74) return checker(x, y);
      return [255, 255, 255];
    });
    expect(browserCrop(page, 80, 50).kind).toBe("browser");
  });

  it("hides a desktop that has a taskbar and only a small logo", () => {
    const frame = paint(80, 50, (x, y) => {
      if (y >= 46) return [28, 28, 32];
      if (x > 34 && x < 46 && y > 18 && y < 30) return checker(x, y);
      return [36, 88, 150];
    });
    expect(browserCrop(frame, 80, 50).kind).toBe("desktop");
  });
});

describe("browserOnlyCss", () => {
  it("crops the canvas and hides the viewer chrome on a dark background", () => {
    const css = browserOnlyCss({
      rect: { x: 10, y: 5, width: 40, height: 20 },
      frameWidth: 80,
      frameHeight: 50,
    });
    expect(css).toContain(LIVE_PANE_BG);
    expect(css).toContain("display: none");
    expect(css).toContain("#noVNC_control_bar");
    expect(css).toContain(".noVNC_logo");
    expect(canvasCropCss({ x: 10, y: 5, width: 40, height: 20 }, 80, 50)).toEqual({
      left: "-25.00%",
      top: "-25.00%",
      width: "200.00%",
      height: "250.00%",
    });
    expect(browserOnlyCss(null)).toContain("#noVNC_status");
    expect(browserOnlyCss(null)).not.toContain("canvas { visibility: hidden");
  });
});
