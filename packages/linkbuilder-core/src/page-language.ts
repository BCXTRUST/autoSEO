const GERMAN_STOPWORDS = new Set([
  "und",
  "der",
  "die",
  "das",
  "ist",
  "nicht",
  "ich",
  "mit",
  "auf",
  "fur",
]);

function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss");
}

function visibleTokens(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function declaredLanguage(html: string): string | null {
  const htmlLang = /<html[^>]*\blang=["']([a-zA-Z-]+)/i.exec(html)?.[1];
  const locale = /<meta[^>]*property=["']og:locale["'][^>]*content=["']([a-zA-Z_]+)/i.exec(
    html,
  )?.[1];
  const swapped = /<meta[^>]*content=["']([a-zA-Z_]+)["'][^>]*property=["']og:locale["']/i.exec(
    html,
  )?.[1];
  const http = /<meta[^>]*http-equiv=["']content-language["'][^>]*content=["']([a-zA-Z-]+)/i.exec(
    html,
  )?.[1];
  const raw = htmlLang || locale || swapped || http;
  if (!raw) return null;
  return raw.toLowerCase().replace("_", "-").split("-")[0] || null;
}

function countryFromHost(url: string, language: string | null): string | null {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  const name = host.toLowerCase();
  if (name.endsWith(".at")) return "AT";
  if (name.endsWith(".ch")) return "CH";
  if (language === "de") return "DE";
  return null;
}

/** Language from the page markup, then German stopwords. Country from the ccTLD. */
export function detectLanguage(
  html: string,
  url: string,
): { language: string | null; country: string | null } {
  let language = declaredLanguage(html);
  if (!language) {
    const tokens = visibleTokens(html);
    if (tokens.length > 0) {
      const german = tokens.filter((token) => GERMAN_STOPWORDS.has(token)).length / tokens.length;
      if (german >= 0.04) language = "de";
    }
  }
  return { language, country: countryFromHost(url, language) };
}
