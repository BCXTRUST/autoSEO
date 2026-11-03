import type { CampaignItem, CampaignJob } from "./campaign-types";

export interface CatalogMetadata {
  runId: string;
  rootUrl: string;
  purpose: string;
  category: string;
  provenance: string;
  depth: number;
}

export interface CatalogEvidence {
  id?: string;
  url?: string;
  title?: string;
  excerpt?: string;
  fetchedAt?: string;
}

export interface CatalogCandidate {
  url: string;
  label: string;
  category: string;
  status: "candidate";
}

export interface CatalogPage {
  item: CampaignItem;
  metadata: CatalogMetadata;
  evidence: CatalogEvidence[];
  candidates: CatalogCandidate[];
}

export interface CatalogProgress {
  pages: CatalogPage[];
  jobs: CampaignJob[];
  candidates: CatalogCandidate[];
  queued: number;
  running: number;
  deferred: number;
  needsAction: number;
  notFound: number;
  succeeded: number;
  guidanceBlocked: boolean;
  guidanceSkipped: boolean;
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

function normalizedWebsiteUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value);
}

function readEvidence(value: unknown): CatalogEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    const source = record(entry);
    if (!source) return [];
    const evidence: CatalogEvidence = {};
    for (const key of ["id", "url", "title", "excerpt", "fetchedAt"] as const) {
      const candidate = source[key];
      const limit = key === "excerpt" ? 2_000 : 500;
      if (typeof candidate === "string" && candidate.length <= limit) {
        if (key === "url" && !safeHttpUrl(candidate)) continue;
        evidence[key] = candidate;
      }
    }
    return Object.keys(evidence).length ? [evidence] : [];
  });
}

function readCandidates(value: unknown): CatalogCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((entry) => {
    const source = record(entry);
    if (
      !source ||
      !safeHttpUrl(source.url) ||
      typeof source.label !== "string" ||
      source.label.length === 0 ||
      source.label.length > 200 ||
      !safeToken(source.category) ||
      source.status !== "candidate"
    ) {
      return [];
    }
    return [
      {
        url: source.url,
        label: source.label,
        category: source.category,
        status: "candidate" as const,
      },
    ];
  });
}

export function readCatalogPage(item: CampaignItem): CatalogPage | null {
  if (item.kind !== "source") return null;
  const details = record(item.details);
  const catalog = record(details?.catalog);
  if (
    !catalog ||
    typeof catalog.runId !== "string" ||
    !/^[a-f0-9]{64}$/.test(catalog.runId) ||
    !safeHttpUrl(catalog.rootUrl) ||
    !safeToken(catalog.purpose) ||
    !safeToken(catalog.category) ||
    !safeToken(catalog.provenance) ||
    typeof catalog.depth !== "number" ||
    !Number.isSafeInteger(catalog.depth) ||
    catalog.depth < 0 ||
    catalog.depth > 2
  ) {
    return null;
  }
  return {
    item,
    metadata: {
      runId: catalog.runId,
      rootUrl: catalog.rootUrl,
      purpose: catalog.purpose,
      category: catalog.category,
      provenance: catalog.provenance,
      depth: catalog.depth,
    },
    evidence: readEvidence(details?.evidence),
    candidates: readCandidates(details?.observedLinks),
  };
}

export function isExpectedCatalogAbsence(
  item: CampaignItem | undefined,
  job: CampaignJob,
): boolean {
  if (
    !item ||
    job.operation !== "catalog_page" ||
    job.itemId !== item.id ||
    job.status !== "failed" ||
    job.lastError !== "page_absent"
  ) {
    return false;
  }
  const page = readCatalogPage(item);
  return page?.metadata.purpose === "page" && page.metadata.provenance === "conventional_probe";
}

export function hasCatalogJobsForWebsite(
  items: CampaignItem[],
  jobs: CampaignJob[],
  websiteUrl: string | undefined,
): boolean {
  const rootUrl = websiteUrl ? normalizedWebsiteUrl(websiteUrl) : undefined;
  if (!rootUrl) return false;
  const itemById = new Map(items.map((item) => [item.id, item]));
  return jobs.some((job) => {
    if (job.operation !== "catalog_page" || !job.itemId) return false;
    const item = itemById.get(job.itemId);
    return item ? readCatalogPage(item)?.metadata.rootUrl === rootUrl : false;
  });
}

export function summarizeCatalog(
  items: CampaignItem[],
  allJobs: CampaignJob[],
  currentWebsiteUrl?: string,
): CatalogProgress {
  const pages = items.flatMap((item) => {
    const page = readCatalogPage(item);
    return page ? [page] : [];
  });
  const jobs = allJobs.filter((job) => job.operation === "catalog_page");
  const itemById = new Map(items.map((item) => [item.id, item]));
  const expectedAbsences = jobs.filter((job) =>
    isExpectedCatalogAbsence(job.itemId ? itemById.get(job.itemId) : undefined, job),
  );
  const supersededGuidance = (item: CampaignItem) =>
    jobs.some(
      (job) =>
        job.itemId === item.id && job.status === "cancelled" && job.lastError === "website_changed",
    );
  const currentRootUrl = currentWebsiteUrl ? normalizedWebsiteUrl(currentWebsiteUrl) : undefined;
  const isCurrentGuidance = (page: CatalogPage) =>
    currentRootUrl === undefined || page.metadata.rootUrl === currentRootUrl;
  const candidates = pages.flatMap((page) => page.candidates);
  return {
    pages,
    jobs,
    candidates,
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => ["running", "reconciling"].includes(job.status)).length,
    deferred: jobs.filter((job) => job.status === "deferred").length,
    needsAction: jobs.filter(
      (job) =>
        ["needs_action", "failed"].includes(job.status) &&
        !isExpectedCatalogAbsence(job.itemId ? itemById.get(job.itemId) : undefined, job),
    ).length,
    notFound: expectedAbsences.length,
    succeeded: jobs.filter((job) => job.status === "succeeded").length,
    guidanceBlocked: pages.some((page) => {
      if (
        page.metadata.purpose !== "guidance" ||
        !["needs_action", "failed"].includes(page.item.status) ||
        !isCurrentGuidance(page) ||
        supersededGuidance(page.item)
      )
        return false;
      const details = record(page.item.details);
      return (
        details?.recoveryReason !==
        "Website catalog crawling is blocked because guidance was skipped."
      );
    }),
    guidanceSkipped: pages.some((page) => {
      if (
        page.metadata.purpose !== "guidance" ||
        page.item.status !== "failed" ||
        !isCurrentGuidance(page) ||
        supersededGuidance(page.item)
      )
        return false;
      const details = record(page.item.details);
      return (
        details?.recoveryReason ===
        "Website catalog crawling is blocked because guidance was skipped."
      );
    }),
  };
}
