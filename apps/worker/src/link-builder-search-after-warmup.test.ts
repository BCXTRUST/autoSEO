import { describe, expect, it } from "vitest";
import { browserSearchFollowsWarmup } from "./link-builder-discovery.js";

describe("browser search after warmup", () => {
  it("waits for the confirmation and one posted reply on each warming host", () => {
    expect(
      browserSearchFollowsWarmup({
        confirmed: true,
        warmingHostIds: ["diabetes", "med2"],
        postedHostIds: ["diabetes"],
      }),
    ).toBe(false);
    expect(
      browserSearchFollowsWarmup({
        confirmed: false,
        warmingHostIds: ["diabetes", "med2"],
        postedHostIds: ["diabetes", "med2"],
      }),
    ).toBe(false);
    expect(
      browserSearchFollowsWarmup({
        confirmed: true,
        warmingHostIds: ["diabetes", "med2"],
        postedHostIds: ["med2", "diabetes"],
      }),
    ).toBe(true);
  });
});
