import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allowedHostEvents,
  canTransitionHost,
  HOST_EVENTS,
  HOST_STATUSES,
  type HostEvent,
  type HostStatus,
  hostState,
  IllegalTransition,
  isHostTerminal,
  PARKABLE_HOST_STATUSES,
  TERMINAL_HOST_STATUSES,
  transitionHost,
} from "./index.js";

const ACTIVE = [
  "discovered",
  "probed",
  "qualified",
  "registering",
  "pending_email",
  "pending_admin",
  "warming",
  "ready",
  "parked_operator",
] as const satisfies readonly HostStatus[];

/** Every legal (status, event) pair and its target; `parked`/`resumed` are covered separately. */
const LEGAL: Array<[HostStatus, HostEvent, HostStatus]> = [
  ["discovered", "probe_succeeded", "probed"],
  ["probed", "qualified", "qualified"],
  ["qualified", "registration_started", "registering"],
  ["qualified", "account_active", "warming"],
  ["registering", "email_pending", "pending_email"],
  ["registering", "admin_pending", "pending_admin"],
  ["pending_email", "admin_pending", "pending_admin"],
  ["registering", "account_active", "warming"],
  ["pending_email", "account_active", "warming"],
  ["pending_admin", "account_active", "warming"],
  ["warming", "warmup_completed", "ready"],
  ["ready", "link_counted", "used"],
  ...ACTIVE.map((status): [HostStatus, HostEvent, HostStatus] => [status, "denied", "denied"]),
  ...ACTIVE.map((status): [HostStatus, HostEvent, HostStatus] => [status, "failed", "dead"]),
  ["registering", "spam_blocked", "spam_blocked"],
  ["warming", "spam_blocked", "spam_blocked"],
  ["ready", "spam_blocked", "spam_blocked"],
  ...(["discovered", "probed", "qualified", "registering", "warming", "ready"] as const).map(
    (status): [HostStatus, HostEvent, HostStatus] => [
      status,
      "unsupported_captcha",
      "unsupported_captcha",
    ],
  ),
  ["parked_operator", "operator_skipped", "dead"],
  ["parked_operator", "park_expired", "dead"],
  ["parked_operator", "park_requalified", "qualified"],
];

const FIXED_EVENTS = HOST_EVENTS.filter((event) => event !== "parked" && event !== "resumed");

describe("host state machine", () => {
  it.each(LEGAL)("%s --%s--> %s", (from, event, to) => {
    const parkedFrom = from === "parked_operator" ? "warming" : null;
    expect(transitionHost(hostState(from, parkedFrom), event)).toEqual({
      status: to,
      parkedFrom: null,
    });
  });

  it("rejects every (status, event) pair outside the legal table", () => {
    const legal = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
    let illegal = 0;
    for (const status of HOST_STATUSES) {
      for (const event of FIXED_EVENTS) {
        if (legal.has(`${status}:${event}`)) continue;
        illegal += 1;
        const state = hostState(status, status === "parked_operator" ? "ready" : null);
        expect(() => transitionHost(state, event), `${status}:${event}`).toThrow(IllegalTransition);
        expect(canTransitionHost(state, event)).toBe(false);
      }
    }
    expect(illegal).toBe(HOST_STATUSES.length * FIXED_EVENTS.length - LEGAL.length);
  });

  it.each(PARKABLE_HOST_STATUSES)("parks from %s and resumes to the same status", (status) => {
    const parked = transitionHost(status, "parked");
    expect(parked).toEqual({ status: "parked_operator", parkedFrom: status });
    expect(transitionHost(parked, "resumed")).toEqual({ status, parkedFrom: null });
  });

  it("refuses to park from non-parkable statuses or to resume without a parked origin", () => {
    for (const status of HOST_STATUSES.filter(
      (candidate) => !(PARKABLE_HOST_STATUSES as readonly string[]).includes(candidate),
    )) {
      expect(() => transitionHost(status, "parked"), status).toThrow(IllegalTransition);
    }
    expect(() => transitionHost("parked_operator", "resumed")).toThrow(IllegalTransition);
    for (const status of HOST_STATUSES.filter((candidate) => candidate !== "parked_operator")) {
      expect(() => transitionHost(hostState(status), "resumed"), status).toThrow(/resumed from/);
    }
  });

  it("never leaves a terminal status", () => {
    for (const status of TERMINAL_HOST_STATUSES) {
      expect(isHostTerminal(status)).toBe(true);
      expect(allowedHostEvents(status)).toEqual([]);
    }
    expect(isHostTerminal("ready")).toBe(false);
  });

  it("drops parkedFrom for non-parked states and reports transition details", () => {
    expect(hostState("ready", "warming")).toEqual({ status: "ready", parkedFrom: null });
    try {
      transitionHost("used", "link_counted");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ machine: "host", from: "used", event: "link_counted" });
    }
  });

  it("reaches used only through the full funnel", () => {
    const path: HostEvent[] = [
      "probe_succeeded",
      "qualified",
      "registration_started",
      "email_pending",
      "parked",
      "resumed",
      "account_active",
      "warmup_completed",
      "link_counted",
    ];
    const end = path.reduce(
      (state, event) => transitionHost(state, event),
      hostState("discovered"),
    );
    expect(end).toEqual({ status: "used", parkedFrom: null });
  });

  it("keeps parkedFrom consistent across random event sequences", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...HOST_EVENTS), { maxLength: 30 }), (events) => {
        let state = hostState("discovered");
        for (const event of events) {
          if (!canTransitionHost(state, event)) continue;
          state = transitionHost(state, event);
          expect(state.parkedFrom !== null).toBe(state.status === "parked_operator");
        }
      }),
    );
  });

  it("rethrows unexpected errors from canTransitionHost", () => {
    expect(() =>
      canTransitionHost({ status: "ready", parkedFrom: null }, "bogus" as HostEvent),
    ).toThrow(TypeError);
  });
});
