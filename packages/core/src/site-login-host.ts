const MAX_HOST_LENGTH = 253;
const HOST_IN_TEXT =
  /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;

function stripWww(host: string): string {
  return host.replace(/^www\./i, "");
}

export function normalizeSiteLoginHost(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Site is required.");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname = "";
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    hostname = raw.split("/")[0] ?? "";
  }
  const host = stripWww(hostname.trim().toLowerCase()).replace(/\.$/, "");
  if (!host || host.includes(" ") || host.length > MAX_HOST_LENGTH) {
    throw new Error("Enter a valid site hostname or URL.");
  }
  return host;
}

export function siteLoginUrl(host: string, url?: string | null): string {
  if (url?.trim()) {
    try {
      return new URL(url.trim()).toString();
    } catch {
      /* fall through */
    }
  }
  return `https://${host}/`;
}

export function hostsCompatible(screenHost: string, loginHost: string): boolean {
  const screen = stripWww(screenHost.trim().toLowerCase());
  const login = stripWww(loginHost.trim().toLowerCase());
  if (!screen || !login) return false;
  return screen === login || screen.endsWith(`.${login}`) || login.endsWith(`.${screen}`);
}

export function hostsFromScreenText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HOST_IN_TEXT)) {
    const candidate = match[1];
    if (!candidate) continue;
    try {
      found.add(normalizeSiteLoginHost(candidate));
    } catch {
      /* skip tokens that are not hosts */
    }
  }
  return [...found];
}

export function screenAllowsVaultFill(loginHost: string, wallText: string): boolean {
  return hostsFromScreenText(wallText).some((host) => hostsCompatible(host, loginHost));
}
