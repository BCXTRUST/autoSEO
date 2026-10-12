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

/**
 * Written only by a launch that disables translate and uses a German UI.
 * A desktop that is already on the problem query but missing this file is an
 * older Chrome, and its translate bubble stays until that process is replaced.
 */
export const CHROME_KIOSK_STAMP = "/tmp/rakazo-chrome-kiosk-v3";

export function chromeKioskStampCommand(): string {
  return `test -f ${posixShellQuote(CHROME_KIOSK_STAMP)} && printf '%s\\n' ok || true`;
}

/**
 * Drop the desktop shell and any Chrome that was started without kiosk flags.
 * An already-running Chrome ignores `--kiosk` and `--no-first-run` on a second launch.
 * `exec` inside the detached command replaces the shell so E2B can disconnect
 * without reaping the browser.
 */
const DESKTOP_PANEL_PROCESSES =
  "xfce4-panel xfdesktop pcmanfm lxpanel tint2 plank gnome-panel plasmashell xfce4-notifyd fbpanel lxqt-panel mate-panel";

/** Hide the window-manager bar (Applications, clock) so noVNC is only the browser. */
function hideDesktopChromeShell(): string {
  return [
    `killall -q ${DESKTOP_PANEL_PROCESSES} >/dev/null 2>&1 || true`,
    'for home in "$HOME" /root /tmp/fluxbox-home /tmp/fluxbox-home-0 /home/user /home/ubuntu /home/rakazo; do',
    '  [ -d "$home/.fluxbox" ] || continue',
    '  init="$home/.fluxbox/init"',
    '  touch "$init"',
    '  grep -v "session.screen0.toolbar.visible" "$init" > "$init.rakazo" || true',
    "  printf '%s\\n' 'session.screen0.toolbar.visible: false' >> \"$init.rakazo\"",
    '  mv "$init.rakazo" "$init"',
    "done",
    "fluxbox-remote reconfigure >/dev/null 2>&1 || true",
    "for class in fluxbox Fluxbox xfce4-panel Xfce4-panel pcmanfm Pcmanfm lxpanel tint2; do",
    '  xdotool search --class "$class" windowunmap >/dev/null 2>&1 || true',
    "done",
  ].join("\n");
}

function dismissChromeDialogShell(): string {
  return [
    'for name in "Welcome to Google Chrome" "Can\'t update Chrome" "Can’t update Chrome" "Cannot update Chrome" "Couldn\'t update Chrome" "Reinstall Chrome" "Google Translate" "Translate this page" "Diese Seite übersetzen" "Seite übersetzen"; do',
    "  dialog=$(xdotool search --onlyvisible --name \"$name\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -n "$dialog" ]; then',
    '    xdotool windowclose "$dialog" >/dev/null 2>&1 || true',
    "  fi",
    "done",
  ].join("\n");
}

/** Chrome reads this even when --disable-translate is ignored. Escape is not used: it leaves fullscreen. */
function installChromeTranslatePolicyShell(): string {
  return [
    `policy='{"TranslateEnabled":false}'`,
    "for dir in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do",
    '  mkdir -p "$dir" 2>/dev/null || sudo -n mkdir -p "$dir" 2>/dev/null || continue',
    `  printf '%s\\n' "$policy" > "$dir/rakazo-translate.json" 2>/dev/null || printf '%s\\n' "$policy" | sudo -n tee "$dir/rakazo-translate.json" >/dev/null 2>&1 || true`,
    '  chmod a+r "$dir/rakazo-translate.json" 2>/dev/null || sudo -n chmod a+r "$dir/rakazo-translate.json" 2>/dev/null || true',
    "done",
  ].join("\n");
}

/** Keep the fluxbox bar and a late translate bubble off after the search page has painted. */
function startDesktopWatchShell(): string {
  return [
    "cat > /tmp/rakazo-desktop-watch.sh << 'EOF'",
    "while true; do",
    `killall -q ${DESKTOP_PANEL_PROCESSES} 2>/dev/null || true`,
    "xdotool search --class fluxbox windowunmap >/dev/null 2>&1 || true",
    "xdotool search --name Toolbar windowunmap >/dev/null 2>&1 || true",
    dismissChromeDialogShell(),
    "sleep 1",
    "done",
    "EOF",
    "chmod +x /tmp/rakazo-desktop-watch.sh",
    "if ! pgrep -f '[r]akazo-desktop-watch' >/dev/null 2>&1; then",
    "  setsid -f /tmp/rakazo-desktop-watch.sh </dev/null >/dev/null 2>&1 || true",
    "fi",
  ].join("\n");
}

export function prepareKioskDesktopCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "export LANG=de_DE.UTF-8",
    "export LANGUAGE=de_DE:de",
    "killall -q chrome chromium chromium-browser google-chrome google-chrome-stable >/dev/null 2>&1 || true",
    installChromeTranslatePolicyShell(),
    hideDesktopChromeShell(),
    "sleep 0.3",
  ].join("\n");
}

