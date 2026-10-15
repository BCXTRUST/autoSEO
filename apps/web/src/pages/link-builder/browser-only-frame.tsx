import { useEffect, useRef, useState } from "react";
import {
  browserCrop,
  browserOnlyCss,
  connectionStatusText,
  LIVE_PANE_BG,
  livePaneStatus,
  type CropRect,
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
  const [showingBrowser, setShowingBrowser] = useState(false);

  useEffect(() => {
    statusRef.current = null;
    setShowingBrowser(false);
    onStatus(null);
    let stopped = false;
    let timer = 0;
    const publish = (status: string | null, browser: boolean) => {
      if (stopped) return;
      setShowingBrowser(browser);
      if (statusRef.current === status) return;
      statusRef.current = status;
      onStatus(status);
    };
    const read = () => {
      if (stopped) return;
      const iframe = frameRef.current;
      try {
        const doc = iframe?.contentDocument ?? null;
        if (!doc) {
          publish("Reconnecting", false);
        } else {
          const stated = livePaneStatus(
            connectionStatusText(
              doc.querySelector("#noVNC_status")?.textContent ?? "",
              doc.body?.innerText ?? "",
            ),
          );
          if (stated) {
            writeStyle(doc, null);
            publish(stated, false);
          } else {
            const canvas = largestCanvas(doc);
            const sample = canvas ? sampleCanvas(canvas) : null;
            const crop = sample
              ? browserCrop(sample.pixels, sample.width, sample.height)
              : { kind: "desktop" as const };
            if (!sample || crop.kind === "desktop") {
              writeStyle(doc, null);
              publish("Opening the browser", false);
            } else {
              writeStyle(doc, {
                rect: crop.rect,
                frameWidth: sample.width,
                frameHeight: sample.height,
              });
              publish(null, true);
            }
          }
        }
      } catch {
        publish("Reconnecting", false);
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
        data-desktop={showingBrowser ? "browser" : "hidden"}
        className="absolute inset-0 h-full w-full border-0"
        style={{
          background: LIVE_PANE_BG,
          pointerEvents: "none",
          visibility: showingBrowser ? "visible" : "hidden",
        }}
      />
      {showingBrowser ? null : (
        <div
          data-live-pane="dark"
          className="absolute inset-0"
          style={{ background: LIVE_PANE_BG }}
        />
      )}
    </div>
  );
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
