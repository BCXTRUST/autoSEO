import { JSDOM } from "jsdom";
import {
  CampaignResearchError,
  fetchCampaignPublicResource,
  validateCampaignResearchUrl,
} from "./campaign-research.js";

const MAX_LINKS = 100;
const MAX_TEXT_CHARS = 18_000;
const MAX_ROBOTS_CHARS = 64 * 1024;
const MAX_ROBOTS_RULES_PER_KIND = 100;
const DEFAULT_TIMEOUT_MS = 8_000;
export const CAMPAIGN_CATALOG_USER_AGENT = "AutoSEO";

export interface CampaignCatalogPage {
  url: string;
  title: string;
  text: string;
  contentType: "text/html" | "text/plain" | "application/xml";
  fetchedAt: string;
  links: Array<{ url: string; label: string }>;
  httpStatus: number;
  /** Raw line-preserving robots.txt, bounded independently from the normalized evidence text. */
  robotsText?: string;
}

export class CampaignCatalogError extends Error {
  constructor(
    readonly kind: "transient" | "invalid_input" | "unsupported",
    readonly safeCode: string,
  ) {
    super(safeCode);
    this.name = "CampaignCatalogError";
  }
}

export interface CatalogRobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

/** Fetches and parses one public catalog page without cookies, credentials, or page execution. */
export async function fetchCampaignCatalogPage(
  input: string,
  options: {
    allowedOrigin: string;
    allowedUrl?: (url: string) => boolean;
    signal?: AbortSignal;
    now?: () => Date;
    timeoutMs?: number;
  },
): Promise<CampaignCatalogPage> {
  try {
    const initialUrl = validateCampaignResearchUrl(input);
    const allowedOrigin = validateCampaignResearchUrl(options.allowedOrigin).origin;
    if (initialUrl.origin !== allowedOrigin) {
      throw new CampaignCatalogError("invalid_input", "origin_mismatch");
    }
    if (options.allowedUrl && !options.allowedUrl(initialUrl.toString())) {
      throw new CampaignCatalogError("unsupported", "robots_disallowed");
    }
    const resource = await fetchCampaignPublicResource(input, {
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      allowedOrigin,
      allowedUrl: options.allowedUrl,
      userAgent: CAMPAIGN_CATALOG_USER_AGENT,
      accept: "text/html, text/plain;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1",
      readContentTypes: [
        "text/html",
        "text/plain",
        "application/xml",
        "text/xml",
        "application/xhtml+xml",
        "application/rss+xml",
        "application/atom+xml",
      ],
    });
    if (resource.httpStatus === 404 || resource.httpStatus === 410) {
      throw new CampaignCatalogError("unsupported", "page_absent");
    }
    if (resource.httpStatus === 401 || resource.httpStatus === 403) {
      throw new CampaignCatalogError("unsupported", "page_forbidden");
    }
    if (resource.httpStatus === 429) throw new CampaignCatalogError("transient", "rate_limited");
    if (resource.httpStatus >= 500) throw new CampaignCatalogError("transient", "server_error");
    if (resource.httpStatus < 200 || resource.httpStatus >= 300) {
      throw new CampaignCatalogError("unsupported", "http_status");
    }

    const normalizedType = normalizeContentType(resource.contentType);
    if (!normalizedType) throw new CampaignCatalogError("unsupported", "content_type_unsupported");
    const isRobotsPath = new URL(resource.url).pathname.toLowerCase().endsWith("/robots.txt");
    if (isRobotsPath && normalizedType !== "text/plain") {
      throw new CampaignCatalogError("unsupported", "robots_content_type");
    }
    const isRobotsFile = normalizedType === "text/plain" && isRobotsPath;
    if (isRobotsFile && resource.body.length > MAX_ROBOTS_CHARS) {
      throw new CampaignCatalogError("unsupported", "robots_too_large");
    }
    const parsed = parseCatalogContent(resource.body, normalizedType, resource.url);
    const isEmptyRobotsFile = isRobotsFile && !parsed.text && parsed.links.length === 0;
    if (!parsed.text && parsed.links.length === 0 && !isEmptyRobotsFile) {
      throw new CampaignCatalogError("unsupported", "page_has_no_catalog_content");
    }
    return {
      url: resource.url,
      title: isEmptyRobotsFile ? "robots.txt" : parsed.title.slice(0, 200) || "Untitled page",
      text: parsed.text.slice(0, MAX_TEXT_CHARS),
      contentType: normalizedType,
      fetchedAt: (options.now?.() ?? new Date()).toISOString(),
      links: parsed.links.slice(0, MAX_LINKS),
      httpStatus: resource.httpStatus,
      ...(isRobotsFile ? { robotsText: resource.body } : {}),
    };
  } catch (error) {
    if (error instanceof CampaignCatalogError) throw error;
    if (error instanceof CampaignResearchError) {
      throw new CampaignCatalogError(error.kind, error.safeCode);
    }
    throw new CampaignCatalogError("transient", "fetch_failed");
  }
}

