const PRIVATE_HOST = /^(localhost|metadata\.google\.internal|.*\.(local|internal|localhost))$/i;

function ipv4Private(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6Private(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return ipv4Private(lower.slice(7));
  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

/** One answer from an injected resolver. Validation never fetches the webhook URL. */
export interface ResolvedAddress {
  address: string;
}

export type HostnameResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export function isPrivateAddress(address: string): boolean {
  const host =
    address
      .replace(/^\[|\]$/g, "")
      .split("%")[0]
      ?.toLowerCase() ?? "";
  if (!host || PRIVATE_HOST.test(host)) return true;
  if (host.includes(":")) return ipv6Private(host);
  return ipv4Private(host);
}

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Syntactic check, plus a DNS check in production. The resolver is injected so tests stay
 * offline. A hostname is refused when any answer is private, loopback, link-local, CGNAT,
 * or a metadata name. The URL itself is not fetched.
 */
export async function webhookUrlAllowed(
  value: string,
  options: { production: boolean; resolve?: HostnameResolver },
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "https" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host)) {
    if (options.production) return { ok: false, reason: "private" };
    return { ok: true, url };
  }
  if (!options.production || isIpLiteral(host)) return { ok: true, url };
  if (!options.resolve) return { ok: false, reason: "unresolved" };
  let answers: readonly ResolvedAddress[];
  try {
    answers = await options.resolve(host);
  } catch {
    return { ok: false, reason: "unresolved" };
  }
  if (answers.length === 0) return { ok: false, reason: "unresolved" };
  if (answers.some((answer) => isPrivateAddress(answer.address))) {
    return { ok: false, reason: "private" };
  }
  return { ok: true, url };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of the raw body, hex encoded. The header value is `sha256=<hex>`. */
export async function signWebhookBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return hex(signature);
}

export async function webhookSignatureHeader(secret: string, rawBody: string): Promise<string> {
  return `sha256=${await signWebhookBody(secret, rawBody)}`;
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header) return false;
  const expected = await webhookSignatureHeader(secret, rawBody);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}
