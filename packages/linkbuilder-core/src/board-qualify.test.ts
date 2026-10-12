import { describe, expect, it } from "vitest";
import { type BoardCandidate, qualifyBoard, rankQualifiedBoards } from "./board-qualify.js";

function openBoard(overrides: Partial<BoardCandidate> = {}): BoardCandidate {
  return {
    language: "de",
    country: "DE",
    activeThreads: true,
    loggedOutCanRead: true,
    registration: "open",
    allowsSoftDeepLink: true,
    alreadyOwned: false,
    liveLinks: 0,
    kind: "qa",
    ...overrides,
  };
}

describe("board qualification", () => {
  it("accepts a public German board with open registration and no live link", () => {
    expect(qualifyBoard(openBoard())).toEqual({ ok: true, priority: 0, kind: "qa" });
    expect(
      qualifyBoard(openBoard({ language: "de-AT", country: "AT", kind: "niche" })),
    ).toMatchObject({ ok: true, kind: "niche" });
  });

  it("rejects closed, hidden, owned, and already-linked hosts", () => {
    expect(qualifyBoard(openBoard({ language: "en", country: "US" })).ok).toBe(false);
    expect(qualifyBoard(openBoard({ language: "en", germanLaneEmpty: true })).ok).toBe(true);
    expect(qualifyBoard(openBoard({ activeThreads: false }))).toMatchObject({
      reason: "no_active_threads",
    });
    expect(qualifyBoard(openBoard({ loggedOutCanRead: false }))).toMatchObject({
      reason: "logged_out_hidden",
    });
    expect(qualifyBoard(openBoard({ registration: "closed" }))).toMatchObject({
      reason: "registration_closed",
    });
    expect(qualifyBoard(openBoard({ registration: "membership" }))).toMatchObject({
      reason: "registration_closed",
    });
    expect(qualifyBoard(openBoard({ registration: "parked" }))).toMatchObject({
      reason: "registration_closed",
    });
    expect(qualifyBoard(openBoard({ registration: "hijacked" }))).toMatchObject({
      reason: "registration_closed",
    });
    expect(qualifyBoard(openBoard({ allowsSoftDeepLink: false }))).toMatchObject({
      reason: "links_forbidden",
    });
    expect(qualifyBoard(openBoard({ alreadyOwned: true }))).toMatchObject({
      reason: "already_owned",
    });
    expect(qualifyBoard(openBoard({ permanentCaptchaStop: true }))).toMatchObject({
      reason: "captcha_stop",
    });
    expect(qualifyBoard(openBoard({ overlapLock: true }))).toMatchObject({
      reason: "overlap_lock",
    });
    expect(qualifyBoard(openBoard({ liveLinks: 1 }))).toMatchObject({
      reason: "live_link_exists",
    });
  });

  it("ranks public Q&A ahead of heavy-mod boards and drops the rejects", () => {
    const ranked = rankQualifiedBoards([
      openBoard({ kind: "heavy_mod", language: "de-CH", country: "CH" }),
      openBoard({ kind: "qa" }),
      openBoard({ liveLinks: 1, kind: "qa" }),
      openBoard({ kind: "long_tail" }),
    ]);
    expect(ranked.map((board) => board.kind)).toEqual(["qa", "long_tail", "heavy_mod"]);
  });
});
