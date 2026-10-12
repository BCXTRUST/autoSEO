import type { AdapterContext } from "@rakazo/adapter-kit";
import { CaptchaSolverError, MIN_CAPTCHA_IMAGE_BYTES } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CaptellEmulator, captellCues } from "./captell-emulator.js";
import { CaptellHttpSolver } from "./captell-solver.js";

const TOKEN = "ct_live_placeholder";
const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

function solver(emulator: CaptellEmulator, options: { maxRetries?: number } = {}) {
  return new CaptellHttpSolver({
    token: async () => TOKEN,
    fetch: emulator.fetch,
    baseUrl: "https://captell.example",
    maxRetries: options.maxRetries ?? 0,
    retryDelayMs: 0,
  });
}

const png = new Uint8Array(MIN_CAPTCHA_IMAGE_BYTES + 20).fill(7);
png.set([0x89, 0x50, 0x4e, 0x47], 0);

describe("CaptellHttpSolver", () => {
  it("describes the captcha types the HTTPS door solves", () => {
    const described = solver(new CaptellEmulator()).describe();
    expect(described.id).toBe("captell-http");
    expect(described.capabilities.supports).toEqual([
      "recaptcha_v2",
      "recaptcha_v3",
      "recaptcha_enterprise",
      "turnstile",
      "hcaptcha",
      "geetest",
      "funcaptcha",
      "image_letters",
      "knowledge_question",
    ]);
  });

  it("posts enterprise, GeeTest and FunCaptcha on the HTTPS door and accepts a deployment key", async () => {
    const emulator = new CaptellEmulator([
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
    ]);
    const client = new CaptellHttpSolver({
      token: async () => "deployment-key-unlimited-1",
      fetch: emulator.fetch,
      baseUrl: "https://captell.example",
      maxRetries: 0,
    });
    await client.solve(
      {
        type: "recaptcha_enterprise",
        websiteURL: "https://board.example/register",
        websiteKey: "ent-1",
      },
      context,
    );
    await client.solve(
      { type: "geetest", websiteURL: "https://board.example/register", websiteKey: "gt-1" },
      context,
    );
    await client.solve(
      { type: "funcaptcha", websiteURL: "https://board.example/register", websiteKey: "pk-1" },
      context,
    );
    expect(emulator.requests.map((request) => request.body)).toEqual([
      {
        type: "RecaptchaV2",
        websiteURL: "https://board.example/register",
        websiteKey: "ent-1",
        isEnterprise: true,
      },
      { type: "GeeTest", websiteURL: "https://board.example/register", gt: "gt-1" },
      {
        type: "FunCaptcha",
        websiteURL: "https://board.example/register",
        websitePublicKey: "pk-1",
      },
    ]);
    expect(emulator.requests[0]?.authorization).toBe("Bearer deployment-key-unlimited-1");
    const refused = new CaptellEmulator();
    await expect(
      new CaptellHttpSolver({
        token: async () => "short",
        fetch: refused.fetch,
        baseUrl: "https://captell.example",
        maxRetries: 0,
      }).solve(
        { type: "geetest", websiteURL: "https://board.example/register", websiteKey: "gt-1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(refused.requests).toHaveLength(0);
  });

  it("posts ImageToText and widget solves with the bearer token and never the image when it is tiny", async () => {
    const emulator = new CaptellEmulator([captellCues.imageSolved(), captellCues.tokenSolved()]);
    const client = solver(emulator);
    const image = await client.solve({ type: "ImageToText", imagePng: png }, context);
    expect(image).toEqual({ answer: "K7XQ2", credits: 4, balance: 996, taskId: "task_image" });
    const token = await client.solve(
      {
        type: "recaptcha_v2",
        websiteURL: "https://board.example/register",
        websiteKey: "site-key-1",
      },
      context,
    );
    expect(token.taskId).toBe("task_token");
    expect(emulator.requests).toHaveLength(2);
    expect(emulator.requests[0]).toMatchObject({
      method: "POST",
      url: "https://captell.example/api/v1/solve",
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
      body: { type: "ImageToText", body: Buffer.from(png).toString("base64") },
    });
    expect(JSON.stringify(emulator.requests[0]?.body)).not.toContain("data:");
    expect(emulator.requests.every((request) => !request.url.includes("/tasks/"))).toBe(true);
    expect(emulator.requests[1]?.body).toEqual({
      type: "RecaptchaV2",
      websiteURL: "https://board.example/register",
      websiteKey: "site-key-1",
    });
    expect(JSON.stringify(emulator.requests[1]?.body)).not.toContain(TOKEN);

    const blocked = new CaptellEmulator();
    const tiny = new Uint8Array(MIN_CAPTCHA_IMAGE_BYTES - 1);
    await expect(
      solver(blocked).solve({ type: "ImageToText", imagePng: tiny }, context),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(blocked.requests).toHaveLength(0);
    await blocked.fetch("https://captell.example/api/v1/solve", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ImageToText", body: Buffer.from(tiny).toString("base64") }),
    });
    expect(blocked.requests).toHaveLength(0);
  });

  it("maps every documented failure and treats a sandbox label as a hard failure", async () => {
    const cases: Array<{
      cue: ReturnType<typeof captellCues.notRead>;
      code: string;
      retryable: boolean;
    }> = [
      { cue: captellCues.notRead(), code: "not_read", retryable: false },
      { cue: captellCues.noToken(), code: "no_token", retryable: true },
      { cue: captellCues.missingSiteKey(), code: "missing_site_key", retryable: false },
      { cue: captellCues.unsupported(), code: "unsupported", retryable: false },
      { cue: captellCues.refused(), code: "refused", retryable: false },
      { cue: captellCues.credits(), code: "credits", retryable: false },
      { cue: captellCues.sandbox("sandbox-token-value"), code: "sandbox", retryable: false },
      { cue: captellCues.serverError(), code: "error", retryable: true },
    ];
    for (const entry of cases) {
      const emulator = new CaptellEmulator([entry.cue]);
      const error = await solver(emulator)
        .solve({ type: "ImageToText", imagePng: png }, context)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(CaptchaSolverError);
      expect(error).toMatchObject({ code: entry.code, retryable: entry.retryable });
      expect(error instanceof Error ? error.message : "").not.toContain("sandbox-token-value");
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }

    const answered = solver(new CaptellEmulator([captellCues.couldNotAnswer()]));
    await expect(
      answered.answerQuestion({ question: "Wie heißt die Hauptstadt?" }, context),
    ).resolves.toEqual({
      couldNotAnswer: true,
    });
    const known = solver(new CaptellEmulator([{ op: "answer", body: { answer: "Berlin" } }]));
    await expect(known.answerQuestion({ question: "2+2" }, context)).resolves.toEqual({
      answer: "Berlin",
    });
  });

  it("retries a transient 5xx inside the budget and then stops", async () => {
    const emulator = new CaptellEmulator([
      { ...captellCues.serverError(), times: 2 },
      captellCues.imageSolved(),
    ]);
    const client = solver(emulator, { maxRetries: 2 });
    await expect(
      client.solve({ type: "ImageToText", imagePng: png }, context),
    ).resolves.toMatchObject({
      answer: "K7XQ2",
    });
    expect(emulator.requests).toHaveLength(3);

    const down = new CaptellEmulator([{ ...captellCues.network("balance"), times: 3 }]);
    await expect(solver(down, { maxRetries: 2 }).balance(context)).rejects.toMatchObject({
      code: "error",
      retryable: false,
    });
    expect(down.requests).toHaveLength(3);
  });

  it("reads the balance and refuses a sandbox-labelled balance", async () => {
    const emulator = new CaptellEmulator([captellCues.balance(42)]);
    await expect(solver(emulator).balance(context)).resolves.toEqual({ credits: 42 });
    expect(emulator.requests[0]).toMatchObject({
      method: "GET",
      url: "https://captell.example/api/v1/balance",
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    });
    const sand = new CaptellEmulator([{ op: "balance", body: { credits: 1, sandbox: true } }]);
    await expect(solver(sand).balance(context)).rejects.toMatchObject({
      code: "sandbox",
      retryable: false,
    });
  });

  it("does not put the token in an error when the call cannot leave the machine", async () => {
    const client = new CaptellHttpSolver({
      token: async () => TOKEN,
      fetch: async () => {
        throw new Error(`connect ${TOKEN} failed`);
      },
      baseUrl: "https://captell.example",
      maxRetries: 0,
    });
    await expect(client.balance(context)).rejects.toMatchObject({ code: "error", retryable: true });
    try {
      await client.balance(context);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }
  });

  it("reads a synchronous ready result and does not poll the task", async () => {
    const emulator = new CaptellEmulator([
      {
        op: "solve",
        body: {
          id: "job_ready",
          status: "ready",
          type: "RecaptchaV2",
          credits: 10,
          balance: 0,
          answer: "top-level",
          solution: { gRecaptchaResponse: "from-solution" },
          sandbox: false,
        },
      },
      {
        op: "solve",
        body: {
          id: "job_text",
          status: "ready",
          type: "ImageToText",
          credits: 4,
          balance: 0,
          answer: "ignored",
          solution: { text: "K7XQ2", token: "other" },
          sandbox: false,
        },
      },
    ]);
    const client = solver(emulator);
    await expect(
      client.solve(
        {
          type: "recaptcha_v2",
          websiteURL: "https://board.example/register",
          websiteKey: "site-key-1",
        },
        context,
      ),
    ).resolves.toEqual({
      answer: "from-solution",
      credits: 10,
      balance: 0,
      taskId: "job_ready",
    });
    await expect(client.solve({ type: "ImageToText", imagePng: png }, context)).resolves.toEqual({
      answer: "K7XQ2",
      credits: 4,
      balance: 0,
      taskId: "job_text",
    });
    expect(emulator.requests.every((request) => !request.url.includes("/tasks/"))).toBe(true);
  });

  it("sends invisible v2 as RecaptchaV2, snaps v3 scores, and copies optional fields", async () => {
    const emulator = new CaptellEmulator([
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
    ]);
    const client = solver(emulator);
    const page = "https://board.example/register";
    await client.solve(
      { type: "recaptcha_v2", websiteURL: page, websiteKey: "k", isInvisible: true },
      context,
    );
    await client.solve(
      { type: "recaptcha_v2", websiteURL: page, websiteKey: "k", isInvisible: "true" },
      context,
    );
    await client.solve(
      { type: "recaptcha_v2", websiteURL: page, websiteKey: "k", isInvisible: "1" },
      context,
    );
    await client.solve({ type: "recaptcha_v3", websiteURL: page, websiteKey: "k" }, context);
    await client.solve(
      {
        type: "turnstile",
        websiteURL: page,
        websiteKey: "k",
        action: "register",
        cData: "cd",
        pageAction: "signup",
        minScore: 0.8,
      },
      context,
    );
    expect(emulator.requests.map((request) => request.body)).toEqual([
      { type: "RecaptchaV2", websiteURL: page, websiteKey: "k", isInvisible: true },
      { type: "RecaptchaV2", websiteURL: page, websiteKey: "k", isInvisible: true },
      { type: "RecaptchaV2", websiteURL: page, websiteKey: "k", isInvisible: true },
      { type: "RecaptchaV3", websiteURL: page, websiteKey: "k", minScore: 0.3 },
      {
        type: "Turnstile",
        websiteURL: page,
        websiteKey: "k",
        action: "register",
        cData: "cd",
        pageAction: "signup",
        minScore: 0.8,
      },
    ]);
    const scores = new CaptellEmulator([
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
      captellCues.tokenSolved(),
    ]);
    const scored = solver(scores);
    for (const minScore of [0.5, 0.6, 0.85]) {
      await scored.solve(
        { type: "recaptcha_v3", websiteURL: page, websiteKey: "k", minScore },
        context,
      );
    }
    expect(
      scores.requests.map((request) => (request.body as { minScore: number }).minScore),
    ).toEqual([0.3, 0.7, 0.9]);
  });

  it("retries a failed solve and does not retry a request that never starts a job", async () => {
    const upstream = new CaptellEmulator([
      { op: "solve", status: 422, body: { code: "UPSTREAM", message: "upstream" }, times: 2 },
      {
        op: "solve",
        body: {
          id: "job_after",
          status: "ready",
          credits: 10,
          balance: 0,
          answer: "token-after-retry",
          solution: {},
        },
      },
    ]);
    await expect(
      solver(upstream, { maxRetries: 4 }).solve(
        {
          type: "recaptcha_v2",
          websiteURL: "https://board.example/register",
          websiteKey: "k",
        },
        context,
      ),
    ).resolves.toMatchObject({ answer: "token-after-retry", taskId: "job_after", balance: 0 });
    expect(upstream.requests).toHaveLength(3);

    const busy = new CaptellEmulator([
      {
        op: "solve",
        status: 422,
        body: { message: "No solver is free right now. Credits were returned." },
        times: 1,
      },
      captellCues.tokenSolved(),
    ]);
    await expect(
      solver(busy, { maxRetries: 4 }).solve({ type: "ImageToText", imagePng: png }, context),
    ).resolves.toMatchObject({ answer: "fixture-token" });
    expect(busy.requests).toHaveLength(2);

    const stopped = [
      { status: 422, body: { code: "UNREADABLE", message: "crop closer" }, code: "not_read" },
      { status: 400, body: { code: "MISSING_FIELD" }, code: "invalid_request" },
      { status: 400, body: { code: "FILE_TOO_SMALL" }, code: "invalid_request" },
      { status: 400, body: { code: "UNKNOWN_TYPE" }, code: "unsupported" },
      { status: 400, body: { code: "BAD_JSON" }, code: "invalid_request" },
      { status: 401, body: { code: "UNAUTHORIZED" }, code: "refused" },
      {
        status: 402,
        body: { code: "INSUFFICIENT_CREDITS", message: "Not enough credits" },
        code: "credits",
      },
      { status: 499, body: { code: "ABORTED", message: "The try was stopped." }, code: "error" },
      { status: 422, body: { code: "PAUSED" }, code: "invalid_request" },
      {
        status: 422,
        body: { code: "TIMEOUT", message: "The solver did not answer in time." },
        code: "error",
        requests: 5,
      },
    ] as const;
    for (const entry of stopped) {
      const emulator = new CaptellEmulator([
        { op: "solve", status: entry.status, body: entry.body, times: 5 },
      ]);
      const error = await solver(emulator, { maxRetries: 4 })
        .solve({ type: "ImageToText", imagePng: png }, context)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(CaptchaSolverError);
      expect(error).toMatchObject({ code: entry.code, retryable: false });
      expect(emulator.requests).toHaveLength("requests" in entry ? entry.requests : 1);
      expect(error instanceof Error ? error.message : "").not.toMatch(/not enough credits/i);
    }
  });

  it("polls a processing hCaptcha job and accepts a ready task with no balance", async () => {
    const emulator = new CaptellEmulator([
      {
        op: "solve",
        status: 202,
        body: { status: "processing", id: "job_1", type: "HCaptcha", balance: "0" },
      },
      {
        op: "task",
        body: { status: "processing", id: "job_1", type: "HCaptcha" },
      },
      {
        op: "task",
        body: {
          id: "job_1",
          status: "ready",
          credits: 10,
          sandbox: false,
          solution: { gRecaptchaResponse: "fixture-widget-token", userAgent: "Mozilla/5.0" },
          answer: "fixture-widget-token",
        },
      },
    ]);
    const client = new CaptellHttpSolver({
      token: async () => TOKEN,
      fetch: emulator.fetch,
      baseUrl: "https://captell.example",
      maxRetries: 0,
      pollIntervalMs: 0,
      solveTimeoutMs: 5_000,
    });
    await expect(
      client.solve(
        {
          type: "hcaptcha",
          websiteURL: "https://board.example/ucp.php?mode=register",
          websiteKey: "site-key-1",
        },
        context,
      ),
    ).resolves.toEqual({
      answer: "fixture-widget-token",
      credits: 10,
      balance: 0,
      taskId: "job_1",
    });
    expect(emulator.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://captell.example/api/v1/solve",
      "GET https://captell.example/api/v1/tasks/job_1",
      "GET https://captell.example/api/v1/tasks/job_1",
    ]);
  });

  it("stops polling when the task reports an error and when the budget runs out", async () => {
    const failed = new CaptellEmulator([
      { op: "solve", status: 202, body: { status: "processing", id: "job_bad" } },
      {
        op: "task",
        status: 422,
        body: { id: "job_bad", status: "error", code: "UNREADABLE", message: "Not read" },
      },
    ]);
    await expect(
      new CaptellHttpSolver({
        token: async () => TOKEN,
        fetch: failed.fetch,
        baseUrl: "https://captell.example",
        maxRetries: 0,
        pollIntervalMs: 0,
        solveTimeoutMs: 5_000,
      }).solve(
        { type: "hcaptcha", websiteURL: "https://board.example/register", websiteKey: "k" },
        context,
      ),
    ).rejects.toMatchObject({ code: "not_read" });
    expect(failed.requests).toHaveLength(2);

    const stuck = new CaptellEmulator([
      { op: "solve", status: 202, body: { status: "processing", id: "job_stuck" } },
      { op: "task", body: { status: "processing", id: "job_stuck" }, times: 5 },
    ]);
    await expect(
      new CaptellHttpSolver({
        token: async () => TOKEN,
        fetch: stuck.fetch,
        baseUrl: "https://captell.example",
        maxRetries: 0,
        pollIntervalMs: 100,
        solveTimeoutMs: 40,
      }).solve(
        { type: "hcaptcha", websiteURL: "https://board.example/register", websiteKey: "k" },
        context,
      ),
    ).rejects.toMatchObject({ code: "error", retryable: true });
  });

  it("reads a live balance body that names the field balance and sends it as a string", async () => {
    const emulator = new CaptellEmulator([
      { op: "balance", body: { balance: "0", name: "autoseo" } },
    ]);
    await expect(solver(emulator).balance(context)).resolves.toEqual({ credits: 0 });
  });

  it("returns an instruction without calling the desk for a password, 2FA or email code", async () => {
    const instructed = new CaptellEmulator([
      {
        op: "answer",
        body: { status: "ready", instruction: "Click Weiter on this form." },
      },
    ]);
    await expect(
      solver(instructed).answerQuestion({ question: "Wie heißt die Hauptstadt?" }, context),
    ).resolves.toEqual({ instruction: "Click Weiter on this form." });

    const secret = new CaptellEmulator();
    await expect(
      solver(secret).answerQuestion({ question: "What is your password?" }, context),
    ).resolves.toEqual({ couldNotAnswer: true });
    await expect(
      solver(secret).answerQuestion({ question: "Enter the email code" }, context),
    ).resolves.toEqual({ couldNotAnswer: true });
    expect(secret.requests).toHaveLength(0);
  });
});
