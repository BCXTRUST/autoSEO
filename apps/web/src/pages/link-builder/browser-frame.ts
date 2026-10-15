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

/**
 * The live pane may show a browser window. Wallpaper, icons, the taskbar,
 * and a dead or blank frame stay hidden.
 */
export function browserCrop(pixels: Uint8ClampedArray, width: number, height: number): BrowserCrop {
  if (width < 8 || height < 8 || pixels.length < width * height * 4) {
    return { kind: "desktop" };
  }
  const cols = Math.max(8, Math.min(40, Math.floor(width / 2)));
  const rows = Math.max(8, Math.min(25, Math.floor(height / 2)));
  const cellW = width / cols;
  const cellH = height / rows;
  const busy = new Array<boolean>(cols * rows);
  const lum = new Array<number>(cols * rows);
  let busyCount = 0;
  let lumSum = 0;
  let lumSq = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const samples = cellLuminance(pixels, width, height, col, row, cellW, cellH);
      let min = 255;
      let max = 0;
      let sum = 0;
      for (const value of samples) {
        min = Math.min(min, value);
        max = Math.max(max, value);
        sum += value;
      }
      const mean = sum / samples.length;
      const index = row * cols + col;
      lum[index] = mean;
      busy[index] = max - min > 26;
      lumSum += mean;
      lumSq += mean * mean;
      if (busy[index]) busyCount += 1;
    }
  }
  const cells = cols * rows;
  const mean = lumSum / cells;
  const stddev = Math.sqrt(Math.max(0, lumSq / cells - mean * mean));
  const busyFraction = busyCount / cells;
  // A dark wallpaper with a small logo is not a page. A real page fills the frame.
  if (mean < 28 && busyFraction < 0.22) return { kind: "blank" };
  const band = Math.max(1, Math.round(rows * 0.08));
  const topBar = uniformEdgeBar(lum, cols, rows, "top", band);
  const bottomBar = uniformEdgeBar(lum, cols, rows, "bottom", band);
  const inBar = (row: number) => (topBar && row < band) || (bottomBar && row >= rows - band);
  const beside = pageBesideBars(
    lum,
    busy,
    cols,
    rows,
    topBar,
    bottomBar,
    band,
    cellW,
    cellH,
    width,
    height,
  );
  if (stddev < 10 && busyFraction < 0.04) {
    if (beside) return beside;
    if (topBar || bottomBar) return { kind: "desktop" };
    if (mean < 22) return { kind: "blank" };
    if (mean >= 175) return { kind: "browser", rect: { x: 0, y: 0, width, height } };
    return { kind: "desktop" };
  }

  const windowBox = largestWindow(busy, cols, rows, inBar);
  if (windowBox && windowBox.area >= cells * 0.18) {
    const rect = boxToPixels(windowBox, cellW, cellH, width, height);
    if (rect.width >= 8 && rect.height >= 8) return { kind: "browser", rect };
  }
  if (beside) return beside;
  if (topBar || bottomBar) return { kind: "desktop" };
  if (busyFraction > 0.12 || (stddev > 14 && busyFraction > 0.05)) {
    return { kind: "browser", rect: { x: 0, y: 0, width, height } };
  }
  return { kind: "desktop" };
}

/** A taskbar with a page behind it is the browser, cropped so the bar stays off the pane. */
function pageBesideBars(
  lum: number[],
  busy: boolean[],
  cols: number,
  rows: number,
  topBar: boolean,
  bottomBar: boolean,
  band: number,
  _cellW: number,
  cellH: number,
  width: number,
  height: number,
): BrowserCrop | null {
  if (!topBar && !bottomBar) return null;
  const y0 = topBar ? band : 0;
  const y1 = bottomBar ? rows - band : rows;
  if (y1 - y0 < rows * 0.55) return null;
  let sum = 0;
  let count = 0;
  let busyMid = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      sum += lum[y * cols + x] ?? 0;
      count += 1;
      if (busy[y * cols + x]) busyMid += 1;
    }
  }
  if (!count) return null;
  const midMean = sum / count;
  const midBusy = busyMid / count;
  if (midMean < 175 && midBusy < 0.08) return null;
  const top = Math.max(0, Math.floor(y0 * cellH));
  const bottom = Math.min(height, Math.ceil(y1 * cellH));
  const rect = { x: 0, y: top, width, height: Math.max(0, bottom - top) };
  if (rect.height < 8) return null;
  return { kind: "browser", rect };
}