/** Returns a stable same-origin URL suitable for queueing as a catalog candidate. */
export function canonicalCatalogUrl(input: string, rootUrl: string): string | null {
  let root: URL;
  let url: URL;
  try {
    root = validateCampaignResearchUrl(rootUrl);
    url = new URL(input, root);
  } catch {
    return null;
  }
  if (
    input.length > 2_048 ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.origin !== root.origin
  ) {
    return null;
  }
  let decodedPath = url.pathname.toLowerCase();
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    return null;
  }
  if (
    /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|m4a|m4v|mov|mp3|mp4|pdf|png|pptx?|rar|svg|tar|tgz|ttf|webm|webp|woff2?|xlsx?|zip)$/i.test(
      decodedPath,
    ) ||
    /(?:^|\/)(?:admin|api|auth|cart|checkout|login|logout|register|search|signin|signup|wp-admin)(?:\/|$)/i.test(
      decodedPath,
    ) ||
    [...url.searchParams.keys()].some((key) => /^(?:q|query|search|keyword|term)$/i.test(key))
  ) {
    return null;
  }
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("utm_") ||
      ["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "ref_src"].includes(lower)
    ) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

/** A heuristic route label only; it does not establish facts about the linked page. */
export function classifyCatalogPage(
  input: string,
  label = "",
): "homepage" | "app" | "shop" | "device" | "article" | "llm" | "other" {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "other";
  }
  const path = `${url.pathname} ${label}`.toLowerCase();
  if (
    /(?:^|\/)(?:llms(?:-full)?\.txt|ai\.txt)$/.test(url.pathname.toLowerCase()) ||
    /\b(?:llms\.txt|machine-readable|ai guidance)\b/.test(label.toLowerCase())
  )
    return "llm";
  if (url.pathname === "/" || url.pathname === "") return "homepage";
  if (/\b(?:device|devices|hardware|router|modem|gateway)\b/.test(path)) return "device";
  if (
    /(?:^|\/)(?:shop|store|product|products|collection|collections)(?:\/|$)/.test(
      url.pathname.toLowerCase(),
    ) ||
    /\b(?:shop|store|catalog|products?)\b/.test(label.toLowerCase())
  )
    return "shop";
  if (
    /(?:^|\/)(?:app|dashboard|workspace)(?:\/|$)/.test(url.pathname.toLowerCase()) ||
    /\b(?:app|dashboard|workspace)\b/.test(label.toLowerCase())
  )
    return "app";
  if (
    /(?:^|\/)(?:blog|article|articles|news|post|posts|docs|guide)(?:\/|$)/.test(
      url.pathname.toLowerCase(),
    ) ||
    /\b(?:blog|article|news|guide|documentation)\b/.test(label.toLowerCase())
  )
    return "article";
  return "other";
}

