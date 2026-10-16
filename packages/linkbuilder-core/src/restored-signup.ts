/** Qualified hosts restored by the dead-host pass. The next signup opens the first one. */
export const RESTORED_SIGNUP_ORDER = [
  "diabetes-forum.de",
  "bmw-syndikat.de",
  "drwindows.de",
  "fitness.com",
  "fitness.com.hr",
  "krank.de",
  "med2-forum.de",
  "nickles.de",
  "office-fragen.de",
  "pickupforum.de",
  "urbia.de",
] as const;

export function restoredSignupIndex(domain: string): number {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return RESTORED_SIGNUP_ORDER.findIndex((item) => host === item || host.endsWith(`.${item}`));
}

export function isRestoredSignupHost(domain: string): boolean {
  return restoredSignupIndex(domain) >= 0;
}
