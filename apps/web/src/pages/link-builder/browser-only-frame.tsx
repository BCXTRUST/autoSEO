import { useEffect, useRef, useState } from "react";
import {
  browserCrop,
  browserOnlyCss,
  type CropRect,
  connectionStatusText,
  LIVE_PANE_BG,
  type LivePaneView,
  livePaneStatus,
  livePaneView,
} from "./browser-frame.js";

/**
 * The link-builder live pane. Chrome may show through. The desktop, its
 * taskbar, and a dead or reconnecting sandbox stay behind a dark cover.
 */
export function BrowserOnlyFrame({
  url,
  title,
  sandbox,
  onStatus,
}: {
  url: string;
  title: string;
  sandbox?: string;
  onStatus: (status: string | null) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const statusRef = useRef<string | null>(null);
  const [view, setView] = useState<LivePaneView>({
    cover: true,
    showingBrowser: false,
    status: null,
  });

  useEffect(() => {
    statusRef.current = null;
    setView({ cover: true, showingBrowser: false, status: null });
    onStatus(null);
    let stopped = false;
    let timer = 0;
    const publish = (next: LivePaneView) => {
      if (stopped) return;
      setView(next);
      if (statusRef.current === next.status) return;
      statusRef.current = next.status;
      onStatus(next.status);
    };
    const read = () => {
      if (stopped) return;
      const iframe = frameRef.current;
      try {
        const doc = iframe?.contentDocument ?? null;
        if (!doc) {
          publish(livePaneView("Reconnecting", null));
        } else {
          hideNovncChrome(doc);
          const stated = livePaneStatus(
            connectionStatusText(
              doc.querySelector("#noVNC_status")?.textContent ?? "",
              doc.body?.innerText ?? "",
            ),
          );
          if (stated) {
            writeStyle(doc, null);
            publish(livePaneView(stated, null));
          } else {
            let crop: ReturnType<typeof browserCrop> | null = null;
            let sample: { width: number; height: number } | null = null;
            try {
              const canvas = largestCanvas(doc);
              const readSample = canvas ? sampleCanvas(canvas) : null;
              sample = readSample;
              crop = readSample
                ? browserCrop(readSample.pixels, readSample.width, readSample.height)
                : null;
            } catch {
              crop = { kind: "blank" };
            }
            const next = livePaneView(null, crop);
            if (crop?.kind === "browser" && sample) {
              writeStyle(doc, {
                rect: crop.rect,
                frameWidth: sample.width,
                frameHeight: sample.height,
              });
            } else {
              writeStyle(doc, null);
            }
            publish(next);
          }
        }
      } catch {
        publish(livePaneView("Reconnecting", null));
      }
      timer = window.setTimeout(read, 800);
    };
    timer = window.setTimeout(read, 200);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [onStatus, url]);

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: LIVE_PANE_BG }}>
      <iframe
        ref={frameRef}
        key={url}
        title={title}
        src={url}
        sandbox={sandbox}
        allow="fullscreen"
        data-desktop={view.showingBrowser ? "browser" : "hidden"}
        className="absolute inset-0 h-full w-full border-0"
        style={{
          background: LIVE_PANE_BG,
          pointerEvents: "none",
        }}
      />
      {view.cover ? (
        <div
          data-live-pane="dark"
          className="absolute inset-0"
          style={{ background: LIVE_PANE_BG }}
        />
      ) : null}
    </div>
  );
}

function hideNovncChrome(doc: Document) {
  for (const id of [
    "noVNC_status",
    "noVNC_status_bar",
    "noVNC_transition",
    "noVNC_control_bar",
    "noVNC_control_bar_anchor",
    "noVNC_popup_status_panel",
  ]) {
    const node = doc.getElementById(id);
    if (!(node instanceof HTMLElement)) continue;
    node.style.setProperty("display", "none", "important");
    if (id === "noVNC_status" || id === "noVNC_transition") node.textContent = "";
  }
}

function writeStyle(
  doc: Document,
  crop: { rect: CropRect; frameWidth: number; frameHeight: number } | null,
) {
  let node = doc.getElementById("rakazo-browser-only");
  if (!node) {
    node = doc.createElement("style");
    node.id = "rakazo-browser-only";
    (doc.head ?? doc.documentElement).appendChild(node);
  }
  node.textContent = browserOnlyCss(crop);
}

function largestCanvas(doc: Document): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let area = 0;
  for (const canvas of doc.querySelectorAll("canvas")) {
    const size = canvas.width * canvas.height;
    if (size > area) {
      best = canvas;
      area = size;
    }
  }
  return best;
}

function sampleCanvas(
  canvas: HTMLCanvasElement,
): { pixels: Uint8ClampedArray; width: number; height: number } | null {
  const width = 80;
  const height = 50;
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(canvas, 0, 0, width, height);
  return { pixels: context.getImageData(0, 0, width, height).data, width, height };
}
