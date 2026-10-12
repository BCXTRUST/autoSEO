/**
 * Stripe stays in this adapter. Core never sees the secret or the Stripe API.
 * A configured secret means checkout can be attempted. It is not itself a charge.
 */
export function stripeCheckoutConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env.STRIPE_SECRET_KEY;
  return typeof key === "string" && key.trim().length > 0;
}
