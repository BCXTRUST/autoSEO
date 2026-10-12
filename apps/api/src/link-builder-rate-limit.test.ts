import { describe, expect, it } from "vitest";
import {
  anonymousRateKey,
  linkBuilderRpcBucket,
  takeLinkBuilderRequest,
  WorkspaceRateLimiter,
} from "./link-builder-rate-limit.js";

describe("link builder rate limit", () => {
  it("limits each workspace inside the window", () => {
    let now = 1_000;
    const limiter = new WorkspaceRateLimiter(2, 1_000, () => now);
    expect(limiter.take("workspace-1").ok).toBe(true);
    expect(limiter.take("workspace-1").ok).toBe(true);
    const blocked = limiter.take("workspace-1");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.take("workspace-2").ok).toBe(true);
    now += 1_000;
    expect(limiter.take("workspace-1").ok).toBe(true);
  });

  it("does not lock a signed-in member out, and keeps anonymous polls off the page window", () => {
    expect(linkBuilderRpcBucket("/link-builder")).toBeNull();
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/projects/list")).toBe("interactive");
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/projects/status")).toBe("poll");
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/projects/screen")).toBe("poll");
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/subscribe")).toBe("poll");
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/hosts/list")).toBe("poll");
    expect(linkBuilderRpcBucket("/rpc/linkBuilder/projects/create")).toBe("interactive");
    expect(anonymousRateKey("203.0.113.8, 10.0.0.1", null)).toBe("ip:203.0.113.8");
    expect(anonymousRateKey(null, null)).toBe("anonymous");

    const limiters = {
      poll: new WorkspaceRateLimiter(1, 60_000, () => 1_000),
      page: new WorkspaceRateLimiter(1, 60_000, () => 1_000),
    };
    for (let i = 0; i < 5; i += 1) {
      expect(
        takeLinkBuilderRequest(limiters, {
          pathname: "/rpc/linkBuilder/projects/status",
          member: true,
          clientKey: "workspace-1",
        }).ok,
      ).toBe(true);
    }
    expect(
      takeLinkBuilderRequest(limiters, {
        pathname: "/rpc/linkBuilder/projects/list",
        member: true,
        clientKey: "workspace-1",
      }),
    ).toEqual({ ok: true, bucket: "interactive" });
    expect(
      takeLinkBuilderRequest(limiters, {
        pathname: "/link-builder",
        member: true,
        clientKey: "workspace-1",
      }),
    ).toEqual({ ok: true, bucket: null });

    expect(
      takeLinkBuilderRequest(limiters, {
        pathname: "/rpc/linkBuilder/projects/status",
        member: false,
        clientKey: "ip:203.0.113.8",
      }).ok,
    ).toBe(true);
    const pollBlocked = takeLinkBuilderRequest(limiters, {
      pathname: "/rpc/linkBuilder/projects/screen",
      member: false,
      clientKey: "ip:203.0.113.8",
    });
    expect(pollBlocked.ok).toBe(false);
    expect(
      takeLinkBuilderRequest(limiters, {
        pathname: "/rpc/linkBuilder/projects/list",
        member: false,
        clientKey: "ip:203.0.113.8",
      }),
    ).toEqual({ ok: true, bucket: "interactive" });
    const pageBlocked = takeLinkBuilderRequest(limiters, {
      pathname: "/rpc/linkBuilder/projects/list",
      member: false,
      clientKey: "ip:203.0.113.8",
    });
    expect(pageBlocked.ok).toBe(false);
  });
});
