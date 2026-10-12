import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertPacing,
  canRegisterHost,
  HOST_IDLE_GAP,
  HUMAN_PACING,
  MAX_REGISTRATIONS_PER_HOST_PER_DAY,
  PACING_LIMITS,
  pacedDelayMs,
  rateLimitWaitMs,
  TEST_PACING,
} from "./pacing.js";

describe("pacing", () => {
  it("ships valid human and test policies", () => {
    expect(assertPacing(HUMAN_PACING)).toBe(HUMAN_PACING);
    expect(assertPacing(TEST_PACING)).toBe(TEST_PACING);
    expect(HUMAN_PACING.keystroke.minMs).toBeGreaterThan(0);
  });

  it("rejects inverted, negative or unbounded ranges", () => {
    expect(() => assertPacing({ ...HUMAN_PACING, keystroke: { minMs: 10, maxMs: 5 } })).toThrow();
    expect(() => assertPacing({ ...HUMAN_PACING, keystroke: { minMs: -1, maxMs: 5 } })).toThrow();
    expect(() =>
      assertPacing({
        ...HUMAN_PACING,
        beforeAction: { minMs: 0, maxMs: PACING_LIMITS.maxBeforeActionMs + 1 },
      }),
    ).toThrow();
    expect(() => assertPacing({ ...HUMAN_PACING, maxActionsPerMinute: 0 })).toThrow();
    expect(() => assertPacing({ ...HUMAN_PACING, maxActionsPerMinute: 500 })).toThrow();
  });

  it("keeps every drawn delay inside its range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 100 }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        (minMs, span, roll) => {
          const delay = pacedDelayMs({ minMs, maxMs: minMs + span }, () => roll);
          return Number.isInteger(delay) && delay >= minMs && delay <= minMs + span;
        },
      ),
    );
  });

  it("allows three retries on a host the same day and idles between hosts", () => {
    expect(MAX_REGISTRATIONS_PER_HOST_PER_DAY).toBe(4);
    expect(HUMAN_PACING.maxActionsPerMinute).toBeLessThanOrEqual(PACING_LIMITS.maxActionsPerMinute);
    expect(HOST_IDLE_GAP.minMs).toBeGreaterThan(0);
    expect(HOST_IDLE_GAP.maxMs).toBeGreaterThanOrEqual(HOST_IDLE_GAP.minMs);
    expect(pacedDelayMs(HOST_IDLE_GAP, () => 0)).toBe(HOST_IDLE_GAP.minMs);
    expect(pacedDelayMs(HOST_IDLE_GAP, () => 0.999_999)).toBe(HOST_IDLE_GAP.maxMs);
    const morning = new Date("2026-10-05T10:00:00.000Z");
    const evening = new Date("2026-10-05T21:00:00.000Z");
    const nextMorning = new Date("2026-10-06T10:00:00.000Z");
    expect(
      canRegisterHost({ priorRegistrationAts: [morning], now: evening, timeZone: "UTC" }),
    ).toBe(true);
    expect(
      canRegisterHost({
        priorRegistrationAts: [morning, morning, morning, morning],
        now: evening,
        timeZone: "UTC",
      }),
    ).toBe(false);
    expect(
      canRegisterHost({ priorRegistrationAts: [morning], now: nextMorning, timeZone: "UTC" }),
    ).toBe(true);
    // 22:30 UTC is the next calendar day in Berlin (CEST).
    expect(
      canRegisterHost({
        priorRegistrationAts: [morning],
        now: new Date("2026-10-05T22:30:00.000Z"),
        timeZone: "Europe/Berlin",
      }),
    ).toBe(true);
  });

  it("holds the rolling per-minute action cap", () => {
    const now = 120_000;
    expect(rateLimitWaitMs([], now, 3)).toBe(0);
    expect(rateLimitWaitMs([70_000, 80_000], now, 3)).toBe(0);
    expect(rateLimitWaitMs([70_000, 80_000, 90_000], now, 3)).toBe(10_000);
    expect(rateLimitWaitMs([10_000, 70_000, 80_000, 90_000], now, 3)).toBe(10_000);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 60_000 }), { maxLength: 40 }),
        fc.integer({ min: 1, max: 10 }),
        (history, cap) => {
          const wait = rateLimitWaitMs(history, 60_000, cap);
          const at = 60_000 + wait;
          return history.filter((time) => time > at - 60_000).length < cap;
        },
      ),
    );
  });
});
