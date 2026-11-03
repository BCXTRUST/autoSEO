import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";
import { Agent, request } from "undici";
import { createAddressCheckedLookup, isPrivateAddress } from "./network-address.js";

const MAX_REDIRECTS = 4;
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_TEXT_CHARS = 18_000;

export interface CampaignResearchEvidence {
  title: string;
  text: string;
  url: string;
  contentType: "text/html" | "text/plain";
  fetchedAt: string;
}

type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Produces the exact validated address that the socket connects to. */
export function createCampaignPublicAddressLookup(resolve?: AddressResolver) {
  const resolver =
    resolve ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  return createAddressCheckedLookup(resolver, (addresses) => {
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isBlockedPublicAddress(entry.address))
    ) {
      throw new Error("address validation failed");
    }
  });
}

export class CampaignResearchError extends Error {
  constructor(
    readonly kind: "transient" | "invalid_input" | "unsupported",
    readonly safeCode: string,
  ) {
    super(safeCode);
    this.name = "CampaignResearchError";
  }
}

/** Fetches one explicitly supplied public URL without credentials, cookies, or script execution. */
export async function researchCampaignUrl(
  input: string,
  options: { now?: () => Date; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CampaignResearchEvidence> {
  const fetched = await fetchCampaignPublicResource(input, {
    ...options,
    readContentTypes: ["text/html", "text/plain"],
  });
  if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
    throw new CampaignResearchError("transient", "http_status");
  }
  if (fetched.contentType !== "text/html" && fetched.contentType !== "text/plain") {
    throw new CampaignResearchError("unsupported", "content_type_unsupported");
  }
  const parsed = extractPageText(fetched.body, fetched.contentType);
  if (!parsed.text) throw new CampaignResearchError("unsupported", "page_has_no_text");
  return {
    ...parsed,
    url: fetched.url,
    contentType: fetched.contentType,
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

export interface CampaignPublicResource {
  url: string;
  httpStatus: number;
  contentType: string;
  body: string;
}

/** Fetches a bounded public resource with redirect, DNS, socket, and response-size checks. */
export async function fetchCampaignPublicResource(
  input: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    accept?: string;
    readContentTypes?: readonly string[];
    allowedOrigin?: string;
    allowedUrl?: (url: string) => boolean;
    userAgent?: string;
  } = {},
): Promise<CampaignPublicResource> {
  let current = validateUrl(input);
  const allowedOrigin = options.allowedOrigin
    ? validateUrl(options.allowedOrigin).origin
    : undefined;
  if (allowedOrigin && current.origin !== allowedOrigin) {
    throw new CampaignResearchError("invalid_input", "origin_mismatch");
  }
  const timeoutMs = Math.min(options.timeoutMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  for (let redirects = 0; ; redirects += 1) {
    if (options.allowedUrl && !options.allowedUrl(current.toString())) {
      throw new CampaignResearchError("unsupported", "robots_disallowed");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CampaignResearchError("transient", "fetch_timeout");
    const fetched = await requestPublicPage(
      current,
      Math.min(remaining, FETCH_TIMEOUT_MS),
      options.signal,
      options.accept,
      options.userAgent,
    );
    const response = fetched.response;
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.body.destroy();
        if (typeof location !== "string") {
          throw new CampaignResearchError("transient", "redirect_missing_location");
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new CampaignResearchError("unsupported", "redirect_limit");
        }
        try {
          current = validateCampaignResearchRedirect(current, location);
          if (allowedOrigin && current.origin !== allowedOrigin) {
            throw new CampaignResearchError("invalid_input", "redirect_origin_mismatch");
          }
        } catch (error) {
          if (error instanceof CampaignResearchError) throw error;
          throw new CampaignResearchError("invalid_input", "redirect_url_invalid");
        }
        continue;
      }
      const contentTypeHeader = response.headers["content-type"];
      const contentType =
        typeof contentTypeHeader === "string"
          ? contentTypeHeader.split(";", 1)[0]!.trim().toLowerCase()
          : "";
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy();
        return { url: current.toString(), httpStatus: response.statusCode, contentType, body: "" };
      }
      if (options.readContentTypes && !options.readContentTypes.includes(contentType)) {
        response.body.destroy();
        return { url: current.toString(), httpStatus: response.statusCode, contentType, body: "" };
      }
      const bytes: Buffer[] = [];
      let length = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          length += buffer.length;
          if (length > MAX_BYTES) throw new CampaignResearchError("unsupported", "page_too_large");
          bytes.push(buffer);
        }
      } catch (error) {
        if (error instanceof CampaignResearchError) throw error;
        throw new CampaignResearchError("transient", "response_read_failed");
      }
      return {
        url: current.toString(),
        httpStatus: response.statusCode,
        contentType,
        body: Buffer.concat(bytes).toString("utf8"),
      };
    } finally {
      await fetched.close();
    }
  }
}

