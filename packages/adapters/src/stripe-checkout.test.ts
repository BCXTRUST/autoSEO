import { describe, expect, it } from "vitest";
import { stripeCheckoutConfigured } from "./stripe-checkout.js";

describe("stripe checkout configuration", () => {
  it("is connected only when a secret is present", () => {
    expect(stripeCheckoutConfigured({})).toBe(false);
    expect(stripeCheckoutConfigured({ STRIPE_SECRET_KEY: "" })).toBe(false);
    expect(stripeCheckoutConfigured({ STRIPE_SECRET_KEY: "   " })).toBe(false);
    expect(stripeCheckoutConfigured({ STRIPE_SECRET_KEY: "configured" })).toBe(true);
  });
});
