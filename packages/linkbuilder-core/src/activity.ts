import type { LbProjectStatus, LbRunStatus } from "@rakazo/contracts";
import type { ScheduleState } from "./schedule.js";

/** Dashboard pill. Operator queue wins so a parked host is never hidden behind "running". */
export const LB_ACTIVITIES = [
  "needs_operator",
  "paused",
  "overtime",
  "running",
  "out_of_window",
  "stopped",
  "draft",
  "idle",
] as const;

export type LbActivity = (typeof LB_ACTIVITIES)[number];

export interface ProjectActivity {
  activity: LbActivity;
  operatorCount: number;
  label: string;
}

export function projectActivity(input: {
  projectStatus: LbProjectStatus;
  runStatus: LbRunStatus | null;
  openTickets: number;
  schedule: ScheduleState;
  lastAction?: string | null;
}): ProjectActivity {
  const operatorCount = Math.max(0, Math.floor(input.openTickets));
  const activity = resolveActivity(input, operatorCount);
  return {
    activity,
    operatorCount,
    label:
      activity === "idle" && waitLabel(input.lastAction)
        ? waitLabel(input.lastAction)!
        : activityLabel(activity, operatorCount, input.runStatus),
  };
}

function resolveActivity(
  input: {
    projectStatus: LbProjectStatus;
    runStatus: LbRunStatus | null;
    schedule: ScheduleState;
    lastAction?: string | null;
  },
  operatorCount: number,
): LbActivity {
  if (input.projectStatus === "draft") return "draft";
  if (input.projectStatus === "archived" || input.projectStatus === "stopped") return "stopped";
  if (operatorCount > 0) return "needs_operator";
  if (input.projectStatus === "paused") return "paused";
  if (waitLabel(input.lastAction)) return input.schedule.active ? "idle" : "out_of_window";
  if (input.runStatus === "overtime") return "overtime";
  if (input.runStatus === "running" || input.runStatus === "queued") return "running";
  if (!input.schedule.active) return "out_of_window";
  return "idle";
}

export function linkBuilderTopic(projectId: string): string {
  return `lb-project:${projectId}`;
}

export function activityLabel(
  activity: LbActivity,
  operatorCount: number,
  runStatus: LbRunStatus | null,
): string {
  switch (activity) {
    case "needs_operator":
      return `needs operator ×${operatorCount}`;
    case "paused":
      return "paused";
    case "overtime":
      return "overtime";
    case "running":
      return "running";
    case "out_of_window":
      return "out of window";
    case "stopped":
      return "stopped";
    case "draft":
      return "draft";
    case "idle":
      return runStatus === "succeeded" || runStatus === "partial" || runStatus === "failed"
        ? runStatus
        : "idle";
  }
}

function waitLabel(action?: string | null): string | null {
  if (action === "Draft waiting for approval") return "Waiting for draft approval";
  if (action === "No forum left to work on") return "Waiting for eligible sites";
  if (action === "Waiting for a site admin") return "Waiting for site approval";
  if (action === "Waiting for the confirmation" || action === "Waiting for the confirmation email")
    return "Waiting for email verification";
  if (action?.startsWith("Search failed:")) return "Research interrupted — check activity";
  return null;
}
