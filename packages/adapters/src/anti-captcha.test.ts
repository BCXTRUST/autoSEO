import { describe, expect, it, vi } from "vitest";
import { AntiCaptchaError, createAntiCaptchaAdapter } from "./anti-captcha.js";

const key = "test-secret-that-must-not-leak";
const input = {
  type: "image-to-text" as const,
  authorizedUse: true as const,
  imageBase64: "aW1hZ2U=",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchQueue(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const item = responses.shift();
    if (item instanceof Error) throw item;
    if (!item) throw new Error("unexpected request");
    return item;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("Anti-Captcha adapter", () => {
  it("does not make a request during construction and returns a validated balance", async () => {
    const { fetcher, calls } = fetchQueue(json({ errorId: 0, balance: 1.25 }));
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    expect(calls).toHaveLength(0);
    await expect(adapter.getBalance()).resolves.toEqual({ balanceUsd: 1.25 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anti-captcha.com/getBalance");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ clientKey: key });
  });

  it("creates ImageToTextTask and returns only the reusable task id", async () => {
    const { fetcher, calls } = fetchQueue(json({ errorId: 0, taskId: 90210 }));
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(adapter.createTask({ ...input, numeric: 3, minLength: 4 })).resolves.toEqual({
      taskId: "90210",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      clientKey: key,
      task: { type: "ImageToTextTask", body: "aW1hZ2U=", numeric: 3, minLength: 4 },
    });
  });

  it("polls processing tasks and returns a typed solution without retaining provider payloads", async () => {
    const { fetcher } = fetchQueue(
      json({ errorId: 0, status: "processing" }),
      json({
        errorId: 0,
        status: "ready",
        solution: { text: "answer", other: "ignored" },
        cost: "0.000700",
      }),
    );
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(adapter.pollTask("1")).resolves.toEqual({ status: "processing" });
    await expect(adapter.pollTask("1")).resolves.toEqual({
      status: "ready",
      solution: { text: "answer" },
      costUsd: 0.0007,
    });
  });

  it("maps provider task failure without exposing provider text", async () => {
    const { fetcher } = fetchQueue(
      json({ errorId: 0, status: "failed", errorCode: "SECRET_INTERNAL_TEXT" }),
    );
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(adapter.pollTask("23")).resolves.toEqual({
      status: "failed",
      code: "provider_task_failed",
    });
  });

  it("maps low balance and authentication provider errors to stable sanitized codes", async () => {
    const lowFunds = fetchQueue(
      json({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: key }),
    );
    const lowFundsAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: lowFunds.fetcher });
    const lowError = await lowFundsAdapter.createTask(input).catch((e: unknown) => e);
    expect(lowError).toBeInstanceOf(AntiCaptchaError);
    expect(lowError).toMatchObject({ code: "low_balance" });
    expect(String(lowError)).not.toContain(key);

    const auth = fetchQueue(json({ errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST" }));
    const authAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: auth.fetcher });
    await expect(authAdapter.getBalance()).rejects.toMatchObject({ code: "authentication" });
  });

  it("rejects malformed JSON and invalid balances", async () => {
    const malformed = fetchQueue(new Response("not json"));
    const malformedAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: malformed.fetcher });
    await expect(malformedAdapter.getBalance()).rejects.toMatchObject({
      code: "malformed_response",
    });

    const balance = fetchQueue(json({ errorId: 0, balance: "1.00" }));
    const balanceAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: balance.fetcher });
    await expect(balanceAdapter.getBalance()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("validates optional task cost and rejects malformed cost values", async () => {
    const validCost = fetchQueue(
      json({ errorId: 0, status: "ready", solution: { text: "ok" }, cost: 0.012 }),
    );
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: validCost.fetcher });
    await expect(adapter.pollTask("9")).resolves.toEqual({
      status: "ready",
      solution: { text: "ok" },
      costUsd: 0.012,
    });

    const badCost = fetchQueue(
      json({ errorId: 0, status: "ready", solution: { text: "ok" }, cost: key }),
    );
    const badCostAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: badCost.fetcher });
    const error = await badCostAdapter.pollTask("9").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "malformed_response" });
    expect(String(error)).not.toContain(key);
  });

  it("requires a valid errorId and treats an unconfirmed create as ambiguous", async () => {
    const create = fetchQueue(json({ taskId: 1 }));
    const createAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: create.fetcher });
    await expect(createAdapter.createTask(input)).rejects.toMatchObject({
      code: "ambiguous_creation",
    });
    expect(create.calls).toHaveLength(1);

    const poll = fetchQueue(json({ status: "processing" }));
    const pollAdapter = createAntiCaptchaAdapter({ clientKey: key, fetch: poll.fetcher });
    await expect(pollAdapter.pollTask("1")).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("requires explicit authorization and validates task identifiers without a request", async () => {
    const { fetcher, calls } = fetchQueue();
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(
      adapter.createTask({ ...input, authorizedUse: false } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(adapter.pollTask("../bad")).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("does not retry or conceal an ambiguous createTask result", async () => {
    const { fetcher, calls } = fetchQueue(new TypeError("socket disconnected"));
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    const error = await adapter.createTask(input).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ambiguous_creation" });
    expect(String(error)).not.toContain(key);
    expect(calls).toHaveLength(1);
  });

  it("returns an ambiguous creation error when response parsing fails after a create request", async () => {
    const { fetcher } = fetchQueue(new Response("invalid"));
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(adapter.createTask(input)).rejects.toMatchObject({ code: "ambiguous_creation" });
  });

  it("honors cancellation before issuing requests", async () => {
    const { fetcher, calls } = fetchQueue();
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.getBalance({ signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(calls).toHaveLength(0);
  });

  it("honors cancellation during an in-flight request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }) as unknown as typeof fetch;
    const adapter = createAntiCaptchaAdapter({ clientKey: key, fetch: fetcher });
    await expect(adapter.getBalance({ signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("maps the per-request deadline to a bounded timeout error", async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const adapter = createAntiCaptchaAdapter({
      clientKey: key,
      fetch: fetcher,
      requestTimeoutMs: 1,
    });
    await expect(adapter.getBalance()).rejects.toMatchObject({ code: "timeout" });
  });

  it("uses per-request timeout signals", async () => {
    const { fetcher, calls } = fetchQueue(json({ errorId: 0, balance: 2 }));
    const adapter = createAntiCaptchaAdapter({
      clientKey: key,
      fetch: fetcher,
      requestTimeoutMs: 2345,
    });
    await adapter.getBalance();
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
