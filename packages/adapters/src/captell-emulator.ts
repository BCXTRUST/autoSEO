import { MIN_CAPTCHA_IMAGE_BYTES } from "@rakazo/adapter-kit";

/*
 * Offline Captell stand-in. It is an in-process `fetch` that replays the documented
 * `/api/v1` responses. Nothing here opens a socket. Images under the solver minimum are
 * refused before they are recorded, so a request log never contains them.
 */

export type CaptellEmulatorOp = "balance" | "solve" | "answer" | "task";

export interface CaptellCue {
  op: CaptellEmulatorOp;
  /** HTTP status. Defaults to 200. `network` rejects the fetch instead. */
  status?: number;
  body?: unknown;
  network?: boolean;
  /** How many matching calls consume this cue. Defaults to 1. */
  times?: number;
}

export interface CaptellEmulatorRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

interface PendingCue extends CaptellCue {
  remaining: number;
}

const SUCCESS = {
  balance: { credits: 1_000 },
  solve: { taskId: "task_default", answer: "K7XQ2", credits: 4, balance: 996 },
  answer: { answer: "Berlin" },
  task: { taskId: "task_default", status: "ready" },
} as const;

/** Documented Captell payloads. Tests queue these as cues. */
export const captellCues = {
  balance(credits: number): CaptellCue {
    return { op: "balance", body: { credits } };
  },
  imageSolved(answer = "K7XQ2", balance = 996): CaptellCue {
    return { op: "solve", body: { taskId: "task_image", answer, credits: 4, balance } };
  },
  tokenSolved(answer = "fixture-token", balance = 990): CaptellCue {
    return { op: "solve", body: { taskId: "task_token", answer, credits: 10, balance } };
  },
  notRead(): CaptellCue {
    return { op: "solve", body: { error: "Not read" } };
  },
  noToken(): CaptellCue {
    return { op: "solve", body: { error: "No token" } };
  },
  missingSiteKey(): CaptellCue {
    return { op: "solve", body: { error: "Missing site key" } };
  },
  unsupported(): CaptellCue {
    return { op: "solve", body: { error: "Unsupported type" } };
  },
  couldNotAnswer(): CaptellCue {
    return { op: "answer", status: 422, body: { status: "error", message: "Could not answer" } };
  },
  refused(): CaptellCue {
    return { op: "solve", status: 403, body: { error: "Request refused" } };
  },
  sandbox(answer = "sandbox-token"): CaptellCue {
    return {
      op: "solve",
      body: { taskId: "task_sandbox", answer, credits: 0, balance: 1_000, sandbox: true },
    };
  },
  credits(): CaptellCue {
    return { op: "solve", status: 402, body: { error: "Not enough credits" } };
  },
  serverError(): CaptellCue {
    return { op: "solve", status: 503, body: { error: "upstream" } };
  },
  network(op: CaptellEmulatorOp = "solve"): CaptellCue {
    return { op, network: true };
  },
};

export class CaptellEmulator {
  /** Calls that were actually forwarded. Tiny captcha images are absent from this log. */
  readonly requests: CaptellEmulatorRequest[] = [];
  private readonly cues: PendingCue[];

  constructor(cues: CaptellCue[] = []) {
    this.cues = cues.map((cue) => ({ ...cue, remaining: cue.times ?? 1 }));
  }

  /** Bound fetch implementation. Pass it to `CaptellHttpSolver`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = await readRequest(input, init);
    if (isTinyImage(request.body)) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    this.requests.push(request);
    const cue = this.take(opOf(request));
    if (cue?.network) throw new TypeError("network down");
    const op = opOf(request);
    const status = cue?.status ?? 200;
    const body = cue?.body ?? SUCCESS[op];
    return jsonResponse(body, status);
  };

  private take(op: CaptellEmulatorOp): PendingCue | undefined {
    const cue = this.cues.find((candidate) => candidate.op === op && candidate.remaining > 0);
    if (cue) cue.remaining -= 1;
    return cue;
  }
}

function opOf(request: CaptellEmulatorRequest): CaptellEmulatorOp {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/balance")) return "balance";
  if (path.endsWith("/answer")) return "answer";
  if (path.includes("/tasks/")) return "task";
  return "solve";
}

function isTinyImage(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { type?: unknown; body?: unknown };
  if (record.type !== "ImageToText" || typeof record.body !== "string") return false;
  const bytes = Buffer.from(record.body, "base64");
  return bytes.byteLength < MIN_CAPTCHA_IMAGE_BYTES;
}

async function readRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<CaptellEmulatorRequest> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  }
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  let body: unknown = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
  }
  return {
    method,
    url,
    authorization: headers.get("authorization"),
    contentType: headers.get("content-type"),
    body,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
