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
  // This function is serialized into the page: all runtime helpers must be local.
  if (node.getAttribute?.("id") === "activate-account-button") {
    if (doc.querySelector("#data-activate-account")) {
      node.click();
      return true;
    }
    const activationForm = doc.querySelector("#activate-account-form");
    if (activationForm && typeof activationForm.requestSubmit === "function") {
      activationForm.requestSubmit();
      return true;
    }
  }
  const tag = (node.tagName ?? "").toUpperCase();
  const type = (node.getAttribute?.("type") ?? (tag === "BUTTON" ? "submit" : "")).toLowerCase();
  const form = node.closest?.("form") ?? null;
  if (form && typeof form.requestSubmit === "function" && (type === "submit" || type === "image")) {
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

/**
 * Clicks without scrolling the field into view. Used while a signup step is open.
 * A real `element.click()` scrolls the target; this path does not.
 */
export function clickControlHeld(selector: string): boolean {
  const doc = (globalThis as { document?: ClickDocument }).document;
  if (!doc) return false;
  let node: ClickNode | null = null;
  try {
    node = doc.querySelector(selector);
  } catch {
    return false;
  }
  if (!node) return false;
  // Keep activation behavior self-contained for Playwright's page.evaluate.
  if (node.getAttribute?.("id") === "activate-account-button") {
    if (doc.querySelector("#data-activate-account")) {
      node.click?.();
      return true;
    }
    const activationForm = doc.querySelector("#activate-account-form");
    if (activationForm && typeof activationForm.requestSubmit === "function") {
      activationForm.requestSubmit();
      return true;
    }
  }
  const tag = (node.tagName ?? "").toUpperCase();
  const type = (node.getAttribute?.("type") ?? (tag === "BUTTON" ? "submit" : "")).toLowerCase();
  const form = node.closest?.("form") ?? null;
  node.focus?.({ preventScroll: true });
  if (form && typeof form.requestSubmit === "function" && (type === "submit" || type === "image")) {
    try {
      form.requestSubmit(node);
      return true;
    } catch {
      // The control is not a submitter of this form.
    }
  }
  const events = globalThis as {
    Event?: new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => object;
  };
  const fire = (name: string) => {
    if (!events.Event || !node?.dispatchEvent) return;
    node.dispatchEvent(new events.Event(name, { bubbles: true, cancelable: true }));
  };
  if (type === "checkbox" || type === "radio") {
    if (node.checked !== true) {
      node.checked = true;
      fire("input");
      fire("change");
    }
    return true;
  }
  fire("click");
  return true;
}

/**
 * `null` when this page has no Discourse challenge. `false` until that page's script
 * has bound the activate button. `true` once a click will run the challenge request.
 */
export function discourseActivateReady(): boolean | null {
  const doc = (globalThis as { document?: ClickDocument }).document;
  if (!doc?.querySelector("#data-activate-account")) return null;
  const button = doc.querySelector("#activate-account-button");
  if (!button) return false;
  const jq = (
    globalThis as {
      jQuery?: { _data?: (node: ClickNode, key: string) => { click?: unknown[] } | undefined };
    }
  ).jQuery;
  if (!jq || typeof jq._data !== "function") return false;
  try {
    const events = jq._data(button, "events");
    return Boolean(events?.click && events.click.length > 0);
  } catch {
    return false;
  }
}

interface ClickNode {
  tagName?: string;
  click?: () => void;
  checked?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => ClickForm | null;
  focus?: (options?: { preventScroll?: boolean }) => void;
  dispatchEvent?: (event: object) => boolean;
  requestSubmit?: () => void;
}

interface ClickForm {
  requestSubmit?: (submitter?: ClickNode) => void;
}

interface ClickDocument {
  querySelector(selector: string): ClickNode | null;
}
