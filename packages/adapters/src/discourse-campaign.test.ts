import { describe, expect, it, vi } from "vitest";
import { createDiscourseCampaignAdapter, hashReviewedContribution } from "./discourse-campaign.js";

const apiKey = "test-discourse-key-must-not-leak";
const topicId = 42;
const raw = "A reviewed contribution with a source link: https://example.org/guide";
const expectedLink = "https://example.org/guide";

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
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake-fetch call");
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function adapter(fetcher: typeof fetch, extra: { timeoutMs?: number; baseUrl?: string } = {}) {
  return createDiscourseCampaignAdapter({
    baseUrl: extra.baseUrl ?? "https://forum.example.test",
    apiKey,
    apiUsername: "campaign-bot",
    authorizedSite: true,
    fetch: fetcher,
    timeoutMs: extra.timeoutMs,
  });
}

function approval(forTopic = topicId, content = raw) {
  return {
    approved: true as const,
    approvedContentHash: hashReviewedContribution(forTopic, content),
  };
}

describe("Discourse campaign adapter", () => {
  it("requires an explicit authorized-site attestation and performs no request on construction", () => {
    expect(() =>
      createDiscourseCampaignAdapter({
        baseUrl: "https://forum.example.test",
        apiKey,
        apiUsername: "campaign-bot",
        authorizedSite: false as true,
        fetch: vi.fn() as unknown as typeof fetch,
      }),
    ).toThrow(/authorized-site/);

    const { fetcher, calls } = fetchQueue();
    adapter(fetcher);
    expect(calls).toHaveLength(0);
  });

  it("requires HTTPS unless a test or controlled transport is injected", () => {
    expect(() =>
      createDiscourseCampaignAdapter({
        baseUrl: "http://forum.example.test",
        apiKey,
        apiUsername: "campaign-bot",
        authorizedSite: true,
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      createDiscourseCampaignAdapter({
        baseUrl: `https://user:${apiKey}@forum.example.test`,
        apiKey,
        apiUsername: "campaign-bot",
        authorizedSite: true,
        fetch: vi.fn() as unknown as typeof fetch,
      }),
    ).toThrow(/credentials/);
  });

  it("reads only the current-user identity and safe topic fields", async () => {
    const { fetcher, calls } = fetchQueue(
      json({ current_user: { id: 7, username: "campaign-bot", email: "private@example.test" } }),
      json({
        id: topicId,
        title: "Campaign topic",
        category_id: 4,
        post_stream: {
          posts: [
            {
              id: 100,
              post_number: 1,
              username: "member",
              raw: "Original",
              cooked: "<p>Original</p>",
              email: "private",
            },
          ],
        },
      }),
    );
    const discourse = adapter(fetcher);

    await expect(discourse.getIdentity()).resolves.toEqual({
      status: "success",
      value: { id: 7, username: "campaign-bot" },
    });
    await expect(discourse.getTopic(topicId)).resolves.toEqual({
      status: "success",
      value: {
        topicId,
        title: "Campaign topic",
        categoryId: 4,
        posts: [
          {
            id: 100,
            postNumber: 1,
            username: "member",
            raw: "Original",
            cooked: "<p>Original</p>",
          },
        ],
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://forum.example.test/session/current.json",
      `https://forum.example.test/t/${topicId}.json`,
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({
      "Api-Key": apiKey,
      "Api-Username": "campaign-bot",
    });
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("blocks a missing or content-mismatched review approval before any POST", async () => {
    const { fetcher, calls } = fetchQueue();
    const discourse = adapter(fetcher);
    const publish = (content: string, approvedContentHash: string) =>
      discourse.publishReviewedContribution({
        topicId,
        raw: content,
        approval: { approved: true, approvedContentHash },
        operationKey: "contribution:7:publish",
      });

    await expect(publish(raw, hashReviewedContribution(topicId + 1, raw))).resolves.toMatchObject({
      status: "blocked",
      code: "invalid_input",
    });
    await expect(publish(`${raw} changed`, approval().approvedContentHash)).resolves.toMatchObject({
      status: "blocked",
      code: "invalid_input",
    });
    await expect(
      discourse.publishReviewedContribution({
        topicId,
        raw,
        approval: undefined as never,
        operationKey: "contribution:7:publish",
      }),
    ).resolves.toMatchObject({ status: "blocked", code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("publishes reviewed text once and returns a same-origin receipt without claiming server idempotency", async () => {
    const { fetcher, calls } = fetchQueue(
      json({ id: 101, topic_id: topicId, topic_slug: "campaign", post_number: 2 }),
    );
    const discourse = adapter(fetcher);
    await expect(
      discourse.publishReviewedContribution({
        topicId,
        raw,
        approval: approval(),
        operationKey: "contribution:7:publish",
      }),
    ).resolves.toEqual({
      status: "success",
      value: {
        operationKey: "contribution:7:publish",
        postId: 101,
        topicId,
        url: `https://forum.example.test/t/${topicId}/2`,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ topic_id: topicId, raw });
    expect(String(calls[0]?.init?.body)).not.toContain(apiKey);
  });

  it("rejects a cross-origin post URL and treats the successful response as ambiguous", async () => {
    const { fetcher } = fetchQueue(
      json({
        id: 101,
        topic_id: topicId,
        post_number: 2,
        post_url: "https://attacker.example/collect",
      }),
    );
    const result = await adapter(fetcher).publishReviewedContribution({
      topicId,
      raw,
      approval: approval(),
      operationKey: "op-101",
    });
    expect(result).toMatchObject({
      status: "ambiguous_submission",
      code: "malformed_response",
      operationKey: "op-101",
    });
    expect(JSON.stringify(result)).not.toContain("attacker.example");
  });

  it("sanitizes ambiguous transport failures and does not retry a timed-out POST", async () => {
    const { fetcher, calls } = fetchQueue(new Error(`socket failed: ${apiKey}`));
    const result = await adapter(fetcher).publishReviewedContribution({
      topicId,
      raw,
      approval: approval(),
      operationKey: "op-timeout",
    });
    expect(result).toMatchObject({
      status: "ambiguous_submission",
      code: "network_error",
      operationKey: "op-timeout",
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(calls).toHaveLength(1);

    const timeoutFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;
    const timedOut = await adapter(timeoutFetch, { timeoutMs: 5 }).publishReviewedContribution({
      topicId,
      raw,
      approval: approval(),
      operationKey: "op-timeout",
    });
    expect(timedOut).toMatchObject({ status: "ambiguous_submission", code: "timeout" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
  });

  it("never follows redirects carrying API credentials", async () => {
    const { fetcher, calls } = fetchQueue(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
    const result = await adapter(fetcher).publishReviewedContribution({
      topicId,
      raw,
      approval: approval(),
      operationKey: "op-redirect",
    });
    expect(result).toMatchObject({ status: "ambiguous_submission", code: "redirect_rejected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("verifies an exact normalized link and rejects substring-only matches", async () => {
    const { fetcher } = fetchQueue(
      json({
        id: 201,
        topic_id: topicId,
        cooked: '<p><a href="https://example.org/guide">right</a></p>',
      }),
      json({
        id: 202,
        topic_id: topicId,
        cooked: '<p><a href="https://example.org/guidebook">near match</a></p>',
      }),
      json({
        id: 203,
        topic_id: topicId,
        cooked: '<p><a href="https://example.org/guide">right</a></p>',
        hidden: true,
      }),
      json({
        id: 204,
        topic_id: topicId,
        cooked: '<p><a href="https://example.org/guide">right</a></p>',
        deleted_at: "2026-10-01T00:00:00Z",
      }),
      json({
        id: 205,
        topic_id: topicId,
        cooked: `<!-- <a href="${expectedLink}">comment</a> --><script><a href="${expectedLink}">script</a></script><p>No real link</p>`,
      }),
    );
    const discourse = adapter(fetcher);
    await expect(discourse.verifyPublication(201, expectedLink)).resolves.toMatchObject({
      status: "success",
      value: {
        verification: "verified",
        evidence: { expectedLinkMatched: true, visibility: "visible" },
      },
    });
    await expect(discourse.verifyPublication(202, expectedLink)).resolves.toMatchObject({
      status: "success",
      value: { verification: "not_verified", evidence: { expectedLinkMatched: false } },
    });
    await expect(discourse.verifyPublication(203, expectedLink)).resolves.toMatchObject({
      status: "success",
      value: {
        verification: "pending",
        evidence: { expectedLinkMatched: true, visibility: "moderated" },
      },
    });
    await expect(discourse.verifyPublication(204, expectedLink)).resolves.toMatchObject({
      status: "success",
      value: {
        verification: "not_verified",
        evidence: { expectedLinkMatched: true, visibility: "deleted" },
      },
    });
    await expect(discourse.verifyPublication(205, expectedLink)).resolves.toMatchObject({
      status: "success",
      value: {
        verification: "not_verified",
        evidence: { expectedLinkMatched: false, audience: "public" },
      },
    });
  });

  it("reports a removed post as pending and never returns raw provider errors", async () => {
    const { fetcher } = fetchQueue(json({ error: apiKey }, 404));
    const result = await adapter(fetcher).verifyPublication(202, expectedLink);
    expect(result).toMatchObject({
      status: "success",
      value: {
        verification: "pending",
        evidence: { visibility: "not_visible", expectedLinkMatched: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("does not verify a post that only an authenticated account can observe", async () => {
    const { fetcher, calls } = fetchQueue(json({ error: "private topic" }, 403));
    const result = await adapter(fetcher).verifyPublication(301, expectedLink);
    expect(result).toMatchObject({
      status: "success",
      value: { verification: "pending", evidence: { visibility: "unknown", audience: "public" } },
    });
    expect(calls[0]?.init?.headers).not.toHaveProperty("Api-Key");
    expect(calls[0]?.init?.headers).not.toHaveProperty("Api-Username");
  });

  it("cancels an oversized response while streaming instead of buffering it all", async () => {
    let cancelled = false;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000_001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const { fetcher } = fetchQueue(oversized);
    await expect(adapter(fetcher).getIdentity()).resolves.toMatchObject({
      status: "blocked",
      code: "malformed_response",
    });
    expect(cancelled).toBe(true);
  });
});
