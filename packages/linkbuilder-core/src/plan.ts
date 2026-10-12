export interface PlanCaps {
  projects: number;
  live_per_day: number;
  personas: number;
}

/** A start or a count would pass a plan cap. */
export class PlanLimitError extends Error {
  readonly cap: "projects" | "personas" | "live_per_day";

  constructor(cap: "projects" | "personas" | "live_per_day") {
    super(`Plan limit reached: ${cap}`);
    this.name = "PlanLimitError";
    this.cap = cap;
  }
}

/**
 * v1 has one persona per project, so both caps apply to the same slot count.
 * `otherStartedProjects` excludes the project being started.
 */
export function assertStartWithinPlan(input: {
  otherStartedProjects: number;
  caps: Pick<PlanCaps, "projects" | "personas">;
}): void {
  const slots = input.otherStartedProjects + 1;
  if (slots > input.caps.projects) throw new PlanLimitError("projects");
  if (slots > input.caps.personas) throw new PlanLimitError("personas");
}

/** A placement may be counted only while today's count is still under the plan cap. */
export function countedWithinPlan(input: {
  wantCounted: boolean;
  countedToday: number;
  livePerDay: number;
}): boolean {
  return input.wantCounted && input.countedToday < input.livePerDay;
}
