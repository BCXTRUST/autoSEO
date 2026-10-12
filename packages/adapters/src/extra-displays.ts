import { createHash } from "node:crypto";
import type { ComputerAction, ComputerInput } from "@rakazo/adapter-kit";
import {
  exposeBrowserDesktopCommand,
  isHttpUrl,
  looksLikeDesktopBrowserApp,
  openPathDesktopCommand,
} from "@rakazo/core";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { clampRounded, shellQuote } from "./computer-support.js";

export const TEAM_EXTRA_DISPLAY_LIMIT = 8;

export interface ExtraDisplayLayout {
  index: number;
  display: string;
  displayNumber: number;
  viewPort: number;
  controlPort: number;
  viewVncPort: number;
  controlVncPort: number;
  isPrimary: boolean;
}

export interface ExtraDisplayEnvironment {
  homeDir: string;
  browserProfilesDir: string;
}

const SCREEN_REGISTRY = "/tmp/rakazo/screen-assignments";

export function allocateExtraDisplayCommand(screenKey: string, leaseId?: string): string {
  const key = createHash("sha256").update(screenKey).digest("hex");
  const owner = leaseId ?? "";
  return [
    "set -eu",
    `dir=${shellQuote(SCREEN_REGISTRY)}`,
    'mkdir -p "$dir"',
    'exec 9>"$dir/.lock"',
    "flock -w 5 9",
    `slot="$dir/${key}.slot"`,
    `if [ -f "$slot" ]; then index=$(sed -n '1p' "$slot"); current=$(sed -n '2p' "$slot"); else index=""; current=""; for candidate in $(seq 0 ${TEAM_EXTRA_DISPLAY_LIMIT - 1}); do if ! grep -h -x -- "$candidate" "$dir"/*.slot >/dev/null 2>&1; then index=$candidate; break; fi; done; [ -n "$index" ] || exit 75; fi`,
    `owner=${shellQuote(owner)}`,
    'if [ -z "$owner" ]; then owner="$current"; fi',
    'incoming_fence=0; current_fence=0; incoming_owner="$owner"; current_owner="$current"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in the remote shell script
    'case "$owner" in *:*) rest=${owner##*:}; case "$rest" in \'\'|*[!0-9]*) ;; *) incoming_fence=$rest; incoming_owner=${owner%:*}; esac ;; esac',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in the remote shell script
    'case "$current" in *:*) rest=${current##*:}; case "$rest" in \'\'|*[!0-9]*) ;; *) current_fence=$rest; current_owner=${current%:*}; esac ;; esac',
    'if [ -n "$owner" ] && [ -n "$current" ] && [ "$owner" != "$current" ] && [ "$incoming_fence" -le "$current_fence" ]; then printf \'RAKAZO_SCREEN_INDEX=stale\\n\'; exit 75; fi',
    'tmp="$slot.$$"',
    'printf \'%s\\n%s\\n\' "$index" "$owner" >"$tmp"',
    'mv "$tmp" "$slot"',
    "printf 'RAKAZO_SCREEN_INDEX=%s\\n' \"$index\"",
  ].join("\n");
}

