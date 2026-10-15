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
export const CHROME_KIOSK_STAMP = "/tmp/rakazo-chrome-kiosk-v6";

export function chromeKioskStampCommand(): string {
  return `test -f ${posixShellQuote(CHROME_KIOSK_STAMP)} && printf '%s\\n' ok || true`;
}

/**
 * The display the vendor noVNC stream is capturing (E2B listens on rfbport
 * 5900). Another x11vnc, or the X1 socket, is a side display: Chrome there
 * leaves the live pane on the wallpaper.
 */
export function streamedDisplayCommand(): string {
  return [
    "display=",
    "vendor=",
    "fallback=",
    "for pid in $(pgrep -x x11vnc 2>/dev/null || true); do",
    '  [ -r "/proc/$pid/cmdline" ] || continue',
    "  args=$(tr '\\0' '\\n' < \"/proc/$pid/cmdline\")",
    "  found=$(printf '%s\\n' \"$args\" | awk 'prev==\"-display\"{print; exit} {prev=$0}')",
    "  port=$(printf '%s\\n' \"$args\" | awk 'prev==\"-rfbport\"{print; exit} {prev=$0}')",
    '  case "$found" in',
    "    :*)",
    '      case "$port" in',
    "        5900) vendor=$found ;;",
    '        *) [ -z "$fallback" ] && fallback=$found ;;',
    "      esac",
    "      ;;",
    "  esac",
    "done",
    'if [ -n "$vendor" ]; then display=$vendor',
    'elif [ -n "$fallback" ]; then display=$fallback',
    "elif [ -S /tmp/.X11-unix/X0 ]; then display=:0",
    "elif [ -S /tmp/.X11-unix/X1 ]; then display=:1",
    'elif [ -n "${DISPLAY:-}" ]; then display=$DISPLAY',
    "else display=:0; fi",
    "printf '%s\\n' \"$display\"",
  ].join("\n");
}

/**
 * Restart the x11vnc that serves this display so it samples the framebuffer
 * instead of a stale wallpaper frame. A replaced X server keeps the old
 * capture until that process starts again.
 */
