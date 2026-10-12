import { afterEach, describe, expect, it } from "vitest";
import { clickControl } from "./page-click.js";

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
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
});
