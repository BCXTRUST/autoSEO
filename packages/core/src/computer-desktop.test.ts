import { describe, expect, it } from "vitest";
import {
  browserWindowPresentCommand,
  COMPUTER_AUTONOMY_INSTRUCTION,
  exposeBrowserDesktopCommand,
  isFileManagerLabel,
  isHttpUrl,
  looksLikeCaptchaWall,
  looksLikeDesktopBrowserApp,
  openHttpUrlCommand,
  openPathDesktopCommand,
  parseVisibleWindows,
  refuseBrowserHuntShell,
} from "./computer-desktop.js";

describe("computer desktop window helpers", () => {
  it("treats http(s) targets as URLs and local paths as files", () => {
    expect(isHttpUrl("https://example.test/forum")).toBe(true);
    expect(isHttpUrl("HTTP://example.test")).toBe(true);
    expect(isHttpUrl("notes/forums.csv")).toBe(false);
    expect(looksLikeDesktopBrowserApp("google-chrome")).toBe(true);
    expect(looksLikeDesktopBrowserApp("nautilus")).toBe(false);
  });

  it("opens URLs through a browser binary and then closes Files", () => {
    const command = openPathDesktopCommand(":0", "https://example.test/join");
    expect(command).toContain("google-chrome");
    expect(command).toContain("https://example.test/join");
    expect(command).toContain("opened=0");
    expect(command).toContain("windowquit");
    expect(command).toContain("windowactivate");
    expect(command).toContain("ctrl+l");
    expect(command.indexOf("google-chrome")).toBeLessThan(command.indexOf("windowquit"));
  });

  it("keeps xdg-open for workspace files so folders can still open", () => {
    const command = openPathDesktopCommand(":0", "/home/user/rakazo-home/notes");
    expect(command).toContain("xdg-open");
    expect(command).not.toContain("windowquit");
  });

  it("looks only for a Chromium window", () => {
    const command = browserWindowPresentCommand(":0");
    expect(command).toContain("chromium Chromium");
    expect(command).not.toMatch(/firefox/i);
  });

  it("quotes URLs so query strings stay one argv", () => {
    expect(openHttpUrlCommand(":2", "https://example.test/a?q=hello world")).toContain(
      "'https://example.test/a?q=hello world'",
    );
    expect(exposeBrowserDesktopCommand(":2")).toContain("DISPLAY=:2");
  });

  it("detects file-manager labels and parses the visible window list", () => {
    expect(isFileManagerLabel("Nautilus\nFiles")).toBe(true);
    expect(isFileManagerLabel("Google-chrome\nChronic pain forum")).toBe(false);
    expect(
      parseVisibleWindows("42\t1\tFiles\n7\t0\tLiving with chronic pain - Chromium\n"),
    ).toEqual([
      { id: "42", title: "Files", focused: true },
      { id: "7", title: "Living with chronic pain - Chromium" },
    ]);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/Never interview the user/);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/request_takeover/);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/open_path/);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/Never open Google Search/);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/Ordinary wording/);
    expect(COMPUTER_AUTONOMY_INSTRUCTION).toMatch(/html\.duckduckgo\.com/);
    expect(looksLikeCaptchaWall("https://www.google.com/sorry/index?q=top+news")).toBe(true);
    expect(looksLikeCaptchaWall("I'm not a robot")).toBe(true);
    expect(looksLikeCaptchaWall("Example Domain")).toBe(false);
  });

  it("stops shell from hunting for browsers instead of using the screen", () => {
    expect(
      refuseBrowserHuntShell(
        "which firefox chromium google-chrome google-chrome-stable brave-browser 2>/dev/null; ls /usr",
      ),
    ).toMatch(/already has a browser/i);
    expect(refuseBrowserHuntShell("command -v google-chrome")).toMatch(/already has a browser/i);
    expect(refuseBrowserHuntShell("ls notes")).toBeUndefined();
  });
});