function cellLuminance(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  col: number,
  row: number,
  cellW: number,
  cellH: number,
): number[] {
  const values: number[] = [];
  for (const fx of [0.25, 0.75]) {
    for (const fy of [0.25, 0.75]) {
      const x = Math.min(width - 1, Math.floor((col + fx) * cellW));
      const y = Math.min(height - 1, Math.floor((row + fy) * cellH));
      const index = (y * width + x) * 4;
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      values.push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
    }
  }
  return values;
}

function uniformEdgeBar(
  lum: number[],
  cols: number,
  rows: number,
  edge: "top" | "bottom",
  band: number,
): boolean {
  const y0 = edge === "top" ? 0 : rows - band;
  const y1 = edge === "top" ? band - 1 : rows - 1;
  const mid0 = Math.floor(rows * 0.3);
  const mid1 = Math.min(rows - 1, Math.floor(rows * 0.7));
  let barSum = 0;
  let barSq = 0;
  let barCount = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const value = lum[y * cols + x] ?? 0;
      barSum += value;
      barSq += value * value;
      barCount += 1;
    }
  }
  if (!barCount) return false;
  const barMean = barSum / barCount;
  const barStd = Math.sqrt(Math.max(0, barSq / barCount - barMean * barMean));
  let midSum = 0;
  let midCount = 0;
  for (let y = mid0; y <= mid1; y += 1) {
    if (y >= y0 && y <= y1) continue;
    for (let x = 0; x < cols; x += 1) {
      midSum += lum[y * cols + x] ?? 0;
      midCount += 1;
    }
  }
  if (!midCount) return false;
  return barStd < 18 && Math.abs(barMean - midSum / midCount) >= 16;
}

interface CellBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

function largestWindow(
  busy: boolean[],
  cols: number,
  rows: number,
  inBar: (row: number) => boolean,
): CellBox | null {
  const dilated = new Array<boolean>(busy.length).fill(false);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const y = row + dy;
          const x = col + dx;
          if (y < 0 || x < 0 || y >= rows || x >= cols) continue;
          if (busy[y * cols + x]) {
            on = true;
            break;
          }
        }
      }
      dilated[row * cols + col] = on;
    }
  }
  const seen = new Array<boolean>(busy.length).fill(false);
  let best: CellBox | null = null;
  for (let start = 0; start < dilated.length; start += 1) {
    if (!dilated[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = true;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    let content = 0;
    while (stack.length) {
      const index = stack.pop() ?? 0;
      const row = Math.floor(index / cols);
      const col = index - row * cols;
      if (busy[index] && !inBar(row)) {
        content += 1;
        minX = Math.min(minX, col);
        minY = Math.min(minY, row);
        maxX = Math.max(maxX, col);
        maxY = Math.max(maxY, row);
      }
      for (const next of [index - 1, index + 1, index - cols, index + cols]) {
        if (next < 0 || next >= dilated.length || seen[next] || !dilated[next]) continue;
        const nextRow = Math.floor(next / cols);
        const nextCol = next - nextRow * cols;
        if (next === index - 1 && nextCol !== col - 1) continue;
        if (next === index + 1 && nextCol !== col + 1) continue;
        seen[next] = true;
        stack.push(next);
      }
    }
    if (content < 4 || maxX < minX || maxY < minY) continue;
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    if (!best || area > best.area) best = { minX, minY, maxX, maxY, area };
  }
  return best;
}

function boxToPixels(
  box: CellBox,
  cellW: number,
  cellH: number,
  width: number,
  height: number,
): CropRect {
  const x = Math.max(0, Math.floor(box.minX * cellW));
  const y = Math.max(0, Math.floor(box.minY * cellH));
  const right = Math.min(width, Math.ceil((box.maxX + 1) * cellW));
  const bottom = Math.min(height, Math.ceil((box.maxY + 1) * cellH));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
