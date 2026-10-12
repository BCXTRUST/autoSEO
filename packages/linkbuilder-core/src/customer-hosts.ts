import { isFixtureHostDomain } from "./fake-scenario.js";

/** Nordlicht demo slug. Example hosts belong on this project only. */
export const FIXTURE_DEMO_SLUG = "nordlicht-wellness";

/** Included AutoSEO credits. Buying more requires a real charge, which the stub never makes. */
export const INCLUDED_CREDIT_BUDGET = 80;

export function mentionsFixtureHost(text: string): boolean {
  return /\b(?:forum|fragen|brett)-[a-z0-9]+\.example\b/i.test(text);
}

export function mentionsExampleDomain(text: string): boolean {
  return /\.example\b/i.test(text);
}

export function isExampleRegistrableDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  return host === "example" || host.endsWith(".example");
}

/**
 * Fixture boards (`forum-*.example` and the same pattern) never belong on a customer project.
 * Any other `*.example` host is also hidden unless this is the Nordlicht demo.
 */
export function showHostToCustomer(domain: string, slug?: string | null): boolean {
  if (isFixtureHostDomain(domain)) return false;
  if (slug && slug !== FIXTURE_DEMO_SLUG && isExampleRegistrableDomain(domain)) return false;
  return true;
}

export function creditBalanceAfterSpend(spent: number): number {
  if (!Number.isInteger(spent) || spent < 0) return INCLUDED_CREDIT_BUDGET;
  return Math.max(0, INCLUDED_CREDIT_BUDGET - spent);
}

/**
 * Credits increase only when a live provider returns a charge id.
 * The Stripe stub has no charge, so the balance stays put.
 */
export function settleCreditPurchase(input: {
  billing: string;
  balance: number;
  chargeId: string | null;
  amount: number;
}): { balance: number; charged: boolean; reason: string } {
  const amount = Number.isInteger(input.amount) && input.amount > 0 ? input.amount : 0;
  if (input.billing === "live" && input.chargeId && amount > 0) {
    return { balance: input.balance + amount, charged: true, reason: "" };
  }
  return {
    balance: input.balance,
    charged: false,
    reason: "A payment provider is not connected. No card is charged.",
  };
}
