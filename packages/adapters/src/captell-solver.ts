import {
  type AdapterContext,
  type AdapterDescriptor,
  type CaptchaBalance,
  CaptchaBalanceSchema,
  type CaptchaQuestionRequest,
  CaptchaQuestionRequestSchema,
  type CaptchaQuestionResult,
  type CaptchaSolveRequest,
  type CaptchaSolveResult,
  CaptchaSolveResultSchema,
  type CaptchaSolver,
  type CaptchaSolverCapabilities,
  CaptchaSolverError,
  type CaptchaType,
  isSecretRegistrationPrompt,
  parseCaptchaSolveRequest,
  type TokenCaptchaType,
  type TokenRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";

/*
 * Captell HTTPS adapter. POST /api/v1/solve may return the finished result, or 202
 * with status "processing" and a job id. A processing job is polled on
 * GET /api/v1/tasks/:id until it is ready or the solve budget runs out.
 * The bearer is read per call and is never written into errors, URLs or logs.
 */

export const CAPTELL_DEFAULT_BASE_URL = "https://captell.run";

const SUPPORTS: CaptchaType[] = [
  "recaptcha_v2",
  "recaptcha_v3",
  "recaptcha_enterprise",
  "turnstile",
  "hcaptcha",
  "geetest",
  "funcaptcha",
  "image_letters",
  "knowledge_question",
];

const MIN_SCORE_BUCKETS = [0.3, 0.7, 0.9] as const;

const SolutionSchema = z
  .object({
    text: z.string().optional(),
    gRecaptchaResponse: z.string().optional(),
    token: z.string().optional(),
  })
  .passthrough();

const WholeNumber = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform((value) => {
  return typeof value === "number" ? value : Number(value);
});

const SolveBodySchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  status: z.string().optional(),
  answer: z.string().optional(),
  solution: SolutionSchema.optional(),
  credits: WholeNumber.pipe(z.number().int().min(0)),
  /** Live ready tasks omit balance. A processing body may send it as a string. */
  balance: WholeNumber.pipe(z.number().int()).optional().default(0),
  sandbox: z.union([z.boolean(), z.string()]).optional(),
  label: z.string().optional(),
});

export interface CaptellHttpSolverOptions {
  /** Plaintext token, loaded from the encrypted store on every call. */
  token: (context: AdapterContext) => Promise<string>;
  /** Receives the plaintext so the caller can redact it. The solver does not store it. */
  onToken?: (token: string) => void;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** How long POST /solve plus task polling may wait for the finished result. */
  solveTimeoutMs?: number;
  /** Extra attempts after the first for a failed solve, network failures and HTTP 5xx. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Pause between GET /api/v1/tasks/:id polls while a job is still processing. */
  pollIntervalMs?: number;
}

