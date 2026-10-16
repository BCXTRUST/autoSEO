import { useEffect, useRef } from "react";
import {
  browserOnlyCss,
  connectionStatusText,
  LIVE_PANE_BG,
  livePaneStatus,
} from "./browser-frame.js";

/**
 * The link-builder live pane. The noVNC bar stays hidden. A reconnecting
 * viewer reports "Reconnecting" on the strip.
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

  useEffect(() => {
    statusRef.current = null;
    onStatus(null);
    let stopped = false;
    let timer = 0;
    const publish = (status: string | null) => {
      if (stopped || statusRef.current === status) return;
      statusRef.current = status;
      onStatus(status);
    };
    const read = () => {
      if (stopped) return;
      const iframe = frameRef.current;
      try {
        const doc = iframe?.contentDocument ?? null;
        if (!doc) {
          publish("Reconnecting");
        } else {
          hideNovncChrome(doc);
          writeStyle(doc);
          publish(
            livePaneStatus(
              connectionStatusText(
                doc.querySelector("#noVNC_status")?.textContent ?? "",
                doc.body?.innerText ?? "",
              ),
            ),
          );
        }
      } catch {
        publish("Reconnecting");
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
        data-desktop="browser"
        className="absolute inset-0 h-full w-full border-0"
        style={{
          background: LIVE_PANE_BG,
          pointerEvents: "none",
        }}
      />
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

function writeStyle(doc: Document) {
  let node = doc.getElementById("rakazo-browser-only");
  if (!node) {
    node = doc.createElement("style");
    node.id = "rakazo-browser-only";
    (doc.head ?? doc.documentElement).appendChild(node);
  }
  node.textContent = browserOnlyCss(null);
}
