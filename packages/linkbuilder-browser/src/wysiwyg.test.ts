import { afterEach, describe, expect, it } from "vitest";
import { writeWysiwygText, wysiwygHtml } from "./wysiwyg.js";

afterEach(() => {
  delete (globalThis as { document?: unknown; require?: unknown }).document;
  delete (globalThis as { require?: unknown }).require;
});

describe("writeWysiwygText", () => {
  it("leaves a plain field alone", async () => {
    (globalThis as { document?: unknown }).document = {
      querySelector: () => ({ tagName: "INPUT", className: "" }),
    };
    await expect(writeWysiwygText({ selector: "#username", text: "member" })).resolves.toBe(
      "plain",
    );
  });

  it("writes the reply into the WoltLab editor", async () => {
    let html = "";
    let focused = true;
    const textarea = { tagName: "TEXTAREA", className: "wysiwygTextarea" };
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => (selector === "#text" ? textarea : null),
    };
    (globalThis as { require?: unknown }).require = (
      _deps: string[],
      done: (mod: unknown) => void,
    ) => {
      done({
        getCkeditor: (node: unknown) => {
          if (node !== textarea) return undefined;
          return {
            setHtml(value: string, focus?: boolean) {
              html = value;
              focused = focus !== false;
            },
          };
        },
      });
    };
    await expect(
      writeWysiwygText({ selector: "#text", text: "Kurzer Hinweis.\n\nOhne Link." }),
    ).resolves.toBe("wrote");
    expect(html).toBe("<p>Kurzer Hinweis.</p><p>Ohne Link.</p>");
    expect(focused).toBe(false);
  });

  it("reports a missing editor instead of submitting an empty reply", async () => {
    (globalThis as { document?: unknown }).document = {
      querySelector: () => ({ tagName: "TEXTAREA", className: "wysiwygTextarea" }),
    };
    (globalThis as { require?: unknown }).require = (
      _deps: string[],
      done: (mod: unknown) => void,
    ) => {
      done({ getCkeditor: () => undefined });
    };
    await expect(writeWysiwygText({ selector: "#text", text: "Hinweis" })).resolves.toBe("missing");
  });
});

describe("wysiwygHtml", () => {
  it("escapes markup in the reply", () => {
    expect(wysiwygHtml("a < b & c")).toBe("<p>a &lt; b &amp; c</p>");
  });
});
