import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RAW_CHARS = 20_000;
const REVIEW_HASH_PREFIX = "autoseo:discourse-reviewed-contribution:v1";

export const DISCOURSE_UNSUPPORTED_CAPABILITIES = [
  "account_registration",
  "email_verification",
] as const;

export type DiscourseBlockedCode =
  | "invalid_input"
  | "authentication"
  | "not_found"
  | "permission_denied"
  | "redirect_rejected"
  | "provider_rejected"
  | "provider_unavailable"
  | "malformed_response"
  | "network_error";

export type DiscourseBlocked = {
  status: "blocked";
  code: DiscourseBlockedCode;
  message: string;
};

export type DiscourseSuccess<T> = { status: "success"; value: T };
export type DiscourseReadResult<T> = DiscourseSuccess<T> | DiscourseBlocked;

export type DiscourseAmbiguousSubmission = {
  status: "ambiguous_submission";
  operationKey: string;
  code:
    | "timeout"
    | "network_error"
    | "redirect_rejected"
    | "malformed_response"
    | "provider_uncertain";
  message: string;
};

export type DiscourseIdentity = { id: number; username: string };

export type DiscourseTopicPost = {
  id: number;
  postNumber: number;
  username: string;
  raw: string;
  cooked: string;
};

export type DiscourseTopic = {
  topicId: number;
  title: string;
  categoryId: number | null;
  posts: DiscourseTopicPost[];
};

export type DiscoursePublicationReceipt = {
  operationKey: string;
  postId: number;
  topicId: number;
  url: string;
};

export type DiscoursePublicationResult =
  | DiscourseSuccess<DiscoursePublicationReceipt>
  | DiscourseBlocked
  | DiscourseAmbiguousSubmission;

export type DiscourseVerification = {
  verification: "verified" | "pending" | "not_verified";
  evidence: {
    postId: number;
    topicId: number | null;
    audience: "public";
    visibility: "visible" | "moderated" | "deleted" | "not_visible" | "unknown";
    expectedLinkMatched: boolean;
  };
};

export interface DiscourseCampaignAdapter {
  getIdentity(): Promise<DiscourseReadResult<DiscourseIdentity>>;
  getTopic(topicId: number): Promise<DiscourseReadResult<DiscourseTopic>>;
  publishReviewedContribution(input: {
    topicId: number;
    raw: string;
    approval: { approved: true; approvedContentHash: string };
    operationKey: string;
  }): Promise<DiscoursePublicationResult>;
  verifyPublication(
    postId: number,
    expectedLink: string,
  ): Promise<DiscourseReadResult<DiscourseVerification>>;
}

export interface DiscourseCampaignOptions {
  baseUrl: string;
  apiKey: string;
  apiUsername: string;
  /** Required attestation that this site is authorized for this campaign. */
  authorizedSite: true;
  /** Inject a deterministic transport for tests. Production uses global fetch and HTTPS. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type ReadOutcome =
  | { kind: "response"; response: Response; payload: JsonObject | null }
  | { kind: "network_error" | "timeout" };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function blocked(code: DiscourseBlockedCode): DiscourseBlocked {
  const messages: Record<DiscourseBlockedCode, string> = {
    invalid_input: "The Discourse request input is invalid.",
    authentication: "Discourse rejected the configured credentials.",
    not_found: "The requested Discourse resource was not found.",
    permission_denied: "The configured Discourse account cannot access this resource.",
    redirect_rejected: "Discourse redirected the request; the adapter did not follow it.",
    provider_rejected: "Discourse rejected the request.",
    provider_unavailable: "Discourse is temporarily unavailable.",
    malformed_response: "Discourse returned an invalid response.",
    network_error: "Could not reach the configured Discourse site.",
  };
  return { status: "blocked", code, message: messages[code] };
}

function validTopicId(topicId: unknown): topicId is number {
  return positiveId(topicId);
}

function validRaw(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.trim().length > 0 &&
    raw.length <= MAX_RAW_CHARS &&
    !hasForbiddenControlCharacter(raw)
  );
}

function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function validOperationKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
}

/** SHA-256 over a versioned JSON tuple binds the exact content to its topic. */
export function hashReviewedContribution(topicId: number, raw: string): string {
  if (!validTopicId(topicId) || !validRaw(raw)) {
    throw new Error("A positive topic ID and valid reviewed content are required.");
  }
  return createHash("sha256")
    .update(JSON.stringify([REVIEW_HASH_PREFIX, topicId, raw]), "utf8")
    .digest("hex");
}

function normalizedHttpUrl(value: unknown, baseUrl?: string | URL): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function cookedLinks(cooked: string, baseUrl: URL): string[] {
  const links: string[] = [];
  const document = new JSDOM(cooked).window.document;
  document.querySelectorAll("script, style").forEach((node) => {
    node.remove();
  });
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href === null) continue;
    const normalized = normalizedHttpUrl(href, baseUrl);
    if (normalized) links.push(normalized);
  }
  return links;
}