/** Parses robots.txt user-agent `*` rules and same-origin sitemap declarations. */
export function parseCatalogRobots(text: string, rootUrl: string): CatalogRobotsRules {
  if (text.length > MAX_ROBOTS_CHARS)
    throw new CampaignCatalogError("unsupported", "robots_too_large");
  let root: URL;
  try {
    root = validateCampaignResearchUrl(rootUrl);
  } catch {
    throw new CampaignCatalogError("invalid_input", "root_url_invalid");
  }
  type Group = {
    agents: string[];
    allow: string[];
    disallow: string[];
    unsupportedDirective: boolean;
    hasRules: boolean;
  };
  const groups: Group[] = [];
  let group: Group = {
    agents: [],
    allow: [],
    disallow: [],
    unsupportedDirective: false,
    hasRules: false,
  };
  const sitemaps: string[] = [];
  let ruleCount = 0;
  for (const original of text.split(/\r?\n/)) {
    if (original.length > 2_048)
      throw new CampaignCatalogError("unsupported", "robots_line_too_long");
    const line = original.split("#", 1)[0]!.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "sitemap") {
      if (value.length > 2_048) {
        throw new CampaignCatalogError("unsupported", "robots_url_too_long");
      }
      const candidate = canonicalCatalogUrl(value, root.toString());
      if (candidate && !sitemaps.includes(candidate)) {
        sitemaps.push(candidate);
        if (sitemaps.length > MAX_LINKS) {
          throw new CampaignCatalogError("unsupported", "robots_rule_limit");
        }
      }
      continue;
    }
    if (name === "user-agent") {
      if (group.hasRules) {
        groups.push(group);
        group = {
          agents: [],
          allow: [],
          disallow: [],
          unsupportedDirective: false,
          hasRules: false,
        };
      }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }
    if (name === "allow" || name === "disallow") {
      if (!group.agents.length) continue;
      group.hasRules = true;
      if (!value) continue;
      if (!value.startsWith("/") || value.length > 2_048) {
        group.unsupportedDirective = true;
        continue;
      }
      const currentRules = group[name];
      ruleCount += 1;
      if (
        ruleCount > MAX_ROBOTS_RULES_PER_KIND * 2 ||
        currentRules.length >= MAX_ROBOTS_RULES_PER_KIND ||
        (value.match(/\*/g)?.length ?? 0) > 16
      ) {
        throw new CampaignCatalogError("unsupported", "robots_rule_limit");
      }
      group[name].push(value);
      continue;
    }
    if (group.agents.length) {
      group.unsupportedDirective = true;
      group.hasRules = true;
    }
  }
  if (group.agents.length) groups.push(group);
  const namedAgent = CAMPAIGN_CATALOG_USER_AGENT.toLowerCase();
  const namedGroups = groups.filter((entry) => entry.agents.includes(namedAgent));
  const applicable = namedGroups.length
    ? namedGroups
    : groups.filter((entry) => entry.agents.includes("*"));
  if (applicable.some((entry) => entry.unsupportedDirective)) {
    throw new CampaignCatalogError("unsupported", "robots_directive_unsupported");
  }
  const allow = unique(applicable.flatMap((entry) => entry.allow));
  const disallow = unique(applicable.flatMap((entry) => entry.disallow));
  if (allow.length > MAX_ROBOTS_RULES_PER_KIND || disallow.length > MAX_ROBOTS_RULES_PER_KIND) {
    throw new CampaignCatalogError("unsupported", "robots_rule_limit");
  }
  return { allow, disallow, sitemaps };
}

/** Applies standard longest-path precedence; an equal-length allow rule wins. */
export function isCatalogUrlAllowed(input: string, rules: CatalogRobotsRules): boolean {
  if (
    input.length > 4_096 ||
    rules.allow.length > MAX_ROBOTS_RULES_PER_KIND ||
    rules.disallow.length > MAX_ROBOTS_RULES_PER_KIND
  )
    return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const target = `${url.pathname}${url.search}`;
  const matches = [
    ...rules.allow.map((pattern) => ({ pattern, allow: true })),
    ...rules.disallow.map((pattern) => ({ pattern, allow: false })),
  ]
    .filter(({ pattern }) => robotsPatternMatches(pattern, target))
    .sort((a, b) => robotsSpecificity(b.pattern) - robotsSpecificity(a.pattern));
  if (!matches.length) return true;
  const best = matches.filter(
    (entry) => robotsSpecificity(entry.pattern) === robotsSpecificity(matches[0]!.pattern),
  );
  return best.some((entry) => entry.allow);
}

function normalizeContentType(value: string): CampaignCatalogPage["contentType"] | null {
  if (value === "text/html" || value === "application/xhtml+xml") return "text/html";
  if (value === "text/plain") return "text/plain";
  if (
    ["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"].includes(value)
  ) {
    return "application/xml";
  }
  return null;
}

