const RESET_TARGET =
  /lost-?password|forgot-?password|reset-?password|new-?password|passwort-vergessen|kennwort-vergessen|kennwort vergessen|passwort vergessen|forgot(?: your)? password|reset(?: your)? password/i;

/** A lost-password page, link, or form. Submitting one emails a password reset. */
export function isPasswordResetTarget(value: string | null | undefined): boolean {
  if (!value) return false;
  return RESET_TARGET.test(value);
}
