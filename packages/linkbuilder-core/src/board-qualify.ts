/**
 * A board is a candidate only when every brief rule passes.
 * This decides. It does not register, post, or place a link.
 */

export type BoardKind = "qa" | "niche" | "long_tail" | "heavy_mod";

export type RegistrationState = "open" | "closed" | "membership" | "parked" | "hijacked";

export type BoardRejectReason =
  | "language"
  | "no_active_threads"
  | "logged_out_hidden"
  | "registration_closed"
  | "links_forbidden"
  | "already_owned"
  | "captcha_stop"
  | "overlap_lock"
  | "live_link_exists";

export interface BoardCandidate {
  /** BCP-47 language, for example `de`, `de-AT`, `en`. */
  language: string;
  country?: string | null;
  /** English is allowed only when the German lane has no open board left. */
  germanLaneEmpty?: boolean;
  activeThreads: boolean;
  /** Logged-out visitors can read the posts. */
  loggedOutCanRead: boolean;
  registration: RegistrationState;
  /** Soft links or a deep Ratgeber URL are allowed after trust. */
  allowsSoftDeepLink: boolean;
  alreadyOwned: boolean;
  permanentCaptchaStop?: boolean;
  overlapLock?: boolean;
  /** Counted LIVE links already on this host. The cap is one. */
  liveLinks: number;
  kind?: BoardKind;
}

export type BoardDecision =
  | { ok: true; priority: number; kind: BoardKind }
  | { ok: false; reason: BoardRejectReason };

const KIND_PRIORITY: Record<BoardKind, number> = {
  qa: 0,
  niche: 1,
  long_tail: 2,
  heavy_mod: 3,
};

function germanMarket(input: BoardCandidate): boolean {
  const language = input.language.trim().toLowerCase();
  const country = input.country?.trim().toUpperCase() ?? "";
  if (language === "de" || language.startsWith("de-")) return true;
  return country === "DE" || country === "AT" || country === "CH";
}

/** Public, open, and not already used. Max one LIVE link on the host. */
export function qualifyBoard(input: BoardCandidate): BoardDecision {
  const kind = input.kind ?? "niche";
  if (
    !germanMarket(input) &&
    !(input.germanLaneEmpty && input.language.toLowerCase().startsWith("en"))
  ) {
    return { ok: false, reason: "language" };
  }
  if (!input.activeThreads) return { ok: false, reason: "no_active_threads" };
  if (!input.loggedOutCanRead) return { ok: false, reason: "logged_out_hidden" };
  if (input.registration !== "open") return { ok: false, reason: "registration_closed" };
  if (!input.allowsSoftDeepLink) return { ok: false, reason: "links_forbidden" };
  if (input.alreadyOwned) return { ok: false, reason: "already_owned" };
  if (input.permanentCaptchaStop) return { ok: false, reason: "captcha_stop" };
  if (input.overlapLock) return { ok: false, reason: "overlap_lock" };
  if (input.liveLinks >= 1) return { ok: false, reason: "live_link_exists" };
  return { ok: true, priority: KIND_PRIORITY[kind], kind };
}

/** Open boards first: public Q&A, then niche, then long-tail, then heavy-mod. */
export function rankQualifiedBoards<T extends BoardCandidate>(boards: readonly T[]): T[] {
  return boards
    .flatMap((board) => {
      const decision = qualifyBoard(board);
      return decision.ok ? [{ board, priority: decision.priority }] : [];
    })
    .sort((left, right) => left.priority - right.priority)
    .map((item) => item.board);
}
