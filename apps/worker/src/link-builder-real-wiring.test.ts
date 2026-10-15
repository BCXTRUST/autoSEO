import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { releasePersonaComputer } from "./link-builder-real-wiring.js";

const context = {
  operationId: "link-builder.release",
  traceId: "link-builder.release",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("releaseDesktop", () => {
  it("destroys the sandbox when stop mode is requested", async () => {
    const update = vi.fn(async () => ({}));
    const destroy = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    await releasePersonaComputer({
      prisma: {
        lbProject: {
          findUnique: vi.fn(async () => ({ workspaceId: "workspace-1" })),
        },
        computer: {
          findMany: vi.fn(async () => [
            {
              id: "computer-1",
              homeKey: "team-workspace-1",
              kind: "e2b",
              providerRef: "sandbox-1",
              state: "running",
              workspaceId: "workspace-1",
            },
          ]),
          update,
        },
      } as unknown as PrismaClient,
      sandbox: { destroy, stop } as unknown as SandboxProvider,
      projectId: "project-1",
      context,
      mode: "stop",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "computer-1" },
      data: { state: "stopped", providerRef: null, screenUrl: null },
    });
  });
});