export function refreshVendorStreamCommand(display: string, force = false): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export TARGET_DISPLAY=${quotedDisplay}`,
    ...(force ? ["rm -f /tmp/rakazo-vnc-noxdamage"] : []),
    "if [ -f /tmp/rakazo-vnc-noxdamage ]; then exit 0; fi",
    "python3 - <<'PY'",
    "import os, signal, subprocess, time",
    "target = os.environ.get('TARGET_DISPLAY', ':0')",
    "found = []",
    "for name in os.listdir('/proc'):",
    "    if not name.isdigit():",
    "        continue",
    "    try:",
    "        raw = open('/proc/%s/cmdline' % name, 'rb').read().split(b'\\0')",
    "    except OSError:",
    "        continue",
    "    if not raw or raw[0].rsplit(b'/', 1)[-1] != b'x11vnc':",
    "        continue",
    "    args = [part.decode('utf-8', 'replace') for part in raw if part]",
    "    shown = ''",
    "    port = ''",
    "    prev = ''",
    "    for arg in args:",
    "        if prev == '-display':",
    "            shown = arg",
    "        if prev == '-rfbport':",
    "            port = arg",
    "        prev = arg",
    "    if shown != target and port != '5900':",
    "        continue",
    "    if '-noxdamage' not in args:",
    "        args.extend(['-noxdamage', '-noxfixes'])",
    "    found.append((int(name), args))",
    "restarted = False",
    "for pid, args in found:",
    "    try:",
    "        os.kill(pid, signal.SIGTERM)",
    "    except OSError:",
    "        continue",
    "    for _ in range(20):",
    "        try:",
    "            os.kill(pid, 0)",
    "        except OSError:",
    "            break",
    "        time.sleep(0.1)",
    "    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)",
    "    restarted = True",
    "if restarted:",
    "    open('/tmp/rakazo-vnc-noxdamage', 'w').write('ok')",
    "PY",
    "exit 0",
  ].join("\n");
}

/**
 * Drop the desktop shell and any Chrome that was started without kiosk flags.
 * An already-running Chrome ignores `--kiosk` and `--no-first-run` on a second launch.
 * `exec` inside the detached command replaces the shell so E2B can disconnect
 * without reaping the browser.
 */
const DESKTOP_PANEL_PROCESSES =
  "xfce4-panel xfdesktop pcmanfm lxpanel tint2 plank gnome-panel plasmashell xfce4-notifyd fbpanel lxqt-panel mate-panel xfce4-screensaver light-locker xscreensaver";

/** Hide the window-manager bar (Applications, clock) so noVNC is only the browser. */
function hideDesktopChromeShell(): string {
  return [
    `killall -q ${DESKTOP_PANEL_PROCESSES} >/dev/null 2>&1 || true`,
    "xset s off -dpms s noblank >/dev/null 2>&1 || true",
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
    "# rakazo-watch-v2",
    "echo $$ > /tmp/rakazo-watch.pid",
    "while true; do",
    `killall -q ${DESKTOP_PANEL_PROCESSES} 2>/dev/null || true`,
    "xset s off -dpms s noblank >/dev/null 2>&1 || true",
    "xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false >/dev/null 2>&1 || true",
    "xfconf-query -c xfce4-screensaver -p /lock/enabled -n -t bool -s false >/dev/null 2>&1 || true",
    "xdotool search --class fluxbox windowunmap >/dev/null 2>&1 || true",
    "xdotool search --name Toolbar windowunmap >/dev/null 2>&1 || true",
    "id=",
    "ffpid=$(pgrep -x firefox-esr 2>/dev/null | awk 'NR==1{print; exit}')",
    'if [ -z "$ffpid" ]; then ffpid=$(pgrep -x firefox 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    'if [ -n "$ffpid" ]; then id=$(xdotool search --pid "$ffpid" 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    "for class in firefox-esr Firefox-esr firefox Firefox Navigator Chromium chromium google-chrome Google-chrome; do",
    '  xdotool search --class "$class" windowmap >/dev/null 2>&1 || true',
    "  id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -n "$id" ]; then break; fi',
    "done",
    "if [ -z \"$id\" ]; then id=$(xdotool search --onlyvisible --name Firefox 2>/dev/null | awk 'NR==1{print; exit}'); fi",
    'if [ -n "$id" ]; then',
    '  xdotool windowmove "$id" 0 0 windowsize "$id" 1280 800 windowactivate "$id" windowraise "$id" >/dev/null 2>&1 || true',
    '  xdotool windowstate --add FULLSCREEN "$id" >/dev/null 2>&1 || true',
    '  if command -v wmctrl >/dev/null 2>&1; then wmctrl -i -r "$id" -b add,fullscreen,above >/dev/null 2>&1 || true; fi',
    "fi",
    dismissChromeDialogShell(),
    "sleep 1",
    "done",
    "EOF",
    "chmod +x /tmp/rakazo-desktop-watch.sh",
    "old=$(cat /tmp/rakazo-watch.pid 2>/dev/null || true)",
    'if [ -n "$old" ] && [ -r "/proc/$old/cmdline" ]; then',
    "  args=$(tr '\\0' ' ' < \"/proc/$old/cmdline\")",
    '  case "$args" in',
    "    *rakazo-desktop-watch*) kill \"$old\" >/dev/null 2>&1 || true ;;",
    "  esac",
    "fi",
    "setsid -f /tmp/rakazo-desktop-watch.sh </dev/null >/dev/null 2>&1 || true",
  ].join("\n");
}

/**
 * The desktop SDK starts Xvfb in the background, then x11vnc attaches to it.
 * Killing that server and starting another from a short command makes the new
 * Xvfb exit 1: either it has no listening socket, or the command's process
 * group is reaped and takes the server with it. The stream then stays black
 * and Chrome exits 1 before a page loads. A display that already answers is
 * left alone. A display that is still booting is waited on. A missing display
 * is started in its own session, without `-nolisten unix`, so Chrome can open
 * the socket. This command does not restart x11vnc.
 */
export function repairDesktopDisplayCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  const number = display.replace(/^:/, "") || "0";
  return [
    `export DISPLAY=${quotedDisplay}`,
    `if xdpyinfo -display ${quotedDisplay} >/dev/null 2>&1; then exit 0; fi`,
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
    `  xdpyinfo -display ${quotedDisplay} >/dev/null 2>&1 && exit 0`,
    "  sleep 0.25",
    "done",
    "mkdir -p /tmp/.X11-unix",
    "chmod 1777 /tmp/.X11-unix 2>/dev/null || true",
    `rm -f /tmp/.X${number}-lock`,
    `setsid -f Xvfb ${quotedDisplay} -ac -screen 0 1280x800x24 +extension RANDR +render -noreset >/tmp/rakazo-xvfb.log 2>&1`,
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
    `  xdpyinfo -display ${quotedDisplay} >/dev/null 2>&1 && exit 0`,
    "  sleep 0.25",
    "done",
    "exit 0",
  ].join("\n");
}

/** Written while a signup form is the active step. The screen must not move that page. */
export const FORM_HOLD_STAMP = "/tmp/rakazo-form-hold";

export function signupFormHeldCommand(): string {
  return `test -f ${posixShellQuote(FORM_HOLD_STAMP)} && printf '%s\\n' held || true`;
}

/**
 * Keep the viewer's x11vnc. Killing it to recapture one window drops the
 * websocket, and `x11vnc -id` exits when that window is not mapped. Firefox
 * is already fullscreen, so the existing display capture is the browser.
 * Start a capture only when none is running.
 */
export function attachBrowserWindowStreamCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "for pid in $(pgrep -x x11vnc 2>/dev/null || true); do",
    '  [ -r "/proc/$pid/cmdline" ] || continue',
    "  args=$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")",
    '  case "$args" in',
    "    *-id* *-noxdamage*|*-noxdamage* *-id*) printf '%s\\n' attached; exit 0 ;;",
    "  esac",
    "done",
    "id=",
    "ffpid=$(pgrep -x firefox-esr 2>/dev/null | awk 'NR==1{print; exit}')",
    'if [ -z "$ffpid" ]; then ffpid=$(pgrep -x firefox 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    'if [ -n "$ffpid" ]; then id=$(xdotool search --pid "$ffpid" 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    'if [ -z "$id" ]; then',
    "for class in firefox-esr Firefox-esr firefox Firefox google-chrome Google-chrome Chromium chromium; do",
    "  id=$(xdotool search --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -n "$id" ]; then break; fi',
    "done",
    "fi",
    'if [ -z "$id" ]; then',
    "  if pgrep -x x11vnc >/dev/null 2>&1; then printf '%s\\n' waiting; exit 0; fi",
    '  setsid -f x11vnc -bg -display "$DISPLAY" -forever -wait 50 -shared -rfbport 5900 -nopw -noxdamage -noxfixes -nowf -noscr >/tmp/rakazo-x11vnc.log 2>&1',
    "  exit 0",
    "fi",
    "for pid in $(pgrep -x x11vnc 2>/dev/null || true); do",
    '  [ -r "/proc/$pid/cmdline" ] || continue',
    "  args=$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")",
    '  case "$args" in',
    '    *"-id $id"* *-noxdamage*|*-noxdamage* *"-id $id"*) printf \'%s\\n\' attached; exit 0 ;;',
    "  esac",
    "done",
    "pkill -x x11vnc >/dev/null 2>&1 || true",
    "for _ in 1 2 3 4 5 6 7 8; do pgrep -x x11vnc >/dev/null 2>&1 || break; sleep 0.1; done",
    'setsid -f x11vnc -bg -display "$DISPLAY" -forever -wait 50 -shared -rfbport 5900 -nopw -noxdamage -noxfixes -nowf -noscr -id "$id" >/tmp/rakazo-x11vnc.log 2>&1',
    "exit 0",
  ].join("\n");
}

export function prepareKioskDesktopCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "export LANG=de_DE.UTF-8",
    "export LANGUAGE=de_DE:de",
    // The persona browser is the signup form. killall would exit that Chrome
    // with status 1 before the form is submitted.
    "if pgrep -f '[r]akazo-lb-browser' >/dev/null 2>&1; then exit 0; fi",
    "if pgrep -af -- '--user-data-dir=' 2>/dev/null | grep -F '/.browser-profiles/' >/dev/null 2>&1; then exit 0; fi",
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
    "export MOZ_WEBRENDER=0",
    "export LIBGL_ALWAYS_SOFTWARE=1",
    "export MOZ_ENABLE_WAYLAND=0",
    "export GDK_BACKEND=x11",
    "export MOZ_DISABLE_CONTENT_SANDBOX=1",
    "unset MOZ_HEADLESS MOZ_HEADLESS_WIDTH MOZ_HEADLESS_HEIGHT",
    "export MOZ_HEADLESS=0",
    'if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then uid=$(id -u); if [ -S "/run/user/$uid/bus" ]; then export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"; fi; fi',
    "trap '' HUP",
    `url=${quotedUrl}`,
    // The image ships /usr/bin/firefox-esr. `firefox` is absent, and Chrome
    // never maps a window on this capture, so the ESR kiosk has to start
    // before the slow Chrome profile setup.
    "mkdir -p /tmp/rakazo-ff-profile",
    "rm -f /tmp/rakazo-ff-profile/.parentlock /tmp/rakazo-ff-profile/lock",
    "ff=",
    "if [ -x /usr/bin/firefox-esr ]; then ff=/usr/bin/firefox-esr; fi",
    'if [ -z "$ff" ] && command -v firefox-esr >/dev/null 2>&1; then ff=$(command -v firefox-esr); fi',
    'if [ -z "$ff" ] && [ -x /usr/lib/firefox-esr/firefox-esr ]; then ff=/usr/lib/firefox-esr/firefox-esr; fi',
    'if [ -z "$ff" ] && command -v firefox >/dev/null 2>&1; then ff=$(command -v firefox); fi',
    startDesktopWatchShell(),
    'if [ -n "$ff" ]; then',
    `  printf '%s\\n' translate-off > ${posixShellQuote(CHROME_KIOSK_STAMP)}`,
    // The sandbox tears the command down when this shell exits, which was
    // killing Firefox and leaving the screensaver. The browser has to be
    // the command, the same way the desktop session stays up.
    '  exec "$ff" --no-remote --kiosk --profile /tmp/rakazo-ff-profile "$url" </dev/null >/tmp/rakazo-firefox.log 2>&1',
    "fi",
    "dir=/tmp/rakazo-linkbuilder-chrome",
    'rm -rf "$dir"',
    'mkdir -p "$dir/Default"',
    'touch "$dir/First Run"',
    installChromeTranslatePolicyShell(),
    `printf '%s\\n' '{"browser":{"check_default_browser":false,"has_seen_welcome_page":true},"translate":{"enabled":false},"translate_blocked_languages":["de","de-DE","en","en-US"],"intl":{"accept_languages":"de-DE,de","selected_languages":"de-DE,de"},"distribution":{"skip_first_run_ui":true,"suppress_first_run_default_browser_prompt":true,"make_chrome_default_for_user":false}}' > "$dir/Default/Preferences"`,
    `printf '%s\\n' '{"intl":{"app_locale":"de","accept_languages":"de-DE,de"}}' > "$dir/Local State"`,
    'flags="--user-data-dir=$dir --kiosk --start-fullscreen --no-first-run --disable-fre --no-default-browser-check --disable-search-engine-choice-screen --disable-translate --disable-infobars --noerrdialogs --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-component-update --disable-background-networking --lang=de --accept-lang=de-DE,de --disable-gpu --disable-gpu-compositing --ozone-platform=x11 --disable-features=Translate,TranslateUI,InfiniteSessionRestore,ChromeWhatsNewUI,OutdatedBuildDetector --password-store=basic --disable-sync --disable-dev-shm-usage --no-sandbox --window-position=0,0 --window-size=1280,800"',
    `printf '%s\\n' translate-off > ${posixShellQuote(CHROME_KIOSK_STAMP)}`,
    startDesktopWatchShell(),
    // Firefox paints into Xvfb. Chrome's GL window stays black on this capture.
    // exec replaces the shell so disconnect cannot reap the browser.
    // stdin from /dev/null: Chrome treats a closed stdin as a quit.
    'if [ -x /usr/bin/firefox-esr ]; then export MOZ_WEBRENDER=0 LIBGL_ALWAYS_SOFTWARE=1; exec /usr/bin/firefox-esr --no-remote --kiosk --profile /tmp/rakazo-ff-profile "$url" </dev/null >/tmp/rakazo-firefox.log 2>&1; fi',
    'if command -v firefox >/dev/null 2>&1; then export MOZ_WEBRENDER=0 LIBGL_ALWAYS_SOFTWARE=1; exec firefox --kiosk "$url" </dev/null >/tmp/rakazo-firefox.log 2>&1; fi',
    'if [ -x /usr/bin/google-chrome ]; then exec /usr/bin/google-chrome $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if [ -x /usr/bin/google-chrome-stable ]; then exec /usr/bin/google-chrome-stable $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if [ -x /usr/bin/chromium ]; then exec /usr/bin/chromium $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if [ -x /usr/bin/chromium-browser ]; then exec /usr/bin/chromium-browser $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if command -v google-chrome >/dev/null 2>&1; then exec google-chrome $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if command -v chromium >/dev/null 2>&1; then exec chromium $flags "$url" </dev/null >/tmp/rakazo-chrome.log 2>&1; fi',
    'if command -v firefox >/dev/null 2>&1; then export MOZ_WEBRENDER=0 LIBGL_ALWAYS_SOFTWARE=1; exec firefox --kiosk "$url" </dev/null >/tmp/rakazo-firefox.log 2>&1; fi',
    'exec xdg-open "$url" </dev/null',
  ];
  return [`# ${DETACHED_BROWSER_MARKER}`, ...launch].join("\n");
}