export class CaptellHttpSolver implements CaptchaSolver {
  private readonly token: CaptellHttpSolverOptions["token"];
  private readonly onToken: ((token: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly solveTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: CaptellHttpSolverOptions) {
    this.token = options.token;
    this.onToken = options.onToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? CAPTELL_DEFAULT_BASE_URL).replace(/\/$/, "");
    if (!this.baseUrl.startsWith("https://")) {
      throw new CaptchaSolverError("invalid_request", "Captell base URL must be https");
    }
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.solveTimeoutMs = options.solveTimeoutMs ?? 180_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  describe(): AdapterDescriptor<CaptchaSolverCapabilities> {
    return {
      id: "captell-http",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { supports: [...SUPPORTS] },
    };
  }

  async balance(context: AdapterContext): Promise<CaptchaBalance> {
    const { status, json } = await this.call(context, "/api/v1/balance", { method: "GET" });
    assertNoSandbox(json);
    if (status >= 400) throw failure(status, json);
    const parsed = CaptchaBalanceSchema.safeParse(balanceBody(json));
    if (!parsed.success) throw new CaptchaSolverError("error", "error", { retryable: false });
    return parsed.data;
  }

  async solve(request: CaptchaSolveRequest, context: AdapterContext): Promise<CaptchaSolveResult> {
    const parsed = parseCaptchaSolveRequest(request);
    const payload = solvePayload(parsed);
    const started = Date.now();
    let { status, json } = await this.call(
      context,
      "/api/v1/solve",
      { method: "POST", body: JSON.stringify(payload) },
      this.solveTimeoutMs,
    );
    assertNoSandbox(json);
    const jobId = jobIdFrom(json);
    if (isProcessing(json)) {
      if (!jobId) throw failure(status >= 400 ? status : 422, json);
      const polled = await this.pollTask(context, jobId, this.solveTimeoutMs - (Date.now() - started));
      status = polled.status;
      json = polled.json;
    }
    assertNoSandbox(json);
    if (isUnfinishedSolve(json)) throw failure(status >= 400 ? status : 422, json);
    if (status >= 400 || hasError(json)) throw failure(status, json);
    const body = SolveBodySchema.safeParse(json);
    const answer = body.success ? answerFromSolve(body.data) : undefined;
    const taskId = body.success ? (body.data.id ?? body.data.taskId) : undefined;
    if (!body.success || !answer || !taskId) {
      throw new CaptchaSolverError("error", "error", { retryable: false });
    }
    return CaptchaSolveResultSchema.parse({
      answer,
      credits: body.data.credits,
      balance: body.data.balance,
      taskId,
    });
  }

  async answerQuestion(
    request: CaptchaQuestionRequest,
    context: AdapterContext,
  ): Promise<CaptchaQuestionResult> {
    const parsed = CaptchaQuestionRequestSchema.parse(request);
    const prompt = [parsed.question, parsed.pageText].filter(Boolean).join("\n");
    if (isSecretRegistrationPrompt(prompt)) return { couldNotAnswer: true };
    const { status, json } = await this.call(context, "/api/v1/answer", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    assertNoSandbox(json);
    const answered = answerResult(json);
    if (answered) return answered;
    if (status >= 400 || hasError(json)) throw failure(status, json);
    return { couldNotAnswer: true };
  }

  private async pollTask(
    context: AdapterContext,
    taskId: string,
    budgetMs: number,
  ): Promise<{ status: number; json: unknown }> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    let last: { status: number; json: unknown } = {
      status: 202,
      json: { status: "processing", id: taskId },
    };
    while (Date.now() <= deadline) {
      if (context.signal.aborted) {
        throw new CaptchaSolverError("error", "error", { retryable: false });
      }
      const remaining = Math.max(1, deadline - Date.now());
      last = await this.call(
        context,
        `/api/v1/tasks/${encodeURIComponent(taskId)}`,
        { method: "GET" },
        Math.min(this.timeoutMs, remaining),
      );
      assertNoSandbox(last.json);
      if (!isProcessing(last.json)) return last;
      const pauseMs = deadline - Date.now();
      if (pauseMs <= 0) break;
      if (this.pollIntervalMs > 0) await delay(Math.min(this.pollIntervalMs, pauseMs));
    }
    throw new CaptchaSolverError("error", "error", { retryable: true });
  }

  private async call(
    context: AdapterContext,
    path: string,
    init: { method: string; body?: string },
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; json: unknown }> {
    const token = await this.token(context);
    this.onToken?.(token);
    if (!usableBearer(token)) {
      throw new CaptchaSolverError("invalid_request", "invalid_request");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    let lastTransient = false;
    const attempts = this.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (context.signal.aborted) {
        throw new CaptchaSolverError("error", "error", { retryable: false });
      }
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body,
          redirect: "error",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
        });
        const json = await readJson(response);
        if (response.status >= 500 || isTransientSolveFailure(path, response.status, json)) {
          lastTransient = true;
          if (attempt < attempts - 1) {
            await delay(this.retryDelayMs);
            continue;
          }
          throw new CaptchaSolverError("error", "error", { retryable: this.maxRetries === 0 });
        }
        return { status: response.status, json };
      } catch (error) {
        if (error instanceof CaptchaSolverError) throw error;
        if (context.signal.aborted) {
          throw new CaptchaSolverError("error", "error", { retryable: false });
        }
        lastTransient = true;
        if (attempt < attempts - 1) {
          await delay(this.retryDelayMs);
        }
      }
    }
    throw new CaptchaSolverError("error", "error", {
      retryable: lastTransient && this.maxRetries === 0,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { code: "BAD_JSON", message: "BAD_JSON" };
  }
}

