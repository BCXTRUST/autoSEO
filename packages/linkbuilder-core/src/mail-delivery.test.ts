import { describe, expect, it } from "vitest";
import {
  isMailDeliveryStatus,
  isMailSendFailure,
  MAIL_RETRY_STATUS,
  MAIL_SKIP_STATUS,
} from "./mail-delivery.js";

describe("mail delivery status", () => {
  it("recognises a forum send failure and keeps it out of the headline", () => {
    expect(isMailSendFailure("[3.3] Fehler bei E-Mail Versand")).toBe(true);
    expect(isMailSendFailure("Found [3.3] Fehler bei E-Mail Versand")).toBe(true);
    expect(isMailSendFailure("Could not send the email")).toBe(true);
    expect(isMailSendFailure("Vitamin D im Winter?")).toBe(false);
    expect(isMailDeliveryStatus(MAIL_RETRY_STATUS)).toBe(true);
    expect(isMailDeliveryStatus(MAIL_SKIP_STATUS)).toBe(true);
  });
});
