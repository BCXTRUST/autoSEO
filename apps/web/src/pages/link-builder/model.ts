import {
  LB_RESPONSIBILITY_ACK_SENTENCE,
  type LbDisclosureMode,
  type LbHostStatus,
  type LbMarket,
  type LbMarketPolicy,
  LbPersonaSchema,
  type LbProjectDetail,
  LbQuotasSchema,
  LbRegistrableDomainSchema,
  LbScheduleSchema,
} from "@rakazo/contracts";
import {
  brandNameSources,
  defaultMarketForCountry,
  LB_WIZARD_COUNTRIES,
  registrableDomain,
  resolvePersonaDisplayName,
  validateTargetUrl,
} from "@rakazo/linkbuilder-core";

export const RESPONSIBILITY_SENTENCE = LB_RESPONSIBILITY_ACK_SENTENCE;

export const WIZARD_STEPS = [
  "Brand",
  "Who writes",
  "How many links",
  "Which pages",
  "Start",
] as const;

/** One short line under each step title. Same order as `WIZARD_STEPS`. */
export const WIZARD_STEP_HINTS = [
  "The name people know, and the sites posts may link to.",
  "The name and voice used on forums.",
  "How many links to post each day, and each week.",
  "The pages posts may link to, and what to say about them.",
  "Check this, then start.",
] as const;

/** Placeholder hosts must never appear on a setup screen. */
export function isSetupPlaceholder(value: string | null | undefined): boolean {
  return /inbox\.example|proxy\.example/i.test(value ?? "");
}

export const QUOTA_LABELS = {
  newPerDay: "New accounts per day",
  livePerDay: "Live links per day",
  liveWeek: "Live links per week",
} as const;

export const FUNNEL_COLUMNS = [
  { id: "discovered", label: "Discovered", statuses: ["discovered", "probed"] },
  { id: "qualified", label: "Qualified", statuses: ["qualified"] },
  {
    id: "warming",
    label: "Warming",
    statuses: ["registering", "pending_email", "pending_admin", "warming"],
  },
  { id: "ready", label: "Ready", statuses: ["ready"] },
  { id: "used", label: "Used", statuses: ["used"] },
  { id: "parked", label: "Parked", statuses: ["parked_operator"] },
  {
    id: "blocked",
    label: "Blocked",
    statuses: ["denied", "spam_blocked", "unsupported_captcha", "dead"],
  },
] as const;

export function funnelColumnId(status: LbHostStatus): (typeof FUNNEL_COLUMNS)[number]["id"] {
  return (
    FUNNEL_COLUMNS.find((column) => (column.statuses as readonly string[]).includes(status))?.id ??
    "blocked"
  );
}

export const PAGE_BOX_LIMIT = 40;

export interface WizardPage {
  id: string;
  url: string;
  keyword: string;
  rules: string;
}

export interface WizardDraft {
  name: string;
  slug: string;
  brandName: string;
  allowedDomains: string;
  displayName: string;
  bio: string;
  register: "du" | "sie";
  mailboxAddress: string | null;
  mailboxId: string | null;
  captchaToken: string;
  captchaConfigured: boolean;
  balance: number | null;
  newPerDay: string;
  livePerDay: string;
  liveWeekCap: string;
  timezone: string;
  weekdaysOnly: boolean;
  windowStart: string;
  windowEnd: string;
  overtime: boolean;
  hardStopHour: string;
  pages: WizardPage[];
  markets: LbMarket[];
  marketPolicy: LbMarketPolicy;
  denyHosts: string;
  links: string;
  posts: string;
  disclosureMode: LbDisclosureMode;
}

export function emptyDraft(): WizardDraft {
  const market = defaultMarketForCountry("DE");
  return {
    name: "",
    slug: "",
    brandName: "",
    allowedDomains: "",
    displayName: "",
    bio: "",
    register: "du",
    mailboxAddress: null,
    mailboxId: null,
    captchaToken: "",
    captchaConfigured: false,
    balance: null,
    newPerDay: "2",
    livePerDay: "1",
    liveWeekCap: "5",
    timezone: market.timezoneId,
    weekdaysOnly: true,
    windowStart: "09:00",
    windowEnd: "22:00",
    overtime: false,
    hardStopHour: "24",
    pages: [emptyPage()],
    markets: [market],
    marketPolicy: "primary_first",
    denyHosts: "",
    links: "1",
    posts: "3",
    disclosureMode: "undisclosed_persona",
  };
}

