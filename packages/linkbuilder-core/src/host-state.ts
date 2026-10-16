import {
  type LbHostStatus,
  LbHostStatusSchema,
  type LbParkableHostStatus,
  LbParkableHostStatusSchema,
} from "@rakazo/contracts";
import { IllegalTransition } from "./errors.js";

export type HostStatus = LbHostStatus;
export type ParkableHostStatus = LbParkableHostStatus;

export const HOST_STATUSES = LbHostStatusSchema.options;
export const PARKABLE_HOST_STATUSES = LbParkableHostStatusSchema.options;
export const TERMINAL_HOST_STATUSES = [
  "used",
  "denied",
  "spam_blocked",
  "unsupported_captcha",
  "form_not_found",
  "dead",
] as const satisfies readonly HostStatus[];

export const HOST_EVENTS = [
  "probe_succeeded",
  "qualified",
  "registration_started",
  "email_pending",
  "admin_pending",
  "account_active",
  "warmup_completed",
  "link_counted",
  "denied",
  "spam_blocked",
  "unsupported_captcha",
  "parked",
  "resumed",
  "operator_skipped",
  "park_expired",
  "park_requalified",
  "failed",
] as const;
export type HostEvent = (typeof HOST_EVENTS)[number];

export interface HostState {
  status: HostStatus;
  /** Status to return to on `resumed`; set only while `parked_operator`. */
  parkedFrom: ParkableHostStatus | null;
}

const NON_TERMINAL = HOST_STATUSES.filter(
  (status) => !(TERMINAL_HOST_STATUSES as readonly HostStatus[]).includes(status),
);

/** Fixed-target transitions; `parked` and `resumed` are computed from the current state. */
const TRANSITIONS: Record<
  Exclude<HostEvent, "parked" | "resumed">,
  { from: readonly HostStatus[]; to: HostStatus }
> = {
  probe_succeeded: { from: ["discovered"], to: "probed" },
  qualified: { from: ["probed"], to: "qualified" },
  registration_started: { from: ["qualified"], to: "registering" },
  email_pending: { from: ["registering"], to: "pending_email" },
  admin_pending: { from: ["registering", "pending_email"], to: "pending_admin" },
  account_active: { from: ["registering", "pending_email", "pending_admin"], to: "warming" },
  warmup_completed: { from: ["warming"], to: "ready" },
  link_counted: { from: ["ready"], to: "used" },
  denied: { from: NON_TERMINAL, to: "denied" },
  spam_blocked: { from: ["registering", "warming", "ready"], to: "spam_blocked" },
  unsupported_captcha: {
    from: ["discovered", "probed", "qualified", "registering", "warming", "ready"],
    to: "unsupported_captcha",
  },
  operator_skipped: { from: ["parked_operator"], to: "dead" },
  park_expired: { from: ["parked_operator"], to: "dead" },
  park_requalified: { from: ["parked_operator"], to: "qualified" },
  // A missing form is `form_not_found`, written directly. `failed` stays dead for a block,
  // a closed registration, or a site that is down.
  failed: { from: NON_TERMINAL, to: "dead" },
};

function isParkable(status: HostStatus): status is ParkableHostStatus {
  return (PARKABLE_HOST_STATUSES as readonly HostStatus[]).includes(status);
}

export function hostState(
  status: HostStatus,
  parkedFrom: ParkableHostStatus | null = null,
): HostState {
  return { status, parkedFrom: status === "parked_operator" ? parkedFrom : null };
}

/** Applies one host event, throwing `IllegalTransition` when the event is not allowed. */
export function transitionHost(current: HostState | HostStatus, event: HostEvent): HostState {
  const state = typeof current === "string" ? hostState(current) : current;
  if (event === "parked") {
    if (!isParkable(state.status)) throw new IllegalTransition("host", state.status, event);
    return { status: "parked_operator", parkedFrom: state.status };
  }
  if (event === "resumed") {
    if (state.status !== "parked_operator" || !state.parkedFrom) {
      throw new IllegalTransition("host", state.status, event);
    }
    return { status: state.parkedFrom, parkedFrom: null };
  }
  const rule = TRANSITIONS[event];
  if (!rule.from.includes(state.status)) throw new IllegalTransition("host", state.status, event);
  return { status: rule.to, parkedFrom: null };
}

export function canTransitionHost(current: HostState | HostStatus, event: HostEvent): boolean {
  try {
    transitionHost(current, event);
    return true;
  } catch (error) {
    if (error instanceof IllegalTransition) return false;
    throw error;
  }
}

export function allowedHostEvents(current: HostState | HostStatus): HostEvent[] {
  return HOST_EVENTS.filter((event) => canTransitionHost(current, event));
}

export function isHostTerminal(status: HostStatus): boolean {
  return (TERMINAL_HOST_STATUSES as readonly HostStatus[]).includes(status);
}