function hasError(json: unknown): boolean {
  return errorText(json).length > 0 || apiSignal(json).code.length > 0;
}

function errorText(json: unknown): string {
  const signal = apiSignal(json);
  return signal.message || signal.code;
}

function apiSignal(json: unknown): { code: string; message: string } {
  if (!json || typeof json !== "object") return { code: "", message: "" };
  const record = json as Record<string, unknown>;
  let code = "";
  let message = "";
  if (typeof record.code === "string") code = record.code;
  if (typeof record.message === "string") message = record.message;
  if (typeof record.error === "string") {
    message = message || record.error;
    if (!code && /^[A-Z0-9_]+$/.test(record.error)) code = record.error;
  }
  if (record.error && typeof record.error === "object") {
    const inner = record.error as Record<string, unknown>;
    if (typeof inner.code === "string" && !code) code = inner.code;
    if (typeof inner.message === "string" && !message) message = inner.message;
  }
  return { code: code.toUpperCase(), message };
}

function isSandbox(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const record = json as Record<string, unknown>;
  return record.sandbox === true || record.sandbox === "sandbox" || record.label === "sandbox";
}

function assertNoSandbox(json: unknown): void {
  if (isSandbox(json)) {
    throw new CaptchaSolverError("sandbox", "sandbox", { retryable: false });
  }
}

/** Live balance is `{ balance: "0" }`. The contract we store is `{ credits }`. */
function balanceBody(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const record = json as Record<string, unknown>;
  const credits = wholeNumber(record.credits) ?? wholeNumber(record.balance);
  if (credits === undefined) return json;
  return { ...record, credits };
}

function wholeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

function jobIdFrom(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.length > 0) return record.id;
  if (typeof record.taskId === "string" && record.taskId.length > 0) return record.taskId;
  return undefined;
}

function solveStatus(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const status = (json as Record<string, unknown>).status;
  return typeof status === "string" ? status : "";
}

function isProcessing(json: unknown): boolean {
  return solveStatus(json) === "processing" || solveStatus(json) === "pending";
}

function isUnfinishedSolve(json: unknown): boolean {
  const status = solveStatus(json);
  return status.length > 0 && status !== "ready";
}

function isTransientSolveFailure(path: string, status: number, json: unknown): boolean {
  if (!path.endsWith("/solve")) return false;
  if (status === 499 || status === 400 || status === 401 || status === 402 || status === 403) {
    return false;
  }
  const { code, message } = apiSignal(json);
  const text = `${code} ${message}`.toLowerCase();
  if (
    /unreadable|not read|aborted|the try was stopped|not enough credits|insufficient_credits/.test(
      text,
    )
  ) {
    return false;
  }
  if (
    code === "BAD_JSON" ||
    code === "UNKNOWN_TYPE" ||
    code === "MISSING_FIELD" ||
    code === "FILE_TOO_SMALL" ||
    code === "PAUSED" ||
    code === "UNAUTHORIZED" ||
    code === "UNREADABLE" ||
    code === "ABORTED" ||
    code === "INSUFFICIENT_CREDITS"
  ) {
    return false;
  }
  if (code === "UPSTREAM" || code === "TIMEOUT") return true;
  return /did not answer in time|no solver is free/.test(text);
}