export function releaseExtraDisplayCommand(screenKey: string, leaseId?: string): string {
  const key = createHash("sha256").update(screenKey).digest("hex");
  const owner = leaseId ?? "";
  return [
    "set -eu",
    `dir=${shellQuote(SCREEN_REGISTRY)}`,
    'mkdir -p "$dir"',
    'exec 9>"$dir/.lock"',
    "flock -w 5 9",
    `slot="$dir/${key}.slot"`,
    "[ -f \"$slot\" ] || { printf 'RAKAZO_SCREEN_RELEASE=missing\\n'; exit 0; }",
    "index=$(sed -n '1p' \"$slot\")",
    "current=$(sed -n '2p' \"$slot\")",
    `owner=${shellQuote(owner)}`,
    'incoming_fence=0; current_fence=0; incoming_owner="$owner"; current_owner="$current"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in the remote shell script
    'case "$owner" in *:*) rest=${owner##*:}; case "$rest" in \'\'|*[!0-9]*) ;; *) incoming_fence=$rest; incoming_owner=${owner%:*}; esac ;; esac',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in the remote shell script
    'case "$current" in *:*) rest=${current##*:}; case "$rest" in \'\'|*[!0-9]*) ;; *) current_fence=$rest; current_owner=${current%:*}; esac ;; esac',
    '[ -z "$owner" ] || [ "$current" = "$owner" ] || { [ "$incoming_owner" = "$current_owner" ] && [ "$incoming_fence" -ge "$current_fence" ]; } || { printf \'RAKAZO_SCREEN_RELEASE=stale\\n\'; exit 0; }',
    'if [ "$index" -ne 0 ]; then display_number=$((index + 1)); view_port=$((6080 + index * 2)); control_port=$((6081 + index * 2)); view_vnc_port=$((5900 + index * 2)); control_vnc_port=$((5901 + index * 2)); pkill -f "Xvfb :$display_number -screen" || true; pkill -f "HOME=/tmp/fluxbox-home-$display_number DISPLAY=:$display_number fluxbox" || true; pkill -f -- "chromium-screen-$display_number" || true; pkill -f "^x11vnc .* -rfbport $view_vnc_port" || true; pkill -f "^x11vnc .* -rfbport $control_vnc_port" || true; pkill -f "^/usr/bin/python3 .*websockify.*$view_port" || true; pkill -f "novnc_proxy.*--listen $view_port" || true; pkill -f "^/usr/bin/python3 .*websockify.*$control_port" || true; pkill -f "novnc_proxy.*--listen $control_port" || true; rm -f "/tmp/.X$display_number-lock" "/tmp/.X11-unix/X$display_number" "/tmp/rakazo/control-token-$display_number" "/tmp/rakazo/view-password-$display_number" "/tmp/rakazo-view-$display_number.vncpass" "/tmp/rakazo-control-$display_number.vncpass" "/tmp/rakazo/screen-$display_number.lock"; fi',
    'rm -f "$slot"',
    "printf 'RAKAZO_SCREEN_RELEASE=%s\\n' \"$index\"",
  ].join("; ");
}

export function parseAllocatedExtraDisplay(output: string): number {
  const index = Number(output.match(/RAKAZO_SCREEN_INDEX=(\d+)/)?.[1]);
  if (!Number.isInteger(index) || index < 0 || index >= TEAM_EXTRA_DISPLAY_LIMIT) {
    throw new ComputerScreenUnavailableError();
  }
  return index;
}

export function parseReleasedExtraDisplay(output: string): number | undefined {
  const match = output.match(/RAKAZO_SCREEN_RELEASE=(\d+)/);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 && index < TEAM_EXTRA_DISPLAY_LIMIT
    ? index
    : undefined;
}

export function extraDisplayLayout(index: number, primaryDisplay: string): ExtraDisplayLayout {
  if (index < 0 || index >= TEAM_EXTRA_DISPLAY_LIMIT) {
    throw new ComputerScreenUnavailableError();
  }
  const viewPort = 6080 + index * 2;
  const controlPort = 6081 + index * 2;
  const viewVncPort = 5900 + index * 2;
  const controlVncPort = 5901 + index * 2;
  if (index === 0) {
    const displayNumber = Number.parseInt(primaryDisplay.replace(":", ""), 10);
    return {
      index,
      display: primaryDisplay,
      displayNumber: Number.isFinite(displayNumber) ? displayNumber : 0,
      viewPort,
      controlPort,
      viewVncPort,
      controlVncPort,
      isPrimary: true,
    };
  }
  return {
    index,
    display: `:${index + 1}`,
    displayNumber: index + 1,
    viewPort,
    controlPort,
    viewVncPort,
    controlVncPort,
    isPrimary: false,
  };
}

export const PRIMARY_WATCH_VIEW_PORT = 6090;
export const PRIMARY_WATCH_VNC_PORT = 5910;

/**
 * A server that must keep running after this shell exits.
 * Redirect the whole group. A bare `cmd &` keeps E2B's stdout pipe open, so the
 * command never finishes and the screen open is reported as a dead computer.
 */
function detachServer(command: string, logFile: string): string {
  return `( ${command} ) </dev/null >${logFile} 2>&1 &`;
}

function tcpListenReadyCommand(port: number): string {
  return `python3 -c 'import socket,sys;s=socket.socket();s.settimeout(0.2);s.connect(("127.0.0.1",int(sys.argv[1])))' ${port} >/dev/null 2>&1`;
}

