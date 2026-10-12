import { describe, expect, it } from "vitest";
import {
  COMPUTER_AUTONOMY_INSTRUCTION,
  detachedBrowserCommand,
  exposeBrowserDesktopCommand,
  isFileManagerLabel,
  isHttpUrl,
  looksLikeCaptchaWall,
  looksLikeDesktopBrowserApp,
  openHttpUrlCommand,
  openPathDesktopCommand,
  parseVisibleWindows,
  raiseBrowserWindowCommand,
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

  it("detaches Chrome so the sandbox command can return", () => {
    const command = detachedBrowserCommand(
      ":0",
      "https://www.google.de/search?q=Magnesium+Kr%C3%A4mpfe+Forum&hl=de&gl=de",
    );
    expect(command).toContain("RAKAZO_DETACH_BROWSER");
    expect(command).toContain("/usr/bin/google-chrome");
    expect(command).toContain("--no-sandbox");
    expect(command).toContain("--no-first-run");
    expect(command).toContain("--disable-fre");
    expect(command).toContain("OutdatedBuildDetector");
    expect(command).toContain("setsid -f");
    expect(command).toContain("pgrep -f '[r]akazo-desktop-watch'");
    expect(command).toContain("xfce4-panel");
    expect(command).toContain(
      "https://www.google.de/search?q=Magnesium+Kr%C3%A4mpfe+Forum&hl=de&gl=de",
    );
    expect(command).toContain("--kiosk");
    expect(command).toContain("exec /usr/bin/google-chrome");
    expect(command).not.toContain(">/tmp/rakazo-browser.log");
    expect(command.trimEnd().endsWith("&")).toBe(false);
  });

  it("replaces the shell with Chrome so the sandbox cannot reap it", () => {
    const command = detachedBrowserCommand(
      ":0",
      "https://www.google.de/search?q=Magnesium+Kr%C3%A4mpfe+Forum&hl=de&gl=de",
    );
    expect(command).toContain("RAKAZO_DETACH_BROWSER");
    expect(command).toContain("exec /usr/bin/google-chrome");
    expect(command).toContain("--kiosk");
    expect(command).toContain("--disable-fre");
    expect(command).toContain("--no-first-run");
    expect(command).toContain("--no-default-browser-check");
    expect(command).toContain("First Run");
    expect(command).toContain(
      "https://www.google.de/search?q=Magnesium+Kr%C3%A4mpfe+Forum&hl=de&gl=de",
    );
    const raised = raiseBrowserWindowCommand(":0");
    expect(raised).toContain("Can't update Chrome");
    expect(raised).toContain("Reinstall Chrome");
    expect(raised).toContain("Welcome to Google Chrome");
    expect(raised).toContain("windowclose");
    expect(raised).not.toContain("key Return");
    expect(raised).toContain("xfce4-panel");
    expect(raised).toContain("fluxbox");
    expect(raised).toContain("toolbar.visible: false");
    expect(raised).toContain("FULLSCREEN");
    expect(command).toContain("fluxbox");
    expect(command).toContain("--disable-component-update");
    expect(command).toContain("--disable-translate");
    expect(command).toContain("--lang=de");
    expect(command).toContain("LANG=de_DE.UTF-8");
    expect(command).toContain("TranslateEnabled");
    expect(command).toContain("translate_blocked_languages");
    expect(command).toContain("app_locale");
    expect(command).toContain("rakazo-chrome-kiosk-v3");
    expect(command).toContain("Translate this page");
    expect(command).toContain("Diese Seite übersetzen");
    expect(command).toContain("Toolbar");
    expect(command).not.toContain("rakazo-chrome-kiosk-v2");
    expect(command).toContain("TranslateUI");
    expect(raised).toContain("Google Translate");
    expect(raised).toContain("Translate this page");
    expect(raised).not.toContain("key --window");
    expect(raised).not.toContain("key Escape");
    expect(command).not.toContain("nohup");
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
