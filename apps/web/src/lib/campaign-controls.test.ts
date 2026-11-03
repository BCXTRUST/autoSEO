import { describe, expect, it } from "vitest";
import { campaignStartBlocked } from "./campaign-controls";

describe("campaign start eligibility", () => {
  it("allows research campaigns to start without any manually added source", () => {
    expect(campaignStartBlocked({ mode: "research", status: "draft" }, [])).toBe(false);
  });

  it("requires a queued or researching user URL for controlled fixtures", () => {
    expect(campaignStartBlocked({ mode: "controlled", status: "draft" }, [])).toBe(true);
    expect(
      campaignStartBlocked({ mode: "controlled", status: "draft" }, [{ status: "queued" }]),
    ).toBe(false);
    expect(
      campaignStartBlocked({ mode: "controlled", status: "draft" }, [{ status: "failed" }]),
    ).toBe(true);
  });

  it("leaves resume availability unchanged for paused campaigns", () => {
    expect(campaignStartBlocked({ mode: "controlled", status: "paused" }, [])).toBe(false);
  });
});