export function extractPageText(
  input: string,
  contentType: "text/html" | "text/plain",
): Pick<CampaignResearchEvidence, "title" | "text"> {
  if (contentType === "text/plain") {
    const text = normalizeText(input).slice(0, MAX_TEXT_CHARS);
    return { title: firstUsefulLine(text).slice(0, 200) || "Untitled page", text };
  }
  // JSDOM does not execute page scripts unless explicitly configured to do so. Resource loading
  // is also disabled, so this only parses the bounded response bytes already fetched above.
  const dom = new JSDOM(input);
  const { document } = dom.window;
  const title = normalizeText(document.title).slice(0, 200) || "Untitled page";
  document
    .querySelectorAll("script, style, noscript, svg, nav, footer, header, form")
    .forEach((node) => {
      node.remove();
    });
  const text = normalizeText(
    document.body?.textContent ?? document.documentElement?.textContent ?? "",
  ).slice(0, MAX_TEXT_CHARS);
  dom.window.close();
  return { title, text };
}

/** Revalidates each redirect destination before a new DNS lookup or connection is attempted. */
export function validateCampaignResearchRedirect(previous: URL, location: string): URL {
  try {
    return validateUrl(new URL(location, previous).toString());
  } catch (error) {
    if (error instanceof CampaignResearchError) throw error;
    throw new CampaignResearchError("invalid_input", "redirect_url_invalid");
  }
}

/** Applies the same URL restrictions used before every research fetch and redirect. */
export function validateCampaignResearchUrl(value: string): URL {
  return validateUrl(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstUsefulLine(value: string): string {
  return value.split(/[.!?\n]/, 1)[0]?.trim() ?? "";
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CampaignResearchError("invalid_input", "url_invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new CampaignResearchError("invalid_input", "url_scheme_or_credentials");
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new CampaignResearchError("invalid_input", "url_host_blocked");
  }
  if (isIP(hostname) !== 0 && isBlockedPublicAddress(hostname)) {
    throw new CampaignResearchError("invalid_input", "url_address_blocked");
  }
  url.hash = "";
  return url;
}

function isBlockedPublicAddress(address: string): boolean {
  if (isPrivateAddress(address)) return true;
  const lower = address.toLowerCase();
  if (isIP(lower) === 4) {
    const [a, b, c] = lower.split(".").map(Number);
    return (
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Public IPv6 unicast currently lives in 2000::/3. This also rejects IPv6 special-use,
  // translation, documentation, and unique-local ranges that are not covered by the helper.
  const groups = lower.split(":");
  const firstGroup = Number.parseInt(groups[0] || "0", 16);
  const secondGroup = Number.parseInt(groups[1] || "0", 16);
  return (
    firstGroup < 0x2000 ||
    firstGroup > 0x3fff ||
    firstGroup === 0x2002 ||
    (firstGroup === 0x2001 && secondGroup <= 0x01ff) ||
    lower.startsWith("2001:db8:")
  );
}

async function requestPublicPage(
  url: URL,
  timeoutMs: number,
  signal?: AbortSignal,
  accept = "text/html, text/plain;q=0.9",
  userAgent = "AutoSEO-Research/1.0",
) {
  const deadline = Date.now() + timeoutMs;
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolvePublicAddresses = async (host: string) => {
    if (isIP(host)) {
      if (isBlockedPublicAddress(host))
        throw new CampaignResearchError("invalid_input", "url_address_blocked");
      return [{ address: host, family: isIP(host) }];
    }
    const records = await dnsLookup(host, { all: true, verbatim: true });
    if (records.length === 0) throw new CampaignResearchError("transient", "dns_failed");
    if (records.some((record) => isBlockedPublicAddress(record.address)))
      throw new CampaignResearchError("invalid_input", "url_address_blocked");
    return records;
  };
  const connectLookup = (host: string) =>
    withTimeout(resolvePublicAddresses(host), Math.max(1, deadline - Date.now()), requestSignal);
  const agent = new Agent({
    connect: { lookup: createCampaignPublicAddressLookup(connectLookup) },
  });
  try {
    // Resolve and validate before opening a socket. The Agent's actual socket lookup performs
    // the same validation and passes that validated answer to connect, preventing a second,
    // unrelated DNS resolution from creating a rebinding gap.
    if (isIP(hostname)) {
      if (isBlockedPublicAddress(hostname))
        throw new CampaignResearchError("invalid_input", "url_address_blocked");
    } else {
      try {
        await connectLookup(hostname);
      } catch (error) {
        if (error instanceof CampaignResearchError) throw error;
        throw new CampaignResearchError(
          "transient",
          requestSignal.aborted ? "fetch_aborted" : "dns_failed",
        );
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CampaignResearchError("transient", "fetch_timeout");
    const response = await request(url, {
      dispatcher: agent,
      headersTimeout: remaining,
      bodyTimeout: remaining,
      signal: requestSignal,
      headers: { accept, "user-agent": userAgent },
    });
    return { response, close: () => agent.destroy() };
  } catch (error) {
    await agent.destroy().catch(() => undefined);
    if (error instanceof CampaignResearchError) throw error;
    throw new CampaignResearchError(
      "transient",
      requestSignal.aborted ? "fetch_timeout" : "fetch_failed",
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (reason?: Error) => void = () => undefined;
  const onAbort = () => rejectAbort(new Error("aborted"));
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      promise,
      abort,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