/**
 * A black kiosk is Chrome painting nowhere x11vnc can read. Firefox in a new
 * session draws a normal window. One try, so a dark page is not relaunched.
 */
export function repaintBlackKioskCommand(display: string, url: string): string {
  const quotedDisplay = posixShellQuote(display);
  const quotedUrl = posixShellQuote(url.trim());
  return [
    `export DISPLAY=${quotedDisplay}`,
    "if [ -f /tmp/rakazo-firefox-kiosk ]; then printf '%s\\n' firefox; exit 0; fi",
    "paint=$(python3 - <<'PY'",
    "import subprocess, sys",
    "try:",
    "    data = subprocess.run(['import','-window','root','-crop','320x200+480+300','-resize','8x5!','-depth','8','ppm:-'], capture_output=True, timeout=8)",
    "except Exception:",
    "    sys.exit(0)",
    "blob = data.stdout or b''",
    "mark = blob.find(b'\\n255\\n')",
    "if data.returncode != 0 or mark < 0:",
    "    sys.exit(0)",
    "pixels = blob[mark+5:]",
    "if len(pixels) < 8*5*3:",
    "    sys.exit(0)",
    "mean = sum(pixels) / float(len(pixels))",
    "print('black' if mean < 12 else 'live')",
    "PY",
    ")",
    "printf '%s\\n' \"${paint:-unknown}\" > /tmp/rakazo-paint",
    "printf '%s\\n' \"${paint:-unknown}\"",
    'if [ "$paint" != black ]; then exit 0; fi',
    "ff=",
    "if [ -x /usr/bin/firefox-esr ]; then ff=/usr/bin/firefox-esr; fi",
    'if [ -z "$ff" ] && command -v firefox-esr >/dev/null 2>&1; then ff=$(command -v firefox-esr); fi',
    'if [ -z "$ff" ] && command -v firefox >/dev/null 2>&1; then ff=$(command -v firefox); fi',
    'if [ -z "$ff" ]; then exit 0; fi',
    "killall -q chrome chromium chromium-browser google-chrome google-chrome-stable >/dev/null 2>&1 || true",
    `setsid -f "$ff" --no-remote --kiosk --profile /tmp/rakazo-ff-profile ${quotedUrl} </dev/null >/tmp/rakazo-firefox.log 2>&1`,
    "printf '%s\\n' firefox > /tmp/rakazo-firefox-kiosk",
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do",
    "  xdotool search --class firefox >/dev/null 2>&1 && exit 0",
    "  xdotool search --class Firefox >/dev/null 2>&1 && exit 0",
    "  sleep 0.4",
    "done",
    "exit 0",
  ].join("\n");
}

