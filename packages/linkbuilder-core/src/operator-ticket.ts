/** A view-only desktop is not help. These reasons used to open an operator ticket. */
export const DESKTOP_ONLY_TICKET_REASONS = [
  "captcha_unsolved",
  "two_factor",
  "missing_password",
  "admin_approval",
  "unknown_page_state",
  "unmapped_form",
] as const;

/** Unsolvable captcha and missing secrets do not get another try. */
const SKIP_IMMEDIATELY = new Set<string>(["captcha_unsolved", "two_factor", "missing_password"]);

/** Unknown and unmapped pages get the normal retry budget, then an ordinary skip. */
export const PAGE_GIVE_UP_AFTER = 3;

export type OperatorUiAction = "skip" | "continue";

export interface OperatorHelp {
  ticketId: string;
  domain: string;
  /** Site and action, for example "Skip board.example". */
  label: string;
  action: OperatorUiAction;
}

/**
 * A ticket the user can finish from our UI, without clicking the desktop.
 * None of the desktop-only reasons qualify: the screen is view-only.
 */
export function operatorHelpFor(input: {
  id: string;
  status: string;
  reason: string;
  domain: string;
  hostStatus: string;
}): OperatorHelp | null {
  if (input.status !== "open") return null;
  if (input.hostStatus !== "parked_operator") return null;
  if ((DESKTOP_ONLY_TICKET_REASONS as readonly string[]).includes(input.reason)) return null;
  const domain = input.domain.trim();
  if (!domain) return null;
  return null;
}

export function shouldSkipDesktopPage(input: { reason: string; failures: number }): boolean {
  if (SKIP_IMMEDIATELY.has(input.reason)) return true;
  return input.failures + 1 >= PAGE_GIVE_UP_AFTER;
}

/** Prior steps that already failed this page. The attempt about to be written is not included. */
export function stepCountsTowardPageGiveUp(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return false;
  const row = outcome as Record<string, unknown>;
  const action = typeof row.lastAction === "string" ? row.lastAction : "";
  if (/the page did not finish, trying again/i.test(action)) return true;
  if (/parked for the operator/i.test(action)) return true;
  if (/^skipped /i.test(action)) return true;
  const reason = typeof row.reason === "string" ? row.reason : "";
  if (
    reason === "unmapped_form" ||
    reason === "unknown_page_state" ||
    reason === "missing_password" ||
    reason === "two_factor"
  ) {
    return true;
  }
  return row.registration === "unknown";
}

/** Feed line for a skip. Names the site and does not ask for an operator. */
export function skippedHostLine(domain: string): string {
  return `Skipped ${domain.trim()}`;
}
