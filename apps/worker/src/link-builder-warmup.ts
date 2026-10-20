import { localDateKey, startOfZonedDay } from "@rakazo/linkbuilder-core";
import { moderationScope } from "@rakazo/linkbuilder-drivers";
import { threadKey } from "./link-builder-page-move.js";

/** Reasons that can change on the next visit, so they are not stored on the thread. */
const EPHEMERAL_REJECTION = new Set(["open_failed", "stale", "no_other_users", "own_last"]);

export function rejectionIsStored(reason: string): boolean {
  return !EPHEMERAL_REJECTION.has(reason);
}

export function normalizeReplyBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A warmup body must be new on this host and long enough to be a real reply. */
export function replyBodyBlocked(
  body: string,
  earlier: readonly string[],
): "short" | "duplicate" | null {
  const normalized = normalizeReplyBody(body);
  if ([...normalized].length < 120) return "short";
  if (earlier.some((item) => normalizeReplyBody(item) === normalized)) return "duplicate";
  return null;
}

/** Two posted replies per Berlin day, and never a second one inside three hours. */
export function warmupPaceBlocked(postedAt: readonly Date[], now: Date, timeZone: string): boolean {
  const day = localDateKey(now, timeZone);
  let today = 0;
  for (const at of postedAt) {
    if (now.getTime() - at.getTime() >= 0 && now.getTime() - at.getTime() < 180 * 60_000) {
      return true;
    }
    if (localDateKey(at, timeZone) === day) today += 1;
  }
  return today >= 2;
}

export interface WarmupCountRow {
  url: string;
  modelId: string;
  status: string;
  verified?: boolean | null;
}

/** Distinct threads with a real posted reply. Canned warmup-fixed rows count as zero. */
export function distinctWarmupThreads(rows: readonly WarmupCountRow[]): number {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.status !== "posted") continue;
    if (row.modelId === "warmup-fixed") continue;
    if (row.verified === false) continue;
    keys.add(threadKey(row.url));
  }
  return keys.size;
}

const MODERATION = /wird nach prüfung|freigeschaltet|moderiert|awaiting approval/i;

export function replyVisibility(input: {
  pageText: string;
  html?: string;
  username: string;
  body: string;
  permalink?: string | null;
}): "posted" | "pending_moderation" | "not_visible" {
  const snippet = normalizeReplyBody(input.body).slice(0, 40);
  const named = input.username.trim().toLowerCase();
  const visible = (text: string) => {
    const page = text.toLowerCase().replace(/\s+/g, " ");
    return (
      named.length > 0 && snippet.length >= 8 && page.includes(named) && page.includes(snippet)
    );
  };
  if (input.html) {
    const scope = moderationScope(input.html, input.username, input.permalink);
    const held =
      MODERATION.test(scope.ownPost) || (scope.banner.length > 0 && MODERATION.test(scope.banner));
    if (held && !visible(scope.pageText)) return "pending_moderation";
    if (visible(scope.pageText) || visible(input.pageText)) return "posted";
    if (held) return "pending_moderation";
    return "not_visible";
  }
  if (MODERATION.test(input.pageText) && !visible(input.pageText)) return "pending_moderation";
  if (visible(input.pageText)) return "posted";
  return "not_visible";
}

const DAILY_REFUSAL = new Set(["link_day", "warmup_pace", "captcha_cap", "no_thread_today"]);

export function dailyRefusal(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object") return null;
  const refused = (outcome as { refused?: unknown }).refused;
  return typeof refused === "string" && DAILY_REFUSAL.has(refused) ? refused : null;
}

export function berlinDayStart(now: Date, timeZone: string): Date {
  return startOfZonedDay(now, timeZone);
}

/** `verified: false` on a draft means the reply was not on the public page. */
export function verifiedFlag(checks: unknown): boolean | null {
  if (!checks || typeof checks !== "object") return null;
  const value = (checks as { verified?: unknown }).verified;
  if (value === false) return false;
  if (value === true) return true;
  return null;
}

export const CAPTCHA_SOLVES_PER_HOST_DAY = 2;