export function draftFromProject(project: LbProjectDetail): WizardDraft {
  const base = emptyDraft();
  return {
    ...base,
    name: project.name,
    slug: project.slug,
    brandName: project.brandName,
    allowedDomains: project.allowedDomains.join(", "),
    displayName: project.persona?.displayName ?? "",
    bio: project.persona?.bio ?? "",
    register: project.persona?.register ?? "du",
    mailboxAddress: project.mailboxAddress,
    mailboxId: project.mailboxId,
    captchaConfigured: project.captchaConfigured,
    balance: project.captchaConfigured ? base.balance : null,
    newPerDay: project.quotas ? String(project.quotas.newPerDay) : base.newPerDay,
    livePerDay: project.quotas ? String(project.quotas.livePerDay) : base.livePerDay,
    liveWeekCap:
      project.quotas?.liveWeekCap !== undefined ? String(project.quotas.liveWeekCap) : "",
    timezone: project.schedule.timezone,
    weekdaysOnly: project.schedule.weekdaysOnly,
    windowStart: project.schedule.window.start,
    windowEnd: project.schedule.window.end,
    overtime: project.schedule.overtimeUntilLiveMet,
    hardStopHour: String(project.schedule.hardStopHour),
    pages: pagesFromProject(project),
    markets: project.markets,
    marketPolicy: project.marketPolicy,
    denyHosts: project.denyHosts.join(", "),
    links: String(project.linkRatio.links),
    posts: String(project.linkRatio.posts),
    disclosureMode: project.disclosureMode,
  };
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export function wizardStepIssues(step: number, draft: WizardDraft): string[] {
  const review = WIZARD_STEPS.length - 1;
  if (step === review) {
    const issues = Array.from({ length: review }, (_, index) =>
      wizardStepIssues(index, draft),
    ).flat();
    if (!draft.mailboxId) issues.push("Not ready yet. Wait a moment, then try again.");
    return issues;
  }
  if (step === 0) return brandIssues(draft);
  if (step === 1) return personaIssues(draft);
  if (step === 2) return quotaIssues(draft);
  if (step === 3) return topicIssues(draft);
  return ["Unknown step"];
}

export function canStart(draft: WizardDraft): boolean {
  return wizardStepIssues(WIZARD_STEPS.length - 1, draft).length === 0;
}

export function artifactImageSrc(artifact: {
  mimeType: string;
  contentBase64: string;
}): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(artifact.mimeType)) return null;
  return `data:${artifact.mimeType};base64,${artifact.contentBase64}`;
}

export function warmupNote(hours = 24): string {
  const days = Math.max(1, Math.ceil(hours / 24));
  const span = days === 1 ? "1 day" : `${days} days`;
  return `The first live link waits about ${span}. Until then the account posts without a link.`;
}

export function disclosureLabel(mode: string): string {
  if (mode === "undisclosed_persona") return "Writes as the persona";
  if (mode === "disclosed_persona") return "Persona, and says it is a promotion";
  if (mode === "disclosed_brand") return "Writes as the brand";
  if (mode === "drafts_only") return "Drafts only, nothing is posted";
  return mode.replaceAll("_", " ");
}

export function addMarket(draft: WizardDraft, country: string): WizardDraft {
  const next = defaultMarketForCountry(country);
  if (
    draft.markets.some(
      (market) => market.country === next.country && market.language === next.language,
    )
  ) {
    return draft;
  }
  const markets = [...draft.markets, next];
  return { ...draft, markets, timezone: markets[0]?.timezoneId ?? draft.timezone };
}

export function removeMarket(draft: WizardDraft, index: number): WizardDraft {
  const markets = draft.markets.filter((_, item) => item !== index);
  const next = markets.length > 0 ? markets : [defaultMarketForCountry("DE")];
  return { ...draft, markets: next, timezone: next[0]?.timezoneId ?? draft.timezone };
}

