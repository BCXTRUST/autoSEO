import { creditBalanceAfterSpend, settleCreditPurchase } from "./customer-hosts.js";

/**
 * Credit packages and the new-project gate.
 * A card is charged only by settleCreditPurchase: billing must be live and a charge id must exist.
 * The included starting balance does not unlock a project.
 */

export const CHECKOUT_NOT_CONNECTED_REASON =
  "Checkout is not connected. No card was charged and credits were not added.";

export const CREDIT_PACKAGES = [
  {
    id: "starter",
    name: "Starter",
    credits: 200,
    priceCents: 2900,
    currency: "eur",
    recommended: false,
  },
  {
    id: "growth",
    name: "Growth",
    credits: 1000,
    priceCents: 9900,
    currency: "eur",
    recommended: true,
  },
  {
    id: "scale",
    name: "Scale",
    credits: 5000,
    priceCents: 39900,
    currency: "eur",
    recommended: false,
  },
] as const;

export type CreditPackage = (typeof CREDIT_PACKAGES)[number];

export interface ProjectPurchase {
  billing: string;
  chargeId: string | null;
  credits?: number;
}

/** A settled provider charge. An allowance row is a separate explicit dev/test record. */
export function mayCreateLinkBuilderProject(purchases: readonly ProjectPurchase[]): boolean {
  return purchases.some((row) => isSettledCharge(row) || row.billing === "allowance");
}

export function creditPackageById(packageId: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((pack) => pack.id === packageId);
}

export function formatPackagePrice(priceCents: number, currency: "eur"): string {
  const major = priceCents / 100;
  const amount = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return currency === "eur" ? `€${amount}` : amount;
}

/**
 * Credits already paid for. Allowance rows and missing charge ids add nothing.
 */
export function settledCreditTotal(purchases: readonly ProjectPurchase[]): number {
  let total = 0;
  for (const row of purchases) {
    if (!isSettledCharge(row)) continue;
    const credits = row.credits ?? 0;
    if (Number.isInteger(credits) && credits > 0) total += credits;
  }
  return total;
}

/** Included budget minus spend, plus credits from settled charges only. */
export function creditBalanceFromLedger(
  spent: number,
  purchases: readonly ProjectPurchase[],
): number {
  return creditBalanceAfterSpend(spent) + settledCreditTotal(purchases);
}

export function quoteCreditPurchase(input: {
  billing: string;
  chargeId: string | null;
  packageId: string;
  balance: number;
}): { balance: number; charged: boolean; reason: string; credits: number } {
  const pack = creditPackageById(input.packageId);
  if (!pack) {
    return { balance: input.balance, charged: false, reason: "Unknown package.", credits: 0 };
  }
  const settled = settleCreditPurchase({
    billing: input.billing,
    balance: input.balance,
    chargeId: input.chargeId,
    amount: pack.credits,
  });
  if (settled.charged) {
    return { balance: settled.balance, charged: true, reason: "", credits: pack.credits };
  }
  return {
    balance: input.balance,
    charged: false,
    reason:
      input.billing === "live"
        ? "No card was charged and credits were not added."
        : CHECKOUT_NOT_CONNECTED_REASON,
    credits: 0,
  };
}

/** Row to store after a settled charge. Null unless billing is live and a charge id exists. */
export function persistedPurchase(input: {
  billing: string;
  chargeId: string | null;
  packageId: string;
}): {
  packageId: string;
  credits: number;
  priceCents: number;
  currency: "eur";
  billing: "live";
  chargeId: string;
} | null {
  const pack = creditPackageById(input.packageId);
  if (!pack || !input.chargeId) return null;
  const quote = quoteCreditPurchase({ ...input, balance: 0 });
  if (!quote.charged) return null;
  return {
    packageId: pack.id,
    credits: pack.credits,
    priceCents: pack.priceCents,
    currency: pack.currency,
    billing: "live",
    chargeId: input.chargeId,
  };
}

function isSettledCharge(row: ProjectPurchase): boolean {
  return row.billing === "live" && typeof row.chargeId === "string" && row.chargeId.trim().length > 0;
}
