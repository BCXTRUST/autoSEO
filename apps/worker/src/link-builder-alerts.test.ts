import { STUCK_ALERT_RECIPIENT } from "@rakazo/linkbuilder-core";
import { describe, expect, it } from "vitest";
import { deliverStuckAlertEmail } from "./link-builder-alerts.js";

describe("stuck alert mail", () => {
  it("sends project pauses to ht@tbs.one from the Resend domain", async () => {
    let body = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    };
    const sent = await deliverStuckAlertEmail({
      kind: "project.paused",
      message: "Paused, Captell balance is low",
      apiKey: "re_test_placeholder",
      domain: "sideinbox.email",
      fetchImpl,
    });
    expect(sent).toBe(true);
    expect(STUCK_ALERT_RECIPIENT).toBe("ht@tbs.one");
    expect(JSON.parse(body)).toMatchObject({
      from: "autoSEO <alerts@sideinbox.email>",
      to: ["ht@tbs.one"],
      subject: "Paused, Captell balance is low",
    });
    expect(body).not.toContain("re_test_placeholder");
  });

  it("does not mail a finished run", async () => {
    const sent = await deliverStuckAlertEmail({
      kind: "run.finished",
      message: "Run finished",
      apiKey: "re_test_placeholder",
      domain: "sideinbox.email",
      fetchImpl: async () => {
        throw new Error("should not send");
      },
    });
    expect(sent).toBe(false);
  });
});