export function makePrimary(draft: WizardDraft, index: number): WizardDraft {
  const market = draft.markets[index];
  if (!market) return draft;
  const markets = [market, ...draft.markets.filter((_, item) => item !== index)];
  return { ...draft, markets, timezone: market.timezoneId };
}

export function updateMarketLocale(
  draft: WizardDraft,
  index: number,
  locale: string,
  timezoneId: string,
): WizardDraft {
  const markets = draft.markets.map((market, item) =>
    item === index ? { ...market, locale, timezoneId } : market,
  );
  return { ...draft, markets, timezone: index === 0 ? timezoneId : draft.timezone };
}

export { LB_WIZARD_COUNTRIES };

export type ParsedSite = { ok: true; domain: string; targetUrl: string | null } | { ok: false };

/** Accept a bare host, www, http(s), or a path. Store the registrable domain. */
export function parseAllowedSite(raw: string): ParsedSite {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return { ok: false };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
  if (url.username || url.password) return { ok: false };
  const domain = registrableDomain(url.hostname);
  if (!domain || !LbRegistrableDomainSchema.safeParse(domain).success) return { ok: false };
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return { ok: true, domain, targetUrl: null };
  url.hash = "";
  url.pathname = path;
  return { ok: true, domain, targetUrl: url.toString() };
}

export function parsedSites(value: string): ParsedSite[] {
  return splitList(value).map(parseAllowedSite);
}

function personalDisplayName(draft: WizardDraft): string {
  const domains = parsedSites(draft.allowedDomains).flatMap((site) =>
    site.ok ? [site.domain] : [],
  );
  return resolvePersonaDisplayName({
    displayName: draft.displayName,
    language: draft.markets[0]?.language ?? "de",
    sources: brandNameSources({
      brandName: draft.brandName,
      projectName: draft.name,
      slug: draft.slug,
      domains,
    }),
  });
}

export function withPersonaPrefill(draft: WizardDraft): WizardDraft {
  const brand = draft.brandName.trim() || draft.name.trim();
  const sites = parsedSites(draft.allowedDomains).filter(
    (site): site is Extract<ParsedSite, { ok: true }> => site.ok,
  );
  const section = sites
    .map((site) => (site.targetUrl ? new URL(site.targetUrl).pathname : ""))
    .find((path) => path.length > 1);
  return {
    ...draft,
    displayName: personalDisplayName(draft),
    bio: draft.bio.trim() ? draft.bio : suggestBio(brand, draft.markets[0]?.language, section),
  };
}

function suggestBio(brand: string, language: string | undefined, section?: string): string {
  const name = brand || "the brand";
  if (language === "de") {
    return section
      ? `Antwortet ruhig und konkret. Kennt ${name}, vor allem die Seiten unter ${section}.`
      : `Antwortet ruhig und konkret. Kennt ${name} und bleibt bei dem, was die Seite sagt.`;
  }
  return section
    ? `Replies in a calm, specific voice. Knows ${name}, especially the pages under ${section}.`
    : `Replies in a calm, specific voice. Knows ${name} and stays with what the page says.`;
}

function brandIssues(draft: WizardDraft): string[] {
  const issues: string[] = [];
  if (draft.name.trim().length === 0) issues.push("Name is required");
  if (draft.brandName.trim().length === 0) issues.push("Brand is required");
  const sites = splitList(draft.allowedDomains);
  if (sites.length === 0) issues.push("Add at least one site");
  for (const site of sites) {
    if (!parseAllowedSite(site).ok) issues.push(`Site ${site} is not a valid address`);
  }
  const slug = draft.slug.trim() || slugifyProjectName(draft.name);
  if (draft.name.trim() && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) issues.push("Slug looks wrong");
  return issues;
}

