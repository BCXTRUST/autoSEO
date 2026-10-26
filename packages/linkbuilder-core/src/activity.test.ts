import { describe, expect, it } from "vitest";
import { projectActivity } from "./activity.js";
import type { ScheduleState } from "./schedule.js";

const open: ScheduleState = { active: true, mode: "window", reason: "in_window" };
const closed: ScheduleState = { active: false, mode: "closed", reason: "after_window" };

describe("project activity", () => {
  it("does not claim work is running when the worker has no eligible sites", () => {
    expect(
      projectActivity({
        projectStatus: "active",
        runStatus: "running",
        openTickets: 0,
        schedule: open,
        lastAction: "No forum left to work on",
      }),
    ).toMatchObject({ activity: "idle", label: "Waiting for eligible sites" });
    expect(
      projectActivity({
        projectStatus: "paused",
        runStatus: "running",
        openTickets: 0,
        schedule: open,
        lastAction: "No forum left to work on",
      }),
    ).toMatchObject({ activity: "paused" });
  });
  it("surfaces an operator queue ahead of a running day", () => {
    expect(
      projectActivity({
        projectStatus: "active",
        runStatus: "running",
        openTickets: 2,
        schedule: open,
      }),
    ).toMatchObject({ activity: "needs_operator", label: "needs operator ×2" });
  });

  it("reports the schedule when nothing is in flight", () => {
    expect(
      projectActivity({
        projectStatus: "active",
        runStatus: "partial",
        openTickets: 0,
        schedule: closed,
      }).activity,
    ).toBe("out_of_window");
  });

  it("keeps a live run labeled running inside the window", () => {
    expect(
      projectActivity({
        projectStatus: "active",
        runStatus: "running",
        openTickets: 0,
        schedule: open,
      }).label,
    ).toBe("running");
  });
});