/** View-only noVNC for the vendor primary display when the SDK stream URL is missing. */
export function ensurePrimaryViewCommand(layout: ExtraDisplayLayout, viewPassword: string): string {
  if (!layout.isPrimary) {
    throw new Error("ensurePrimaryViewCommand only applies to the primary display");
  }
  const log = "/tmp/rakazo/screen-primary";
  const passwordFile = "/tmp/rakazo/view-password-primary";
  const passwordAuthFile = "/tmp/rakazo-view-primary.vncpass";
  const viewPort = PRIMARY_WATCH_VIEW_PORT;
  const viewVncPort = PRIMARY_WATCH_VNC_PORT;
  return [
    "set -u",
    "mkdir -p /tmp/rakazo /tmp/.X11-unix",
    "exec 8>/tmp/rakazo/screen-primary.lock",
    `if ! flock -w 20 8; then if [ -s ${shellQuote(passwordFile)} ] && ${tcpListenReadyCommand(viewVncPort)} && ${tcpListenReadyCommand(viewPort)}; then printf 'RAKAZO_SCREEN_PASSWORD=%s\\n' "$(cat ${shellQuote(passwordFile)})"; exit 0; fi; printf 'RAKAZO_SCREEN_ERROR=lock\\n' >&2; exit 1; fi`,
    "set -eu",
    `if [ -s ${shellQuote(passwordFile)} ]; then view_password=$(cat ${shellQuote(passwordFile)}); else umask 077; view_password=${shellQuote(viewPassword)}; printf %s "$view_password" >${shellQuote(passwordFile)}; fi`,
    `if xdpyinfo -display ${layout.display} >/dev/null 2>&1 && ${tcpListenReadyCommand(viewVncPort)} && ${tcpListenReadyCommand(viewPort)}; then printf 'RAKAZO_SCREEN_PASSWORD=%s\\n' "$view_password"; exit 0; fi`,
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 || { printf 'RAKAZO_SCREEN_ERROR=no_display\\n' >&2; exit 1; }`,
    `command -v x11vnc >/dev/null 2>&1 || { printf 'RAKAZO_SCREEN_ERROR=no_x11vnc\\n' >&2; exit 1; }`,
    `pkill -f '^x11vnc .* -rfbport ${viewVncPort}' || true`,
    `fuser -k ${viewPort}/tcp >/dev/null 2>&1 || true`,
    `x11vnc -storepasswd "$view_password" ${shellQuote(passwordAuthFile)} >/dev/null`,
    detachServer(
      `x11vnc -display ${layout.display} -forever -shared -viewonly -rfbauth ${shellQuote(passwordAuthFile)} -listen 127.0.0.1 -rfbport ${viewVncPort} -xkb -ncache 0`,
      `${log}-x11vnc.log`,
    ),
    `if command -v websockify >/dev/null 2>&1; then`,
    detachServer(
      `websockify --web=/usr/share/novnc 0.0.0.0:${viewPort} 127.0.0.1:${viewVncPort}`,
      `${log}-novnc.log`,
    ),
    `elif [ -d /opt/noVNC/utils ]; then`,
    detachServer(
      `cd /opt/noVNC/utils && exec ./novnc_proxy --vnc localhost:${viewVncPort} --listen ${viewPort} --web /opt/noVNC`,
      `${log}-novnc.log`,
    ),
    `else`,
    `  printf 'RAKAZO_SCREEN_ERROR=no_novnc\\n' >&2; exit 1`,
    `fi`,
    `for i in $(seq 1 50); do if ${tcpListenReadyCommand(viewVncPort)} && ${tcpListenReadyCommand(viewPort)}; then printf 'RAKAZO_SCREEN_PASSWORD=%s\\n' "$view_password"; exit 0; fi; sleep 0.1; done`,
    `printf 'RAKAZO_SCREEN_ERROR=ports_not_ready\\n' >&2`,
    `tail -n 20 ${log}-x11vnc.log ${log}-novnc.log >&2 || true`,
    "exit 1",
  ].join("\n");
}

export function ensureExtraDisplayCommand(
  layout: ExtraDisplayLayout,
  env: ExtraDisplayEnvironment,
  viewPassword: string,
): string {
  if (layout.isPrimary) {
    throw new Error("ensureExtraDisplayCommand does not apply to the primary display");
  }
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  const profile = `${env.browserProfilesDir}/chromium-screen-${layout.displayNumber}`;
  const sharedProfile = `${env.browserProfilesDir}/chromium`;
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  const passwordFile = `/tmp/rakazo/view-password-${layout.displayNumber}`;
  const passwordAuthFile = `/tmp/rakazo-view-${layout.displayNumber}.vncpass`;
  return [
    "set -eu",
    `mkdir -p /tmp/rakazo ${fluxHome}/.fluxbox /tmp/.X11-unix ${profile}`,
    `exec 8>${shellQuote(`/tmp/rakazo/screen-${layout.displayNumber}.lock`)}`,
    "flock -w 5 8",
    `if [ -s ${shellQuote(passwordFile)} ]; then view_password=$(cat ${shellQuote(passwordFile)}); else umask 077; view_password=${shellQuote(viewPassword)}; printf %s "$view_password" >${shellQuote(passwordFile)}; fi`,
    `if xdpyinfo -display ${layout.display} >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/${layout.viewVncPort}) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1; then printf 'RAKAZO_SCREEN_PASSWORD=%s\n' "$view_password"; exit 0; fi`,
    `if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then`,
    `  rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber} ${tokenFile}`,
    `  Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >${log}-xvfb.log 2>&1 &`,
    `  for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
    `  xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
    `  if command -v fluxbox >/dev/null 2>&1; then HOME=${fluxHome} DISPLAY=${layout.display} fluxbox >${log}-fluxbox.log 2>&1 & fi`,
    `  if [ -d ${shellQuote(sharedProfile)} ]; then cp -a ${shellQuote(sharedProfile)}/. ${shellQuote(profile)}/; rm -f ${profile}/SingletonLock ${profile}/SingletonCookie ${profile}/SingletonSocket; fi`,
    `  for browser in google-chrome google-chrome-stable chromium chromium-browser firefox; do`,
    `    if command -v "$browser" >/dev/null 2>&1; then`,
    `      DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)} "$browser" --user-data-dir=${shellQuote(profile)} >${log}-browser.log 2>&1 &`,
    `      break`,
    `    fi`,
    `  done`,
    `fi`,
    `pkill -f '^x11vnc .* -rfbport ${layout.viewVncPort}' || true`,
    `pkill -f '^/usr/bin/python3 .*websockify.*${layout.viewPort}' || true`,
    `pkill -f '[n]ovnc_proxy.*--listen ${layout.viewPort}' || true`,
    `x11vnc -storepasswd "$view_password" ${shellQuote(passwordAuthFile)} >/dev/null`,
    detachServer(
      `x11vnc -display ${layout.display} -forever -shared -viewonly -rfbauth ${shellQuote(passwordAuthFile)} -listen 127.0.0.1 -rfbport ${layout.viewVncPort} -xkb -ncache 0`,
      `${log}-x11vnc.log`,
    ),
    `if command -v websockify >/dev/null 2>&1; then`,
    detachServer(
      `websockify --web=/usr/share/novnc 0.0.0.0:${layout.viewPort} 127.0.0.1:${layout.viewVncPort}`,
      `${log}-novnc.log`,
    ),
    `elif [ -d /opt/noVNC/utils ]; then`,
    detachServer(
      `cd /opt/noVNC/utils && exec ./novnc_proxy --vnc localhost:${layout.viewVncPort} --listen ${layout.viewPort} --web /opt/noVNC`,
      `${log}-novnc.log`,
    ),
    `else`,
    `  exit 1`,
    `fi`,
    `for i in $(seq 1 50); do if (echo >/dev/tcp/127.0.0.1/${layout.viewVncPort}) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1; then printf 'RAKAZO_SCREEN_PASSWORD=%s\n' "$view_password"; exit 0; fi; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

