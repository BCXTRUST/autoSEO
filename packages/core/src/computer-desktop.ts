/** Default graphical browsers to try before falling back to xdg-open. */
export const DESKTOP_BROWSER_APPS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "firefox",
] as const;

const FILE_MANAGER_CLASSES = [
  "Nautilus",
  "org.gnome.Nautilus",
  "Thunar",
  "Pcmanfm",
  "pcmanfm",
  "Caja",
  "Nemo",
  "dolphin",
  "Dolphin",
] as const;

const BROWSER_WINDOW_CLASSES = [
  "google-chrome",
  "Google-chrome",
  "Chromium",
  "chromium",
  "firefox",
  "Firefox",
  "Navigator",
] as const;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function looksLikeDesktopBrowserApp(application: string): boolean {
  return /chrome|chromium|firefox|browser/i.test(application);
}

const BROWSER_HUNT_SHELL =
  /\b(?:which|whereis|type\s+-a|command\s+-v)\b[\s\S]{0,400}\b(?:firefox|chromium|google-chrome|chrome|brave-browser|msedge)\b/i;
const BROWSER_LS_SHELL = /\bls\b[\s\S]{0,200}(?:\/usr(?:\/(?:local\/)?bin)?|\/opt|\/snap)\b/i;

export const BROWSER_HUNT_SHELL_ERROR =
  "The desktop already has a browser. Use computer_observe, then computer_act or open_path on the page you see. Do not search for browsers with shell.";

export function refuseBrowserHuntShell(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (BROWSER_HUNT_SHELL.test(trimmed)) return BROWSER_HUNT_SHELL_ERROR;
  if (BROWSER_LS_SHELL.test(trimmed) && /chrome|chromium|firefox|brave|browser/i.test(trimmed)) {
    return BROWSER_HUNT_SHELL_ERROR;
  }
  return undefined;
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Marker for a browser process that must outlive the command that started it. */
export const DETACHED_BROWSER_MARKER = "RAKAZO_DETACH_BROWSER";

/** True when a browser window class is mapped. Desktop icons do not count. */
export function browserWindowPresentCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "for class in chromium Chromium; do",
    "  id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    "  if [ -n \"$id\" ]; then printf '%s\\n' browser; exit 0; fi",
    "done",
    "printf '%s\\n' none",
  ].join("\n");
}

export function openHttpUrlCommand(display: string, url: string): string {
  const quotedUrl = posixShellQuote(url.trim());
  const apps = DESKTOP_BROWSER_APPS.map(posixShellQuote).join(" ");
  return [
    "opened=0",
    `for app in ${apps}; do`,
    '  if command -v "$app" >/dev/null 2>&1; then',
    `    nohup env DISPLAY=${display} "$app" ${quotedUrl} >/tmp/rakazo-browser.log 2>&1 &`,
    "    opened=1",
    "    break",
    "  fi",
    "done",
    `if [ "$opened" = 0 ]; then env DISPLAY=${display} xdg-open ${quotedUrl}; fi`,
  ].join("\n");
}

/** Close overlapping file-manager windows and raise a visible browser. */
export function exposeBrowserDesktopCommand(display: string): string {
  const fileManagers = FILE_MANAGER_CLASSES.map(posixShellQuote).join(" ");
  const browsers = BROWSER_WINDOW_CLASSES.map(posixShellQuote).join(" ");
  return [
    `for class in ${fileManagers}; do`,
    `  DISPLAY=${display} xdotool search --onlyvisible --class "$class" windowquit 2>/dev/null || true`,
    "done",
    `for class in ${browsers}; do`,
    `  id=$(DISPLAY=${display} xdotool search --onlyvisible --class "$class" 2>/dev/null | awk 'NR==1{print; exit}')`,
    `  if [ -n "$id" ]; then`,
    `    DISPLAY=${display} xdotool windowactivate --sync "$id" windowraise "$id" 2>/dev/null || true`,
    "    break",
    "  fi",
    "done",
  ].join("\n");
}

