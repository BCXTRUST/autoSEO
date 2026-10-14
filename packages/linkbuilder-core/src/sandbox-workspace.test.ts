import { describe, expect, it } from "vitest";
import {
  isInfrastructureFailure,
  isMissingSandboxWorkspace,
  statusAfterMissingWorkspace,
} from "./sandbox-workspace.js";

describe("missing sandbox workspace", () => {
  it("treats a missing workspace directory as retryable infrastructure", () => {
    const reason = "[invalid_argument] cwd '/home/user/rakazo-home' does not exist";
    expect(isMissingSandboxWorkspace(reason)).toBe(true);
    expect(isInfrastructureFailure(reason)).toBe(true);
    expect(isMissingSandboxWorkspace("registration_closed")).toBe(false);
    expect(isMissingSandboxWorkspace("edge_block")).toBe(false);
    expect(isMissingSandboxWorkspace("The topic you selected does not exist.")).toBe(false);
    expect(isInfrastructureFailure("runner not running")).toBe(true);
    expect(isInfrastructureFailure("The board refused the registration")).toBe(false);
  });

  it("reopens onto the stored login without a second account or a link", () => {
    expect(statusAfterMissingWorkspace(null)).toBe("qualified");
    expect(statusAfterMissingWorkspace({ emailVerifiedAt: null, adminApprovedAt: null })).toBe(
      "registering",
    );
    expect(
      statusAfterMissingWorkspace({
        emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
        adminApprovedAt: null,
      }),
    ).toBe("pending_admin");
    expect(
      statusAfterMissingWorkspace({
        emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
        adminApprovedAt: new Date("2026-10-02T00:00:00.000Z"),
      }),
    ).toBe("warming");
  });
});
