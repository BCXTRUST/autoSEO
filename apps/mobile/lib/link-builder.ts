/** Operator tickets open at /link-builder-ticket. Push payloads use this path in `data.url`. */
export const OPERATOR_TICKET_PATH = "/link-builder-ticket";

export function linkBuilderPushRoute(data: {
  url?: string;
  projectId?: string;
  ticketId?: string;
}): { pathname: "/link-builder-ticket"; params: { projectId: string; ticketId?: string } } | null {
  if (!data.url?.startsWith(OPERATOR_TICKET_PATH)) return null;
  const projectId = data.projectId;
  if (!projectId) return null;
  return {
    pathname: "/link-builder-ticket",
    params: data.ticketId ? { projectId, ticketId: data.ticketId } : { projectId },
  };
}

export function ticketCountdown(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const remaining = Date.parse(expiresAt) - now;
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return "Expired";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export interface MobileLbCard {
  id: string;
  name: string;
  activityLabel: string;
  newToday: number;
  liveToday: number;
  newPerDay: number;
  livePerDay: number;
  runStatus: string | null;
  lastEvent: string | null;
  operatorQueue: number;
  operatorHelp?: { ticketId: string; domain: string; label: string; action: "skip" | "continue" } | null;
}

export interface MobileLbTicket {
  id: string;
  projectId: string;
  domain: string;
  reason: string;
  status: string;
  note: string | null;
  screenUrl: string | null;
  screenshotArtifactId: string | null;
  expiresAt: string | null;
}

export interface MobileLbArtifact {
  mimeType: string;
  contentBase64: string;
}

export function artifactImageUri(artifact: MobileLbArtifact): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(artifact.mimeType)) return null;
  return `data:${artifact.mimeType};base64,${artifact.contentBase64}`;
}

export function projectStatusLine(
  card: Pick<
    MobileLbCard,
    "activityLabel" | "newToday" | "liveToday" | "newPerDay" | "livePerDay"
  > & { operatorHelp?: { label: string } | null },
): string {
  const activity = /^needs operator\b/i.test(card.activityLabel) ? "" : card.activityLabel;
  const head = card.operatorHelp?.label || activity;
  const counts = `NEW ${card.newToday}/${card.newPerDay} · LIVE ${card.liveToday}/${card.livePerDay}`;
  return head ? `${head} · ${counts}` : counts;
}

export function ticketActionBody(note: string): { note?: string } {
  const trimmed = note.trim();
  return trimmed ? { note: trimmed } : {};
}
