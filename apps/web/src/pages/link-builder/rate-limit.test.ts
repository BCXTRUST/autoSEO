import { describe, expect, it } from "vitest";
import { isLinkBuilderRateLimit, linkBuilderPollBackoffMs } from "./rate-limit.js";

describe("link builder rate-limit errors", () => {
  it("recognizes the full-screen status text without treating other failures as limited", () => {
    expect(isLinkBuilderRateLimit(new Error("Too Many Requests"))).toBe(true);
    expect(isLinkBuilderRateLimit({ code: "TOO_MANY_REQUESTS", status: 429 })).toBe(true);
    expect(isLinkBuilderRateLimit(new Error("Could not load"))).toBe(false);
    expect(isLinkBuilderRateLimit(null)).toBe(false);
  });

  it("backs off a limited poll instead of retrying immediately", () => {
    expect(linkBuilderPollBackoffMs(0)).toBe(10_000);
    expect(linkBuilderPollBackoffMs(1)).toBe(20_000);
    expect(linkBuilderPollBackoffMs(8)).toBe(30_000);
  });
});