function personaIssues(draft: WizardDraft): string[] {
  const parsed = LbPersonaSchema.safeParse({
    displayName: draft.displayName,
    bio: draft.bio,
    register: draft.register,
    language: draft.markets[0]?.language,
  });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function quotaIssues(draft: WizardDraft): string[] {
  const issues: string[] = [];
  const quotas = LbQuotasSchema.safeParse({
    newPerDay: Number(draft.newPerDay),
    livePerDay: Number(draft.livePerDay),
    liveWeekCap: draft.liveWeekCap.trim() === "" ? undefined : Number(draft.liveWeekCap),
    maxLivePerHost: 1,
  });
  if (!quotas.success) issues.push(quotas.error.issues[0]?.message ?? "Quotas look wrong");
  const schedule = LbScheduleSchema.safeParse({
    timezone: draft.timezone,
    weekdaysOnly: draft.weekdaysOnly,
    window: { start: draft.windowStart, end: draft.windowEnd },
    overtimeUntilLiveMet: draft.overtime,
    hardStopHour: Number(draft.hardStopHour),
  });
  if (!schedule.success) issues.push(schedule.error.issues[0]?.message ?? "Schedule looks wrong");
  return issues;
}

function topicIssues(draft: WizardDraft): string[] {
  const issues: string[] = [];
  const domains = pageDomains(draft);
  const pages = draft.pages.slice(0, PAGE_BOX_LIMIT);
  const filled = pages.filter(
    (page) => page.url.trim() || page.keyword.trim() || page.rules.trim(),
  );
  if (filled.length === 0) return ["Add a page"];
  for (const page of filled) {
    const number = pages.indexOf(page) + 1;
    const url = normalizePageUrl(page.url);
    if (!url) {
      if (page.url.trim()) {
        issues.push(`Page ${number} looks wrong`);
        continue;
      }
      if (!page.keyword.trim()) {
        issues.push(`Add the address for page ${number}`);
        continue;
      }
      if (page.keyword.trim().length > 80) issues.push(`Keyword for page ${number} is too long`);
      continue;
    }
    const checked = validateTargetUrl(url, domains);
    if (!checked.ok) issues.push(`Page ${number} must be on a site you added`);
    if (!page.keyword.trim()) issues.push(`Add a keyword for page ${number}`);
    else if (page.keyword.trim().length > 80) issues.push(`Keyword for page ${number} is too long`);
  }
  return issues;
}

function newPageId(): string {
  return `page-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyPage(): WizardPage {
  return { id: newPageId(), url: "", keyword: "", rules: "" };
}

export function normalizePageUrl(raw: string): string | null {
  const parsed = parseAllowedSite(raw);
  if (!parsed.ok) return null;
  return parsed.targetUrl ?? `https://${parsed.domain}`;
}

export function pageDomains(draft: WizardDraft): string[] {
  return [
    ...new Set(parsedSites(draft.allowedDomains).flatMap((site) => (site.ok ? [site.domain] : []))),
  ];
}

export function firstSiteUrl(draft: WizardDraft): string | null {
  for (const site of parsedSites(draft.allowedDomains)) {
    if (!site.ok) continue;
    return site.targetUrl ?? `https://${site.domain}`;
  }
  return null;
}

/** Copy the brand site into the first page when no page address is set yet. */
export function withPagePrefill(draft: WizardDraft): WizardDraft {
  const site = firstSiteUrl(draft);
  const pages = draft.pages.length > 0 ? draft.pages.slice(0, PAGE_BOX_LIMIT) : [emptyPage()];
  if (!site || pages.some((page) => page.url.trim())) return { ...draft, pages };
  const [first, ...rest] = pages;
  if (!first || first.keyword.trim() || first.rules.trim()) return { ...draft, pages };
  return { ...draft, pages: [{ ...first, url: site }, ...rest] };
}

export function dropBlankPages(draft: WizardDraft): WizardDraft {
  const pages = draft.pages.filter(
    (page) => page.url.trim() || page.keyword.trim() || page.rules.trim(),
  );
  if (pages.length === 0) return { ...draft, pages: draft.pages.slice(0, 1) };
  return { ...draft, pages: pages.slice(0, PAGE_BOX_LIMIT) };
}

export function addWizardPage(draft: WizardDraft): WizardDraft {
  if (draft.pages.length >= PAGE_BOX_LIMIT) return draft;
  return { ...draft, pages: [...draft.pages, emptyPage()] };
}

export function removeWizardPage(draft: WizardDraft, index: number): WizardDraft {
  if (draft.pages.length <= 1) return draft;
  return { ...draft, pages: draft.pages.filter((_, item) => item !== index) };
}

function sameKeyword(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("de") === right.trim().toLocaleLowerCase("de");
}

function pagesFromProject(project: LbProjectDetail): WizardPage[] {
  const facts = project.facts.join("\n");
  const lanes = project.topicLanes;
  const targets = project.targets;
  if (targets.length === 0) {
    if (lanes.length === 0) return [emptyPage()];
    return lanes.slice(0, PAGE_BOX_LIMIT).map((lane) => ({
      id: lane.id,
      url: "",
      keyword: lane.tag,
      rules: lane.description || facts,
    }));
  }
  const lanesCoverTargets =
    lanes.length > 0 &&
    targets.every((target) =>
      target.keywordClusters.some((keyword) =>
        lanes.some((lane) => sameKeyword(lane.tag, keyword)),
      ),
    );
  if (lanesCoverTargets) {
    return lanes.slice(0, PAGE_BOX_LIMIT).map((lane) => {
      const target = targets.find((item) =>
        item.keywordClusters.some((keyword) => sameKeyword(keyword, lane.tag)),
      );
      return {
        id: lane.id,
        url: target?.url ?? "",
        keyword: lane.tag,
        rules: target?.description || lane.description || (targets.length === 1 ? facts : ""),
      };
    });
  }
  return targets.slice(0, PAGE_BOX_LIMIT).map((target, index) => {
    const lane = lanes[index] ?? (targets.length === 1 ? lanes[0] : undefined);
    return {
      id: lane?.id ?? `page-${index + 1}`,
      url: target.url,
      keyword: target.keywordClusters.join(", ") || lane?.tag || "",
      rules: target.description || lane?.description || (targets.length === 1 ? facts : ""),
    };
  });
}

export function patchFromDraft(draft: WizardDraft) {
  const prepared = withPagePrefill(dropBlankPages(draft));
  const sites = parsedSites(prepared.allowedDomains).filter(
    (site): site is Extract<ParsedSite, { ok: true }> => site.ok,
  );
  const domains = [...new Set(sites.map((site) => site.domain))];
  const pages = prepared.pages.slice(0, PAGE_BOX_LIMIT);
  const lanes = pages
    .filter((page) => page.keyword.trim())
    .map((page) => ({
      id: page.id,
      tag: page.keyword.trim().slice(0, 40),
      description: page.rules.trim().slice(0, 500),
      exampleQuestions: [] as string[],
    }));
  const targets = pages.flatMap((page) => {
    const url = normalizePageUrl(page.url);
    if (!url) return [];
    const keyword = page.keyword.trim().slice(0, 80);
    return [
      {
        url,
        priority: 50,
        description: page.rules.trim().slice(0, 300),
        keywordClusters: keyword ? [keyword] : [],
      },
    ];
  });
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim() || slugifyProjectName(draft.name),
    brandName: draft.brandName.trim(),
    allowedDomains: domains,
    persona: {
      displayName: personalDisplayName(draft),
      bio: draft.bio,
      register: draft.register,
      language: draft.markets[0]?.language,
    },
    quotas: {
      newPerDay: Number(draft.newPerDay),
      livePerDay: Number(draft.livePerDay),
      ...(draft.liveWeekCap.trim() ? { liveWeekCap: Number(draft.liveWeekCap) } : {}),
      maxLivePerHost: 1 as const,
    },
    schedule: {
      timezone: draft.timezone,
      weekdaysOnly: draft.weekdaysOnly,
      window: { start: draft.windowStart, end: draft.windowEnd },
      overtimeUntilLiveMet: draft.overtime,
      hardStopHour: Number(draft.hardStopHour),
    },
    topicLanes: lanes,
    targets,
    facts: pages
      .map((page) => page.rules.trim())
      .filter(Boolean)
      .map((rule) => rule.slice(0, 500)),
    markets: draft.markets,
    marketPolicy: draft.marketPolicy,
    denyHosts: splitList(draft.denyHosts),
    linkRatio: { links: Number(draft.links), posts: Number(draft.posts) },
    disclosureMode: draft.disclosureMode,
    captchaToken: draft.captchaConfigured ? undefined : draft.captchaToken || undefined,
    provisionMailbox: true,
  };
}
