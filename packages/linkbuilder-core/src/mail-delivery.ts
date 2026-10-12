/** A forum page that says the verification mail was not sent. Not a thread title. */
const MAIL_SEND_FAILED =
  /fehler bei e-?mail(?:[- ]versand)?|\[3\.3\]|could not send (?:the )?(?:e-?mail|mail)|failed to send (?:the )?(?:e-?mail|mail)|e-?mail (?:could not|couldn't) be sent|mail delivery failed|error sending (?:e-?mail|mail)|unable to send (?:the )?(?:e-?mail|mail)/i;

/** Short log line. Never the page headline. */
export const MAIL_RETRY_STATUS = "Mail did not send. Trying again.";

/** Short log line after the resend also produced no mail. */
export const MAIL_SKIP_STATUS = "Mail still missing. Skipping this site.";

export function isMailSendFailure(text: string | null | undefined): boolean {
  return MAIL_SEND_FAILED.test(text ?? "");
}

export function isMailDeliveryStatus(text: string | null | undefined): boolean {
  const line = text?.trim() ?? "";
  return line === MAIL_RETRY_STATUS || line === MAIL_SKIP_STATUS || isMailSendFailure(line);
}
