import { describe, expect, it } from "vitest";
import {
  operatorHelpFor,
  PAGE_GIVE_UP_AFTER,
  shouldSkipDesktopPage,
  skippedHostLine,
  stepCountsTowardPageGiveUp,
} from "./operator-ticket.js";

describe("operator tickets", () => {
  it("does not ask for help on a view-only captcha or an unknown page", () => {
    for (const reason of ["captcha_unsolved", "unknown_page_state", "unmapped_form"]) {
      expect(
        operatorHelpFor({
          id: "ticket-1",
          status: "open",
          reason,
          domain: "board.example",
          hostStatus: "parked_operator",
        }),
      ).toBeNull();
    }
  });

  it("skips an unsolvable captcha immediately and a repeated page after three tries", () => {
    expect(shouldSkipDesktopPage({ reason: "captcha_unsolved", failures: 0 })).toBe(true);
    expect(shouldSkipDesktopPage({ reason: "unknown_page_state", failures: 0 })).toBe(false);
    expect(shouldSkipDesktopPage({ reason: "unknown_page_state", failures: 1 })).toBe(false);
    expect(
      shouldSkipDesktopPage({ reason: "unmapped_form", failures: PAGE_GIVE_UP_AFTER - 1 }),
    ).toBe(true);
  });

  it("names the site on an ordinary skip", () => {
    expect(skippedHostLine("winfuture-forum.de")).toBe("Skipped winfuture-forum.de");
    expect(stepCountsTowardPageGiveUp({ lastAction: "The page did not finish, trying again" })).toBe(
      true,
    );
    expect(stepCountsTowardPageGiveUp({ lastAction: "Registered" })).toBe(false);
  });
});
