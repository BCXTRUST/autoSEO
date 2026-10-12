import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature, webhookUrlAllowed } from "./webhooks.js";

const publicAnswer = async () => [{ address: "203.0.113.10" }];

describe("outbound webhooks", () => {
  it("signs the raw body and rejects a tampered body", async () => {
    const secret = "whsec_test_secret_value";
    const body = JSON.stringify({ kind: "project.paused", projectId: "p1" });
    const header = `sha256=${await signWebhookBody(secret, body)}`;
    expect(await verifyWebhookSignature(secret, body, header)).toBe(true);
    expect(await verifyWebhookSignature(secret, `${body} `, header)).toBe(false);
    expect(await verifyWebhookSignature("whsec_other_secret_value", body, header)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it("allows https and refuses private hosts in production", async () => {
    expect(
      (
        await webhookUrlAllowed("https://hooks.example/link-builder", {
          production: true,
          resolve: publicAnswer,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await webhookUrlAllowed("http://hooks.example/link-builder", { production: true })).ok,
    ).toBe(false);
    expect((await webhookUrlAllowed("https://127.0.0.1/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://10.1.2.3/hook", { production: true })).ok).toBe(false);
    expect((await webhookUrlAllowed("https://192.168.1.9/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://100.64.1.1/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://169.254.169.254/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://[fe80::1]/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://localhost/hook", { production: true })).ok).toBe(
      false,
    );
    expect((await webhookUrlAllowed("https://127.0.0.1/hook", { production: false })).ok).toBe(
      true,
    );
    expect(
      (await webhookUrlAllowed("https://user:pass@hooks.example/hook", { production: false })).ok,
    ).toBe(false);
    expect((await webhookUrlAllowed("https://203.0.113.10/hook", { production: true })).ok).toBe(
      true,
    );
  });

  it("refuses a production hostname when any DNS answer is private", async () => {
    let lookedUp = 0;
    const resolve = async () => {
      lookedUp += 1;
      return [{ address: "203.0.113.10" }, { address: "10.0.0.8" }];
    };
    const mixed = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve,
    });
    expect(mixed).toMatchObject({ ok: false, reason: "private" });
    expect(lookedUp).toBe(1);

    const cgnat = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve: async () => [{ address: "100.127.0.1" }],
    });
    expect(cgnat).toMatchObject({ ok: false, reason: "private" });

    const metadata = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve: async () => [{ address: "169.254.169.254" }],
    });
    expect(metadata).toMatchObject({ ok: false, reason: "private" });

    const linkLocal = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve: async () => [{ address: "fe80::1" }],
    });
    expect(linkLocal).toMatchObject({ ok: false, reason: "private" });

    const mapped = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve: async () => [{ address: "::ffff:127.0.0.1" }],
    });
    expect(mapped).toMatchObject({ ok: false, reason: "private" });

    const unresolved = await webhookUrlAllowed("https://hooks.example/hook", {
      production: true,
      resolve: async () => {
        throw new Error("offline");
      },
    });
    expect(unresolved).toMatchObject({ ok: false, reason: "unresolved" });
    expect((await webhookUrlAllowed("https://hooks.example/hook", { production: true })).ok).toBe(
      false,
    );

    let skipped = 0;
    await webhookUrlAllowed("https://10.1.2.3/hook", {
      production: true,
      resolve: async () => {
        skipped += 1;
        return [{ address: "203.0.113.10" }];
      },
    });
    expect(skipped).toBe(0);
  });
});
