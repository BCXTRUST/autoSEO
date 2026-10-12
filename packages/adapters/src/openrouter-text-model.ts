import type {
  AdapterContext,
  AdapterDescriptor,
  TextModel,
  TextModelCapabilities,
  TextModelRequest,
  TextModelResult,
} from "@rakazo/adapter-kit";
import { z } from "zod";

/*
 * One TextModel over the repo's OpenRouter chat-completions endpoint. The key is the same
 * deployment key the Pi runtime already uses (`OPENROUTER_API_KEY` / the encrypted model
 * credential). Lane ids default to the plan 9 names and are overridable per project.
 */

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Reasoning models can spend most of a minute before the JSON arrives. */
export const OPENROUTER_TEXT_TIMEOUT_MS = 120_000;

/** Product names from plan section 9, as OpenRouter-style ids. Deployments may override them. */
export const DEFAULT_TEXT_MODEL_LANES = {
  // Gemini 3.8 Flash is the quality/cost default for end-user drafting.
  // Claude Fable 5 stays available by setting LINK_BUILDER_MODEL_DRAFT.
  draft: "google/gemini-3.8-flash",
  classify: "google/gemini-3.8-flash",
  fallback: "moonshotai/kimi-k3",
} as const;

export interface TextModelLanes {
  draft: string;
  classify: string;
  fallback: string;
}

const ChatSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().optional(),
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      }),
    )
    .optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

export interface OpenRouterTextModelOptions {
  apiKey: (context: AdapterContext) => Promise<string>;
  onSecret?: (secret: string) => void;
  fetch?: typeof fetch;
  models?: Partial<TextModelLanes>;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenRouterTextModel implements TextModel {
  private readonly apiKey: OpenRouterTextModelOptions["apiKey"];
  private readonly onSecret: ((secret: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly models: TextModelLanes;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterTextModelOptions) {
    this.apiKey = options.apiKey;
    this.onSecret = options.onSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.models = { ...DEFAULT_TEXT_MODEL_LANES, ...options.models };
    this.baseUrl = (options.baseUrl ?? OPENROUTER_CHAT_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? OPENROUTER_TEXT_TIMEOUT_MS;
    if (!this.baseUrl.startsWith("https://")) throw new Error("invalid");
  }

  describe(): AdapterDescriptor<TextModelCapabilities> {
    return {
      id: "openrouter-text-model",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { lanes: ["draft", "classify", "fallback"], structuredOutput: true },
    };
  }

  async complete<T>(
    request: TextModelRequest<T>,
    context: AdapterContext,
  ): Promise<TextModelResult<T>> {
    const key = await this.apiKey(context);
    this.onSecret?.(key);
    const modelId = requestedModel(request.modelId, this.models[request.lane]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          max_tokens: request.maxTokens,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        modelId,
        raw: redact(error instanceof Error ? error.message : "error", key),
      };
    }
    const json = await readJson(response);
    const body = ChatSchema.safeParse(json);
    if (!body.success) return { ok: false, reason: "schema", modelId, raw: "schema" };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "error", modelId, raw: "unauthorized" };
    }
    const choice = body.data.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (choice?.finish_reason === "content_filter" || looksLikeRefusal(content)) {
      return { ok: false, reason: "refusal", modelId, raw: redact(content, key) };
    }
    const parsed = parseJsonContent(content);
    const value = request.schema.safeParse(parsed);
    if (!value.success) {
      return { ok: false, reason: "schema", modelId, raw: redact(content.slice(0, 500), key) };
    }
    return {
      ok: true,
      value: value.data,
      modelId,
      tokens: {
        input: body.data.usage?.prompt_tokens ?? 0,
        output: body.data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export function lanesFromEnv(
  env: NodeJS.ProcessEnv,
  override?: Partial<TextModelLanes>,
): TextModelLanes {
  return {
    draft: override?.draft || env.LINK_BUILDER_MODEL_DRAFT || DEFAULT_TEXT_MODEL_LANES.draft,
    classify:
      override?.classify || env.LINK_BUILDER_MODEL_CLASSIFY || DEFAULT_TEXT_MODEL_LANES.classify,
    fallback:
      override?.fallback || env.LINK_BUILDER_MODEL_FALLBACK || DEFAULT_TEXT_MODEL_LANES.fallback,
  };
}

function requestedModel(override: string | undefined, laneModel: string): string {
  if (override && /^[A-Za-z0-9._:/-]{1,80}$/.test(override)) return override;
  return laneModel;
}

function parseJsonContent(content: string): unknown {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { choices: [{ message: { content: text } }] };
  }
}

function looksLikeRefusal(content: string): boolean {
  return /I can(?:not|'t) (?:help|assist)|Ich kann (?:dir |ihnen )?(?:dabei )?nicht helfen|as an AI/i.test(
    content,
  );
}

function redact(message: string, secret: string): string {
  return secret ? message.split(secret).join("redacted") : message;
}
