import type { CampaignItem, CampaignJob } from "./campaign-types";

export type DiscoveryInspection = "pending" | "observed" | "unavailable";
export type DiscoveryDisposition = "unreviewed" | "selected" | "dismissed";

export interface DiscoveryMetadata {
  runId: string;
  rootUrl: string;
  purpose: "search" | "candidate";
  provider: string;
  query: string;
  sourceItemIds: string[];
  rank?: number;
  observedAt?: string;
  inspection: DiscoveryInspection;
  eligibility: "needs_review";
  disposition: DiscoveryDisposition;
  rulesLinks: Array<{ url: string; label: string }>;
  platformHint: "unknown" | "discourse";
}

export interface DiscoveryRecord {
  item: CampaignItem;
  metadata: DiscoveryMetadata;
  job?: CampaignJob;
  excerpt: string;
}

export interface DiscoverySummary {
  searches: DiscoveryRecord[];
  candidates: DiscoveryRecord[];
}

export function canSelectDiscoveryRecord(
  record: DiscoveryRecord,
  currentWebsiteUrl: string,
): boolean {
  let currentRootUrl: string;
  try {
    const url = new URL(currentWebsiteUrl);
    url.hash = "";
    currentRootUrl = url.href;
  } catch {
    return false;
  }
  return (
    record.metadata.purpose === "candidate" &&
    record.item.kind === "opportunity" &&
    record.item.status === "needs_action" &&
    record.metadata.rootUrl === currentRootUrl &&
    record.metadata.inspection === "observed" &&
    record.metadata.eligibility === "needs_review" &&
    record.metadata.disposition === "unreviewed" &&
    record.job?.operation === "discovery_inspect" &&
    record.job.status === "succeeded"
  );
}

export function canDismissDiscoveryRecord(record: DiscoveryRecord): boolean {
  return record.metadata.purpose === "candidate" && record.metadata.disposition === "unreviewed";
}

export function countCandidatesForSearch(
  search: DiscoveryRecord,
  candidates: DiscoveryRecord[],
): number {
  if (search.metadata.purpose !== "search") return 0;
  return candidates.filter(
    (candidate) =>
      candidate.metadata.purpose === "candidate" &&
      candidate.metadata.runId === search.metadata.runId &&
      candidate.metadata.provider === search.metadata.provider &&
      candidate.metadata.query === search.metadata.query,
  ).length;
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

function readDiscoveryMetadata(item: CampaignItem): DiscoveryMetadata | null {
  const details = record(item.details);
  const data = record(details?.discovery);
  if (
    !data ||
    !safeHttpUrl(item.url) ||
    typeof data.runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.runId) ||
    !safeHttpUrl(data.rootUrl) ||
    (data.purpose !== "search" && data.purpose !== "candidate") ||
    typeof data.provider !== "string" ||
    !/^[a-zA-Z0-9_-]{1,40}$/.test(data.provider) ||
    typeof data.query !== "string" ||
    data.query.length < 1 ||
    data.query.length > 300 ||
    !Array.isArray(data.sourceItemIds) ||
    data.sourceItemIds.length > 12 ||
    !data.sourceItemIds.every((id) => typeof id === "string" && id.length <= 200) ||
    !["pending", "observed", "unavailable"].includes(data.inspection as string) ||
    data.eligibility !== "needs_review" ||
    !["unreviewed", "selected", "dismissed"].includes(data.disposition as string) ||
    (data.platformHint !== undefined &&
      data.platformHint !== "unknown" &&
      data.platformHint !== "discourse")
  ) {
    return null;
  }
  if (data.purpose === "search" ? item.kind !== "source" : item.kind !== "opportunity") return null;
  if (
    data.rank !== undefined &&
    (!Number.isSafeInteger(data.rank) || Number(data.rank) < 1 || Number(data.rank) > 100_000)
  )
    return null;
  if (
    data.observedAt !== undefined &&
    (typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt)))
  )
    return null;
  if (
    data.rulesLinks !== undefined &&
    (!Array.isArray(data.rulesLinks) || data.rulesLinks.length > 5)
  )
    return null;
  const sourceRulesLinks = Array.isArray(data.rulesLinks) ? data.rulesLinks : [];
  const rulesLinks = sourceRulesLinks.flatMap((entry) => {
    const link = record(entry);
    if (
      !link ||
      !safeHttpUrl(link.url) ||
      typeof link.label !== "string" ||
      link.label.length < 1 ||
      link.label.length > 200
    ) {
      return [];
    }
    return [{ url: link.url, label: link.label }];
  });
  if (rulesLinks.length !== sourceRulesLinks.length) return null;
  return {
    runId: data.runId,
    rootUrl: data.rootUrl,
    purpose: data.purpose,
    provider: data.provider,
    query: data.query,
    sourceItemIds: data.sourceItemIds as string[],
    ...(data.rank === undefined ? {} : { rank: Number(data.rank) }),
    ...(data.observedAt === undefined ? {} : { observedAt: String(data.observedAt) }),
    inspection: data.inspection as DiscoveryInspection,
    eligibility: "needs_review",
    disposition: data.disposition as DiscoveryDisposition,
    rulesLinks,
    platformHint: (data.platformHint ?? "unknown") as DiscoveryMetadata["platformHint"],
  };
}

export function readDiscoveryRecord(
  item: CampaignItem,
  jobs: CampaignJob[] = [],
): DiscoveryRecord | null {
  const metadata = readDiscoveryMetadata(item);
  if (!metadata) return null;
  const operation = metadata.purpose === "search" ? "discovery_search" : "discovery_inspect";
  const job = [...jobs]
    .reverse()
    .find((candidate) => candidate.itemId === item.id && candidate.operation === operation);
  return {
    item,
    metadata,
    job,
    excerpt: readExcerpt(item),
  };
}

function readExcerpt(item: CampaignItem): string {
  const details = record(item.details);
  const evidence = record(details?.evidence);
  const excerpt =
    typeof details?.excerpt === "string"
      ? details.excerpt
      : typeof evidence?.excerpt === "string"
        ? evidence.excerpt
        : item.body;
  return excerpt.slice(0, 2_000);
}

export function summarizeDiscovery(items: CampaignItem[], jobs: CampaignJob[]): DiscoverySummary {
  const searches: DiscoveryRecord[] = [];
  const candidates: DiscoveryRecord[] = [];
  for (const item of items) {
    const result = readDiscoveryRecord(item, jobs);
    if (!result) continue;
    if (result.metadata.purpose === "search") searches.push(result);
    else candidates.push(result);
  }
  return { searches, candidates };
}