/** True when a browser window class is mapped. Desktop icons do not count. */
export function browserWindowPresentCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "for class in google-chrome Google-chrome Chromium chromium firefox Firefox Firefox-esr Navigator firefox-esr; do",
    "  id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    "  if [ -n \"$id\" ]; then printf '%s\\n' browser; exit 0; fi",
    "done",
    "printf '%s\\n' none",
  ].join("\n");
}

/**
 * Firefox is already running. A second launch uses the same profile and the
 * first process exits 1. Chromium can be headless with no window; it does not
 * count, so a visible Firefox can still be the stream.
 */
export function browserProcessCommand(): string {
  return [
    "pid=$(pgrep -x firefox-esr | awk 'NR==1{print; exit}')",
    'if [ -z "$pid" ]; then pid=$(pgrep -x firefox | awk \'NR==1{print; exit}\'); fi',
    'if [ -n "$pid" ]; then',
    "  state=$(ps -o stat= -p \"$pid\" 2>/dev/null | awk '{print substr($1,1,1)}')",
    '  if [ -n "$state" ] && [ "$state" != "Z" ]; then printf \'%s\\n\' up; exit 0; fi',
    "fi",
    "printf '%s\\n' none",
  ].join("\n");
}

/**
 * A firefox process with no mapped window leaves x11vnc on the wallpaper.
 * Map a hidden window first. A process that has already had time to paint
 * and still has no window is replaced once on this same display.
 */
