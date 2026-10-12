import type { LbQuotas, LbSchedule } from "@rakazo/contracts";

export type RunMetric = "registrations" | "posts";

export type RunPhrase =
  | { kind: "continue" }
  | { kind: "add"; metric: RunMetric; amount: number }
  | { kind: "set"; metric: RunMetric; scope: "today" | "week"; amount: number };

const CONTINUE = /^(?:continue|resume)$/i;
const MORE =
  /^(?:do|add)\s+(\d{1,2})\s+more\s+(registrations?|posts?|links?)\s+today$/i;
const SET_LIMIT =
  /^increase the (daily|weekly)(?: (registration|post|link))? limit to (\d{1,3})$/i;

export function parseRunPhrase(text: string): RunPhrase | null {
  const phrase = text.trim().replace(/\s+/g, " ");
  if (CONTINUE.test(phrase)) return { kind: "continue" };
  const more = MORE.exec(phrase);
  if (more) {
    return { kind: "add", metric: metricOf(more[2] ?? ""), amount: Number(more[1]) };
  }
  const set = SET_LIMIT.exec(phrase);
  if (set) {
    const scope = set[1] === "weekly" ? "week" : "today";
    const word = set[2];
    const metric: RunMetric =
      word === "post" || word === "link" ? "posts" : scope === "week" ? "posts" : "registrations";
    return { kind: "set", metric: word === "registration" ? "registrations" : metric, scope, amount: Number(set[3]) };
  }
  return null;
}

function metricOf(word: string): RunMetric {
  return /^post|^link/i.test(word) ? "posts" : "registrations";
}

export interface AppliedRunPhrase {
  quotas: LbQuotas;
  schedule: LbSchedule;
  resume: boolean;
  summary: string;
}

/** Applies one short instruction. "3 more" adds beyond what is already done or allowed. */
export function applyRunPhrase(input: {
  phrase: string;
  quotas: LbQuotas;
  schedule: LbSchedule;
  newToday: number;
  liveToday: number;
  now?: Date;
}): AppliedRunPhrase | null {
  const parsed = parseRunPhrase(input.phrase);
  if (!parsed) return null;
  const now = input.now ?? new Date();
  const quotas = { ...input.quotas };
  let schedule = input.schedule;
  if (parsed.kind === "continue") {
    schedule = { ...schedule, resumeUntil: new Date(now.getTime() + 12 * 60 * 60_000).toISOString() };
    return { quotas, schedule, resume: true, summary: "Running now" };
  }
  if (parsed.kind === "add") {
    if (parsed.metric === "registrations") {
      quotas.newPerDay = clamp(Math.max(quotas.newPerDay, input.newToday) + parsed.amount, 50);
      return {
        quotas,
        schedule,
        resume: true,
        summary: `Registrations today ${quotas.newPerDay}`,
      };
    }
    quotas.livePerDay = clamp(Math.max(quotas.livePerDay, input.liveToday) + parsed.amount, 50);
    if (quotas.liveWeekCap !== undefined && quotas.liveWeekCap < quotas.livePerDay) {
      quotas.liveWeekCap = quotas.livePerDay;
    }
    return { quotas, schedule, resume: true, summary: `Posts today ${quotas.livePerDay}` };
  }
  if (parsed.scope === "today" && parsed.metric === "registrations") {
    quotas.newPerDay = clamp(parsed.amount, 50);
    return { quotas, schedule, resume: false, summary: `Registrations today ${quotas.newPerDay}` };
  }
  if (parsed.scope === "today") {
    quotas.livePerDay = clamp(parsed.amount, 50);
    if (quotas.liveWeekCap !== undefined && quotas.liveWeekCap < quotas.livePerDay) {
      quotas.liveWeekCap = quotas.livePerDay;
    }
    return { quotas, schedule, resume: false, summary: `Posts today ${quotas.livePerDay}` };
  }
  const week = clamp(parsed.amount, 250);
  quotas.liveWeekCap = Math.max(week, quotas.livePerDay);
  return { quotas, schedule, resume: false, summary: `Weekly limit ${quotas.liveWeekCap}` };
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(value)));
}
