import type {
  ChallengeOperationOptions,
  ChallengeProvider,
  ChallengeTaskResult,
  ImageToTextChallengeInput,
} from "@rakazo/adapter-kit/challenge";

const API_URL = "https://api.anti-captcha.com";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type AntiCaptchaErrorCode =
  | "invalid_input"
  | "unsupported_task"
  | "low_balance"
  | "authentication"
  | "provider_error"
  | "malformed_response"
  | "network_error"
  | "ambiguous_creation"
  | "timeout"
  | "aborted";

/** A sanitized provider error. It never retains raw payloads or credentials. */
export class AntiCaptchaError extends Error {
  readonly code: AntiCaptchaErrorCode;
  readonly retryable: boolean;

  constructor(code: AntiCaptchaErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "AntiCaptchaError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AntiCaptchaAdapterOptions {
  clientKey: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) {
    throw new AntiCaptchaError("malformed_response", "Anti-Captcha returned an invalid response.");
  }
  return value;
}

function validateInput(input: ImageToTextChallengeInput): void {
  if (!input || typeof input !== "object" || input.type !== "image-to-text") {
    throw new AntiCaptchaError("unsupported_task", "This challenge task type is not supported.");
  }
  if (input.authorizedUse !== true) {
    throw new AntiCaptchaError("invalid_input", "An authorized-use attestation is required.");
  }
  if (
    typeof input.imageBase64 !== "string" ||
    input.imageBase64.length === 0 ||
    input.imageBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.imageBase64)
  ) {
    throw new AntiCaptchaError("invalid_input", "Image data must be valid base64.");
  }
  const decodedBytes =
    Math.floor((input.imageBase64.length * 3) / 4) -
    (input.imageBase64.endsWith("==") ? 2 : input.imageBase64.endsWith("=") ? 1 : 0);
  if (decodedBytes < 1 || decodedBytes > MAX_IMAGE_BYTES) {
    throw new AntiCaptchaError("invalid_input", "Image data must be between 1 byte and 5 MiB.");
  }
  for (const [field, value] of [
    ["phrase", input.phrase],
    ["caseSensitive", input.caseSensitive],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new AntiCaptchaError("invalid_input", `${field} must be a boolean.`);
    }
  }
  if (
    input.numeric !== undefined &&
    (typeof input.numeric !== "number" || ![0, 1, 2, 3].includes(input.numeric))
  ) {
    throw new AntiCaptchaError("invalid_input", "numeric must be one of 0, 1, 2, or 3.");
  }
  for (const [field, value] of [
    ["minLength", input.minLength],
    ["maxLength", input.maxLength],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
    ) {
      throw new AntiCaptchaError("invalid_input", `${field} must be an integer from 0 to 100.`);
    }
  }
  if (
    input.minLength !== undefined &&
    input.maxLength !== undefined &&
    input.minLength > input.maxLength
  ) {
    throw new AntiCaptchaError("invalid_input", "minLength cannot exceed maxLength.");
  }
}

function validateTaskId(taskId: string): void {
  if (
    typeof taskId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(taskId) ||
    !Number.isSafeInteger(Number(taskId))
  ) {
    throw new AntiCaptchaError(
      "invalid_input",
      "taskId must be a positive provider task identifier.",
    );
  }
}

function providerFailure(code: unknown): AntiCaptchaError {
  if (typeof code === "string" && /(?:ZERO_BALANCE|NO_FUNDS|BALANCE)/i.test(code)) {
    return new AntiCaptchaError("low_balance", "Anti-Captcha has insufficient account balance.");
  }
  if (typeof code === "string" && /(?:KEY|AUTH|ACCESS_DENIED)/i.test(code)) {
    return new AntiCaptchaError("authentication", "Anti-Captcha rejected the configured key.");
  }
  return new AntiCaptchaError("provider_error", "Anti-Captcha could not complete the request.");
}

function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function abortError(signal: AbortSignal | undefined): AntiCaptchaError {
  return signal?.aborted
    ? new AntiCaptchaError("aborted", "The Anti-Captcha request was cancelled.")
    : new AntiCaptchaError("timeout", "The Anti-Captcha request timed out.", true);
}