export function recoverWindowlessBrowserCommand(display: string, url: string): string {
  const quotedDisplay = posixShellQuote(display);
  const quotedUrl = posixShellQuote(url.trim());
  return [
    `export DISPLAY=${quotedDisplay}`,
    "export MOZ_WEBRENDER=0",
    "export LIBGL_ALWAYS_SOFTWARE=1",
    "export MOZ_ENABLE_WAYLAND=0",
    "export GDK_BACKEND=x11",
    "export MOZ_HEADLESS=0",
    "unset MOZ_HEADLESS_WIDTH MOZ_HEADLESS_HEIGHT",
    "id=",
    "ffpid=$(pgrep -x firefox-esr 2>/dev/null | awk 'NR==1{print; exit}')",
    'if [ -z "$ffpid" ]; then ffpid=$(pgrep -x firefox 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    'if [ -n "$ffpid" ]; then',
    '  xdotool search --pid "$ffpid" windowmap >/dev/null 2>&1 || true',
    "  id=$(xdotool search --pid \"$ffpid\" 2>/dev/null | awk 'NR==1{print; exit}')",
    "fi",
    'if [ -z "$id" ]; then',
    "for class in firefox-esr Firefox-esr firefox Firefox Navigator; do",
    '  xdotool search --class "$class" windowmap >/dev/null 2>&1 || true',
    "  id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -n "$id" ]; then break; fi',
    "done",
    "fi",
    'if [ -n "$id" ]; then',
    '  xdotool windowmove "$id" 0 0 windowsize "$id" 1280 800 windowactivate "$id" windowraise "$id" >/dev/null 2>&1 || true',
    '  xdotool windowstate --add FULLSCREEN "$id" >/dev/null 2>&1 || true',
    "  exit 0",
    "fi",
    "pid=$(pgrep -x firefox-esr | awk 'NR==1{print; exit}')",
    'if [ -z "$pid" ]; then pid=$(pgrep -x firefox | awk \'NR==1{print; exit}\'); fi',
    'if [ -z "$pid" ]; then exit 0; fi',
    "age=$(ps -o etimes= -p \"$pid\" 2>/dev/null | tr -d ' ')",
    'if [ -n "$age" ] && [ "$age" -lt 20 ]; then exit 0; fi',
    "nows=$(date +%s)",
    "old=$(cat /tmp/rakazo-ff-recover 2>/dev/null || echo 0)",
    'case "$old" in ""|*[!0-9]*) old=0 ;; esac',
    'if [ "$((nows - old))" -lt 90 ]; then exit 0; fi',
    "printf '%s\\n' \"$nows\" > /tmp/rakazo-ff-recover",
    'kill "$pid" >/dev/null 2>&1 || true',
    "sleep 0.3",
    'kill -9 "$pid" >/dev/null 2>&1 || true',
    "mkdir -p /tmp/rakazo-ff-profile",
    "rm -f /tmp/rakazo-ff-profile/.parentlock /tmp/rakazo-ff-profile/lock",
    "ff=/usr/bin/firefox-esr",
    'if [ ! -x "$ff" ]; then ff=$(command -v firefox-esr || command -v firefox || true); fi',
    'if [ -z "$ff" ]; then exit 0; fi',
    `setsid -f "$ff" --no-remote --kiosk --profile /tmp/rakazo-ff-profile ${quotedUrl} </dev/null >/tmp/rakazo-firefox.log 2>&1`,
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
    "  xdotool search --class firefox-esr >/dev/null 2>&1 && exit 0",
    "  xdotool search --class firefox >/dev/null 2>&1 && exit 0",
    "  sleep 0.4",
    "done",
    "exit 0",
  ].join("\n");
}