/** Put the URL in the visible browser, even if Chrome is already on another page. */
export function focusBrowserAndOpenUrlCommand(display: string, url: string): string {
  const quotedUrl = posixShellQuote(url.trim());
  const browsers = BROWSER_WINDOW_CLASSES.map(posixShellQuote).join(" ");
  return [
    openHttpUrlCommand(display, url),
    "sleep 0.5",
    exposeBrowserDesktopCommand(display),
    "id=",
    `for class in ${browsers}; do`,
    `  id=$(DISPLAY=${display} xdotool search --onlyvisible --class "$class" 2>/dev/null | awk 'NR==1{print; exit}')`,
    '  if [ -n "$id" ]; then break; fi',
    "done",
    'if [ -n "$id" ]; then',
    `  DISPLAY=${display} xdotool windowactivate --sync "$id"`,
    "  sleep 0.2",
    `  DISPLAY=${display} xdotool key ctrl+l`,
    "  sleep 0.15",
    `  DISPLAY=${display} xdotool type --delay 1 -- ${quotedUrl}`,
    `  DISPLAY=${display} xdotool key Return`,
    "fi",
  ].join("\n");
}

export function openPathDesktopCommand(display: string, pathOrUrl: string): string {
  if (isHttpUrl(pathOrUrl)) {
    return focusBrowserAndOpenUrlCommand(display, pathOrUrl);
  }
  return `DISPLAY=${display} xdg-open ${posixShellQuote(pathOrUrl)}`;
}

export function focusedWindowLabelCommand(display: string): string {
  return [
    `DISPLAY=${display} xdotool getactivewindow getwindowclassname 2>/dev/null || true`,
    `DISPLAY=${display} xdotool getactivewindow getwindowname 2>/dev/null || true`,
  ].join("; ");
}

export function isFileManagerLabel(label: string): boolean {
  return /nautilus|thunar|pcmanfm|nemo|caja|dolphin|\bfiles\b|file manager/i.test(label);
}

export function looksLikeCaptchaWall(text: string): boolean {
  return /i['’]?m not a robot|recaptcha|hcaptcha|unusual traffic|google\.com\/sorry|checking your browser/i.test(
    text,
  );
}

export function listVisibleWindowsCommand(display: string): string {
  return [
    `focus=$(DISPLAY=${display} xdotool getwindowfocus 2>/dev/null || true)`,
    `DISPLAY=${display} xdotool search --onlyvisible --name . 2>/dev/null | while read -r id; do`,
    `  name=$(DISPLAY=${display} xdotool getwindowname "$id" 2>/dev/null | tr '\\n' ' ')`,
    `  focused=0`,
    `  [ "$id" = "$focus" ] && focused=1`,
    `  printf '%s\\t%s\\t%s\\n' "$id" "$focused" "$name"`,
    "done",
  ].join("\n");
}

export function parseVisibleWindows(
  stdout: string,
): Array<{ id: string; title?: string; focused?: boolean }> {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const [id, focused, ...titleParts] = line.split("\t");
      if (!id) return [];
      const title = titleParts.join("\t").trim();
      return [
        {
          id,
          ...(title ? { title } : {}),
          ...(focused === "1" ? { focused: true } : {}),
        },
      ];
    })
    .slice(0, 16);
}

export const COMPUTER_AUTONOMY_INSTRUCTION =
  "Never interview the user. Do not ask for forum names, URLs, emails, usernames, or passwords. Invent throwaway credentials and pick public sites yourself. Never ask them to close windows, click the desktop, or tell you how to proceed. Close overlapping file-manager windows yourself. Ordinary wording is the whole task (for example: register for 5 new forums please; comment on all forums you registered yesterday) — start computer_observe and open_path immediately. After one observe, act or open_path; do not observe again until the screen should have changed. If a forum or page is already on screen, computer_act there — do not use shell to find firefox, chromium, or chrome, and do not ls /usr. Never open Google Search, google.com, google.com/sorry, or a news query; this computer hits Google CAPTCHA. If they named a site or pasted a URL, open_path that exact http(s) URL. If they did not, open_path concrete forum homepages or DuckDuckGo html search (html.duckduckgo.com), never google.com/search. For yesterday or prior work, read your files and memory first. After you register or comment, write the site URL and outcome to a notes file. If Google shows a CAPTCHA, do not wait: request_takeover is optional, then immediately open_path a non-Google URL and keep going. Only wait on request_takeover when the destination site itself needs the user's real password, payment, or a CAPTCHA you cannot leave. For a saved login, click the password field then vault_fill — never print or ask for that password. Raise the browser, type into the address bar, and keep working until the task is done.";
