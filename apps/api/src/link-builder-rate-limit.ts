/** Fixed window of request timestamps for one workspace. In-process only; no Redis. */
export class WorkspaceRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(workspaceId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const at = this.now();
    const recent = (this.hits.get(workspaceId) ?? []).filter((ts) => at - ts < this.windowMs);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? at;
      this.hits.set(workspaceId, recent);
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (at - oldest)) };
    }
    recent.push(at);
    this.hits.set(workspaceId, recent);
    return { ok: true };
  }
}

/** Link-builder RPC budget for one API process. */
export const LINK_BUILDER_RATE_LIMIT = 120;
export const LINK_BUILDER_RATE_WINDOW_MS = 60_000;

/**
 * Anonymous callers only. A signed-in workspace member is not charged, so a
 * live dashboard cannot lock the customer out of the project list.
 */
export const LINK_BUILDER_POLL_RATE_LIMIT = LINK_BUILDER_RATE_LIMIT;

const LINK_BUILDER_RPC_MARKER = "/linkBuilder/";

/** Reads the live dashboard repeats. Opening the project list is not one of these. */
const POLL_PROCEDURES = new Set([
  "projects/get",
  "projects/status",
  "projects/screen",
  "hosts/list",
  "placements/list",
  "runs/list",
  "runs/steps",
  "threads/list",
  "drafts/list",
  "operator/tickets",
  "proxyLeases/list",
  "subscribe",
]);

export type LinkBuilderRateBucket = "poll" | "interactive";

/**
 * Document navigations such as `/link-builder` are not RPC and are not counted.
 * `projects/list` stays on the page-load window.
 */
export function linkBuilderRpcBucket(pathname: string): LinkBuilderRateBucket | null {
  const index = pathname.indexOf(LINK_BUILDER_RPC_MARKER);
  if (index < 0) return null;
  const procedure = pathname.slice(index + LINK_BUILDER_RPC_MARKER.length).replace(/\/+$/, "");
  if (!procedure) return "interactive";
  return POLL_PROCEDURES.has(procedure) ? "poll" : "interactive";
}

/** First forwarded address, or the direct peer. Unusable values share one bucket. */
export function anonymousRateKey(
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined,
): string {
  const forwarded = forwardedFor?.split(",")[0]?.trim() ?? "";
  const raw = forwarded || realIp?.trim() || "";
  const ip = raw.replace(/[^0-9a-fA-F:.%]/g, "").slice(0, 64);
  return ip ? `ip:${ip}` : "anonymous";
}

/**
 * Signed-in members are allowed through. Anonymous floods are limited, and a
 * status or computer poll does not spend the page-load window.
 */
export function takeLinkBuilderRequest(
  limiters: { poll: WorkspaceRateLimiter; page: WorkspaceRateLimiter },
  input: { pathname: string; member: boolean; clientKey: string },
):
  | { ok: true; bucket: LinkBuilderRateBucket | null }
  | { ok: false; bucket: LinkBuilderRateBucket; retryAfterMs: number } {
  const bucket = linkBuilderRpcBucket(input.pathname);
  if (!bucket || input.member) return { ok: true, bucket };
  const decision = (bucket === "poll" ? limiters.poll : limiters.page).take(input.clientKey);
  if (!decision.ok) return { ok: false, bucket, retryAfterMs: decision.retryAfterMs };
  return { ok: true, bucket };
}
