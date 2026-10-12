/**
 * Human-like pacing for the persona browser (plan section 8). Values live here so the bounds are
 * asserted by tests instead of being tuned inside an adapter.
 */

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

export interface PacingPolicy {
  /** Delay between key presses while typing. */
  keystroke: DelayRange;
  /** Pause before each click, fill or navigation. */
  beforeAction: DelayRange;
  /** Upper bound on page actions per rolling minute on one host. */
  maxActionsPerMinute: number;
}

/** Hard ceilings so a misconfigured policy cannot stall a run for minutes per field. */
export const PACING_LIMITS = {
  maxKeystrokeMs: 400,
  maxBeforeActionMs: 5_000,
  maxActionsPerMinute: 120,
} as const;

export const HUMAN_PACING: PacingPolicy = {
  keystroke: { minMs: 45, maxMs: 160 },
  beforeAction: { minMs: 350, maxMs: 1_400 },
  maxActionsPerMinute: 40,
};

/** Near-instant pacing for offline tests; keeps the same code path with tiny bounded delays. */
export const TEST_PACING: PacingPolicy = {
  keystroke: { minMs: 0, maxMs: 2 },
  beforeAction: { minMs: 0, maxMs: 5 },
  maxActionsPerMinute: PACING_LIMITS.maxActionsPerMinute,
};

/** A failed submit can be tried again the same day. Three retries after the first attempt. */
export const MAX_REGISTRATIONS_PER_HOST_PER_DAY = 4;

/** Idle gap after leaving one host before the next host is opened. */
export const HOST_IDLE_GAP: DelayRange = { minMs: 8_000, maxMs: 25_000 };

/** Calendar day in `timeZone`, so a registration just before local midnight still counts. */
export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return format.format(a) === format.format(b);
}

/** False once this host already registered on the local day of `now`. */
export function canRegisterHost(input: {
  priorRegistrationAts: readonly Date[];
  now: Date;
  timeZone: string;
}): boolean {
  let used = 0;
  for (const at of input.priorRegistrationAts) {
    if (sameLocalDay(at, input.now, input.timeZone)) used += 1;
  }
  return used < MAX_REGISTRATIONS_PER_HOST_PER_DAY;
}

function assertRange(name: string, range: DelayRange, ceiling: number): void {
  const { minMs, maxMs } = range;
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 0 || maxMs < minMs) {
    throw new RangeError(`${name} must be integers with 0 <= min <= max`);
  }
  if (maxMs > ceiling) throw new RangeError(`${name} max must be at most ${ceiling} ms`);
}

export function assertPacing(policy: PacingPolicy): PacingPolicy {
  assertRange("keystroke", policy.keystroke, PACING_LIMITS.maxKeystrokeMs);
  assertRange("beforeAction", policy.beforeAction, PACING_LIMITS.maxBeforeActionMs);
  const perMinute = policy.maxActionsPerMinute;
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new RangeError("maxActionsPerMinute must be a positive integer");
  }
  if (perMinute > PACING_LIMITS.maxActionsPerMinute) {
    throw new RangeError(
      `maxActionsPerMinute must be at most ${PACING_LIMITS.maxActionsPerMinute}`,
    );
  }
  return policy;
}

/** A uniformly drawn delay inside the range; `random` returns values in [0, 1). */
export function pacedDelayMs(range: DelayRange, random: () => number = Math.random): number {
  const roll = Math.min(Math.max(random(), 0), 0.999_999);
  return range.minMs + Math.floor(roll * (range.maxMs - range.minMs + 1));
}

/**
 * Milliseconds to wait before the next action so no rolling 60 s window holds more than
 * `maxActionsPerMinute` actions. `history` holds earlier action times in ms.
 */
export function rateLimitWaitMs(
  history: readonly number[],
  nowMs: number,
  maxActionsPerMinute: number,
): number {
  const windowStart = nowMs - 60_000;
  const recent = history.filter((at) => at > windowStart).sort((a, b) => a - b);
  if (recent.length < maxActionsPerMinute) return 0;
  const oldestThatMustExpire = recent[recent.length - maxActionsPerMinute]!;
  return Math.max(0, oldestThatMustExpire + 60_000 - nowMs);
}