/** Wait until a browser window exists, then make it the only thing on the screen. */
export function raiseBrowserWindowCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    startDesktopWatchShell(),
    hideDesktopChromeShell(),
    dismissChromeDialogShell(),
    "id=",
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
    hideDesktopChromeShell(),
    dismissChromeDialogShell(),
    "  for class in firefox-esr Firefox-esr firefox Firefox Navigator Chromium chromium google-chrome Google-chrome; do",
    '    xdotool search --class "$class" windowmap >/dev/null 2>&1 || true',
    "  done",
    "  id=",
    "  ffpid=$(pgrep -x firefox-esr 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -z "$ffpid" ]; then ffpid=$(pgrep -x firefox 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    '  if [ -n "$ffpid" ]; then xdotool search --pid "$ffpid" windowmap >/dev/null 2>&1 || true; id=$(xdotool search --pid "$ffpid" 2>/dev/null | awk \'NR==1{print; exit}\'); fi',
    '  if [ -z "$id" ]; then',
    "  for class in firefox-esr Firefox-esr firefox Firefox Navigator Chromium chromium google-chrome Google-chrome; do",
    "    id=$(xdotool search --onlyvisible --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '    if [ -n "$id" ]; then break; fi',
    "  done",
    "  fi",
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
    "printf '%s\\n' window-pending",
    "exit 0",
  ].join("\n");
}