export function createAntiCaptchaAdapter(options: AntiCaptchaAdapterOptions): ChallengeProvider {
  const { clientKey } = options;
  if (typeof clientKey !== "string" || clientKey.trim().length === 0) {
    throw new AntiCaptchaError("invalid_input", "A non-empty Anti-Captcha key is required.");
  }
  const requestFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new AntiCaptchaError("invalid_input", "requestTimeoutMs must be between 1 and 120000.");
  }

  async function request(
    method: "getBalance" | "createTask" | "getTaskResult",
    data: JsonObject,
    operation: ChallengeOperationOptions | undefined,
    creation = false,
  ): Promise<JsonObject> {
    if (operation?.signal?.aborted) throw abortError(operation.signal);
    const signal = deadlineSignal(operation?.signal, timeoutMs);
    let response: Response;
    try {
      response = await requestFetch(`${API_URL}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey, ...data }),
        signal,
      });
    } catch {
      if (creation) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have reached Anti-Captcha, but its task ID is unavailable; do not retry automatically.",
        );
      }
      if (signal.aborted) throw abortError(operation?.signal);
      throw new AntiCaptchaError("network_error", "Could not reach Anti-Captcha.", true);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (signal.aborted && !creation) throw abortError(operation?.signal);
      if (creation) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have completed, but its response was invalid; do not create another task automatically.",
        );
      }
      throw new AntiCaptchaError("malformed_response", "Anti-Captcha returned invalid JSON.");
    }
    let result: JsonObject;
    try {
      result = parseJsonObject(payload);
    } catch {
      if (creation) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have completed, but its response was invalid; do not create another task automatically.",
        );
      }
      throw new AntiCaptchaError(
        "malformed_response",
        "Anti-Captcha returned an invalid response.",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AntiCaptchaError("authentication", "Anti-Captcha rejected the configured key.");
      }
      if (response.status === 408 || response.status === 504) {
        if (creation) {
          throw new AntiCaptchaError(
            "ambiguous_creation",
            "Task creation may have completed, but the response was not confirmed; do not retry automatically.",
          );
        }
        throw new AntiCaptchaError("timeout", "The Anti-Captcha request timed out.", true);
      }
      if (creation && response.status >= 500) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have completed, but the response was not confirmed; do not retry automatically.",
        );
      }
      throw new AntiCaptchaError("provider_error", "Anti-Captcha could not complete the request.");
    }
    if (
      typeof result.errorId !== "number" ||
      !Number.isFinite(result.errorId) ||
      !Number.isInteger(result.errorId) ||
      result.errorId < 0
    ) {
      if (creation) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have completed, but Anti-Captcha returned no valid confirmation; do not retry automatically.",
        );
      }
      throw new AntiCaptchaError(
        "malformed_response",
        "Anti-Captcha returned an invalid response.",
      );
    }
    if (result.errorId !== 0) {
      throw providerFailure(result.errorCode);
    }
    return result;
  }

  return {
    async getBalance(operation) {
      const result = await request("getBalance", {}, operation);
      if (
        typeof result.balance !== "number" ||
        !Number.isFinite(result.balance) ||
        result.balance < 0
      ) {
        throw new AntiCaptchaError(
          "malformed_response",
          "Anti-Captcha returned an invalid balance.",
        );
      }
      return { balanceUsd: result.balance };
    },

    async createTask(input, operation) {
      validateInput(input);
      const task = {
        type: "ImageToTextTask",
        body: input.imageBase64,
        ...(input.phrase === undefined ? {} : { phrase: input.phrase }),
        ...(input.caseSensitive === undefined ? {} : { case: input.caseSensitive }),
        ...(input.numeric === undefined ? {} : { numeric: input.numeric }),
        ...(input.minLength === undefined ? {} : { minLength: input.minLength }),
        ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
      };
      const result = await request("createTask", { task }, operation, true);
      const id = result.taskId;
      if (
        (typeof id !== "number" && typeof id !== "string") ||
        !/^[1-9]\d{0,19}$/.test(String(id)) ||
        !Number.isSafeInteger(Number(id))
      ) {
        throw new AntiCaptchaError(
          "ambiguous_creation",
          "Task creation may have completed, but Anti-Captcha returned no usable task ID.",
        );
      }
      return { taskId: String(id) };
    },

    async pollTask(taskId, operation): Promise<ChallengeTaskResult> {
      validateTaskId(taskId);
      const result = await request("getTaskResult", { taskId: Number(taskId) }, operation);
      if (result.status === "processing") return { status: "processing" };
      if (result.status === "ready") {
        if (
          !isObject(result.solution) ||
          typeof result.solution.text !== "string" ||
          result.solution.text.length === 0 ||
          result.solution.text.length > 500
        ) {
          throw new AntiCaptchaError(
            "malformed_response",
            "Anti-Captcha returned an invalid solution.",
          );
        }
        let costUsd: number | undefined;
        if (result.cost !== undefined) {
          if (typeof result.cost === "number" && Number.isFinite(result.cost) && result.cost >= 0) {
            costUsd = result.cost;
          } else if (typeof result.cost === "string" && /^\d+(?:\.\d+)?$/.test(result.cost)) {
            costUsd = Number(result.cost);
            if (!Number.isFinite(costUsd)) {
              throw new AntiCaptchaError(
                "malformed_response",
                "Anti-Captcha returned an invalid task cost.",
              );
            }
          } else {
            throw new AntiCaptchaError(
              "malformed_response",
              "Anti-Captcha returned an invalid task cost.",
            );
          }
        }
        return {
          status: "ready",
          solution: { text: result.solution.text },
          ...(costUsd === undefined ? {} : { costUsd }),
        };
      }
      if (result.status === "failed") {
        return { status: "failed", code: "provider_task_failed" };
      }
      throw new AntiCaptchaError(
        "malformed_response",
        "Anti-Captcha returned an unknown task status.",
      );
    },
  };
}
