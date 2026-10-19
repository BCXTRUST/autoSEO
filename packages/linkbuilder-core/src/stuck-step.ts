/** Hosts that must not receive a new signup. Existing accounts on them can continue. */
export const NEW_SIGNUP_BANNED_HOSTS = [
  "frauenselbsthilfe.de",
  "lifters-lounge.com",
  "lifters-lounge.de",
  "medizin-forum.de",
  "phpbb.de",
  "macuser.de",
  "bulli-forum.com",
  "psychic.de",
  "ulrichradig.de",
  "tauschring-koeln.de",
] as const;

const NO_PROGRESS =
  /did not finish|trying again|step failed, retrying|captcha not submitted|black pane|scrolled off the form|same page/i;

const SANDBOX_GONE =
  /SandboxNotFound|sandbox not found|not running anymore|runner returned no response/i;

export interface StuckRecord {
  action: string;
  error: string | null;
  looked: boolean;
}

export type StuckDecision = "continue" | "yield" | "look" | "pause";

export type StuckLookAction =
  | { action: "find_form" }
  | { action: "fill_fields" }
  | { action: "other_thread"; index: number };

export function isNewSignupBannedHost(domain: string): boolean {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!host) return false;
  return NEW_SIGNUP_BANNED_HOSTS.some(
    (banned) => host === banned || host.endsWith(`.${banned}`) || host.includes(banned),
  );
}

export function isNoProgressAction(action: string): boolean {
  return NO_PROGRESS.test(action);
}

export function isSandboxGoneText(value: string | null | undefined): boolean {
  return SANDBOX_GONE.test(value ?? "");
}

/**
 * A stuck step looks at the page once. The same click is not repeated.
 * A dead sandbox is left for the viewer to replace once. Any other stuck
 * step pauses after that look.
 */
export function decideStuckStep(recordsNewestFirst: readonly StuckRecord[]): StuckDecision {
  const latest = recordsNewestFirst[0];
  if (!latest) return "continue";
  if (isSandboxGoneText(latest.error) || isSandboxGoneText(latest.action)) return "yield";
  if (latest.looked && !isNoProgressAction(latest.action)) return "continue";
  if (!isNoProgressAction(latest.action)) return "continue";
  for (const record of recordsNewestFirst) {
    if (!isNoProgressAction(record.action) && !record.looked) break;
    if (record.looked) return "pause";
  }
  return "look";
}

export function stuckLookPrompt(input: {
  url: string;
  fields: readonly string[];
  links: readonly string[];
  allowOtherThread?: boolean;
}): string {
  const fields = input.fields.length > 0 ? input.fields.join("\n") : "(none)";
  const links = input.links.length > 0 ? input.links.join("\n") : "(none)";
  const allowOtherThread = input.allowOtherThread !== false;
  return [
    "The browser step is not moving. Do not repeat the last click.",
    `Page: ${input.url}`,
    "Empty fields:",
    fields,
    "Links:",
    links,
    allowOtherThread
      ? "Choose one: find the form, fill the fields that are listed, or open another thread by index."
      : "Choose one: find the form, or fill the fields that are listed. Do not open another thread.",
    allowOtherThread
      ? 'Reply JSON only: {"action":"find_form"} or {"action":"fill_fields"} or {"action":"other_thread","index":0}'
      : 'Reply JSON only: {"action":"find_form"} or {"action":"fill_fields"}',
  ].join("\n");
}

export const STUCK_LOOK_SYSTEM =
  "You are looking at a forum page that did not advance. Pick one action from the lists. Never invent a URL. Never repeat a click that already failed.";

export function parseStuckLook(value: unknown, linkCount: number): StuckLookAction | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { action?: unknown; index?: unknown };
  if (row.action === "find_form" || row.action === "fill_fields") return { action: row.action };
  if (row.action !== "other_thread") return null;
  if (typeof row.index !== "number" || !Number.isInteger(row.index)) return null;
  if (row.index < 0 || row.index >= linkCount) return null;
  return { action: "other_thread", index: row.index };
}

export function localStuckChoice(input: {
  emptyFillable: number;
  threadCount: number;
}): StuckLookAction {
  if (input.emptyFillable > 0) return { action: "fill_fields" };
  if (input.threadCount > 0) return { action: "other_thread", index: 0 };
  return { action: "find_form" };
}
