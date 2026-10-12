import { type HostnameResolver, isPrivateAddress } from "./webhooks.js";

const MAX_HTML = 200_000;
const MAX_REDIRECTS = 3;
const LOCALES = new Set([
  "de",
  "en",
  "fr",
  "es",
  "it",
  "nl",
  "pl",
  "pt",
  "sv",
  "da",
  "no",
  "fi",
  "at",
  "ch",
  "us",
  "gb",
  "uk",
  "br",
]);

export interface PageSuggestion {
  keyword: string;
  rule: string;
}

/** Keyword and a short rule from a page's title, heading, and description. */
export function suggestPageCopy(url: string, html: string): PageSuggestion {
  const keyword = clip(pickKeyword(html) || keywordFromUrl(url), 80);
  const rule = clip(pickRule(html), 300);
  return { keyword, rule };
}

/**
 * Read a public page and suggest a keyword and a short rule. A private host, a failed read,
 * or a redirect off the site returns a URL-only keyword when the path has one.
 */
export async function suggestFromPublicPage(
  rawUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    resolve?: HostnameResolver;
    allowPrivate?: boolean;
  } = {},
): Promise<PageSuggestion> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const allowed = await publicPageUrl(current, options);
    if (!allowed) return { keyword: "", rule: "" };
    let response: Response;
    try {
      response = await fetchImpl(allowed.toString(), {
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      return suggestPageCopy(allowed.toString(), "");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) return suggestPageCopy(allowed.toString(), "");
      current = new URL(location, allowed).toString();
      continue;
    }
    if (!response.ok) return suggestPageCopy(allowed.toString(), "");
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1_000_000)
      return suggestPageCopy(allowed.toString(), "");
    const html = (await response.text()).slice(0, MAX_HTML);
    return suggestPageCopy(response.url || allowed.toString(), html);
  }
  return { keyword: "", rule: "" };
}

export function keywordFromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const parts = url.pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && !LOCALES.has(part.toLowerCase()));
  const slug = parts.at(-1);
  if (!slug) return "";
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pickKeyword(html: string): string {
  const heading = textContent(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i));
  if (heading.length >= 2 && heading.length <= 80) return heading;
  const title = textContent(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  return titleSegment(title);
}

function pickRule(html: string): string {
  const described =
    metaContent(html, "description") || metaContent(html, "og:description") || firstParagraph(html);
  return described;
}

function firstParagraph(html: string): string {
  const matches = html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi);
  for (const match of matches) {
    const text = textContent(match[1] ?? "");
    if (text.length >= 40) return text;
  }
  return "";
}

function titleSegment(title: string): string {
  const parts = title
    .split(/\s+[|·–—]\s+|\s+-\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  return parts[0] ?? "";
}

function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern)?.[1];
    if (found) return textContent(found);
  }
  return "";
}

function firstMatch(html: string, pattern: RegExp): string {
  return html.match(pattern)?.[1] ?? "";
}

function textContent(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ntilde: "ñ",
};

function decodeEntities(value: string): string {
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = current.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  const sliced = trimmed.slice(0, max);
  const space = sliced.lastIndexOf(" ");
  return (space > 40 ? sliced.slice(0, space) : sliced).trim();
}

async function publicPageUrl(
  value: string,
  options: { resolve?: HostnameResolver; allowPrivate?: boolean },
): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (isPrivateAddress(host)) return null;
  if (options.allowPrivate) return url;
  if (!options.resolve) return null;
  try {
    const answers = await options.resolve(host);
    if (answers.length === 0 || answers.some((answer) => isPrivateAddress(answer.address))) {
      return null;
    }
  } catch {
    return null;
  }
  return url;
}
