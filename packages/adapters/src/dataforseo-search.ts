import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AdapterDescriptor,
  SearchProvider,
  SearchProviderCapabilities,
  WebSearchRequest,
  WebSearchResult,
} from "@rakazo/adapter-kit";
import { WebSearchRequestSchema, WebSearchResultSchema } from "@rakazo/adapter-kit";
import { z } from "zod";

/*
 * DataForSEO Google organic live advanced. Basic auth is read per call and never written
 * into errors, URLs or logs. No vendor SDK.
 */

export const DATAFORSEO_ENDPOINT =
  "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";

/** Location codes for the wizard countries. Unknown countries are refused, not guessed. */
export const DATAFORSEO_LOCATION_CODES: Readonly<Record<string, number>> = {
  DE: 2276,
  AT: 2040,
  CH: 2756,
  US: 2840,
  GB: 2826,
  FR: 2250,
  ES: 2724,
  IT: 2380,
  NL: 2528,
  PL: 2616,
  SE: 2752,
  BR: 2076,
};

const ItemSchema = z.object({
  type: z.string(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  domain: z.string().nullish(),
});

const ResponseSchema = z.object({
  status_code: z.number().nullish(),
  status_message: z.string().nullish(),
  tasks: z
    .array(
      z.object({
        status_code: z.number().nullish(),
        status_message: z.string().nullish(),
        result: z
          .array(
            z
              .object({
                items: z.array(z.unknown()).nullish(),
              })
              .nullable(),
          )
          .nullable()
          .optional(),
      }),
    )
    .optional(),
});

/** Provider status only. Never the login, the password, or the response body. */
export function providerStatusLine(json: unknown): string {
  const root = recordOf(json);
  const tasks = root && Array.isArray(root.tasks) ? root.tasks : [];
  const task = recordOf(tasks[0]);
  const message = statusText(task?.status_message) || statusText(root?.status_message);
  const line = `status ${statusCode(root?.status_code)}/${statusCode(task?.status_code)}${message ? ` ${message}` : ""}`;
  return line.slice(0, 160);
}

export class SearchProviderError extends Error {
  readonly code: "unauthorized" | "invalid" | "upstream" | "schema" | "unsupported_market";

  constructor(code: SearchProviderError["code"], message: string = code) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
  }
}

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

export interface DataForSeoSearchOptions {
  credentials: (context: AdapterContext) => Promise<DataForSeoCredentials>;
  /** Receives the password so the caller can redact it. The adapter does not store it. */
  onSecret?: (secret: string) => void;
  fetch?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export class DataForSeoSearchProvider implements SearchProvider {
  partialNotice: string | null = null;
  private readonly credentials: DataForSeoSearchOptions["credentials"];
  private readonly onSecret: ((secret: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: DataForSeoSearchOptions) {
    this.credentials = options.credentials;
    this.onSecret = options.onSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? DATAFORSEO_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!this.endpoint.startsWith("https://")) {
      throw new SearchProviderError("invalid", "invalid");
    }
  }

  describe(): AdapterDescriptor<SearchProviderCapabilities> {
    return {
      id: "dataforseo-serp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { maxDepth: 100, operators: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchResult[]> {
    this.partialNotice = null;
    const parsed = WebSearchRequestSchema.parse(request);
    const location = DATAFORSEO_LOCATION_CODES[parsed.country];
    if (!location) throw new SearchProviderError("unsupported_market");
    const language = parsed.language.split("-")[0] ?? parsed.language;
    const creds = await this.credentials(context);
    this.onSecret?.(creds.password);
    this.onSecret?.(creds.login);
    if (!creds.login || !creds.password) throw new SearchProviderError("unauthorized");
    const body = JSON.stringify([
      {
        keyword: parsed.query,
        location_code: location,
        language_code: language,
        depth: parsed.depth,
        device: "desktop",
      },
    ]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      throw new SearchProviderError("upstream", redact(errorText(error), creds));
    }
    if (response.status === 401 || response.status === 403) {
      throw new SearchProviderError("unauthorized");
    }
    const json = await readJson(response);
    const payload = ResponseSchema.safeParse(json);
    if (!payload.success) throw new SearchProviderError("schema", providerStatusLine(json));
    const task = payload.data.tasks?.[0];
    if ((payload.data.status_code && payload.data.status_code !== 20000) || !task) {
      throw new SearchProviderError(
        response.status >= 500 ? "upstream" : "invalid",
        providerStatusLine(json),
      );
    }
    if (task.status_code && task.status_code !== 20000 && task.status_code !== 40106) {
      throw new SearchProviderError(
        task.status_code === 40100 ? "unauthorized" : "invalid",
        providerStatusLine(json),
      );
    }
    const items = task.result?.[0]?.items ?? [];
    const results: WebSearchResult[] = [];
    for (const raw of items) {
      const parsedItem = ItemSchema.safeParse(raw);
      if (!parsedItem.success) continue;
      const item = parsedItem.data;
      if (item.type !== "organic" || !item.url) continue;
      const row = WebSearchResultSchema.safeParse({
        url: item.url,
        title: item.title ?? "",
        snippet: item.description ?? "",
        domain: item.domain || domainOf(item.url),
      });
      if (row.success) results.push(row.data);
      if (results.length >= parsed.depth) break;
    }
    if (task.status_code === 40106) {
      if (results.length === 0) {
        throw new SearchProviderError("invalid", providerStatusLine(json));
      }
      this.partialNotice = providerStatusLine(json);
    }
    return results;
  }
}

export function searchFixtureKey(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function statusCode(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function statusText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "upstream";
}

function redact(message: string, creds: DataForSeoCredentials): string {
  return message.split(creds.password).join("redacted").split(creds.login).join("redacted");
}
