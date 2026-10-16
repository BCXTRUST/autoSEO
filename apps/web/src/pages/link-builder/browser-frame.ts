/** Dark pane shown instead of the E2B desktop. rgb(12, 12, 14). */
export const LIVE_PANE_BG = "#0c0c0e";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserCrop =
  | { kind: "browser"; rect: CropRect }
  | { kind: "desktop" }
  | { kind: "blank" };

/** What the live pane may show. The dark cover is only for a dead, reconnecting, or real desktop. */
export interface LivePaneView {
  cover: boolean;
  showingBrowser: boolean;
  status: string | null;
}

export function livePaneView(connection: string | null, crop: BrowserCrop | null): LivePaneView {
  if (connection) return { cover: true, showingBrowser: false, status: connection };
  if (crop?.kind === "browser") return { cover: false, showingBrowser: true, status: null };
  // Wallpaper and a black framebuffer stay covered. No status here: a search
  // in progress is not a chip, and the strip only speaks when the computer
  // is off or reconnecting.
  return { cover: true, showingBrowser: false, status: null };
}

/**
 * Short status for the dark strip. The long provider sentence never reaches the pane.
 * "Connected" is a live noVNC status and stays null.
 */
export function livePaneStatus(text: string): string | null {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/sandbox is probably not running anymore/i.test(value)) return "Computer is off";
  if (value.length > 180) return null;
  if (/\breconnecting\b/i.test(value) || /\bconnecting\b/i.test(value)) return "Reconnecting";
  if (/\bdisconnected\b/i.test(value)) return "Reconnecting";
  if (/failed to connect|connection closed|unable to connect/i.test(value)) return "Reconnecting";
  return null;
}

/** Prefer the noVNC status line. A dead sandbox page has the sentence in the body. */
export function connectionStatusText(statusText: string, bodyText: string): string {
  const body = bodyText.replace(/\s+/g, " ").trim();
  if (/sandbox is probably not running anymore/i.test(body)) return body.slice(0, 240);
  const status = statusText.replace(/\s+/g, " ").trim();
  if (status) return status.slice(0, 240);
  if (body.length <= 180) return body;
  return "";
}

export function canvasCropCss(
  rect: CropRect,
  frameWidth: number,
  frameHeight: number,
): { left: string; top: string; width: string; height: string } {
  return {
    left: `${((-100 * rect.x) / rect.width).toFixed(2)}%`,
    top: `${((-100 * rect.y) / rect.height).toFixed(2)}%`,
    width: `${((100 * frameWidth) / rect.width).toFixed(2)}%`,
    height: `${((100 * frameHeight) / rect.height).toFixed(2)}%`,
  };
}

/** Hide the noVNC bar, logo, and centered status. Crop the canvas to the browser when one is found. */
export function browserOnlyCss(
  crop: { rect: CropRect; frameWidth: number; frameHeight: number } | null,
): string {
  const placed = crop ? canvasCropCss(crop.rect, crop.frameWidth, crop.frameHeight) : null;
  const canvas = placed
    ? `#noVNC_screen canvas, canvas {
        position: absolute !important;
        left: ${placed.left} !important;
        top: ${placed.top} !important;
        width: ${placed.width} !important;
        height: ${placed.height} !important;
        max-width: none !important;
        max-height: none !important;
      }`
    : "";
  return `html, body, #noVNC_container, #noVNC_screen, #screen {
      background: ${LIVE_PANE_BG} !important;
      overflow: hidden !important;
    }
    #noVNC_control_bar,
    #noVNC_control_bar_anchor,
    #noVNC_status_bar,
    #noVNC_transition,
    .noVNC_logo,
    #noVNC_logo,
    #noVNC_connect_dlg,
    #noVNC_password_dlg,
    #noVNC_popup_status_panel,
    #noVNC_bell,
    #noVNC_status,
    .noVNC_status {
      display: none !important;
      visibility: hidden !important;
    }
    ${canvas}`;
}