function parseCatalogContent(
  input: string,
  contentType: CampaignCatalogPage["contentType"],
  pageUrl: string,
): { title: string; text: string; links: Array<{ url: string; label: string }> } {
  if (contentType === "text/plain") {
    const text = normalizeText(input).slice(0, MAX_TEXT_CHARS);
    return {
      title: firstUsefulLine(text).slice(0, 200) || "Plain text page",
      text,
      links: markdownLinks(input, pageUrl),
    };
  }
  if (contentType === "application/xml" && /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input)) {
    throw new CampaignCatalogError("unsupported", "xml_declaration_unsupported");
  }
  let dom: JSDOM;
  try {
    dom = new JSDOM(
      input,
      contentType === "application/xml" ? { contentType: "application/xml" } : {},
    );
  } catch {
    throw new CampaignCatalogError("unsupported", "document_parse_failed");
  }
  const { document } = dom.window;
  const links =
    contentType === "application/xml" ? xmlLinks(document, pageUrl) : htmlLinks(document, pageUrl);
  const title = normalizeText(
    document.querySelector("title")?.textContent ??
      document.documentElement?.getAttribute("title") ??
      "",
  );
  if (contentType === "text/html") {
    document
      .querySelectorAll("script, style, noscript, svg, nav, footer, header, form")
      .forEach((node) => {
        node.remove();
      });
  }
  const text = normalizeText(
    document.body?.textContent ?? document.documentElement?.textContent ?? "",
  ).slice(0, MAX_TEXT_CHARS);
  dom.window.close();
  return {
    title:
      title.slice(0, 200) || (contentType === "application/xml" ? "XML catalog" : "Untitled page"),
    text,
    links,
  };
}

function htmlLinks(document: Document, pageUrl: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= MAX_LINKS) break;
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const url = safeObservedUrl(href, pageUrl);
    if (!url) continue;
    links.push({ url, label: normalizeText(anchor.textContent ?? "").slice(0, 200) || url });
  }
  return links;
}

function xmlLinks(document: Document, pageUrl: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  for (const loc of Array.from(document.getElementsByTagName("loc"))) {
    if (links.length >= MAX_LINKS) break;
    const url = safeObservedUrl(loc.textContent ?? "", pageUrl);
    if (!url) continue;
    const parentName = loc.parentElement?.tagName.toLowerCase() ?? "";
    const label = parentName.endsWith("sitemap") ? "Sitemap index entry" : "Sitemap URL";
    links.push({ url, label });
  }
  return links;
}

function markdownLinks(input: string, pageUrl: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  const expression = /\[([^\]]{1,200})\]\(([^)\s]{1,2048})(?:\s+[^)]*)?\)/g;
  for (const match of input.matchAll(expression)) {
    if (links.length >= MAX_LINKS) break;
    const url = safeObservedUrl(match[2]!, pageUrl);
    if (url) links.push({ url, label: normalizeText(match[1]!) || url });
  }
  return links;
}

function safeObservedUrl(input: string, base: string): string | null {
  try {
    const url = new URL(input.trim(), base);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function robotsPatternMatches(pattern: string, target: string): boolean {
  const endAnchored = pattern.endsWith("$");
  const source = endAnchored ? pattern.slice(0, -1) : pattern;
  if (!source.includes("*")) return endAnchored ? target === source : target.startsWith(source);
  const parts = source.split("*");
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const first = index === 0;
    const last = index === parts.length - 1;
    if (!part) continue;
    if (first && !source.startsWith("*")) {
      if (!target.startsWith(part)) return false;
      cursor = part.length;
      continue;
    }
    if (last && endAnchored && !source.endsWith("*")) {
      const start = target.length - part.length;
      if (start < cursor || !target.endsWith(part)) return false;
      cursor = target.length;
      continue;
    }
    const found = target.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  return true;
}

function robotsSpecificity(pattern: string): number {
  return pattern.replace(/[*$]/g, "").length;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstUsefulLine(value: string): string {
  return value.split(/[.!?\n]/, 1)[0]?.trim() ?? "";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
