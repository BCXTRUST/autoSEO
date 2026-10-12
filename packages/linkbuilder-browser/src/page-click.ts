/**
 * Clicks a control inside the page. A submit button uses `requestSubmit` so the browser
 * includes that button's name in the POST. `element.click()` on a submit control can
 * reload the same form without the button, which is how phpBB keeps showing its terms.
 */
export function clickControl(selector: string): boolean {
  const doc = (globalThis as { document?: ClickDocument }).document;
  if (!doc) return false;
  let node: ClickNode | null = null;
  try {
    node = doc.querySelector(selector);
  } catch {
    return false;
  }
  if (!node || typeof node.click !== "function") return false;
  const tag = (node.tagName ?? "").toUpperCase();
  const type = (node.getAttribute?.("type") ?? (tag === "BUTTON" ? "submit" : "")).toLowerCase();
  const form = node.closest?.("form") ?? null;
  if (
    form &&
    typeof form.requestSubmit === "function" &&
    (type === "submit" || type === "image")
  ) {
    try {
      form.requestSubmit(node);
      return true;
    } catch {
      // The control is not a submitter of this form.
    }
  }
  node.click();
  return true;
}

interface ClickNode {
  tagName?: string;
  click?: () => void;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => ClickForm | null;
}

interface ClickForm {
  requestSubmit?: (submitter?: ClickNode) => void;
}

interface ClickDocument {
  querySelector(selector: string): ClickNode | null;
}
