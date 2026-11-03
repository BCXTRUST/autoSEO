import type { CampaignItem } from "./campaign-types";

export type DraftContextState = "available" | "supplied" | "missing";

export interface DraftOfficialReference {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  fetchedAt: string;
}

export interface DraftProjectContext {
  rootUrl: string | null;
  runId: string | null;
  sourceIds: string[];
  state: DraftContextState;
  isHistorical: boolean;
  references: DraftOfficialReference[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function normalizedUrl(value: string | undefined): string | null {
  if (!value || !safeHttpUrl(value)) return null;
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

export function readDraftProjectContext(
  item: CampaignItem,
  currentWebsiteUrl: string,
): DraftProjectContext | null {
  const details = record(item.details);
  const context = record(details?.projectContext);
  if (
    !context ||
    !["available", "supplied", "missing"].includes(context.state as string) ||
    !safeHttpUrl(context.rootUrl) ||
    !(
      context.runId === null ||
      (typeof context.runId === "string" && /^[a-f0-9]{64}$/.test(context.runId))
    ) ||
    !Array.isArray(context.sourceIds) ||
    context.sourceIds.length > 3 ||
    !context.sourceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
  ) {
    return null;
  }

  const sourceIds = context.sourceIds as string[];
  if (
    (context.state === "missing" && (context.runId !== null || sourceIds.length > 0)) ||
    (context.state !== "missing" && (context.runId === null || sourceIds.length === 0))
  ) {
    return null;
  }
  const references = Array.isArray(details?.evidence)
    ? details.evidence.slice(0, 20).flatMap((entry) => {
        const evidence = record(entry);
        if (
          !evidence ||
          typeof evidence.id !== "string" ||
          !sourceIds.includes(evidence.id) ||
          !safeHttpUrl(evidence.url) ||
          typeof evidence.title !== "string" ||
          evidence.title.length > 200 ||
          typeof evidence.excerpt !== "string" ||
          evidence.excerpt.length > 1_200 ||
          typeof evidence.fetchedAt !== "string" ||
          !Number.isFinite(Date.parse(evidence.fetchedAt))
        ) {
          return [];
        }
        return [
          {
            id: evidence.id,
            url: evidence.url,
            title: evidence.title,
            excerpt: evidence.excerpt,
            fetchedAt: evidence.fetchedAt,
          },
        ];
      })
    : [];
  const rootUrl = context.rootUrl;
  const normalizedRoot = normalizedUrl(rootUrl ?? undefined);
  const normalizedCurrent = normalizedUrl(currentWebsiteUrl);
  return {
    rootUrl,
    runId: typeof context.runId === "string" ? context.runId : null,
    sourceIds,
    state: context.state as DraftContextState,
    isHistorical: Boolean(
      normalizedRoot && normalizedCurrent && normalizedRoot !== normalizedCurrent,
    ),
    references,
  };
}
