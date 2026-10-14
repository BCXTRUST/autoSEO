/**
 * A host dies with this reason when the sandbox command cwd is missing.
 * That is the computer folder, not a closed board or an edge block.
 */
export function isMissingSandboxWorkspace(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const text = reason.toLowerCase();
  if (text.includes("registration_closed") || text.includes("edge_block")) return false;
  const missing = text.includes("does not exist") || text.includes("no such file");
  if (!missing) return false;
  return text.includes("rakazo-home") || text.includes("sandbox workspace");
}

/** Step failures that should be retried. They must not mark the host dead. */
export function isInfrastructureFailure(message: string): boolean {
  return (
    /no computer|did not become ready|runner not running/i.test(message) ||
    isMissingSandboxWorkspace(message)
  );
}

export interface WorkspaceRetryAccount {
  emailVerifiedAt: Date | null;
  adminApprovedAt: Date | null;
}

/**
 * Status to reopen a host that is dead only because the sandbox folder was missing.
 * An existing login stays on the same account. This does not jump to ready, which
 * would place a link, and it does not start a second registration from qualified
 * when a login is already stored.
 */
export function statusAfterMissingWorkspace(
  account: WorkspaceRetryAccount | null,
): "qualified" | "registering" | "pending_admin" | "warming" {
  if (!account) return "qualified";
  if (!account.emailVerifiedAt) return "registering";
  if (!account.adminApprovedAt) return "pending_admin";
  return "warming";
}
