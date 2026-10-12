/** oRPC turns an API 429 into this status message. */
export function isLinkBuilderRateLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  if (value.code === "TOO_MANY_REQUESTS" || value.status === 429) return true;
  return typeof value.message === "string" && /too many requests/i.test(value.message);
}

/** Quiet wait after a limited poll. The first delay is already off a tight loop. */
export function linkBuilderPollBackoffMs(attempt: number): number {
  const steps = [10_000, 20_000, 30_000];
  const index = Math.min(Math.max(0, Math.floor(attempt)), steps.length - 1);
  return steps[index] ?? 30_000;
}