function failure(status: number, json: unknown): CaptchaSolverError {
  const { code, message } = apiSignal(json);
  const text = `${code} ${message}`.toLowerCase();
  if (code === "UNREADABLE" || /not read|unreadable/.test(text)) {
    return new CaptchaSolverError("not_read", "not_read", { retryable: false });
  }
  if (code === "TIMEOUT" || /did not answer in time/.test(text)) {
    return new CaptchaSolverError("error", "error", { retryable: true });
  }
  if (/no solver is free/.test(text) || code === "UPSTREAM") {
    return new CaptchaSolverError("error", "error", { retryable: true });
  }
  if (code === "ABORTED" || status === 499 || /the try was stopped/.test(text)) {
    return new CaptchaSolverError("error", "error", { retryable: false });
  }
  if (/no token/.test(text)) {
    return new CaptchaSolverError("no_token", "no_token", { retryable: true });
  }
  if (/missing site key/.test(text)) {
    return new CaptchaSolverError("missing_site_key", "missing_site_key", { retryable: false });
  }
  if (code === "MISSING_FIELD" || code === "BAD_JSON" || code === "FILE_TOO_SMALL") {
    return new CaptchaSolverError("invalid_request", "invalid_request", { retryable: false });
  }
  if (code === "UNKNOWN_TYPE" || /unsupported/.test(text)) {
    return new CaptchaSolverError("unsupported", "unsupported", { retryable: false });
  }
  if (
    code === "INSUFFICIENT_CREDITS" ||
    /not enough credits|insufficient credits/.test(text) ||
    status === 402
  ) {
    return new CaptchaSolverError("credits", "credits", { retryable: false });
  }
  if (code === "UNAUTHORIZED" || /refus/.test(text) || status === 401 || status === 403) {
    return new CaptchaSolverError("refused", "refused", { retryable: false });
  }
  if (code === "PAUSED" || status === 400 || status === 422) {
    return new CaptchaSolverError("invalid_request", "invalid_request", { retryable: false });
  }
  return new CaptchaSolverError("error", "error", { retryable: false });
}

function usableBearer(token: string): boolean {
  if (!token || /\s/.test(token) || token.includes("://")) return false;
  if (/^ct_live_[A-Za-z0-9_-]{8,120}$/.test(token)) return true;
  return token.length >= 16 && token.length <= 200;
}

function answerFromSolve(body: z.infer<typeof SolveBodySchema>): string | undefined {
  const solution = body.solution;
  if (solution?.text) return solution.text;
  if (solution?.gRecaptchaResponse) return solution.gRecaptchaResponse;
  if (solution?.token) return solution.token;
  return body.answer || undefined;
}

function answerResult(json: unknown): CaptchaQuestionResult | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "";
  if (status === "error" || /could not answer/i.test(errorText(json)))
    return { couldNotAnswer: true };
  if (status && status !== "ready") return null;
  const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (answer) return { answer };
  if (instruction) return { instruction };
  return null;
}

function solvePayload(parsed: CaptchaSolveRequest): Record<string, unknown> {
  if (parsed.type === "ImageToText") {
    return { type: "ImageToText", body: Buffer.from(parsed.imagePng).toString("base64") };
  }
  return widgetBody(parsed);
}

function widgetBody(parsed: TokenRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: solveType(parsed.type),
    websiteURL: parsed.websiteURL,
  };
  if (parsed.type === "geetest") body.gt = parsed.websiteKey;
  else if (parsed.type === "funcaptcha") body.websitePublicKey = parsed.websiteKey;
  else body.websiteKey = parsed.websiteKey;
  if (parsed.pageAction !== undefined) body.pageAction = parsed.pageAction;
  if (parsed.action !== undefined) body.action = parsed.action;
  if (parsed.cData !== undefined) body.cData = parsed.cData;
  if (parsed.chlPageData !== undefined) body.chlPageData = parsed.chlPageData;
  if (parsed.challenge !== undefined) body.challenge = parsed.challenge;
  if (parsed.enterprisePayload !== undefined) body.enterprisePayload = parsed.enterprisePayload;
  if (parsed.type === "recaptcha_enterprise" || truthyFlag(parsed.isEnterprise)) {
    body.isEnterprise = true;
  }
  if (truthyFlag(parsed.isInvisible)) body.isInvisible = true;
  if (parsed.type === "recaptcha_v3") body.minScore = snapMinScore(parsed.minScore ?? 0.3);
  else if (parsed.minScore !== undefined) body.minScore = parsed.minScore;
  return body;
}

function solveType(type: TokenCaptchaType): string {
  if (type === "geetest") return "GeeTest";
  if (type === "funcaptcha") return "FunCaptcha";
  if (type === "recaptcha_v3") return "RecaptchaV3";
  if (type === "turnstile") return "Turnstile";
  if (type === "hcaptcha") return "HCaptcha";
  return "RecaptchaV2";
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function snapMinScore(value: number): 0.3 | 0.7 | 0.9 {
  if (!Number.isFinite(value) || value <= 0.5) return MIN_SCORE_BUCKETS[0];
  if (value <= 0.8) return MIN_SCORE_BUCKETS[1];
  return MIN_SCORE_BUCKETS[2];
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
