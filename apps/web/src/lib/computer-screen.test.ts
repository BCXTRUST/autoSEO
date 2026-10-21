import { describe, expect, it } from "vitest";
import { latestComputerScreenshotId, screenFrameSrc } from "./computer-screen.js";

describe("screenFrameSrc", () => {
  it("builds a data URL for a PNG frame", () => {
    expect(screenFrameSrc({ image: "abc", mimeType: "image/png" })).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("returns null when there is no image", () => {
    expect(screenFrameSrc({ image: null })).toBeNull();
    expect(screenFrameSrc({})).toBeNull();
  });
});

describe("latestComputerScreenshotId", () => {
  it("returns the newest computer-screen image from the thread", () => {
    expect(
      latestComputerScreenshotId([
        {
          blocks: [{ kind: "image", artifactId: "old", name: "computer-screen.png" }],
        },
        {
          blocks: [
            { kind: "text" },
            { kind: "image", artifactId: "newer", name: "computer-screen.png" },
          ],
        },
      ]),
    ).toBe("newer");
  });
});

describe("screenFrameSrc", () => {
  it("builds a data URL for a PNG frame", () => {
    expect(screenFrameSrc({ image: "abc", mimeType: "image/png" })).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("returns null when there is no image", () => {
    expect(screenFrameSrc({ image: null })).toBeNull();
    expect(screenFrameSrc({})).toBeNull();
  });
});
