import { afterEach, describe, expect, it } from "vitest";
import { clickControl, clickControlHeld, discourseActivateReady } from "./page-click.js";

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { jQuery?: unknown }).jQuery;
});

describe("clickControl", () => {
  it("submits the agreement button by name instead of a bare click", () => {
    const calls: string[] = [];
    const form = {
      requestSubmit(submitter: unknown) {
        calls.push(submitter === button ? "requestSubmit" : "other");
      },
    };
    const button = {
      tagName: "INPUT",
      getAttribute: (name: string) => (name === "type" ? "submit" : null),
      closest: (selector: string) => (selector === "form" ? form : null),
      click: () => calls.push("click"),
    };
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => (selector === "#agreed" ? button : null),
    };
    expect(clickControl("#agreed")).toBe(true);
    expect(calls).toEqual(["requestSubmit"]);
  });

  it("posts the Discourse activate form when the button sits outside it", () => {
    const calls: string[] = [];
    const form = { requestSubmit: () => calls.push("form") };
    const button = {
      tagName: "BUTTON",
      getAttribute: (name: string) => (name === "id" ? "activate-account-button" : null),
      closest: () => null,
      click: () => calls.push("click"),
    };
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector === "#activate-account-button") return button;
        if (selector === "#activate-account-form") return form;
        return null;
      },
    };
    expect(clickControl("#activate-account-button")).toBe(true);
    expect(calls).toEqual(["form"]);
  });

  it("clicks the Discourse button so its challenge script can submit", () => {
    const calls: string[] = [];
    const form = { requestSubmit: () => calls.push("form") };
    const button = {
      tagName: "BUTTON",
      getAttribute: (name: string) => (name === "id" ? "activate-account-button" : null),
      closest: () => null,
      click: () => calls.push("click"),
    };
    const meta = { id: "data-activate-account" };
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector === "#activate-account-button") return button;
        if (selector === "#activate-account-form") return form;
        if (selector === "#data-activate-account") return meta;
        return null;
      },
    };
    expect(clickControl("#activate-account-button")).toBe(true);
    expect(calls).toEqual(["click"]);
  });

  it("waits until the Discourse challenge script has bound the button", () => {
    const button = { id: "activate-account-button" };
    const meta = { id: "data-activate-account" };
    (globalThis as { document?: unknown; jQuery?: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector === "#data-activate-account") return meta;
        if (selector === "#activate-account-button") return button;
        return null;
      },
    };
    (globalThis as { jQuery?: unknown }).jQuery = {
      _data: () => ({ click: [] as unknown[] }),
    };
    expect(discourseActivateReady()).toBe(false);
    (globalThis as { jQuery?: { _data: () => { click: unknown[] } } }).jQuery = {
      _data: () => ({ click: [() => undefined] }),
    };
    expect(discourseActivateReady()).toBe(true);
    delete (globalThis as { jQuery?: unknown }).jQuery;
  });

  it("clicks a link that has no form", () => {
    const calls: string[] = [];
    const link = {
      tagName: "A",
      getAttribute: () => null,
      closest: () => null,
      click: () => calls.push("click"),
    };
    (globalThis as { document?: unknown }).document = {
      querySelector: () => link,
    };
    expect(clickControl("a.register")).toBe(true);
    expect(calls).toEqual(["click"]);
  });

  it("checks a consent box without the click that scrolls it into view", () => {
    const calls: string[] = [];
    const box = {
      tagName: "INPUT",
      checked: false,
      getAttribute: (name: string) => (name === "type" ? "checkbox" : null),
      closest: () => null,
      focus: () => calls.push("focus"),
      click: () => calls.push("click"),
      dispatchEvent: () => {
        calls.push("event");
        return true;
      },
    };
    (globalThis as { document?: unknown }).document = {
      querySelector: () => box,
    };
    expect(clickControlHeld("#agree")).toBe(true);
    expect(box.checked).toBe(true);
    expect(calls).toContain("focus");
    expect(calls).not.toContain("click");
  });
});
