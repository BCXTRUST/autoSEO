import { describe, expect, it } from "vitest";
import {
  decideStuckStep,
  isNewSignupBannedHost,
  localStuckChoice,
  parseStuckLook,
  stuckLookPrompt,
} from "./stuck-step.js";

describe("stuck step", () => {
  it("looks once, then pauses, and does not retry a dead sandbox", () => {
    expect(decideStuckStep([])).toBe("continue");
    expect(
      decideStuckStep([{ action: "Filled the registration form", error: null, looked: false }]),
    ).toBe("continue");
    expect(
      decideStuckStep([
        { action: "The page did not finish, trying again", error: null, looked: false },
      ]),
    ).toBe("look");
    expect(
      decideStuckStep([
        { action: "Step failed, retrying", error: null, looked: false },
        { action: "Looking at the page to find the form", error: null, looked: true },
      ]),
    ).toBe("pause");
    expect(
      decideStuckStep([
        { action: "Looking at the page to find the form", error: null, looked: true },
      ]),
    ).toBe("continue");
    expect(
      decideStuckStep([
        { action: "Step failed, retrying", error: "SandboxNotFoundError", looked: false },
      ]),
    ).toBe("yield");
  });

  it("blocks a new signup on the banned hosts and keeps every other host", () => {
    expect(isNewSignupBannedHost("frauenselbsthilfe.de")).toBe(true);
    expect(isNewSignupBannedHost("www.lifters-lounge.com")).toBe(true);
    expect(isNewSignupBannedHost("medizin-forum.de")).toBe(true);
    expect(isNewSignupBannedHost("psychic.de")).toBe(true);
    expect(isNewSignupBannedHost("ulrichradig.de")).toBe(true);
    expect(isNewSignupBannedHost("tauschring-koeln.de")).toBe(true);
    expect(isNewSignupBannedHost("forum.example")).toBe(false);
  });

  it("accepts only an action the page actually offered", () => {
    expect(parseStuckLook({ action: "find_form" }, 0)).toEqual({ action: "find_form" });
    expect(parseStuckLook({ action: "fill_fields" }, 0)).toEqual({ action: "fill_fields" });
    expect(parseStuckLook({ action: "other_thread", index: 1 }, 2)).toEqual({
      action: "other_thread",
      index: 1,
    });
    expect(parseStuckLook({ action: "other_thread", index: 3 }, 2)).toBeNull();
    expect(parseStuckLook({ action: "click_again" }, 1)).toBeNull();
    expect(localStuckChoice({ emptyFillable: 2, threadCount: 1 })).toEqual({
      action: "fill_fields",
    });
    expect(localStuckChoice({ emptyFillable: 0, threadCount: 1 })).toEqual({
      action: "other_thread",
      index: 0,
    });
    expect(
      stuckLookPrompt({ url: "https://forum.example/register", fields: ["email"], links: [] }),
    ).toContain("find the form");
  });
});