function responseCode(status: number): DiscourseBlockedCode {
  if (status === 401 || status === 403)
    return status === 401 ? "authentication" : "permission_denied";
  if (status === 404) return "not_found";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected";
}

function parsePositivePathId(value: unknown): number | null {
  return positiveId(value) ? value : null;
}

export function createDiscourseCampaignAdapter(
  options: DiscourseCampaignOptions,
): DiscourseCampaignAdapter {
  if (options.authorizedSite !== true) {
    throw new Error("An authorized-site attestation is required.");
  }
  if (
    typeof options.apiKey !== "string" ||
    options.apiKey.trim().length === 0 ||
    /[\r\n]/.test(options.apiKey) ||
    typeof options.apiUsername !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(options.apiUsername)
  ) {
    throw new Error("Valid Discourse credentials are required.");
  }

  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new Error("A valid Discourse base URL is required.");
  }
  if (
    (base.protocol !== "https:" && !(options.fetch && base.protocol === "http:")) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "Discourse must use HTTPS and the base URL cannot contain credentials or query data.",
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const requestFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("timeoutMs must be between 1 and 120000.");
  }

  const endpoint = (path: string): string => new URL(path.replace(/^\/+/, ""), base).toString();

  function requestHeaders(
    headers: HeadersInit | undefined,
    authenticated: boolean,
  ): Record<string, string> {
    const result: Record<string, string> = { Accept: "application/json" };
    new Headers(headers).forEach((value, name) => {
      result[name] = value;
    });
    if (authenticated) {
      result["Api-Key"] = options.apiKey;
      result["Api-Username"] = options.apiUsername;
    }
    return result;
  }

  async function send(path: string, init: RequestInit, authenticated = true): Promise<ReadOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await requestFetch(endpoint(path), {
        ...init,
        signal: controller.signal,
        redirect: "manual",
        headers: requestHeaders(init.headers, authenticated),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (timedOut) return { kind: "timeout" };
        return { kind: "response", response, payload: null };
      }
      const payload = await jsonBody(response);
      if (timedOut) return { kind: "timeout" };
      return { kind: "response", response, payload };
    } catch {
      return { kind: timedOut ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function jsonBody(response: Response): Promise<JsonObject | null> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      if (totalBytes === 0) return null;
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const payload: unknown = JSON.parse(text);
      return isObject(payload) ? payload : null;
    } catch {
      return null;
    } finally {
      reader.releaseLock();
    }
  }

  function redirect(response: Response): boolean {
    return response.status >= 300 && response.status < 400;
  }

  async function getJson(
    path: string,
    authenticated = true,
  ): Promise<DiscourseReadResult<JsonObject>> {
    const outcome = await send(path, { method: "GET" }, authenticated);
    if (outcome.kind !== "response") {
      return blocked(outcome.kind === "timeout" ? "provider_unavailable" : "network_error");
    }
    if (redirect(outcome.response)) return blocked("redirect_rejected");
    if (!outcome.response.ok) return blocked(responseCode(outcome.response.status));
    const payload = outcome.payload;
    if (!payload) return blocked("malformed_response");
    return { status: "success", value: payload };
  }

  async function getIdentity(): Promise<DiscourseReadResult<DiscourseIdentity>> {
    const result = await getJson("session/current.json");
    if (result.status !== "success") return result;
    const user = result.value.current_user;
    if (
      !isObject(user) ||
      !positiveId(user.id) ||
      !safeString(user.username, 100) ||
      user.username.length === 0
    ) {
      return blocked("malformed_response");
    }
    return { status: "success", value: { id: user.id, username: user.username } };
  }

  async function getTopic(topicId: number): Promise<DiscourseReadResult<DiscourseTopic>> {
    if (!validTopicId(topicId)) return blocked("invalid_input");
    const result = await getJson(`t/${topicId}.json`);
    if (result.status !== "success") return result;
    const topic = result.value;
    const stream = topic.post_stream;
    if (
      !positiveId(topic.id) ||
      topic.id !== topicId ||
      !safeString(topic.title, 500) ||
      !isObject(stream) ||
      !Array.isArray(stream.posts)
    ) {
      return blocked("malformed_response");
    }
    const posts: DiscourseTopicPost[] = [];
    for (const item of stream.posts.slice(0, 50)) {
      if (!isObject(item) || !positiveId(item.id) || !positiveId(item.post_number)) continue;
      posts.push({
        id: item.id,
        postNumber: item.post_number,
        username: safeString(item.username, 100) ? item.username : "",
        raw: safeString(item.raw, MAX_RAW_CHARS) ? item.raw : "",
        cooked: safeString(item.cooked, 100_000) ? item.cooked : "",
      });
    }
    const categoryId =
      topic.category_id === null || topic.category_id === undefined
        ? null
        : parsePositivePathId(topic.category_id);
    if (topic.category_id !== null && topic.category_id !== undefined && categoryId === null) {
      return blocked("malformed_response");
    }
    return { status: "success", value: { topicId, title: topic.title, categoryId, posts } };
  }

  async function publishReviewedContribution(input: {
    topicId: number;
    raw: string;
    approval: { approved: true; approvedContentHash: string };
    operationKey: string;
  }): Promise<DiscoursePublicationResult> {
    if (
      !input ||
      !validTopicId(input.topicId) ||
      !validRaw(input.raw) ||
      !validOperationKey(input.operationKey) ||
      !input.approval ||
      input.approval.approved !== true ||
      typeof input.approval.approvedContentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.approval.approvedContentHash) ||
      input.approval.approvedContentHash !== hashReviewedContribution(input.topicId, input.raw)
    ) {
      return blocked("invalid_input");
    }

    // Discourse's standard create-post endpoint does not accept a documented
    // idempotency token. The caller must persist operationKey and reconcile
    // ambiguous results; this adapter deliberately never retries this POST.
    const outcome = await send("posts.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic_id: input.topicId, raw: input.raw }),
    });
    if (outcome.kind !== "response") {
      return {
        status: "ambiguous_submission",
        operationKey: input.operationKey,
        code: outcome.kind,
        message:
          "The post may have been created, but Discourse did not confirm its receipt. Do not retry automatically.",
      };
    }
    if (redirect(outcome.response)) {
      return {
        status: "ambiguous_submission",
        operationKey: input.operationKey,
        code: "redirect_rejected",
        message:
          "Discourse redirected the post request. Its result is uncertain; do not retry automatically.",
      };
    }
    if (!outcome.response.ok) {
      if (outcome.response.status === 408 || outcome.response.status >= 500) {
        return {
          status: "ambiguous_submission",
          operationKey: input.operationKey,
          code: "provider_uncertain",
          message:
            "Discourse did not confirm whether the post was created. Do not retry automatically.",
        };
      }
      return blocked(responseCode(outcome.response.status));
    }

    const payload = outcome.payload;
    const postId = payload ? parsePositivePathId(payload.id) : null;
    const topicId = payload ? parsePositivePathId(payload.topic_id) : null;
    const postNumber = payload ? parsePositivePathId(payload.post_number) : null;
    const hasPostUrl = typeof payload?.post_url === "string";
    const postUrl = hasPostUrl
      ? normalizedHttpUrl(payload?.post_url, base)
      : topicId !== null && postNumber !== null
        ? new URL(`t/${topicId}/${postNumber}`, base).href
        : null;
    if (
      !payload ||
      postId === null ||
      topicId !== input.topicId ||
      postNumber === null ||
      postUrl === null ||
      new URL(postUrl).origin !== base.origin ||
      new URL(postUrl).search.length > 0 ||
      new URL(postUrl).hash.length > 0
    ) {
      return {
        status: "ambiguous_submission",
        operationKey: input.operationKey,
        code: "malformed_response",
        message:
          "Discourse may have created the post, but the receipt was invalid. Do not retry automatically.",
      };
    }
    return {
      status: "success",
      value: { operationKey: input.operationKey, postId, topicId, url: postUrl },
    };
  }

  async function verifyPublication(
    postId: number,
    expectedLink: string,
  ): Promise<DiscourseReadResult<DiscourseVerification>> {
    const normalizedExpected = normalizedHttpUrl(expectedLink);
    if (!validTopicId(postId) || normalizedExpected === null) return blocked("invalid_input");
    // Verify through an anonymous read so an admin-only or private post can
    // never be reported as publicly live.
    const result = await getJson(`posts/${postId}.json`, false);
    if (
      result.status === "blocked" &&
      (result.code === "not_found" ||
        result.code === "authentication" ||
        result.code === "permission_denied")
    ) {
      return {
        status: "success",
        value: {
          verification: "pending",
          evidence: {
            postId,
            topicId: null,
            audience: "public",
            visibility: result.code === "not_found" ? "not_visible" : "unknown",
            expectedLinkMatched: false,
          },
        },
      };
    }
    if (result.status !== "success") return result;
    const post = result.value;
    const observedTopicId = parsePositivePathId(post.topic_id);
    const deleted =
      post.deleted === true || (typeof post.deleted_at === "string" && post.deleted_at.length > 0);
    const moderated =
      post.hidden === true || (typeof post.post_status === "number" && post.post_status > 0);
    if (post.id !== postId || observedTopicId === null || !safeString(post.cooked, 200_000)) {
      return blocked("malformed_response");
    }
    const matched = cookedLinks(post.cooked, base).includes(normalizedExpected);
    const visibility = deleted ? "deleted" : moderated ? "moderated" : "visible";
    const verification = deleted
      ? "not_verified"
      : moderated
        ? "pending"
        : matched
          ? "verified"
          : "not_verified";
    return {
      status: "success",
      value: {
        verification,
        evidence: {
          postId,
          topicId: observedTopicId,
          audience: "public",
          visibility,
          expectedLinkMatched: matched,
        },
      },
    };
  }

  return { getIdentity, getTopic, publishReviewedContribution, verifyPublication };
}