export function detachedBrowserCommand(display: string, url: string): string {
  const quotedUrl = posixShellQuote(url.trim());
  const quotedDisplay = posixShellQuote(display);
  const launch = [
    `export DISPLAY=${quotedDisplay}`,
    "export LANG=de_DE.UTF-8",
    "export LANGUAGE=de_DE:de",
    `url=${quotedUrl}`,
    "dir=/tmp/rakazo-linkbuilder-chrome",
    'rm -rf "$dir"',
    'mkdir -p "$dir/Default"',
    'touch "$dir/First Run"',
    installChromeTranslatePolicyShell(),
    `printf '%s\\n' '{"browser":{"check_default_browser":false,"has_seen_welcome_page":true},"translate":{"enabled":false},"translate_blocked_languages":["de","de-DE","en","en-US"],"intl":{"accept_languages":"de-DE,de","selected_languages":"de-DE,de"},"distribution":{"skip_first_run_ui":true,"suppress_first_run_default_browser_prompt":true,"make_chrome_default_for_user":false}}' > "$dir/Default/Preferences"`,
    `printf '%s\\n' '{"intl":{"app_locale":"de","accept_languages":"de-DE,de"}}' > "$dir/Local State"`,
    'flags="--user-data-dir=$dir --kiosk --start-fullscreen --no-first-run --disable-fre --no-default-browser-check --disable-search-engine-choice-screen --disable-translate --disable-infobars --noerrdialogs --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-component-update --disable-background-networking --lang=de --accept-lang=de-DE,de --disable-features=Translate,TranslateUI,InfiniteSessionRestore,ChromeWhatsNewUI,OutdatedBuildDetector --password-store=basic --disable-sync --disable-dev-shm-usage --no-sandbox --window-position=0,0 --window-size=1280,800"',
    `printf '%s\\n' translate-off > ${posixShellQuote(CHROME_KIOSK_STAMP)}`,
    startDesktopWatchShell(),
    'if [ -x /usr/bin/google-chrome ]; then exec /usr/bin/google-chrome $flags "$url"; fi',
    'if [ -x /usr/bin/google-chrome-stable ]; then exec /usr/bin/google-chrome-stable $flags "$url"; fi',
    'if [ -x /usr/bin/chromium ]; then exec /usr/bin/chromium $flags "$url"; fi',
    'if [ -x /usr/bin/chromium-browser ]; then exec /usr/bin/chromium-browser $flags "$url"; fi',
    'if command -v google-chrome >/dev/null 2>&1; then exec google-chrome $flags "$url"; fi',
    'if command -v chromium >/dev/null 2>&1; then exec chromium $flags "$url"; fi',
    'if command -v firefox >/dev/null 2>&1; then exec firefox --kiosk "$url"; fi',
    'exec xdg-open "$url"',
  ];
  return [`# ${DETACHED_BROWSER_MARKER}`, ...launch].join("\n");
}

/** Wait until a browser window exists, then make it the only thing on the screen. */
export function raiseBrowserWindowCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  const classes = ["google-chrome", "Google-chrome", "Chromium", "chromium", "firefox", "Firefox"]
    .map(posixShellQuote)
    .join(" ");
  return [
    `export DISPLAY=${quotedDisplay}`,
    hideDesktopChromeShell(),
    dismissChromeDialogShell(),
    "id=",
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
    hideDesktopChromeShell(),
    dismissChromeDialogShell(),
    `  for class in ${classes}; do`,
    "    id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '    if [ -n "$id" ]; then break; fi',
    "  done",
    '  if [ -n "$id" ]; then',
    '    name=$(xdotool getwindowname "$id" 2>/dev/null || true)',
    '    case "$name" in',
    '      *"Welcome to Google Chrome"*|*"update Chrome"*|*"Reinstall Chrome"*)',
    '        xdotool windowclose "$id" >/dev/null 2>&1 || true',
    "        id=",
    "        sleep 0.3",
    "        continue",
    "        ;;",
    "    esac",
    "    read -r width height <<EOF",
    "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)",
    "EOF",
    "    width=${width:-1280}",
    "    height=${height:-800}",
    '    xdotool windowmove "$id" 0 0 windowsize --sync "$id" "$width" "$height" windowactivate "$id" windowraise "$id" || true',
    '    xdotool windowstate --add FULLSCREEN "$id" 2>/dev/null || true',
    '    if command -v wmctrl >/dev/null 2>&1; then wmctrl -i -r "$id" -b add,fullscreen,above 2>/dev/null || true; fi',
    "    for _dismiss in 1 2 3 4 5; do",
    dismissChromeDialogShell().replace(/^/gm, "    "),
    "      sleep 0.5",
    "    done",
    "    exit 0",
    "  fi",
    "  sleep 0.4",
    "done",
    "exit 1",
  ].join("\n");
}

/** Open an http(s) URL in a real browser instead of xdg-open (which often raises Files). */
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