export function parseExtraDisplayViewPassword(output: string): string {
  const password = output.match(/RAKAZO_SCREEN_PASSWORD=([A-Za-z0-9_-]+)/)?.[1];
  if (!password) throw new ComputerScreenUnavailableError();
  return password;
}

export function extraDisplayControlStartCommand(
  layout: ExtraDisplayLayout,
  controlToken: string,
  password: string,
): string {
  const passwordFile = `/tmp/rakazo-control-${layout.displayNumber}.vncpass`;
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  return [
    "set -eu",
    extraDisplayControlStopCommand(layout, controlToken),
    `mkdir -p /tmp/rakazo`,
    `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
    `x11vnc -storepasswd ${shellQuote(password)} ${passwordFile} >/dev/null`,
    `x11vnc -bg -display ${shellQuote(layout.display)} -forever -wait 50 -shared -rfbport ${layout.controlVncPort} -rfbauth ${passwordFile} 2>${log}-control-x11vnc.log`,
    "if command -v websockify >/dev/null 2>&1; then",
    detachServer(
      `websockify --web=/usr/share/novnc 0.0.0.0:${layout.controlPort} 127.0.0.1:${layout.controlVncPort}`,
      `${log}-control-novnc.log`,
    ),
    "elif [ -d /opt/noVNC/utils ]; then",
    detachServer(
      `cd /opt/noVNC/utils && exec ./novnc_proxy --vnc localhost:${layout.controlVncPort} --listen ${layout.controlPort} --web /opt/noVNC`,
      `${log}-control-novnc.log`,
    ),
    "else",
    "  exit 1",
    "fi",
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.controlPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

export function extraDisplayControlStopCommand(
  layout: ExtraDisplayLayout,
  controlToken?: string,
): string {
  const stop = [
    `pkill -f '^x11vnc .* -rfbport ${layout.controlVncPort}' || true`,
    `pkill -f '^/usr/bin/python3 .*websockify.*${layout.controlPort}' || true`,
    `pkill -f '[n]ovnc_proxy.*--listen ${layout.controlPort}' || true`,
    `rm -f /tmp/rakazo-control-${layout.displayNumber}.vncpass`,
    `rm -f /tmp/rakazo/control-token-${layout.displayNumber}`,
  ].join("; ");
  if (!controlToken) return stop;
  return `[ -f /tmp/rakazo/control-token-${layout.displayNumber} ] && [ "$(cat /tmp/rakazo/control-token-${layout.displayNumber})" != ${shellQuote(controlToken)} ] || { ${stop}; }`;
}

export function observeExtraDisplayCommand(layout: ExtraDisplayLayout): string {
  const imagePath = `/tmp/rakazo/observe-${layout.displayNumber}.png`;
  return [
    `DISPLAY=${layout.display} xdotool getmouselocation --shell 2>/tmp/rakazo/cursor-${layout.displayNumber}.txt || true`,
    `DISPLAY=${layout.display} scrot -o ${imagePath} 2>/dev/null || DISPLAY=${layout.display} import -window root ${imagePath}`,
    `test -s ${imagePath}`,
    `base64 -w0 ${imagePath} 2>/dev/null || base64 ${imagePath}`,
    `printf '\\nCURSOR '`,
    `tr '\\n' ' ' </tmp/rakazo/cursor-${layout.displayNumber}.txt 2>/dev/null || true`,
  ].join("; ");
}

export function parseExtraDisplayObservation(output: string): {
  image: Uint8Array;
  cursor?: { x: number; y: number };
} {
  const cursorLine = output.match(/X=(\d+).*Y=(\d+)/);
  const base64Line =
    output
      .split(/\nCURSOR /)[0]
      ?.trim()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const image = Uint8Array.from(Buffer.from(base64Line, "base64"));
  if (!image.byteLength) throw new Error("extra display observation did not capture an image");
  return {
    image,
    ...(cursorLine ? { cursor: { x: Number(cursorLine[1]), y: Number(cursorLine[2]) } } : {}),
  };
}

export function extraDisplayActionCommand(
  layout: ExtraDisplayLayout,
  action: ComputerAction,
): string {
  if (action.kind === "wait") {
    return `sleep ${clampRounded(action.ms, 0, 5_000) / 1000}`;
  }
  if (action.kind === "scroll") {
    const repeat = clampRounded(action.amount ?? 3, 1, 20);
    const button = action.direction === "up" ? "4" : "5";
    return `DISPLAY=${layout.display} xdotool click --repeat ${repeat} ${button}`;
  }
  if (action.kind === "key") {
    const keys = [...(action.modifiers ?? []), action.key].join("+");
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(keys)}`;
  }
  if (action.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(action.text)}`;
  }
  if (action.kind === "pointer") {
    const button = action.button === "right" ? "3" : "1";
    if (action.type === "move") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y}`;
    }
    if (action.type === "down") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mousedown ${button}`;
    }
    if (action.type === "up") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mouseup ${button}`;
    }
    return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} click ${button}`;
  }
  if (action.kind === "open") {
    return openPathDesktopCommand(layout.display, action.path);
  }
  const launch = `DISPLAY=${layout.display} ${shellQuote(action.application)}${action.uri ? ` ${shellQuote(action.uri)}` : ""}`;
  if (
    looksLikeDesktopBrowserApp(action.application) ||
    (action.uri !== undefined && isHttpUrl(action.uri))
  ) {
    return `${launch}\n${exposeBrowserDesktopCommand(layout.display)}`;
  }
  return launch;
}

export function extraDisplayInputCommand(layout: ExtraDisplayLayout, input: ComputerInput): string {
  if (input.kind === "key") {
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(input.key)}`;
  }
  if (input.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(input.text)}`;
  }
  const button = input.button === "right" ? "3" : "1";
  if (input.type === "move") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y}`;
  }
  if (input.type === "down") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mousedown ${button}`;
  }
  if (input.type === "up") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mouseup ${button}`;
  }
  return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} click ${button}`;
}

export function primaryStreamCleanupCommand(primaryViewPort = 6080): string {
  return [
    "pkill -f '^x11vnc .* -R viewonly' || true",
    `pkill -f '[n]ovnc_proxy.*${primaryViewPort}' || true`,
    `pkill -f '[w]ebsockify.*${primaryViewPort}' || true`,
  ].join("; ");
}

export function screenControlKey(sandboxId: string, screenKey: string): string {
  return `${sandboxId}:${screenKey}`;
}
