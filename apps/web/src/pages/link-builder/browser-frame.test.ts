import { describe, expect, it } from "vitest";
import {
  browserOnlyCss,
  canvasCropCss,
  connectionStatusText,
  LIVE_PANE_BG,
  livePaneStatus,
  livePaneView,
} from "./browser-frame.js";

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
