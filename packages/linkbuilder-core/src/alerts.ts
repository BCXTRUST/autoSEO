/** Stuck-alert mail stays on this address. */
export const STUCK_ALERT_RECIPIENT = "ht@tbs.one";

export const LB_ALERT_KINDS = [
  "project.paused",
  "captcha.needs_operator",
  "placement.live",
  "run.finished",
] as const;

export type LbAlertKind = (typeof LB_ALERT_KINDS)[number];

export interface AlertEvent {
  kind: LbAlertKind;
  workspaceId: string;
  projectId: string;
  /** Stable for one condition. A second emit with the same key is a no-op. */
  dedupeKey: string;
  message: string;
  payload: Record<string, string | number | boolean | null>;
}

/** Internal delivery of link-builder alerts. Vendor push and webhooks sit behind this. */
export interface AlertSink {
  emit(event: AlertEvent): Promise<"sent" | "duplicate">;
}

export function pauseDedupeKey(reason: "balance" | "proxy" | "mailbox"): string {
  return `project.paused:${reason}`;
}