/**
 * Map the browser onto the streamed display. A black framebuffer while Chrome
 * is open is an x11vnc damage miss: restart that capture once with polling.
 * Does not start a sandbox and does not close Chrome.
 */
export function repairBlackStreamCommand(display: string): string {
  const quotedDisplay = posixShellQuote(display);
  return [
    `export DISPLAY=${quotedDisplay}`,
    "id=",
    "for class in google-chrome Google-chrome Chromium chromium firefox Firefox Navigator firefox-esr; do",
    "  id=$(xdotool search --class \"$class\" 2>/dev/null | awk 'NR==1{print; exit}')",
    '  if [ -n "$id" ]; then break; fi',
    "done",
    'if [ -z "$id" ]; then exit 0; fi',
    'xdotool windowmap "$id" >/dev/null 2>&1 || true',
    "read -r width height <<EOF",
    "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)",
    "EOF",
    "width=${width:-1280}",
    "height=${height:-800}",
    'xdotool windowmove "$id" 0 0 windowsize --sync "$id" "$width" "$height" windowactivate "$id" windowraise "$id" >/dev/null 2>&1 || true',
    'xdotool windowstate --add FULLSCREEN "$id" >/dev/null 2>&1 || true',
    "if [ -f /tmp/rakazo-vnc-noxdamage ]; then exit 0; fi",
    "sleep 0.4",
    "sample=$(python3 - <<'PY'",
    "import subprocess, sys",
    "cmds = [",
    "  ['import','-window','root','-crop','640x400+320+200','-resize','16x10!','-depth','8','ppm:-'],",
    "  ['import','-window','root','-resize','16x10!','-depth','8','ppm:-'],",
    "]",
    "blob = b''",
    "code = 1",
    "for cmd in cmds:",
    "    try:",
    "        data = subprocess.run(cmd, capture_output=True, timeout=8)",
    "    except Exception:",
    "        continue",
    "    if data.returncode == 0 and data.stdout:",
    "        blob = data.stdout",
    "        code = 0",
    "        break",
    "if code != 0:",
    "    sys.exit(0)",
    "mark = blob.find(b'\\n255\\n')",
    "if mark < 0:",
    "    sys.exit(0)",
    "pixels = blob[mark+5:]",
    "if len(pixels) < 16*10*3:",
    "    sys.exit(0)",
    "mean = sum(pixels) / float(len(pixels))",
    "print('black' if mean < 12 else 'live')",
    "PY",
    ")",
    'if [ "$sample" != black ]; then exit 0; fi',
    "python3 - <<'PY'",
    "import os, signal, subprocess, time",
    "restarted = False",
    "found = []",
    "for name in os.listdir('/proc'):",
    "    if not name.isdigit():",
    "        continue",
    "    try:",
    "        raw = open('/proc/%s/cmdline' % name, 'rb').read().split(b'\\0')",
    "    except OSError:",
    "        continue",
    "    if not raw or not raw[0]:",
    "        continue",
    "    if raw[0].rsplit(b'/', 1)[-1] != b'x11vnc':",
    "        continue",
    "    args = [part.decode('utf-8', 'replace') for part in raw if part]",
    "    if '-noxdamage' in args:",
    "        continue",
    "    found.append((int(name), args + ['-noxdamage', '-noxfixes']))",
    "for pid, args in found:",
    "    try:",
    "        os.kill(pid, signal.SIGTERM)",
    "    except OSError:",
    "        continue",
    "    for _ in range(20):",
    "        try:",
    "            os.kill(pid, 0)",
    "        except OSError:",
    "            break",
    "        time.sleep(0.1)",
    "    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)",
    "    restarted = True",
    "if restarted:",
    "    open('/tmp/rakazo-vnc-noxdamage', 'w').write('ok')",
    "PY",
    "exit 0",
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
