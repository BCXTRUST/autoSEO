import { describe, expect, it } from "vitest";
import {
  CHECKOUT_NOT_CONNECTED_REASON,
  CREDIT_PACKAGES,
  creditBalanceFromLedger,
  formatPackagePrice,
  mayCreateLinkBuilderProject,
  persistedPurchase,
  quoteCreditPurchase,
  settledCreditTotal,
} from "./billing.js";

describe("new project gate", () => {
  it("stays closed without a settled charge or an explicit allowance", () => {
    expect(mayCreateLinkBuilderProject([])).toBe(false);
    expect(mayCreateLinkBuilderProject([{ billing: "stub", chargeId: null }])).toBe(false);
    expect(mayCreateLinkBuilderProject([{ billing: "live", chargeId: null }])).toBe(false);
    expect(mayCreateLinkBuilderProject([{ billing: "live", chargeId: "  " }])).toBe(false);
  });

  it("opens for a live charge id or an allowance row", () => {
    expect(mayCreateLinkBuilderProject([{ billing: "live", chargeId: "ch_123" }])).toBe(true);
    expect(mayCreateLinkBuilderProject([{ billing: "allowance", chargeId: null }])).toBe(true);
  });

  it("does not treat the included balance as a purchase", () => {
    expect(creditBalanceFromLedger(0, [])).toBe(80);
    expect(mayCreateLinkBuilderProject([])).toBe(false);
  });
});

describe("credit checkout", () => {
  it("lists packages with a price and the credits they add", () => {
    expect(CREDIT_PACKAGES.map((pack) => pack.id)).toEqual(["starter", "growth", "scale"]);
    for (const pack of CREDIT_PACKAGES) {
      expect(pack.credits).toBeGreaterThan(0);
      expect(pack.priceCents).toBeGreaterThan(0);
      expect(formatPackagePrice(pack.priceCents, pack.currency)).toMatch(/^€\d/);
    }
    expect(CREDIT_PACKAGES.filter((pack) => pack.recommended)).toHaveLength(1);
  });

  it("does not charge, store, or add credits when checkout is disconnected", () => {
    const quote = quoteCreditPurchase({
      billing: "stub",
      chargeId: null,
      packageId: "growth",
      balance: 80,
    });
    expect(quote).toEqual({
      balance: 80,
      charged: false,
      reason: CHECKOUT_NOT_CONNECTED_REASON,
      credits: 0,
    });
    expect(persistedPurchase({ billing: "stub", chargeId: null, packageId: "growth" })).toBeNull();
    expect(persistedPurchase({ billing: "live", chargeId: null, packageId: "growth" })).toBeNull();
  });

  it("adds the package only after a live charge id", () => {
    expect(
      quoteCreditPurchase({
        billing: "live",
        chargeId: "ch_123",
        packageId: "starter",
        balance: 80,
      }),
    ).toEqual({ balance: 280, charged: true, reason: "", credits: 200 });
    expect(persistedPurchase({ billing: "live", chargeId: "ch_123", packageId: "starter" })).toEqual({
      packageId: "starter",
      credits: 200,
      priceCents: 2900,
      currency: "eur",
      billing: "live",
      chargeId: "ch_123",
    });
  });

  it("ignores allowance rows when summing credits", () => {
    expect(settledCreditTotal([{ billing: "allowance", chargeId: null, credits: 500 }])).toBe(0);
    expect(
      creditBalanceFromLedger(4, [
        { billing: "allowance", chargeId: null, credits: 500 },
        { billing: "live", chargeId: "ch_123", credits: 200 },
      ]),
    ).toBe(276);
  });
});
